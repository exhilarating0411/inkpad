/**
 * Copy and paste of handwriting, text boxes and pictures.
 *
 * A copy goes to the system clipboard in three forms at once:
 *   - image/png   a picture of the selection, for pasting into other apps
 *   - text/plain  the typed text, if any
 *   - text/html   the same picture, plus the exact elements, so pasting back
 *                 into this app gives real ink again (also on another device
 *                 through Apple's Universal Clipboard)
 * A copy of the elements is also kept on this device (localStorage), for when
 * the system clipboard cannot be written or loses the extra data.
 */
import { nanoid } from 'nanoid'
import type { CanvasElement } from '../store/types'
import { imageUrl } from '../store/images'
import { INK } from '../theme'
import { TB, layoutText } from '../export/text'
import { strokeOptions, strokePath } from './ink'
import type { Rect } from './geometry'

export interface Clip {
  id: string
  /** page it was copied from */
  page: string
  elements: CanvasElement[]
  /** bounds of the elements when copied (world coordinates) */
  bounds: Rect
  /** false when only this device has it (the system clipboard could not be written) */
  system: boolean
}

const KEY = 'inkpad:clip'
const MARK = 'inkpad-clip:'

let memory: Clip | null = null

export function lastClip(): Clip | null {
  if (memory) return memory
  try {
    memory = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  } catch {
    memory = null
  }
  return memory
}

function remember(clip: Clip) {
  memory = clip
  try {
    localStorage.setItem(KEY, JSON.stringify(clip))
  } catch {
    // very large selection: kept in memory only (still works until the app is closed)
  }
}

// ---------- copy ----------

/**
 * Puts the elements on the clipboard. Must be called straight from a click or
 * key press (browsers only allow clipboard writes then); the picture is drawn
 * afterwards, which the clipboard API allows.
 */
export function copyElements(page: string, elements: CanvasElement[], bounds: Rect): Promise<void> {
  const clip: Clip = { id: nanoid(10), page, elements, bounds, system: true }
  remember(clip)
  const text = elements
    .filter((e) => e.type === 'text')
    .map((e) => (e.type === 'text' ? e.text : ''))
    .filter((t) => t.trim())
    .join('\n\n')
  const png = renderPng(elements, bounds)
  const html = png.then(async (blob) => clipHtml(clip, blob ? await dataUrl(blob) : ''))

  const fail = (err: unknown) => {
    console.warn('clipboard write failed', err)
    // keep it for pasting in this app at least; try the old way for the text and data
    clip.system = legacyCopy(clipHtml(clip, ''), text)
    remember(clip)
  }
  if (!window.isSecureContext || !navigator.clipboard?.write || typeof ClipboardItem === 'undefined') {
    fail('no clipboard API')
    return Promise.resolve()
  }
  try {
    const items: Record<string, Promise<Blob>> = {
      'text/html': html.then((h) => new Blob([h], { type: 'text/html' })),
      'image/png': png.then((b) => b ?? Promise.reject(new Error('no picture'))),
    }
    if (text) items['text/plain'] = Promise.resolve(new Blob([text], { type: 'text/plain' }))
    return navigator.clipboard.write([new ClipboardItem(items)]).catch(async (err) => {
      // some browsers refuse one of the types: try again without the picture
      try {
        const h = await html
        const plain: Record<string, Blob> = { 'text/html': new Blob([h], { type: 'text/html' }) }
        if (text) plain['text/plain'] = new Blob([text], { type: 'text/plain' })
        await navigator.clipboard.write([new ClipboardItem(plain)])
      } catch {
        fail(err)
      }
    })
  } catch (err) {
    fail(err)
    return Promise.resolve()
  }
}

/** For plain http (local network): execCommand copy, which can carry HTML and text but no picture. */
function legacyCopy(html: string, text: string): boolean {
  const onCopy = (e: ClipboardEvent) => {
    e.clipboardData?.setData('text/html', html)
    e.clipboardData?.setData('text/plain', text)
    e.preventDefault()
  }
  // Safari only copies when something is selected: select a throwaway box
  const ta = document.createElement('textarea')
  ta.value = text || ' '
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0'
  const active = document.activeElement as HTMLElement | null
  document.body.append(ta)
  ta.select()
  document.addEventListener('copy', onCopy, true)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.removeEventListener('copy', onCopy, true)
  ta.remove()
  active?.focus?.({ preventScroll: true })
  return ok
}

