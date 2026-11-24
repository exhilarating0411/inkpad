/**
 * Sync engine: keeps this device and a private GitHub repository in step.
 *
 * Layout of the notes repository:
 *   v2/workspace/<file>        page list (Yjs updates)
 *   v2/pages/<pageId>/<file>   contents of one page (Yjs updates)
 *   images/<imageId>           pictures
 * Files ending in .b64 hold the update as base64 text: text can be sent inside
 * the tree request, so a whole upload costs only three write requests. Very
 * large updates are still uploaded as binary .bin blobs.
 * Older app versions used workspace/ and pages/ (binary .bin files); those are
 * still read. New files go to v2/ so that an older app, which would misread
 * the text files, does not see them at all.
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
 *
 * Uploads stay within GitHub's limit on writes, downloads within its limit on
 * requests (see budget.ts); GitHub asking to slow down is respected.
 *
 * Downloads go a batch at a time, each batch taken in and remembered before
 * the next, so a large library (a new device) arrives bit by bit and an
 * interruption loses at most one batch. Every round also uploads, and the
 * page on screen and the most recently changed pages come first, so everyday
 * changes are not held up behind a restore.
 */
import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import { GitHub, GitHubError, fromBase64, toBase64, type NewFile, type RemoteFile, type SyncConfig } from './github'
import { READ_LIMITS, readBudget, writeBudget } from './budget'
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
  pagesMap,
  peekOpenPage,
  workspaceDoc,
  workspaceReady,
  withStoredPage,
} from '../store/workspace'
import { backend } from '../store/backend'
import { clearPendingImage, getImageBlob, pendingImages, setRemoteImageFetcher } from '../store/images'
import { whenInkIdle } from '../store/activity'
import { forgetPageText } from '../store/search'

/** `left`: pages whose contents are still being downloaded (a large library arriving on a new device) */
export type SyncState =
  | { kind: 'off' }
  | { kind: 'idle'; lastSync: number; left?: number }
  | { kind: 'syncing'; left?: number }
  | { kind: 'offline' }
  | { kind: 'error'; message: string }

const CONFIG_KEY = 'inkpad:sync'
/** how often to look for other devices' changes while the app is on screen (unchanged answers are free) */
const POLL_MS = 5_000
/** upload this long after the last edit */
const AFTER_EDIT_MS = 1_500
/** merge a folder into one snapshot once it has this many files */
const COMPACT_AT = 30
/** files up to this size (base64 characters) go inside the tree request… */
const MAX_INLINE_FILE = 512 * 1024
/** …as long as the request stays below this size */
const MAX_INLINE_TOTAL = 3 * 1024 * 1024
/** larger files are uploaded as blobs, at most this many per commit; the rest follow in the next one */
const MAX_BLOBS_PER_COMMIT = 10
/** downloads running at the same time */
const PARALLEL_DOWNLOADS = 6
/** at most this many files are downloaded per round, so each round (which also uploads) stays short */
const MAX_DOWNLOADS_PER_ROUND = 60
/** new files go here; old ones (without the prefix) are still read */
const V2 = 'v2/'

const meta = backend.syncMeta
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
let laterTimer = 0
let laterAt = 0
let running: Promise<void> | null = null
let again = false
let stopEdits: (() => void) | null = null
/** GitHub asked us to send nothing before this time */
let blockedUntil = 0
/** the app was put away: upload now even if the write budget is used up */
let flushRequested = false

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
  setRemoteImageFetcher(async (id) => {
    const g = gh()
    if (!g) return null
    readBudget.spend(1)
    return g.getFile(`images/${id}`)
  })
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibility)
  schedulePoll()
}

function stop() {
  stopEdits?.()
  stopEdits = null
  clearTimeout(pollTimer)
  clearTimeout(editTimer)
  clearTimeout(laterTimer)
  laterTimer = 0
  setRemoteImageFetcher(null)
  window.removeEventListener('online', onOnline)
  document.removeEventListener('visibilitychange', onVisibility)
}

const onOnline = () => void syncNow()
// Sync when the app is put away (so the other device sees it) and when it comes back.
const onVisibility = () => {
  if (document.visibilityState === 'hidden') flushRequested = true
  void syncNow()
}

