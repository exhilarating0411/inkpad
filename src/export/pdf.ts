/**
 * PDF export, generated in the browser and downloaded directly.
 *
 * Handwriting pages: ink is drawn as vector paths (sharp at any zoom), pictures
 * are embedded, typed text is drawn as a high-resolution image (so Chinese and
 * any other script works without shipping a font). The PDF page is as big as
 * the page's content, never cut into sheets.
 *
 * Documents (Markdown): laid out by the browser exactly like the preview
 * (formulas, tables, code), split into A4 pages between paragraphs and
 * embedded as images.
 *
 * The bookmarks follow notebook → section → page → sub-page.
 */
import * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, rgb, type PDFPage } from 'pdf-lib'
import { createContext, destroyContext, domToCanvas } from 'modern-screenshot'
import type { CanvasElement, ImageElement, PageMeta, StrokeElement, TextElement } from '../store/types'
import { pageDbNameOf, pagesMap, peekOpenPage } from '../store/workspace'
import { getImageBlob, imageUrl } from '../store/images'
import { strokeOptions, strokePathExplicit } from '../canvas/ink'
import { INK } from '../theme'
import { renderMarkdown } from '../markdown/render'
import { exportPages, type ExportNode, type ExportRequest } from './plan'

export interface Progress {
  done: number
  total: number
  page: string
}

/** A4 in points */
const A4 = { w: 595.28, h: 841.89 }
const MARGIN = 36
/** world pixels → points (96 dpi → 72 dpi) */
const PT = 0.75
/** PDF viewers refuse pages bigger than this (points) */
const MAX_SIDE = 14_400
const TITLE_PT = 18
const TEXT_COLOUR = '#22201c'

export async function exportPdf(req: ExportRequest, onProgress: (p: Progress) => void, cancelled: () => boolean): Promise<Blob> {
  const pdf = await PDFDocument.create()
  pdf.setTitle(req.title, { showInWindowTitleBar: true })
  pdf.setCreator('InkPad')
  pdf.setProducer('InkPad')

  const ids = exportPages(req).filter((id) => pagesMap.has(id))
  const firstPdfPage = new Map<string, number>()
  for (let i = 0; i < ids.length; i++) {
    if (cancelled()) throw new Cancelled()
    const meta = pagesMap.get(ids[i])!
    onProgress({ done: i, total: ids.length, page: meta.title || 'Untitled' })
    firstPdfPage.set(meta.id, pdf.getPageCount())
    await withPageDoc(meta, async (doc) => {
      if (meta.kind === 'markdown') await addDocument(pdf, meta, doc.getText('markdown').toString(), cancelled)
      else await addCanvas(pdf, meta, [...doc.getMap<CanvasElement>('elements').values()])
    })
  }
  if (pdf.getPageCount() === 0) pdf.addPage([A4.w, A4.h])
  if (ids.length > 1) addOutline(pdf, req.nodes, firstPdfPage)
  onProgress({ done: ids.length, total: ids.length, page: '' })
  const bytes = await pdf.save()
  return new Blob([bytes as BlobPart], { type: 'application/pdf' })
}

export class Cancelled extends Error {
  name = 'Cancelled'
}

/** The page's contents: the open copy if it is open, otherwise a temporary one from storage. */
async function withPageDoc(meta: PageMeta, fn: (doc: Y.Doc) => Promise<void>) {
  const open = peekOpenPage(meta.id)
  if (open) {
    await open.ready
    return fn(open.doc)
  }
  const doc = new Y.Doc()
  const p = new IndexeddbPersistence(pageDbNameOf(meta.id), doc)
  await p.whenSynced
  try {
    await fn(doc)
  } finally {
    await p.destroy()
    doc.destroy()
  }
}

// ---------- colours and text images ----------

function colour(hex: string) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  const n = m ? parseInt(m[1], 16) : 0x1f1f1f
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255)
}

const fontFamily = () => getComputedStyle(document.documentElement).fontFamily || 'system-ui, sans-serif'

/** Breaks text into lines the way a text box does: at spaces, and between any two CJK characters. */
function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []
  for (const para of text.split('\n')) {
    const tokens = para.match(/[⺀-鿿가-힯豈-﫿＀-￯]|[^\s⺀-鿿가-힯豈-﫿＀-￯]+\s*|\s+/g) ?? ['']
    let line = ''
    for (const tok of tokens) {
      if (ctx.measureText(line + tok).width <= maxWidth || !line) {
        if (ctx.measureText(tok).width > maxWidth && !line) {
          // one word wider than the box: break it anywhere
          for (const ch of tok) {
            if (line && ctx.measureText(line + ch).width > maxWidth) {
              lines.push(line)
              line = ''
            }
            line += ch
          }
        } else line += tok
      } else {
        lines.push(line.trimEnd())
        line = tok.trimStart()
      }
    }
    lines.push(line.trimEnd())
  }
  return lines
}

