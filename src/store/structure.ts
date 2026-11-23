/**
 * Notebooks → sections (tabs) → pages → sub-pages, like OneNote.
 *
 * All of it lives in the workspace document, so it syncs like everything else.
 * Reading is forgiving: a page whose parent is missing (deleted on another
 * device) is simply shown at the top level, and loops count as top level too.
 */
import { nanoid } from 'nanoid'
import type { NotebookMeta, PageKind, PageMeta, SectionMeta } from './types'
import {
  REMOTE,
  createPage,
  deletePage,
  foldersMap,
  notebooksMap,
  pagesMap,
  sectionsMap,
  settingsMap,
  updatePage,
  workspaceDoc,
  workspaceReady,
} from './workspace'

/** page, sub-page, sub-sub-page */
export const MAX_DEPTH = 3

export const SECTION_COLORS = ['#e0a030', '#d9534f', '#c2569b', '#7b4fd6', '#4a72d9', '#2f9e9e', '#4a9d5b', '#8a857a']

const DEFAULT_NOTEBOOK = 'nb-main'
const UNSORTED_SECTION = 's-unsorted'

export const pageOrder = (p: PageMeta) => p.order ?? p.created
const byOrder = (a: { order: number; created: number }, b: { order: number; created: number }) =>
  a.order - b.order || a.created - b.created

// ---------- reading ----------

export function notebooks(): NotebookMeta[] {
  return [...notebooksMap.values()].sort(byOrder)
}

export function sectionsOf(notebookId: string): SectionMeta[] {
  return [...sectionsMap.values()].filter((s) => s.notebookId === notebookId).sort(byOrder)
}

/**
 * The page's parent if it really is one: exists, is in the same section and
 * is not part of a loop (two devices nesting pages into each other at once).
 */
export function parentOf(p: PageMeta): string | null {
  const first = p.parentId ? pagesMap.get(p.parentId) : undefined
  if (!first || first.sectionId !== p.sectionId) return null
  const seen = new Set([p.id])
  for (let cur: PageMeta | undefined = first; cur; ) {
    if (seen.has(cur.id)) return null
    seen.add(cur.id)
    const next: PageMeta | undefined = cur.parentId ? pagesMap.get(cur.parentId) : undefined
    if (!next || next.sectionId !== p.sectionId) break
    cur = next
  }
  return first.id
}

/** Children of every page of a section, sorted; key null = top level. */
export function childMap(sectionId: string): Map<string | null, PageMeta[]> {
  const m = new Map<string | null, PageMeta[]>()
  for (const p of pagesMap.values()) {
    if (p.sectionId !== sectionId) continue
    const parent = parentOf(p)
    let list = m.get(parent)
    if (!list) m.set(parent, (list = []))
    list.push(p)
  }
  for (const list of m.values()) list.sort((a, b) => pageOrder(a) - pageOrder(b) || a.created - b.created)
  return m
}

export interface TreeRow {
  page: PageMeta
  depth: number
  childCount: number
}

/** The section's pages in display order. Children of collapsed pages (and of `skip`) are left out. */
export function flatTree(sectionId: string, collapsed: Set<string> = new Set(), skip?: string): TreeRow[] {
  const kids = childMap(sectionId)
  const rows: TreeRow[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const page of kids.get(parent) ?? []) {
      const n = kids.get(page.id)?.length ?? 0
      rows.push({ page, depth, childCount: n })
      if (n && !collapsed.has(page.id) && page.id !== skip) walk(page.id, depth + 1)
    }
  }
  walk(null, 0)
  return rows
}

/** All pages of a section in display order, with depth (nothing collapsed). */
export const sectionPages = (sectionId: string) => flatTree(sectionId)

/** Ids of the page and everything below it. */
export function subtree(pageId: string): string[] {
  const p = pagesMap.get(pageId)
  if (!p?.sectionId) return [pageId]
  const kids = childMap(p.sectionId)
  const out: string[] = []
  const walk = (id: string) => {
    out.push(id)
    for (const k of kids.get(id) ?? []) walk(k.id)
  }
  walk(pageId)
  return out
}

/** How many levels there are below the page (0 = no sub-pages). */
export function levelsBelow(pageId: string): number {
  const p = pagesMap.get(pageId)
  if (!p?.sectionId) return 0
  const kids = childMap(p.sectionId)
  const height = (id: string): number => Math.max(0, ...(kids.get(id) ?? []).map((k) => 1 + height(k.id)))
  return height(pageId)
}

