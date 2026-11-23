import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import type { CanvasElement, PageMeta } from './types'
import { pageDbNameOf, pagesMap, peekOpenPage } from './workspace'

export interface SearchResult {
  page: PageMeta
  /** a short piece of the text around the first match ('' if only the title matched) */
  snippet: string
}

// Text of pages that are not open, remembered until the page changes.
const cache = new Map<string, { updated: number; text: string }>()

function textOf(doc: Y.Doc, kind: PageMeta['kind']): string {
  if (kind === 'markdown') return doc.getText('markdown').toString()
  const out: string[] = []
  for (const el of doc.getMap<CanvasElement>('elements').values()) if (el.type === 'text') out.push(el.text)
  return out.join('\n')
}

async function pageText(meta: PageMeta): Promise<string> {
  const open = peekOpenPage(meta.id)
  if (open) {
    await open.ready
    return textOf(open.doc, meta.kind)
  }
  const hit = cache.get(meta.id)
  if (hit && hit.updated === meta.updated) return hit.text
  const doc = new Y.Doc()
  const p = new IndexeddbPersistence(pageDbNameOf(meta.id), doc)
  await p.whenSynced
  const text = textOf(doc, meta.kind)
  await p.destroy()
  doc.destroy()
  cache.set(meta.id, { updated: meta.updated, text })
  return text
}

/**
 * Finds pages whose title or text contains every word of the query (any case).
 * `include` limits the search, e.g. to one notebook, so only those pages are read.
 */
export async function searchPages(query: string, include: (p: PageMeta) => boolean = () => true): Promise<SearchResult[]> {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return []
  const pages = [...pagesMap.values()].filter(include).sort((a, b) => b.updated - a.updated)
  const texts = await Promise.all(pages.map((p) => pageText(p).catch(() => '')))
  const results: SearchResult[] = []
  pages.forEach((page, i) => {
    const text = texts[i]
    const hay = `${page.title}\n${text}`.toLowerCase()
    if (!words.every((w) => hay.includes(w))) return
    results.push({ page, snippet: snippetFor(text, words) })
  })
  return results
}

function snippetFor(text: string, words: string[]): string {
  const lower = text.toLowerCase()
  let at = -1
  for (const w of words) {
    const i = lower.indexOf(w)
    if (i >= 0 && (at < 0 || i < at)) at = i
  }
  if (at < 0) return ''
  const start = Math.max(0, at - 30)
  const end = Math.min(text.length, at + 70)
  return (start > 0 ? '…' : '') + text.slice(start, end).replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '')
}