interface TextLayout {
  lines: string[]
  lineHeight: number
  font: string
}

const measureCtx = document.createElement('canvas').getContext('2d')!

function layoutText(text: string, fontSize: number, width: number, bold = false): TextLayout {
  const font = `${bold ? '700 ' : ''}${fontSize}px ${fontFamily()}`
  measureCtx.font = font
  return { lines: wrapLines(measureCtx, text, width), lineHeight: fontSize * 1.5, font }
}

/** Draws laid-out text into a transparent PNG; scale = image pixels per world pixel. */
async function textPng(layout: TextLayout, width: number, colourHex: string, scale: number): Promise<Uint8Array> {
  const height = layout.lines.length * layout.lineHeight
  const s = Math.min(scale, 8000 / Math.max(width, 1), 8000 / Math.max(height, 1))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.ceil(width * s))
  c.height = Math.max(1, Math.ceil(height * s))
  const ctx = c.getContext('2d')!
  ctx.scale(s, s)
  ctx.font = layout.font
  ctx.fillStyle = colourHex
  ctx.textBaseline = 'middle'
  layout.lines.forEach((line, i) => ctx.fillText(line, 0, (i + 0.5) * layout.lineHeight))
  return canvasBytes(c, 'image/png')
}

async function canvasBytes(c: HTMLCanvasElement, type: string, quality?: number): Promise<Uint8Array> {
  const blob = await new Promise<Blob | null>((resolve) => c.toBlob(resolve, type, quality))
  if (!blob) throw new Error('Could not create an image (the page may be too large).')
  return new Uint8Array(await blob.arrayBuffer())
}

/** Page title in the top-left corner. Returns its height in points. */
async function drawTitle(pdf: PDFDocument, page: PDFPage, title: string): Promise<number> {
  const width = (page.getWidth() - 2 * MARGIN) / PT
  const layout = layoutText(title || 'Untitled', TITLE_PT / PT, width, true)
  layout.lines = layout.lines.slice(0, 2)
  const png = await pdf.embedPng(await textPng(layout, width, TEXT_COLOUR, 4))
  const h = layout.lines.length * layout.lineHeight * PT
  page.drawImage(png, { x: MARGIN, y: page.getHeight() - MARGIN - h, width: width * PT, height: h })
  return h + 14
}

function titleHeight(title: string, pageWidth: number): number {
  const layout = layoutText(title || 'Untitled', TITLE_PT / PT, (pageWidth - 2 * MARGIN) / PT, true)
  return Math.min(2, layout.lines.length) * layout.lineHeight * PT + 14
}

// ---------- handwriting pages ----------

/** text box geometry, matching the editor: 10px grab bar, 1px border, 4px/6px padding */
const TB = { top: 10 + 1 + 4, left: 1 + 6, extra: 10 + 2 + 8, sides: 14 }