function clipHtml(clip: Clip, pngUrl: string): string {
  const data = encodeURIComponent(JSON.stringify({ ...clip, system: true }))
  const img = pngUrl ? `<img src="${pngUrl}" alt="${MARK}${clip.id}" width="${Math.round(clip.bounds.w)}">` : ''
  return `<meta charset="utf-8"><div data-inkpad="${data}" title="${MARK}${clip.id}">${img}</div>`
}

/**
 * The elements in pasted HTML, if it came from this app. Browsers may strip
 * the data attribute; then the id still finds this device's own copy.
 */
export function clipFromHtml(html: string): Clip | null {
  if (!html || !html.includes(MARK)) return null
  const m = /data-inkpad="([^"]+)"/.exec(html)
  if (m) {
    try {
      const clip = JSON.parse(decodeURIComponent(m[1].replace(/&amp;/g, '&'))) as Clip
      if (Array.isArray(clip.elements) && clip.bounds) return clip
    } catch {
      /* fall through */
    }
  }
  const id = new RegExp(`${MARK}([\\w-]+)`).exec(html)?.[1]
  const local = lastClip()
  return id && local?.id === id ? local : null
}

// ---------- picture of the selection ----------

const PAD = 12
const MAX_PIXELS = 4096

/** The elements drawn on white, at twice their size (as on a sharp screen). */
export async function renderPng(elements: CanvasElement[], bounds: Rect): Promise<Blob | null> {
  try {
    const scale = Math.min(2, MAX_PIXELS / (bounds.w + 2 * PAD), MAX_PIXELS / (bounds.h + 2 * PAD))
    const c = document.createElement('canvas')
    c.width = Math.max(1, Math.ceil((bounds.w + 2 * PAD) * scale))
    c.height = Math.max(1, Math.ceil((bounds.h + 2 * PAD) * scale))
    const ctx = c.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.scale(scale, scale)
    ctx.translate(PAD - bounds.x, PAD - bounds.y)
    const sorted = [...elements].sort((a, b) => a.z - b.z)
    // the same layers as on screen: pictures, typed text, ink
    for (const el of sorted) {
      if (el.type !== 'image') continue
      const url = await imageUrl(el.imageId)
      if (!url) continue
      const img = new Image()
      img.src = url
      await img.decode().catch(() => undefined)
      if (img.naturalWidth) ctx.drawImage(img, el.x, el.y, el.w, el.h)
    }
    for (const el of sorted) {
      if (el.type !== 'text' || !el.text.trim()) continue
      const w = Math.max(10, el.w - TB.sides)
      const l = layoutText(el.text, el.fontSize, w)
      ctx.font = l.font
      ctx.fillStyle = !el.color || el.color === INK ? '#1f1f1f' : el.color
      ctx.textBaseline = 'middle'
      l.lines.forEach((line, i) => ctx.fillText(line, el.x + TB.left, el.y + TB.top + (i + 0.5) * l.lineHeight))
    }
    for (const el of sorted) {
      if (el.type !== 'stroke') continue
      const d = strokePath(el.points, strokeOptions(el))
      if (!d) continue
      ctx.save()
      ctx.translate(el.dx, el.dy)
      ctx.globalAlpha = el.highlighter ? 0.35 : 1
      ctx.fillStyle = el.color === INK ? '#1f1f1f' : el.color
      ctx.fill(new Path2D(d))
      ctx.restore()
    }
    return await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/png'))
  } catch (err) {
    console.warn('could not draw the selection', err)
    return null
  }
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => resolve('')
    r.readAsDataURL(blob)
  })
}

// ---------- paste ----------

/** Copies of the clip's elements with new ids, moved by (dx, dy), stacked above everything. */
export function cloneElements(elements: CanvasElement[], dx: number, dy: number): CanvasElement[] {
  const base = Date.now()
  return [...elements]
    .sort((a, b) => a.z - b.z)
    .map((el, i) => {
      const z = base + i * 0.001 + Math.random() * 0.0001
      const id = nanoid(12)
      if (el.type === 'stroke') return { ...el, id, z, points: [...el.points], dx: el.dx + dx, dy: el.dy + dy }
      return { ...el, id, z, x: el.x + dx, y: el.y + dy }
    })
}
