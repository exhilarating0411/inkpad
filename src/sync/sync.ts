/**
 * Sync engine: keeps this device and a private GitHub repository in step.
 *
 * Layout of the notes repository:
 *   workspace/<file>.bin    page list (Yjs updates)
 *   pages/<pageId>/<file>   contents of one page (Yjs updates)
 *   images/<imageId>        pictures
 *
 * Every upload is a NEW file with a unique name, so two devices never write
 * the same file and never conflict. Yjs merges the updates, in any order.
 * When a folder gets many small files they are merged into one snapshot.
 *
 * To know exactly what to upload, each document has a "shadow" copy holding
 * only what is already on GitHub; the upload is the difference.
 *
 * A document stays marked "needs uploading" until its upload is committed, so
 * an interrupted sync (tab closed, connection lost) is simply redone next time.
 * As a safety net, the first sync after the app starts compares every
 * document with its shadow and uploads anything GitHub does not have yet.
 */
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { createStore, get, set } from 'idb-keyval'
import { nanoid } from 'nanoid'
import { GitHub, GitHubError, type RemoteFile, type SyncConfig } from './github'
import {
  REMOTE,
  WORKSPACE_DOC,
  clearDirty,
  dirtyDocs,
  editVersion,
  loadDoc,
  markDirty,
  markEverythingDirty,
  onLocalChange,
  pageDbNameOf,
  pagesMap,
  peekOpenPage,
  workspaceDoc,
  workspaceReady,
} from '../store/workspace'
import { clearPendingImage, getImageBlob, pendingImages, setRemoteImageFetcher } from '../store/images'

export type SyncState =
  | { kind: 'off' }
  | { kind: 'idle'; lastSync: number }
  | { kind: 'syncing' }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

const CONFIG_KEY = 'inkpad:sync'
const POLL_MS = 20_000
const AFTER_EDIT_MS = 4_000
/** merge a folder into one snapshot once it has this many files */
const COMPACT_AT = 30

const meta = createStore('inkpad-sync', 'meta')
const debug = (...a: unknown[]) => localStorage.getItem('inkpad:debug') && console.log('[sync]', ...a)
const deviceId = (() => {
  let id = localStorage.getItem('inkpad:device')
  if (!id) localStorage.setItem('inkpad:device', (id = nanoid(6)))
  return id
})()

// ---------- configuration ----------

export function loadConfig(): SyncConfig | null {
  try {
    const c = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? 'null')
    return c?.token && c?.owner && c?.repo ? c : null
  } catch {
    return null
  }
}

/** Validates the settings against GitHub, saves them and starts syncing. */
export async function connect(cfg: SyncConfig): Promise<void> {
  const clean: SyncConfig = { ...cfg, owner: cfg.owner.trim(), repo: cfg.repo.trim(), branch: cfg.branch.trim() || 'main', token: cfg.token.trim() }
  await new GitHub(clean).check()
  localStorage.setItem(CONFIG_KEY, JSON.stringify(clean))
  markEverythingDirty()
  start()
  void syncNow()
}

export function disconnect() {
  localStorage.removeItem(CONFIG_KEY)
  stop()
  setState({ kind: 'off' })
}

// ---------- state for the UI ----------

let state: SyncState = loadConfig() ? { kind: 'idle', lastSync: 0 } : { kind: 'off' }
const stateListeners = new Set<(s: SyncState) => void>()
function setState(s: SyncState) {
  state = s
  stateListeners.forEach((fn) => fn(s))
}
export const getSyncState = () => state
export function onSyncState(fn: (s: SyncState) => void) {
  stateListeners.add(fn)
  return () => stateListeners.delete(fn)
}

// ---------- scheduling ----------

let pollTimer = 0
let editTimer = 0
let running: Promise<void> | null = null
let again = false
let stopEdits: (() => void) | null = null

