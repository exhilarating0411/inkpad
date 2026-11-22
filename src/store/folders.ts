import { nanoid } from 'nanoid'
import type { FolderMeta, PageMeta } from './types'
import { foldersMap, pagesMap, updatePage, workspaceDoc } from './workspace'

/** Pages without a (known) folder are shown in this virtual folder. */
export const UNSORTED = '__unsorted'

export const pageOrder = (p: PageMeta) => p.order ?? p.created

/**
 * The folder a page really lives in: its folder, or Unsorted when the folder is
 * missing (e.g. deleted on another device while this page was moved into it).
 */
export function pageFolder(p: PageMeta): string {
  return p.folderId && foldersMap.has(p.folderId) ? p.folderId : UNSORTED
}

/**
 * Parent of a folder, safe against broken data: a missing parent or a loop
 * (two devices moving folders into each other at the same time) counts as top level.
 */
export function parentOf(id: string): string | null {
  const f = foldersMap.get(id)
  if (!f?.parentId || !foldersMap.has(f.parentId)) return null
  const seen = new Set([id])
  for (let cur: string | null = f.parentId; cur; cur = foldersMap.get(cur)?.parentId ?? null) {
    if (seen.has(cur)) return null
    seen.add(cur)
    if (!foldersMap.has(cur)) break
  }
  return f.parentId
}

export function childFolders(parentId: string | null): FolderMeta[] {
  return [...foldersMap.values()].filter((f) => parentOf(f.id) === parentId).sort((a, b) => a.order - b.order)
}

export function pagesIn(folder: string): PageMeta[] {
  return [...pagesMap.values()].filter((p) => pageFolder(p) === folder).sort((a, b) => pageOrder(a) - pageOrder(b))
}

/** Folder names from the top down to (and including) this folder. */
export function folderPath(folder: string): FolderMeta[] {
  const path: FolderMeta[] = []
  for (let cur: string | null = folder === UNSORTED ? null : folder; cur; cur = parentOf(cur)) {
    const f = foldersMap.get(cur)
    if (!f) break
    path.unshift(f)
  }
  return path
}

export function folderLabel(folder: string): string {
  if (folder === UNSORTED) return 'Unsorted'
  return folderPath(folder).map((f) => f.name).join(' › ')
}

/** The folder and everything inside it. */
export function descendants(id: string): Set<string> {
  const out = new Set<string>([id])
  let grew = true
  while (grew) {
    grew = false
    for (const f of foldersMap.values()) {
      const parent = parentOf(f.id)
      if (parent && out.has(parent) && !out.has(f.id)) {
        out.add(f.id)
        grew = true
      }
    }
  }
  return out
}

/** Number of pages in a folder including its sub-folders. */
export function pageCount(folder: string): number {
  if (folder === UNSORTED) return pagesIn(UNSORTED).length
  const all = descendants(folder)
  let n = 0
  for (const p of pagesMap.values()) if (all.has(pageFolder(p))) n++
  return n
}

// ---------- changes ----------

export function createFolder(name: string, parentId: string | null): FolderMeta {
  const now = Date.now()
  const f: FolderMeta = { id: nanoid(10), name: name.trim() || 'New folder', parentId, created: now, order: now }
  foldersMap.set(f.id, f)
  return f
}

export function renameFolder(id: string, name: string) {
  const f = foldersMap.get(id)
  if (f && name.trim()) foldersMap.set(id, { ...f, name: name.trim() })
}

/** Moves a folder (with everything in it) under another folder or to the top level. */
export function moveFolder(id: string, parentId: string | null): boolean {
  const f = foldersMap.get(id)
  if (!f || (parentId && descendants(id).has(parentId))) return false
  foldersMap.set(id, { ...f, parentId, order: Date.now() })
  return true
}

/** Swaps a folder with its neighbour above (-1) or below (+1). */
export function shiftFolder(id: string, dir: -1 | 1) {
  const siblings = childFolders(parentOf(id))
  const i = siblings.findIndex((f) => f.id === id)
  const j = i + dir
  if (i < 0 || j < 0 || j >= siblings.length) return
  const a = siblings[i]
  const b = siblings[j]
  workspaceDoc.transact(() => {
    foldersMap.set(a.id, { ...a, order: b.order })
    foldersMap.set(b.id, { ...b, order: a.order })
  })
}

/** Deletes a folder; its pages and sub-folders move up to its parent. Nothing is lost. */
export function deleteFolder(id: string) {
  const parent = parentOf(id)
  const base = Date.now()
  workspaceDoc.transact(() => {
    // keep the pages in the order they had, at the end of the parent folder
    pagesIn(id).forEach((p, i) => pagesMap.set(p.id, { ...p, folderId: parent, order: base + i }))
    for (const f of foldersMap.values()) if (f.parentId === id) foldersMap.set(f.id, { ...f, parentId: parent })
    foldersMap.delete(id)
  })
}

/** Moves a page to the end of another folder. */
export function movePage(pageId: string, folder: string) {
  updatePage(pageId, { folderId: folder === UNSORTED ? null : folder, order: Date.now() })
}

/**
 * Puts a page at position `index` of its folder's list (manual arrangement).
 * Uses a number between its new neighbours, so other pages are untouched and
 * two devices rearranging at once never conflict.
 */
export function placePage(pageId: string, index: number) {
  const page = pagesMap.get(pageId)
  if (!page) return
  const list = pagesIn(pageFolder(page)).filter((p) => p.id !== pageId)
  const prev = list[index - 1]
  const next = list[index]
  let order: number
  if (prev && next) order = (pageOrder(prev) + pageOrder(next)) / 2
  else if (prev) order = pageOrder(prev) + 1000
  else if (next) order = pageOrder(next) - 1000
  else order = Date.now()
  updatePage(pageId, { order })
}
