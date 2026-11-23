/**
 * What goes into an exported PDF, as a tree: it becomes the PDF's bookmarks
 * (notebook → sections → pages → sub-pages). Kept small and free of the PDF
 * library, which is only downloaded when an export really starts.
 */
import { childMap, sectionsOf } from '../store/structure'
import { notebooksMap, pagesMap, sectionsMap } from '../store/workspace'

export interface ExportNode {
  title: string
  /** missing for a section heading: it points at its first page */
  pageId?: string
  children: ExportNode[]
}

export interface ExportRequest {
  /** used for the file name and the PDF's title */
  title: string
  nodes: ExportNode[]
}

function pageNodes(sectionId: string, parentId: string | null, kids = childMap(sectionId)): ExportNode[] {
  return (kids.get(parentId) ?? []).map((p) => ({
    title: p.title || 'Untitled',
    pageId: p.id,
    children: pageNodes(sectionId, p.id, kids),
  }))
}

/** One page with its sub-pages. */
export function pageExport(pageId: string): ExportRequest {
  const p = pagesMap.get(pageId)
  if (!p?.sectionId) return { title: 'Page', nodes: [] }
  const title = p.title || 'Untitled'
  return { title, nodes: [{ title, pageId, children: pageNodes(p.sectionId, p.id) }] }
}

export function sectionExport(sectionId: string): ExportRequest {
  const s = sectionsMap.get(sectionId)
  return { title: s?.name ?? 'Section', nodes: pageNodes(sectionId, null) }
}

export function notebookExport(notebookId: string): ExportRequest {
  const nb = notebooksMap.get(notebookId)
  return {
    title: nb?.name ?? 'Notebook',
    nodes: sectionsOf(notebookId)
      .map((s) => ({ title: s.name, children: pageNodes(s.id, null) }))
      .filter((n) => n.children.length > 0),
  }
}

/** Pages in the order they appear in the PDF. */
export function exportPages(req: ExportRequest): string[] {
  const out: string[] = []
  const walk = (nodes: ExportNode[]) =>
    nodes.forEach((n) => {
      if (n.pageId) out.push(n.pageId)
      walk(n.children)
    })
  walk(req.nodes)
  return out
}