export function depthOf(pageId: string): number {
  let d = 0
  for (let p = pagesMap.get(pageId); p; d++) {
    const parent = parentOf(p)
    if (!parent) break
    p = pagesMap.get(parent)
  }
  return d
}

/** Parent pages from the top down (not including the page). */
export function ancestors(pageId: string): PageMeta[] {
  const out: PageMeta[] = []
  let p = pagesMap.get(pageId)
  while (p) {
    const parent = parentOf(p)
    p = parent ? pagesMap.get(parent) : undefined
    if (p) out.unshift(p)
  }
  return out
}

/** "Notebook › Section" for a page. */
export function locationLabel(p: PageMeta, withNotebook = true): string {
  const s = p.sectionId ? sectionsMap.get(p.sectionId) : undefined
  if (!s) return ''
  const nb = notebooksMap.get(s.notebookId)
  return withNotebook && nb ? `${nb.name} › ${s.name}` : s.name
}

// ---------- notebooks ----------

export function createNotebook(name: string): { notebook: NotebookMeta; section: SectionMeta } {
  const now = Date.now()
  const notebook: NotebookMeta = { id: nanoid(10), name: name.trim() || 'New notebook', created: now, order: now }
  let section!: SectionMeta
  workspaceDoc.transact(() => {
    notebooksMap.set(notebook.id, notebook)
    section = createSection(notebook.id, 'New section', SECTION_COLORS[0])
  })
  return { notebook, section }
}

export function renameNotebook(id: string, name: string) {
  const nb = notebooksMap.get(id)
  if (nb && name.trim()) notebooksMap.set(id, { ...nb, name: name.trim() })
}

/** Deletes a notebook with all its sections and pages. */
export async function deleteNotebook(id: string) {
  const sections = sectionsOf(id)
  notebooksMap.delete(id)
  for (const s of sections) await deleteSection(s.id)
}

// ---------- sections ----------

export function createSection(notebookId: string, name: string, color: string): SectionMeta {
  const now = Date.now()
  const s: SectionMeta = { id: nanoid(10), notebookId, name: name.trim() || 'New section', color, created: now, order: now }
  sectionsMap.set(s.id, s)
  return s
}

export function updateSection(id: string, patch: Partial<Pick<SectionMeta, 'name' | 'color'>>) {
  const s = sectionsMap.get(id)
  if (!s) return
  const name = patch.name?.trim()
  sectionsMap.set(id, { ...s, ...patch, name: name || s.name })
}

/** Swaps a section with its neighbour on the left (-1) or right (+1). */
export function shiftSection(id: string, dir: -1 | 1) {
  const s = sectionsMap.get(id)
  if (!s) return
  const list = sectionsOf(s.notebookId)
  const i = list.findIndex((x) => x.id === id)
  const other = list[i + dir]
  if (!other) return
  workspaceDoc.transact(() => {
    // equal orders (made on two devices at once) would make the swap do nothing
    const a = s.order === other.order ? other.order + dir : other.order
    sectionsMap.set(s.id, { ...s, order: a })
    sectionsMap.set(other.id, { ...other, order: s.order })
  })
}

export function moveSectionToNotebook(id: string, notebookId: string) {
  const s = sectionsMap.get(id)
  if (s && s.notebookId !== notebookId) sectionsMap.set(id, { ...s, notebookId, order: Date.now() })
}

/** Deletes a section with all its pages. */
export async function deleteSection(id: string) {
  const pages = [...pagesMap.values()].filter((p) => p.sectionId === id)
  sectionsMap.delete(id)
  for (const p of pages) await deletePage(p.id)
}

// ---------- pages ----------

function orderBetween(a?: number, b?: number): number {
  if (a !== undefined && b !== undefined) return (a + b) / 2
  if (a !== undefined) return a + 1000
  if (b !== undefined) return b - 1000
  return Date.now()
}

/** New page at the end of the section, or at the end of a page's sub-pages. */
export function addPage(kind: PageKind, sectionId: string, parentId: string | null = null): PageMeta {
  const siblings = childMap(sectionId).get(parentId) ?? []
  const last = siblings[siblings.length - 1]
  return createPage(kind, sectionId, parentId, Math.max(Date.now(), last ? pageOrder(last) + 1000 : 0))
}