function schedulePoll() {
  clearTimeout(pollTimer)
  pollTimer = window.setTimeout(() => {
    if (document.visibilityState === 'visible') void syncNow()
    schedulePoll()
  }, POLL_MS)
}

/** Syncs again after `ms` (a budget or GitHub asked to wait, or more to download), or sooner if already planned. */
function syncLater(ms: number) {
  const at = Date.now() + Math.max(500, ms)
  if (laterTimer && laterAt <= at) return
  clearTimeout(laterTimer)
  laterAt = at
  laterTimer = window.setTimeout(() => {
    laterTimer = 0
    void syncNow()
  }, at - Date.now())
}

/** The page on screen: downloaded before any other, even if the read budget has to go into debt. */
let shownPage = ''
/** pages whose contents are still to be downloaded, after the last round */
let waitingPages = new Set<string>()

export function setShownPage(id: string | undefined) {
  shownPage = id ?? ''
  if (shownPage && waitingPages.has(shownPage)) void syncNow()
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

/** Shows "Syncing…" only while something is really downloaded or uploaded, not for every quiet check. */
function setBusy() {
  const left = waitingPages.size || undefined
  if (state.kind !== 'syncing' || state.left !== left) setState({ kind: 'syncing', left })
}

/** set by a round that left files to download: when the next batch may go (ms from now) */
let nextBatchIn: number | null = null

async function syncOnce() {
  const cfg = loadConfig()
  if (!cfg) return setState({ kind: 'off' })
  if (!navigator.onLine) return setState({ kind: 'offline' })
  if (Date.now() < blockedUntil) return syncLater(blockedUntil - Date.now()) // the message is showing
  const key = JSON.stringify(cfg)
  if (!gh || ghFor !== key) {
    gh = new GitHub(cfg)
    ghFor = key
  }
  // not while a line is being written: wait for a short pause (unless the app is being put away)
  if (!flushRequested) await whenInkIdle()
  const flush = flushRequested
  flushRequested = false
  try {
    await workspaceReady
    for (let attempt = 0; attempt < 4; attempt++) {
      nextBatchIn = null
      if (await syncRound(gh, flush)) {
        // once per app start, after taking in the other devices' changes:
        // find anything an earlier, interrupted sync did not upload
        if (!checkedEverything) {
          checkedEverything = true
          if (await markUnuploaded()) again = true
        }
        // more to download: next batch on a timer, so this sync ends and
        // edits made meanwhile go up with the next round
        if (nextBatchIn !== null) syncLater(nextBatchIn)
        setState({ kind: 'idle', lastSync: Date.now(), left: waitingPages.size || undefined })
        return
      }
    }
    throw new Error('Another device kept syncing at the same moment; will retry.')
  } catch (e) {
    console.warn('sync failed', e)
    if (e instanceof GitHubError && e.retryAt) {
      blockedUntil = e.retryAt
      syncLater(e.retryAt - Date.now())
      const until = new Date(e.retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      setState({ kind: 'error', message: `GitHub asked to pause until ${until}; sync continues by itself.` })
    } else if (!navigator.onLine || e instanceof TypeError) setState({ kind: 'offline' })
    else setState({ kind: 'error', message: e instanceof GitHubError || e instanceof Error ? e.message : String(e) })
  }
}

const docDir = (docId: string) => V2 + (docId === WORKSPACE_DOC ? 'workspace' : `pages/${docId}`)
/** The document a file belongs to, in the current (v2/) or the old layout. */
function docIdOf(path: string): string | null {
  const p = path.startsWith(V2) ? path.slice(V2.length) : path
  if (p.startsWith('workspace/')) return WORKSPACE_DOC
  const m = p.match(/^pages\/([^/]+)\//)
  return m ? m[1] : null
}

/** The Yjs update stored in a file: .b64 files hold it as base64 text, others as raw bytes. */
async function download(gh: GitHub, f: RemoteFile): Promise<Uint8Array> {
  const bytes = await gh.getBlob(f.sha)
  return f.path.endsWith('.b64') ? fromBase64(new TextDecoder().decode(bytes)) : bytes
}

/** When a file was uploaded (from its name: u-<time>-<device> or s-<time>-<device>); 0 if unknown. */
function stampOf(path: string): number {
  const m = path.match(/\/[us]-([0-9a-z]+)-[^/]*$/)
  return m ? parseInt(m[1], 36) || 0 : 0
}

/** Downloads files a few at a time; results in the same order. */
async function downloadAll(gh: GitHub, files: RemoteFile[]): Promise<Uint8Array[]> {
  readBudget.spend(files.length)
  const out: Uint8Array[] = new Array(files.length)
  let next = 0
  const worker = async () => {
    while (next < files.length) {
      const i = next++
      out[i] = await download(gh, files[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(PARALLEL_DOWNLOADS, files.length) }, worker))
  return out
}

/** Returns false if another device pushed in the meantime (caller retries). */
async function syncRound(gh: GitHub, flush: boolean): Promise<boolean> {
  const shadows: Shadow[] = []
  const openShadow = async (docId: string) => {
    const s = await openShadowDoc(docId)
    shadows.push(s)
    return s
  }
  try {
    return await syncRoundInner(gh, openShadow, flush)
  } finally {
    for (const s of shadows) await s.close()
  }
}

async function syncRoundInner(gh: GitHub, openShadow: (docId: string) => Promise<Shadow>, flush: boolean): Promise<boolean> {
  const head = await gh.head()
  const lastHead = await meta.get<string>('head')
  const applied = new Set<string>((await meta.get<string[]>('applied')) ?? [])
  // the tree of `head`, if known: saves a request when committing. Only ever
  // used for exactly that commit; a tree of another commit would drop files.
  const known = await meta.get<{ head: string; tree: string }>('tree')
  let baseTree = known?.head === head ? known.tree : undefined
  let files: RemoteFile[]
  if (head === lastHead) files = (await meta.get<RemoteFile[]>('files')) ?? []
  else {
    readBudget.spend(2)
    const listed = await gh.listFiles(head)
    files = listed.files
    baseTree = listed.tree
  }

  debug('round', { head, lastHead, files: files.map((f) => f.path), dirty: dirtyDocs() })
  // ----- 1. take in what other devices uploaded: page list first, then pages -----
  const byDoc = new Map<string, RemoteFile[]>()
  for (const f of files) {
    const id = docIdOf(f.path)
    if (!id) continue
    if (!byDoc.has(id)) byDoc.set(id, [])
    byDoc.get(id)!.push(f)
  }
  const freshOf = (docId: string) => (byDoc.get(docId) ?? []).filter((f) => !applied.has(f.path))
  const applyFiles = async (docId: string, newFiles: RemoteFile[], updates: Uint8Array[]) => {
    await whenInkIdle(300, 5_000) // merging redraws the page: not in the middle of a line
    const shadow = await openShadow(docId)
    debug('apply', docId, newFiles.map((f) => f.path))
    await applyToLocal(docId, updates)
    newFiles.forEach((f, i) => {
      Y.applyUpdate(shadow.doc, updates[i], REMOTE)
      applied.add(f.path)
    })
  }
  // the page list always comes in whole (it is small: merged at COMPACT_AT files)
  const freshWorkspace = freshOf(WORKSPACE_DOC)
  if (freshWorkspace.length) {
    setBusy()
    await applyFiles(WORKSPACE_DOC, freshWorkspace, await downloadAll(gh, freshWorkspace))
    await meta.set('applied', [...applied])
  }
  // pages: only those still in the page list (which may have just changed);
  // files of deleted pages are cleaned up below.
  // Page on screen first, then the most recently changed: a change just made
  // on another device comes in with the next round even during a big restore.
  const waiting = [...byDoc.keys()]
    .filter((id) => id !== WORKSPACE_DOC && pagesMap.has(id))
    .map((id) => {
      const fs = freshOf(id)
      return { id, files: fs, newest: Math.max(0, ...fs.map((f) => stampOf(f.path))) }
    })
    .filter((p) => p.files.length)
    .sort((a, b) => Number(b.id === shownPage) - Number(a.id === shownPage) || b.newest - a.newest)
  // a batch of whole pages, as many as this round and the read budget allow
  const batch: typeof waiting = []
  let count = 0
  for (const p of waiting) {
    const n = p.files.length
    if (batch.length === 0) {
      // the first page goes if the budget has room for it (a page with more
      // files than the budget can ever hold goes once the budget is full)
      if (readBudget.available(p.id === shownPage) < Math.min(n, READ_LIMITS.capacity)) break
    } else if (count + n > Math.min(MAX_DOWNLOADS_PER_ROUND, readBudget.available())) break
    batch.push(p)
    count += n
  }
  if (batch.length) {
    setBusy()
    const updates = await downloadAll(gh, batch.flatMap((p) => p.files))
    let i = 0
    for (const p of batch) {
      await applyFiles(p.id, p.files, updates.slice(i, i + p.files.length))
      i += p.files.length
    }
    // remembered at once: an interruption later in this round does not undo it
    await meta.set('applied', [...applied])
  }
  const rest = waiting.slice(batch.length)
  waitingPages = new Set(rest.map((p) => p.id))
  if (rest.length) {
    nextBatchIn = batch.length ? 0 : readBudget.waitFor(Math.min(rest[0].files.length, READ_LIMITS.capacity), rest[0].id === shownPage)
    debug('to download', { pages: rest.length, files: rest.reduce((s, p) => s + p.files.length, 0), nextBatchIn })
  }
  /** a page whose files are not all here yet: may get new changes uploaded, but must not be merged into a snapshot */
  const incomplete = (docId: string) => waitingPages.has(docId)

  const quiet = head === lastHead && !freshWorkspace.length && !batch.length

  // ----- 2. upload what this device has that GitHub does not -----
  // any commit costs at least 3 writes: if even that is over budget, don't
  // prepare an upload now (the changes stay marked); try again when possible
  const minWait = writeBudget.waitFor(3, flush)
  if (minWait > 0 && (dirtyDocs().length || pendingImages().length)) {
    debug('write budget: upload in', minWait, 'ms')
    syncLater(minWait)
    if (!quiet) await saveRound(head, files, applied, baseTree)
    return true
  }
  const add: NewFile[] = []
  const remove: string[] = []
  const afterCommit: (() => Promise<void> | void)[] = []
  const stamp = `${Date.now().toString(36)}-${deviceId}`
  let inlineSize = 0
  let blobs = 0
  /** some changes did not fit in this commit: another round follows right away */
  let more = false
  /** a file for this commit: inside the tree request if small enough, else a blob; null if neither fits */
  const pack = (docId: string, kind: 'u' | 's', update: Uint8Array): NewFile | null => {
    const text = toBase64(update)
    if (text.length <= MAX_INLINE_FILE && inlineSize + text.length <= MAX_INLINE_TOTAL) {
      inlineSize += text.length
      return { path: `${docDir(docId)}/${kind}-${stamp}.b64`, text }
    }
    if (blobs < MAX_BLOBS_PER_COMMIT) {
      blobs++
      return { path: `${docDir(docId)}/${kind}-${stamp}.bin`, data: update }
    }
    return null
  }

  await whenInkIdle(300, 5_000)
  const toCheck = new Set(dirtyDocs())
  for (const [docId, fs] of byDoc) if (fs.length >= COMPACT_AT && !incomplete(docId)) toCheck.add(docId)
  // check the page list first so new pages are known before their contents
  const order = [...toCheck].sort((a, b) => (a === WORKSPACE_DOC ? -1 : b === WORKSPACE_DOC ? 1 : 0))
  for (const docId of order) {
    if (docId !== WORKSPACE_DOC && !pagesMap.has(docId)) {
      clearDirty(docId)
      continue
    }
    // the mark is removed only once the upload is committed, and only if the
    // document was not edited again meanwhile
    const version = editVersion(docId)
    const doc = await loadDoc(docId)
    const shadow = await openShadow(docId)
    const remoteFiles = byDoc.get(docId) ?? []
    const diff = Y.encodeStateAsUpdate(doc, Y.encodeStateVector(shadow.doc))
    const hasChanges = hasSomethingNew(shadow.doc, diff)
    debug('check', docId, { diffBytes: diff.length, remoteFiles: remoteFiles.length })
    if (remoteFiles.length + (hasChanges ? 1 : 0) >= COMPACT_AT && !incomplete(docId)) {
      // merge everything into one snapshot and drop the small files (old and new layout);
      // only with all of them here, or the ones not yet downloaded would be lost
      const full = Y.encodeStateAsUpdate(doc)
      const file = pack(docId, 's', full)
      if (!file) {
        more = true // stays marked; goes in the next commit
        continue
      }
      add.push(file)
      remove.push(...remoteFiles.map((f) => f.path))
      afterCommit.push(() => {
        Y.applyUpdate(shadow.doc, full, REMOTE)
        applied.add(file.path)
        clearDirty(docId, version)
      })
    } else if (hasChanges) {
      const file = pack(docId, 'u', diff)
      if (!file) {
        more = true
        continue
      }
      add.push(file)
      afterCommit.push(() => {
        Y.applyUpdate(shadow.doc, diff, REMOTE)
        applied.add(file.path)
        clearDirty(docId, version)
      })
    } else {
      afterCommit.push(() => clearDirty(docId, version))
    }
  }

  // pages deleted on any device: remove their files from GitHub
  for (const [docId, fs] of byDoc) {
    if (docId !== WORKSPACE_DOC && !pagesMap.has(docId) && workspaceKnown(applied, files)) {
      remove.push(...fs.map((f) => f.path))
    }
  }

  // pictures added on this device (always blobs: they are binary and may be large)
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
    if (blobs >= MAX_BLOBS_PER_COMMIT) {
      more = true
      break
    }
    blobs++
    add.push({ path, data: new Uint8Array(await blob.arrayBuffer()) })
    afterCommit.push(() => clearPendingImage(id))
  }

  let newHead = head
  let newTree = baseTree
  if (add.length || remove.length) {
    const writes = GitHub.writesFor(add)
    const wait = writeBudget.waitFor(writes, flush)
    if (wait > 0) {
      // over the write budget: upload later. Nothing is marked as uploaded,
      // so the marks and shadows stay exactly as they are.
      debug('write budget: upload in', wait, 'ms')
      syncLater(wait)
      await saveRound(head, files, applied, baseTree)
      return true
    }
    setBusy()
    writeBudget.spend(writes)
    const msg = `Sync from ${deviceLabel()} (${add.length} added${remove.length ? `, ${remove.length} merged/removed` : ''})`
    const committed = await gh.commit(head, msg, add, [...new Set(remove)], baseTree)
    if (!committed) {
      // someone else pushed first: start over (our documents are still marked)
      await meta.set('applied', [...applied])
      return false
    }
    for (const fn of afterCommit) await fn()
    newHead = committed.commit
    newTree = committed.tree
    const removed = new Set(remove)
    files = [...files.filter((f) => !removed.has(f.path)), ...add.map((a) => ({ path: a.path, sha: '' }))]
    for (const p of removed) applied.delete(p)
  } else {
    for (const fn of afterCommit) await fn()
    // nothing new either way: what is stored is still right
    if (quiet && (baseTree === undefined || known?.head === head)) return true
  }

  await saveRound(newHead, files, applied, newTree)
  if (more) again = true
  return true
}

async function saveRound(head: string, files: RemoteFile[], applied: Set<string>, tree: string | undefined) {
  await meta.set('head', head)
  await meta.set('files', files)
  await meta.set('applied', [...applied])
  await meta.set('tree', tree ? { head, tree } : undefined)
}

/** Only clean up deleted pages once this device has taken in every page-list file. */
function workspaceKnown(applied: Set<string>, files: RemoteFile[]) {
  return files.filter((f) => docIdOf(f.path) === WORKSPACE_DOC).every((f) => applied.has(f.path))
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

/**
 * Takes downloaded updates into this device's copy of a document. A page that
 * is not open is written to storage without staying in memory, so restoring a
 * large library does not keep thousands of pages loaded.
 */
async function applyToLocal(docId: string, updates: Uint8Array[]) {
  const apply = (doc: Y.Doc) => doc.transact(() => updates.forEach((u) => Y.applyUpdate(doc, u, REMOTE)), REMOTE)
  if (docId === WORKSPACE_DOC || peekOpenPage(docId)) return apply(await loadDoc(docId))
  await withStoredPage(docId, apply) // written to storage, not kept in memory
  forgetPageText(docId)
  // opened in the meantime: it may have loaded from storage before the write
  const open = peekOpenPage(docId)
  if (open) {
    await open.ready
    apply(open.doc)
  }
}

/** This device's copy of a document; pages that are not open are loaded only for the moment. */
async function withLocalDoc<T>(docId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  if (docId === WORKSPACE_DOC) return fn(workspaceDoc)
  return withStoredPage(docId, fn)
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
  const p = backend.persistDoc(`shadow:${docId}`, doc)
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