export function start() {
  if (!loadConfig() || stopEdits) return
  stopEdits = onLocalChange(() => {
    clearTimeout(editTimer)
    editTimer = window.setTimeout(() => void syncNow(), AFTER_EDIT_MS)
  })
  const gh = () => {
    const c = loadConfig()
    return c ? new GitHub(c) : null
  }
  setRemoteImageFetcher(async (id) => (await gh()?.getFile(`images/${id}`)) ?? null)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibility)
  schedulePoll()
}

function stop() {
  stopEdits?.()
  stopEdits = null
  clearTimeout(pollTimer)
  clearTimeout(editTimer)
  setRemoteImageFetcher(null)
  window.removeEventListener('online', onOnline)
  document.removeEventListener('visibilitychange', onVisibility)
}

const onOnline = () => void syncNow()
// Sync when the app is put away (so the other device sees it) and when it comes back.
const onVisibility = () => void syncNow()

function schedulePoll() {
  clearTimeout(pollTimer)
  pollTimer = window.setTimeout(() => {
    if (document.visibilityState === 'visible') void syncNow()
    schedulePoll()
  }, POLL_MS)
}

/** Runs one sync now (or right after the one in progress). */
export function syncNow(): Promise<void> {
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await syncOnce()
    } while (again)
  })().finally(() => (running = null))
  return running
}

// ---------- one sync ----------

let gh: GitHub | null = null
let ghFor = ''

async function syncOnce() {
  const cfg = loadConfig()
  if (!cfg) return setState({ kind: 'off' })
  if (!navigator.onLine) return setState({ kind: 'offline' })
  const key = JSON.stringify(cfg)
  if (!gh || ghFor !== key) {
    gh = new GitHub(cfg)
    ghFor = key
  }
  setState({ kind: 'syncing' })
  try {
    await workspaceReady
    for (let attempt = 0; attempt < 4; attempt++) {
      if (await syncRound(gh)) {
        // once per app start, after taking in the other devices' changes:
        // find anything an earlier, interrupted sync did not upload
        if (!checkedEverything) {
          checkedEverything = true
          if (await markUnuploaded()) again = true
        }
        setState({ kind: 'idle', lastSync: Date.now() })
        return
      }
    }
    throw new Error('Another device kept syncing at the same moment; will retry.')
  } catch (e) {
    console.warn('sync failed', e)
    if (!navigator.onLine || e instanceof TypeError) setState({ kind: 'offline' })
    else setState({ kind: 'error', message: e instanceof GitHubError || e instanceof Error ? e.message : String(e) })
  }
}