/**
 * Puts a page (with its sub-pages) under `parentId`, right after the sibling
 * `afterId` (null = first). Uses an order number between the new neighbours,
 * so nothing else changes and two devices rearranging at once never conflict.
 */
export function placePage(pageId: string, parentId: string | null, afterId: string | null) {
  const page = pagesMap.get(pageId)
  if (!page?.sectionId) return
  const siblings = (childMap(page.sectionId).get(parentId) ?? []).filter((p) => p.id !== pageId)
  const i = afterId ? siblings.findIndex((p) => p.id === afterId) : -1
  const prev = i >= 0 ? siblings[i] : undefined
  const next = siblings[i + 1]
  updatePage(pageId, { parentId, order: orderBetween(prev && pageOrder(prev), next && pageOrder(next)) })
}

function previousSibling(p: PageMeta): PageMeta | undefined {
  const siblings = childMap(p.sectionId!).get(parentOf(p)) ?? []
  const i = siblings.findIndex((x) => x.id === p.id)
  return i > 0 ? siblings[i - 1] : undefined
}

/** "Make sub-page": the page goes under the page above it. */
export function canIndent(pageId: string): boolean {
  const p = pagesMap.get(pageId)
  const prev = p?.sectionId ? previousSibling(p) : undefined
  return !!prev && depthOf(prev.id) + 1 + levelsBelow(pageId) < MAX_DEPTH
}

export function indentPage(pageId: string) {
  const p = pagesMap.get(pageId)
  const prev = p && canIndent(pageId) ? previousSibling(p) : undefined
  if (!prev) return
  const kids = childMap(p!.sectionId!).get(prev.id) ?? []
  placePage(pageId, prev.id, kids.length ? kids[kids.length - 1].id : null)
}

export const canOutdent = (pageId: string) => {
  const p = pagesMap.get(pageId)
  return !!p && parentOf(p) !== null
}

/** "Promote": the page moves up one level, right below its old parent. */
export function outdentPage(pageId: string) {
  const p = pagesMap.get(pageId)
  const parent = p && parentOf(p)
  const parentMeta = parent ? pagesMap.get(parent) : undefined
  if (!parentMeta) return
  placePage(pageId, parentOf(parentMeta), parentMeta.id)
}

/** Moves a page (with its sub-pages) to the end of another section. */
export function movePageToSection(pageId: string, sectionId: string) {
  const ids = subtree(pageId)
  const top = childMap(sectionId).get(null) ?? []
  const last = top[top.length - 1]
  workspaceDoc.transact(() => {
    for (const id of ids) updatePage(id, { sectionId })
    updatePage(pageId, { parentId: null, order: Math.max(Date.now(), last ? pageOrder(last) + 1000 : 0) })
  })
}

/** Deletes one page; its sub-pages are kept and move up into its place. */
export async function deletePageKeepChildren(pageId: string) {
  const p = pagesMap.get(pageId)
  if (!p?.sectionId) return deletePage(pageId)
  const kids = childMap(p.sectionId)
  const children = kids.get(p.id) ?? []
  const parent = parentOf(p)
  const siblings = kids.get(parent) ?? []
  const next = siblings[siblings.findIndex((x) => x.id === p.id) + 1]
  const start = pageOrder(p)
  const gap = (next ? pageOrder(next) - start : 1000) / (children.length + 1)
  workspaceDoc.transact(() => {
    children.forEach((c, i) => updatePage(c.id, { parentId: parent, order: start + gap * (i + 1) }))
  })
  await deletePage(pageId)
}

// ---------- converting the old folder layout, and repairing ----------

const LAYOUT_KEY = 'layout'

function ensureDefaultNotebook(): string {
  const first = notebooks()[0]
  if (first) return first.id
  notebooksMap.set(DEFAULT_NOTEBOOK, { id: DEFAULT_NOTEBOOK, name: 'My notebook', created: 0, order: 0 })
  return DEFAULT_NOTEBOOK
}

function ensureUnsorted(name: string): string {
  if (!sectionsMap.has(UNSORTED_SECTION)) {
    const notebookId = ensureDefaultNotebook()
    sectionsMap.set(UNSORTED_SECTION, {
      id: UNSORTED_SECTION,
      notebookId,
      name,
      color: SECTION_COLORS[7],
      created: 0,
      order: Number.MAX_SAFE_INTEGER,
    })
  }
  return UNSORTED_SECTION
}

