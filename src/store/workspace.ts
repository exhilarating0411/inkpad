import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { nanoid } from 'nanoid'
import { lastPaper } from '../paper'
import type { CanvasElement, FolderMeta, NotebookMeta, PageKind, PageMeta, SectionMeta } from './types'

/** Transaction origin for user edits that should be undoable. */
export const LOCAL = 'local'
/** Transaction origin for typing inside text boxes (the textarea has its own undo). */
export const TYPING = 'typing'
/** Transaction origin for changes that came from another device through sync. */
export const REMOTE = 'remote'

// ---------- which documents have changes not yet uploaded ----------

export const WORKSPACE_DOC = 'workspace'
const DIRTY_KEY = 'inkpad:dirty'
const dirty = new Set<string>(JSON.parse(localStorage.getItem(DIRTY_KEY) ?? '[]'))
/** counts edits per document, so a sync can tell whether a page changed again while it was uploading */
const editCount = new Map<string, number>()
const changeListeners = new Set<() => void>()
const dirtyListeners = new Set<() => void>()
function saveDirty() {
  localStorage.setItem(DIRTY_KEY, JSON.stringify([...dirty]))
  dirtyListeners.forEach((fn) => fn())
}

export function markDirty(docId: string) {
  dirty.add(docId)
  editCount.set(docId, (editCount.get(docId) ?? 0) + 1)
  saveDirty()
  changeListeners.forEach((fn) => fn())
}
export const dirtyDocs = () => [...dirty]
export const editVersion = (docId: string) => editCount.get(docId) ?? 0
/**
 * Removes the "needs uploading" mark. With `version`, only if the document was
 * not edited again since that version was read (those edits still need uploading).
 */
export function clearDirty(docId: string, version?: number) {
  if (version !== undefined && editVersion(docId) !== version) return
  if (dirty.delete(docId)) saveDirty()
}
/** Used when sync is first switched on: everything on this device needs uploading. */
export function markEverythingDirty() {
  for (const id of [WORKSPACE_DOC, ...pagesMap.keys()]) {
    dirty.add(id)
    editCount.set(id, (editCount.get(id) ?? 0) + 1)
  }
  saveDirty()
}
/** An edit was made on this device (used to start a sync). */
export function onLocalChange(fn: () => void) {
  changeListeners.add(fn)
  return () => changeListeners.delete(fn)
}
/** The set of documents waiting to be uploaded changed (used by the sync status). */
export function onDirtyChange(fn: () => void) {
  dirtyListeners.add(fn)
  return () => dirtyListeners.delete(fn)
}

// ---------- workspace: the list of pages ----------

export const workspaceDoc = new Y.Doc()
const workspacePersistence = new IndexeddbPersistence('inkpad:workspace', workspaceDoc)
export const pagesMap = workspaceDoc.getMap<PageMeta>('pages')
export const notebooksMap = workspaceDoc.getMap<NotebookMeta>('notebooks')
export const sectionsMap = workspaceDoc.getMap<SectionMeta>('sections')
/** small settings shared by all devices (e.g. which data layout the workspace uses) */
export const settingsMap = workspaceDoc.getMap<unknown>('settings')
/** folders of the old layout, read once when converting */
export const foldersMap = workspaceDoc.getMap<FolderMeta>('folders')

workspaceDoc.on('update', (_u: Uint8Array, origin: unknown) => {
  if (origin !== workspacePersistence && origin !== REMOTE) markDirty(WORKSPACE_DOC)
})

// A page deleted on another device: remove its contents here too.
pagesMap.observe((event) => {
  if (event.transaction.origin !== REMOTE) return
  event.changes.keys.forEach((change, id) => {
    if (change.action === 'delete') void deletePageData(id)
  })
})

/** The workspace is loaded from this device's storage (see structure.ts for the ready-to-use state). */
export const workspaceReady: Promise<void> = workspacePersistence.whenSynced.then(() => undefined)

export function createPage(
  kind: PageKind,
  sectionId: string,
  parentId: string | null = null,
  order = Date.now(),
  title = kind === 'canvas' ? 'Untitled page' : 'Untitled document',
  id = nanoid(12),
): PageMeta {
  const now = Date.now()
  const meta: PageMeta = { id, title, kind, created: now, updated: now, sectionId, parentId, order }
  if (kind === 'canvas') meta.paper = lastPaper()
  pagesMap.set(meta.id, meta)
  return meta
}

export function renamePage(id: string, title: string) {
  const meta = pagesMap.get(id)
  if (meta) pagesMap.set(id, { ...meta, title, updated: Date.now() })
}

export function touchPage(id: string) {
  const meta = pagesMap.get(id)
  if (meta && Date.now() - meta.updated > 5000) pagesMap.set(id, { ...meta, updated: Date.now() })
}

export async function deletePage(id: string) {
  pagesMap.delete(id)
  await deletePageData(id)
}

async function deletePageData(id: string) {
  dirty.delete(id)
  saveDirty()
  const open = openPages.get(id)
  openPages.delete(id)
  if (open) {
    open.undo.destroy()
    await open.persistence.clearData()
    open.doc.destroy()
  } else {
    const doc = new Y.Doc()
    const p = new IndexeddbPersistence(pageDbName(id), doc)
    await p.whenSynced
    await p.clearData()
    doc.destroy()
  }
}

export function updatePage(id: string, patch: Partial<PageMeta>) {
  const meta = pagesMap.get(id)
  if (meta) pagesMap.set(id, { ...meta, ...patch })
}

// ---------- page documents: the contents of one page ----------

export interface OpenPage {
  id: string
  doc: Y.Doc
  elements: Y.Map<CanvasElement>
  undo: Y.UndoManager
  persistence: IndexeddbPersistence
  ready: Promise<void>
}

const openPages = new Map<string, OpenPage>()
/** the page document if it is already loaded (does not load it) */
export const peekOpenPage = (id: string) => openPages.get(id)
export const pageDbNameOf = (id: string) => `inkpad:page:${id}`
const pageDbName = (id: string) => `inkpad:page:${id}`

export function openPage(id: string): OpenPage {
  let page = openPages.get(id)
  if (page) return page
  const doc = new Y.Doc()
  const persistence = new IndexeddbPersistence(pageDbName(id), doc)
  const elements = doc.getMap<CanvasElement>('elements')
  // Undo steps are grouped explicitly (stopCapturing() starts a new step), not by time:
  // fast handwriting would otherwise merge many strokes into one undo.
  const undo = new Y.UndoManager(elements, { trackedOrigins: new Set([LOCAL]), captureTimeout: 10 * 60_000 })
  page = { id, doc, elements, undo, persistence, ready: persistence.whenSynced.then(() => undefined) }
  openPages.set(id, page)
  doc.on('update', (_u: Uint8Array, origin: unknown) => {
    // any edit made on this device (not the initial load from storage or a synced change)
    if (origin !== persistence && origin !== REMOTE) {
      touchPage(id)
      markDirty(id)
    }
  })
  return page
}

/** The Y.Doc behind a sync document id ('workspace' or a page id), loaded from storage. */
export async function loadDoc(docId: string): Promise<Y.Doc> {
  if (docId === WORKSPACE_DOC) {
    await workspacePersistence.whenSynced
    return workspaceDoc
  }
  const page = openPage(docId)
  await page.ready
  return page.doc
}