const docDir = (docId: string) => (docId === WORKSPACE_DOC ? 'workspace' : `pages/${docId}`)
function docIdOf(path: string): string | null {
  if (path.startsWith('workspace/')) return WORKSPACE_DOC
  const m = path.match(/^pages\/([^/]+)\//)
  return m ? m[1] : null
}

/** Returns false if another device pushed in the meantime (caller retries). */
async function syncRound(gh: GitHub): Promise<boolean> {
  const shadows: Shadow[] = []
  const openShadow = async (docId: string) => {
    const s = await openShadowDoc(docId)
    shadows.push(s)
    return s
  }
  try {
    return await syncRoundInner(gh, openShadow)
  } finally {
    for (const s of shadows) await s.close()
  }
}

async function syncRoundInner(gh: GitHub, openShadow: (docId: string) => Promise<Shadow>): Promise<boolean> {
  const head = await gh.head()
  const lastHead = await get<string>('head', meta)
  const applied = new Set<string>((await get<string[]>('applied', meta)) ?? [])
  let files: RemoteFile[]
  if (head === lastHead) files = (await get<RemoteFile[]>('files', meta)) ?? []
  else files = await gh.listFiles(head)

  debug('round', { head, lastHead, files: files.map((f) => f.path), dirty: dirtyDocs() })
  // ----- 1. take in what other devices uploaded (page list first) -----
  const byDoc = new Map<string, RemoteFile[]>()
  for (const f of files) {
    const id = docIdOf(f.path)
    if (!id) continue
    if (!byDoc.has(id)) byDoc.set(id, [])
    byDoc.get(id)!.push(f)
  }
  const fresh = [...byDoc.entries()]
    .map(([id, fs]) => [id, fs.filter((f) => !applied.has(f.path))] as const)
    .filter(([, fs]) => fs.length)
    .sort(([a], [b]) => (a === WORKSPACE_DOC ? -1 : b === WORKSPACE_DOC ? 1 : 0))
  for (const [docId, newFiles] of fresh) {
    // a page that was deleted (no longer listed): skip it, it gets cleaned up below
    if (docId !== WORKSPACE_DOC && !pagesMap.has(docId)) continue
    const doc = await loadDoc(docId)
    const shadow = await openShadow(docId)
    debug('apply', docId, newFiles.map((f) => f.path))
    for (const f of newFiles) {
      const update = await gh.getBlob(f.sha)
      Y.applyUpdate(doc, update, REMOTE)
      Y.applyUpdate(shadow.doc, update, REMOTE)
      applied.add(f.path)
    }
  }

  // ----- 2. upload what this device has that GitHub does not -----
  const add: { path: string; data: Uint8Array }[] = []
  const remove: string[] = []
  const afterCommit: (() => Promise<void>)[] = []
  const stamp = `${Date.now().toString(36)}-${deviceId}`

  const toCheck = new Set(dirtyDocs())
  for (const [docId, fs] of byDoc) if (fs.length >= COMPACT_AT) toCheck.add(docId)
  // check the page list first so new pages are known before their contents
  const order = [...toCheck].sort((a, b) => (a === WORKSPACE_DOC ? -1 : b === WORKSPACE_DOC ? 1 : 0))
  for (const docId of order) {
    if (docId !== WORKSPACE_DOC && !pagesMap.has(docId)) {
      clearDirty(docId)
      continue
    }
    // the mark is only removed once the upload is committed, and only if the
    // document was not edited again meanwhile (see afterCommit below)
    const version = editVersion(docId)
    afterCommit.push(async () => clearDirty(docId, version))
    const doc = await loadDoc(docId)
    const shadow = await openShadow(docId)
    const remoteFiles = byDoc.get(docId) ?? []
    const diff = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(shadow.doc))
    const hasChanges = hasSomethingNew(shadow.doc, diff)
    debug('check', docId, { diffBytes: diff.length, remoteFiles: remoteFiles.length })
    if (remoteFiles.length + (hasChanges ? 1 : 0) >= COMPACT_AT) {
      // merge everything into one snapshot and drop the small files
      const full = Y.encodeStateAsUpdate(doc)
      const path = `${docDir(docId)}/s-${stamp}.bin`
      add.push({ path, data: full })
      remove.push(...remoteFiles.map((f) => f.path))
      afterCommit.push(async () => {
        Y.applyUpdate(shadow.doc, full, REMOTE)
        applied.add(path)
      })
    } else if (hasChanges) {
      const path = `${docDir(docId)}/u-${stamp}.bin`
      add.push({ path, data: diff })
      afterCommit.push(async () => {
        Y.applyUpdate(shadow.doc, diff, REMOTE)
        applied.add(path)
      })
    }
  }

  // pages deleted on any device: remove their folders from GitHub
  for (const [docId, fs] of byDoc) {
    if (docId !== WORKSPACE_DOC && !pagesMap.has(docId) && workspaceKnown(applied, files)) {
      remove.push(...fs.map((f) => f.path))
    }
  }

  // pictures added on this device
  const remotePaths = new Set(files.map((f) => f.path))
  for (const id of pendingImages()) {
    const path = `images/${id}`
    if (remotePaths.has(path)) {
      clearPendingImage(id)
      continue
    }
    const blob = await getImageBlob(id)
    if (!blob) {
      clearPendingImage(id)
      continue
    }
    add.push({ path, data: new Uint8Array(await blob.arrayBuffer()) })
    afterCommit.push(async () => clearPendingImage(id))
  }

  let newHead = head
  if (add.length || remove.length) {
    const msg = `Sync from ${deviceLabel()} (${add.length} added${remove.length ? `, ${remove.length} merged/removed` : ''})`
    const committed = await gh.commit(head, msg, add, [...new Set(remove)])
    if (!committed) {
      // someone else pushed first: start over (our documents are still marked)
      await set('applied', [...applied], meta)
      return false
    }
    for (const fn of afterCommit) await fn()
    newHead = committed
    const removed = new Set(remove)
    files = [...files.filter((f) => !removed.has(f.path)), ...add.map((a) => ({ path: a.path, sha: '' }))]
    for (const p of removed) applied.delete(p)
  } else {
    for (const fn of afterCommit) await fn()
  }

  await set('head', newHead, meta)
  await set('files', files, meta)
  await set('applied', [...applied], meta)
  return true
}