/** Folders from the top down to (and including) the folder; loop-safe. */
function folderChain(id: string): string[] {
  const chain: string[] = []
  const seen = new Set<string>()
  for (let cur: string | null | undefined = id; cur && foldersMap.has(cur) && !seen.has(cur); cur = foldersMap.get(cur)?.parentId) {
    seen.add(cur)
    chain.unshift(cur)
  }
  return chain
}

/**
 * Where a page or folder of the old layout goes. A top-level folder became a
 * section; a sub-folder became a page (its pages are now its sub-pages).
 * Ids are derived from the folder ids, so every device converting on its own
 * produces exactly the same result and syncing merges it cleanly.
 */
function legacyHome(folderId: string): { sectionId: string; parentId: string | null } | null {
  const chain = folderChain(folderId)
  if (!chain.length) return null
  const sectionId = 's-' + chain[0]
  if (!sectionsMap.has(sectionId)) return null
  // pages of a sub-folder are sub-pages of the sub-folder's page
  return { sectionId, parentId: chain.length === 1 ? null : 'f-' + folderId }
}

function convertFolders() {
  const notebookId = ensureDefaultNotebook()
  const folders = [...foldersMap.values()]
  const tops = folders.filter((f) => folderChain(f.id).length === 1).sort(byOrder)
  tops.forEach((f, i) => {
    sectionsMap.set('s-' + f.id, {
      id: 's-' + f.id,
      notebookId,
      name: f.name,
      color: SECTION_COLORS[i % (SECTION_COLORS.length - 1)],
      created: f.created,
      order: f.order,
    })
  })
  // sub-folders become pages, parents before children
  const nested = folders
    .map((f) => ({ f, chain: folderChain(f.id) }))
    .filter((x) => x.chain.length > 1)
    .sort((a, b) => a.chain.length - b.chain.length)
  for (const { f, chain } of nested) {
    const sectionId = 's-' + chain[0]
    // depth of the folder's page: at most MAX_DEPTH - 2, so the pages inside it still fit
    const depth = Math.min(chain.length - 2, MAX_DEPTH - 2)
    const parentId = depth > 0 ? 'f-' + chain[depth] : null
    const id = 'f-' + f.id
    if (!pagesMap.has(id)) {
      pagesMap.set(id, { id, title: f.name, kind: 'markdown', created: f.created, updated: f.created, sectionId, parentId, order: f.order })
    }
  }
}

/** Gives every page a valid section and every section a valid notebook. Idempotent. */
function repair() {
  const notebookId = ensureDefaultNotebook()
  for (const s of sectionsMap.values()) {
    if (!notebooksMap.has(s.notebookId)) sectionsMap.set(s.id, { ...s, notebookId })
  }
  for (const p of pagesMap.values()) {
    if (p.sectionId && sectionsMap.has(p.sectionId)) continue
    // made by an older version of the app (folders), or its section was deleted elsewhere
    const home = (!p.sectionId && p.folderId && legacyHome(p.folderId)) || {
      sectionId: ensureUnsorted(sectionsMap.size ? 'Unsorted' : 'Notes'),
      parentId: null,
    }
    pagesMap.set(p.id, { ...p, ...home, order: pageOrder(p) })
  }
  if (sectionsMap.size === 0) ensureUnsorted('Notes')
}

function prepare() {
  workspaceDoc.transact(() => {
    const fresh = settingsMap.get(LAYOUT_KEY) === undefined && pagesMap.size === 0 && foldersMap.size === 0
    if (settingsMap.get(LAYOUT_KEY) !== 2) {
      convertFolders()
      settingsMap.set(LAYOUT_KEY, 2)
    }
    repair()
    if (fresh) createPage('canvas', [...sectionsMap.keys()][0], null, Date.now(), 'My first page')
  })
}

/** Loaded, converted from the old layout if needed, and repaired. */
export const structureReady: Promise<void> = workspaceReady.then(() => {
  prepare()
  // changes from other devices may bring pages from an older app version, or orphans
  let timer = 0
  const later = (e: { transaction: { origin: unknown } }) => {
    if (e.transaction.origin !== REMOTE) return
    clearTimeout(timer)
    timer = window.setTimeout(prepare, 300)
  }
  pagesMap.observe(later)
  sectionsMap.observe(later)
  notebooksMap.observe(later)
})