async function addCanvas(pdf: PDFDocument, meta: PageMeta, elements: CanvasElement[]) {
  const sorted = [...elements].sort((a, b) => a.z - b.z)
  const strokes = sorted.filter((e): e is StrokeElement => e.type === 'stroke')
  const texts = sorted.filter((e): e is TextElement => e.type === 'text' && e.text.trim() !== '')
  const images = sorted.filter((e): e is ImageElement => e.type === 'image')

  const layouts = new Map(texts.map((t) => [t.id, layoutText(t.text, t.fontSize, Math.max(10, t.w - TB.sides))]))
  // content bounds in world pixels
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  const grow = (ax: number, ay: number, bx: number, by: number) => {
    x0 = Math.min(x0, ax)
    y0 = Math.min(y0, ay)
    x1 = Math.max(x1, bx)
    y1 = Math.max(y1, by)
  }
  for (const s of strokes) {
    const pad = s.size / 2
    grow(s.bbox[0] + s.dx - pad, s.bbox[1] + s.dy - pad, s.bbox[2] + s.dx + pad, s.bbox[3] + s.dy + pad)
  }
  for (const t of texts) {
    const l = layouts.get(t.id)!
    grow(t.x, t.y, t.x + t.w, t.y + TB.extra + l.lines.length * l.lineHeight)
  }
  for (const im of images) grow(im.x, im.y, im.x + im.w, im.y + im.h)
  const empty = x0 === Infinity
  if (empty) x0 = y0 = x1 = y1 = 0

  const contentW = x1 - x0
  const contentH = y1 - y0
  let k = PT
  let width = Math.max(A4.w, contentW * k + 2 * MARGIN)
  let head = titleHeight(meta.title, width)
  // very large pages are scaled down to what PDF viewers accept
  k = Math.min(PT, (MAX_SIDE - 2 * MARGIN) / Math.max(contentW, 1), (MAX_SIDE - 2 * MARGIN - head) / Math.max(contentH, 1))
  width = Math.min(MAX_SIDE, Math.max(A4.w, contentW * k + 2 * MARGIN))
  head = titleHeight(meta.title, width)
  const height = Math.min(MAX_SIDE, Math.max(A4.h, contentH * k + 2 * MARGIN + head))

  const page = pdf.addPage([width, height])
  await drawTitle(pdf, page, meta.title)
  const top = height - MARGIN - head
  const px = (x: number) => MARGIN + (x - x0) * k
  const py = (y: number) => top - (y - y0) * k

  // pictures, then typed text, then ink: the same layers as on screen
  for (const im of images) {
    const embedded = await embedPicture(pdf, im.imageId)
    if (embedded) {
      page.drawImage(embedded, { x: px(im.x), y: py(im.y + im.h), width: im.w * k, height: im.h * k })
    } else {
      page.drawRectangle({ x: px(im.x), y: py(im.y + im.h), width: im.w * k, height: im.h * k, borderColor: rgb(0.8, 0.8, 0.8), borderWidth: 1 })
    }
  }
  for (const t of texts) {
    const l = layouts.get(t.id)!
    const w = Math.max(10, t.w - TB.sides)
    const h = l.lines.length * l.lineHeight
    const png = await pdf.embedPng(await textPng(l, w, !t.color ? TEXT_COLOUR : t.color === INK ? '#1f1f1f' : t.color, 4))
    page.drawImage(png, { x: px(t.x + TB.left), y: py(t.y + TB.top + h), width: w * k, height: h * k })
  }
  for (const s of strokes) {
    const d = strokePathExplicit(s.points, strokeOptions(s))
    if (!d) continue
    page.drawSvgPath(d, {
      x: MARGIN + (s.dx - x0) * k,
      y: top - (s.dy - y0) * k,
      scale: k,
      color: colour(s.color),
      opacity: s.highlighter ? 0.35 : 1,
    })
  }
}

async function embedPicture(pdf: PDFDocument, imageId: string) {
  try {
    let blob = await getImageBlob(imageId)
    if (!blob) {
      const url = await imageUrl(imageId) // downloads it when sync is on
      if (!url) return null
      blob = await (await fetch(url)).blob()
    }
    const bytes = new Uint8Array(await blob.arrayBuffer())
    if (bytes[0] === 0xff && bytes[1] === 0xd8) return await pdf.embedJpg(bytes)
    if (bytes[0] === 0x89 && bytes[1] === 0x50) return await pdf.embedPng(bytes)
    // WebP, GIF…: PDF cannot hold them, convert to PNG
    const bitmap = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = bitmap.width
    c.height = bitmap.height
    c.getContext('2d')!.drawImage(bitmap, 0, 0)
    bitmap.close()
    return await pdf.embedPng(await canvasBytes(c, 'image/png'))
  } catch {
    return null
  }
}

// ---------- documents ----------

/** CSS width the document is laid out at; it is then scaled to the A4 text width */
const DOC_CSS_WIDTH = 680