/** Only clean up deleted pages once this device has taken in every page-list file. */
function workspaceKnown(applied: Set<string>, files: RemoteFile[]) {
  return files.filter((f) => f.path.startsWith('workspace/')).every((f) => applied.has(f.path))
}

/**
 * True when `update` holds anything (new content or deletions) that the
 * shadow, i.e. GitHub, does not have yet. A difference update always carries
 * all of the document's deletions, even old ones, so its size says nothing.
 */
function hasSomethingNew(shadow: Y.Doc, update: Uint8Array) {
  return !Y.snapshotContainsUpdate(Y.snapshot(shadow), update)
}

/** set once the full check below has run since the app started */
let checkedEverything = false

/**
 * Compares every document on this device with its shadow and marks the ones
 * holding changes GitHub does not have (e.g. a sync was cut off by closing the
 * tab). Returns how many were found.
 */
async function markUnuploaded(): Promise<number> {
  const waiting = new Set(dirtyDocs())
  let found = 0
  for (const docId of [WORKSPACE_DOC, ...pagesMap.keys()]) {
    if (waiting.has(docId)) continue
    const shadow = await openShadowDoc(docId)
    try {
      const behind = await withLocalDoc(docId, (doc) => hasSomethingNew(shadow.doc, Y.encodeStateAsUpdate(doc, Y.encodeStateVector(shadow.doc))))
      if (behind) {
        debug('not uploaded yet', docId)
        markDirty(docId)
        found++
      }
    } finally {
      await shadow.close()
    }
  }
  return found
}

/** This device's copy of a document; pages that are not open are loaded only for the moment. */
async function withLocalDoc<T>(docId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  if (docId === WORKSPACE_DOC) return fn(workspaceDoc)
  const open = peekOpenPage(docId)
  if (open) {
    await open.ready
    return fn(open.doc)
  }
  const doc = new Y.Doc()
  const p = new IndexeddbPersistence(pageDbNameOf(docId), doc)
  await p.whenSynced
  try {
    return fn(doc)
  } finally {
    await p.destroy()
    doc.destroy()
  }
}

function deviceLabel() {
  const ua = navigator.userAgent
  if (/iPad|Macintosh.*Mobile|Macintosh.*Touch/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Windows/.test(ua)) return 'Windows'
  if (/Macintosh/.test(ua)) return 'Mac'
  return 'device'
}

// ---------- shadow documents: what GitHub already has ----------

interface Shadow {
  doc: Y.Doc
  close(): Promise<void>
}

async function openShadowDoc(docId: string): Promise<Shadow> {
  const doc = new Y.Doc()
  const p = new IndexeddbPersistence(`inkpad:shadow:${docId}`, doc)
  await p.whenSynced
  return {
    doc,
    close: async () => {
      await p.destroy()
      doc.destroy()
    },
  }
}

// start automatically if sync was set up earlier
if (loadConfig()) start()