async function addDocument(pdf: PDFDocument, meta: PageMeta, source: string, cancelled: () => boolean) {
  const contentW = A4.w - 2 * MARGIN
  const scale = contentW / DOC_CSS_WIDTH // points per CSS pixel
  const sliceH = Math.floor((A4.h - 2 * MARGIN) / scale) // CSS pixels per PDF page

  const host = document.createElement('div')
  host.className = 'pdf-host'
  const frame = document.createElement('div')
  frame.className = 'pdf-frame'
  frame.style.width = DOC_CSS_WIDTH + 'px'
  const article = document.createElement('article')
  article.className = 'md-preview pdf-doc'
  const h1 = document.createElement('h1')
  h1.className = 'pdf-title'
  h1.textContent = meta.title || 'Untitled'
  const body = document.createElement('div')
  body.innerHTML = renderMarkdown(source)
  article.append(h1, body)
  frame.append(article)
  host.append(frame)
  document.body.append(host)

  try {
    await Promise.all(
      [...body.querySelectorAll<HTMLImageElement>('img[data-inkpad-id]')].map(async (img) => {
        const url = await imageUrl(img.dataset.inkpadId!)
        if (!url) return void (img.alt = '[picture not available on this device]')
        img.src = url
        await img.decode().catch(() => undefined)
      }),
    )
    await Promise.all([...body.querySelectorAll('img')].map((img) => (img.complete ? null : img.decode().catch(() => undefined))))
    await document.fonts.ready

    // where pages may break: between blocks, list items and table rows, never inside a line
    const total = article.scrollHeight
    const base = article.getBoundingClientRect().top
    const cuts = new Set<number>()
    article.querySelectorAll<HTMLElement>('p, li, tr, h1, h2, h3, h4, h5, h6, pre, blockquote, table, hr, img, .katex-display, ul, ol').forEach((el) => {
      if (el.parentElement?.closest('td, th, pre, .katex')) return
      cuts.add(Math.floor(el.getBoundingClientRect().top - base))
    })
    const sorted = [...cuts].filter((c) => c > 0).sort((a, b) => a - b)
    const starts = [0]
    while (starts[starts.length - 1] + sliceH < total) {
      const from = starts[starts.length - 1]
      const fits = sorted.filter((c) => c > from + sliceH * 0.3 && c <= from + sliceH)
      starts.push(fits.length ? fits[fits.length - 1] : from + sliceH)
    }

    frame.style.height = sliceH + 'px'
    const ctx = await createContext(frame, { scale: 2, backgroundColor: '#ffffff', autoDestruct: false })
    try {
      for (let i = 0; i < starts.length; i++) {
        if (cancelled()) throw new Cancelled()
        const end = starts[i + 1] ?? total
        // hide what belongs to the next PDF page
        article.style.transform = `translateY(${-starts[i]}px)`
        article.style.clipPath = `inset(${starts[i]}px 0 ${Math.max(0, total - end)}px 0)`
        ctx.node = frame
        const canvas = await domToCanvas(ctx)
        const jpg = await pdf.embedJpg(await canvasBytes(canvas, 'image/jpeg', 0.92))
        const page = pdf.addPage([A4.w, A4.h])
        page.drawImage(jpg, { x: MARGIN, y: A4.h - MARGIN - sliceH * scale, width: contentW, height: sliceH * scale })
      }
    } finally {
      destroyContext(ctx)
    }
  } finally {
    host.remove()
  }
}

// ---------- bookmarks ----------

function addOutline(pdf: PDFDocument, nodes: ExportNode[], firstPage: Map<string, number>) {
  const ctx = pdf.context
  const pages = pdf.getPages()
  // a section bookmark points at its first page
  const target = (n: ExportNode): number | undefined =>
    n.pageId !== undefined ? firstPage.get(n.pageId) : n.children.map(target).find((x) => x !== undefined)

  const rootRef = ctx.nextRef()
  const build = (list: ExportNode[], parentRef: PDFRef): { first?: PDFRef; last?: PDFRef; count: number } => {
    const items = list.map((n) => ({ n, page: target(n), ref: ctx.nextRef() })).filter((x) => x.page !== undefined)
    let count = 0
    items.forEach((it, i) => {
      const kids = build(it.n.children, it.ref)
      const dict = ctx.obj({
        Title: PDFHexString.fromText(it.n.title),
        Parent: parentRef,
        Dest: [pages[it.page!].ref, 'XYZ', null, null, null],
      })
      if (i > 0) dict.set(PDFName.of('Prev'), items[i - 1].ref)
      if (i < items.length - 1) dict.set(PDFName.of('Next'), items[i + 1].ref)
      if (kids.first) {
        dict.set(PDFName.of('First'), kids.first)
        dict.set(PDFName.of('Last'), kids.last!)
        dict.set(PDFName.of('Count'), PDFNumber.of(kids.count))
      }
      ctx.assign(it.ref, dict)
      count += 1 + kids.count
    })
    return { first: items[0]?.ref, last: items[items.length - 1]?.ref, count }
  }
  const top = build(nodes, rootRef)
  if (!top.first) return
  ctx.assign(rootRef, ctx.obj({ Type: 'Outlines', First: top.first, Last: top.last!, Count: top.count }))
  pdf.catalog.set(PDFName.of('Outlines'), rootRef)
  pdf.catalog.set(PDFName.of('PageMode'), PDFName.of('UseOutlines'))
}
