import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'
import { nanoid } from 'nanoid'
import type { CanvasElement, ImageElement, StrokeElement, TextElement, Tool, Viewport } from '../store/types'
import { LOCAL, TYPING, openPage } from '../store/workspace'
import { storeImage } from '../store/images'
import { PREDICT_MS, computeBBox, strokeOptions, strokePath } from './ink'
import { elementBounds, elementInRect, pointInRect, rectFromPoints, strokeHit, type Rect } from './geometry'
import { ImageView, StrokePath, TextBox } from './ElementViews'
import { inkColor } from '../theme'

export interface CanvasApi {
  undo(): void
  redo(): void
  insertImages(files: Blob[]): void
  pasteFromClipboard(): void
  zoomBy(factor: number): void
  resetZoom(): void
  deleteSelection(): void
  /** Restyle the text box being edited (or the selected ones). */
  styleText(patch: { color?: string; fontSize?: number }): void
}

export interface CanvasContext {
  selectionCount: number
  /** a text box is being edited or is selected */
  textActive: boolean
}

export interface InkSettings {
  penColor: string
  penSize: number
  hlColor: string
  hlSize: number
  textColor: string
  textSize: number
  /** Let a finger draw even after a pen has been seen. */
  fingerDraw: boolean
}

interface Props {
  pageId: string
  tool: Tool
  ink: InkSettings
  apiRef: RefObject<CanvasApi | null>
  onToolChange(t: Tool): void
  onPenDetected(): void
  penDetected: boolean
  onZoomChange(scale: number): void
  onContextChange(ctx: CanvasContext): void
}

type Gesture =
  | {
      kind: 'draw'
      pointerId: number
      points: number[]
      /** time of each point (ms), to guess where the pen is heading */
      times: number[]
      /** the pen touched down with pressure 0: the first real reading replaces the stand-in */
      firstPressureMissing: boolean
      color: string
      size: number
      highlighter: boolean
      pressure: boolean
    }
  | { kind: 'erase'; pointerId: number }
  | { kind: 'pan'; pointerId: number; lastX: number; lastY: number; startX: number; startY: number; moved: boolean; tap?: 'clear' | 'text' | 'eraser-toggle' }
  | { kind: 'pinch'; ids: [number, number]; startDist: number; startScale: number; worldX: number; worldY: number }
  | { kind: 'move'; pointerId: number; startX: number; startY: number }
  | { kind: 'resize'; pointerId: number; id: string; startX: number; startW: number; ratio: number; isImage: boolean }
  | { kind: 'band'; pointerId: number; sx: number; sy: number }

const MIN_SCALE = 0.1
const MAX_SCALE = 8
const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))
const vpKey = (id: string) => `inkpad:vp:${id}`
const round1 = (n: number) => Math.round(n * 10) / 10

/**
 * The live line, extended to where the pen will probably be `ms` from now
 * (from its speed over the last ~25 ms). Hides some of the delay between the
 * pen and the screen; the guess is dropped when the pen lifts.
 */
function withPrediction(points: number[], times: number[], ms: number): number[] {
  const n = times.length
  if (ms <= 0 || n < 3) return points
  const last = n - 1
  let first = last
  while (first > 0 && times[last] - times[first - 1] <= 25) first--
  const dt = times[last] - times[first]
  if (first === last || dt <= 0) return points
  const vx = (points[last * 3] - points[first * 3]) / dt
  const vy = (points[last * 3 + 1] - points[first * 3 + 1]) / dt
  let dx = vx * ms
  let dy = vy * ms
  // never guess far: a sudden turn would draw a visible spike
  const len = Math.hypot(dx, dy)
  const max = 20
  if (len > max) {
    dx = (dx / len) * max
    dy = (dy / len) * max
  }
  if (len < 0.5) return points
  return [...points, points[last * 3] + dx, points[last * 3 + 1] + dy, points[last * 3 + 2]]
}

function isTextInput(el: Element | null) {
  return !!el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT' || (el as HTMLElement).isContentEditable)
}

export default function Canvas(props: Props) {
  const { pageId, tool, ink, apiRef } = props
  const page = openPage(pageId)

  const rootRef = useRef<HTMLDivElement>(null)
  const livePathRef = useRef<SVGPathElement>(null)
  const [elements, setElements] = useState<CanvasElement[]>([])
  const elementsRef = useRef(elements)
  elementsRef.current = elements

  const [vp, setVpState] = useState<Viewport>(() => loadViewport(pageId))
  const vpRef = useRef(vp)
  const setVp = useCallback((v: Viewport) => {
    vpRef.current = v
    setVpState(v)
  }, [])

  const [selection, setSelectionState] = useState<Set<string>>(new Set())
  const selectionRef = useRef(selection)
  const setSelection = useCallback((s: Set<string>) => {
    selectionRef.current = s
    setSelectionState(s)
  }, [])

  const [drag, setDrag] = useState<{ dx: number; dy: number } | null>(null)
  const [resize, setResize] = useState<{ id: string; w: number; h: number } | null>(null)
  const [band, setBand] = useState<Rect | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)

  const gesture = useRef<Gesture | null>(null)
  const touches = useRef(new Map<number, { x: number; y: number }>())
  const penDown = useRef(false)
  const spaceHeld = useRef(false)
  const textHeights = useRef(new Map<string, number>())
  const clearLiveAfterRender = useRef(false)
  const liveFrame = useRef(0)
  const propsRef = useRef(props)
  propsRef.current = props
  const lastFingerTap = useRef<{ t: number; x: number; y: number } | null>(null)
  const toolBeforeEraser = useRef<Tool>('pen')
  const [toast, setToast] = useState<{ text: string; key: number } | null>(null)
  const [pasteSheet, setPasteSheet] = useState(false)
  const [focusedText, setFocusedText] = useState<string | null>(null)
  /** last text box that had focus, and when it lost it (tapping a toolbar button may blur it on iPad) */
  const lastText = useRef<{ id: string; blurredAt: number } | null>(null)
  const blurTimer = useRef(0)

  useEffect(() => {
    if (!toast) return
    const t = setTimeout(() => setToast(null), 900)
    return () => clearTimeout(t)
  }, [toast])

  /**
   * Safari does not expose the Apple Pencil double-tap to web pages, so a quick
   * double-tap with a finger toggles pen ⇄ eraser instead.
   */
  const onFingerTap = (x: number, y: number) => {
    const now = performance.now()
    const prev = lastFingerTap.current
    if (!prev || now - prev.t > 350 || Math.hypot(x - prev.x, y - prev.y) > 40) {
      lastFingerTap.current = { t: now, x, y }
      return
    }
    lastFingerTap.current = null
    const current = propsRef.current.tool
    if (current === 'eraser') {
      const back = toolBeforeEraser.current
      propsRef.current.onToolChange(back)
      setToast({ text: back === 'highlighter' ? 'Highlighter' : 'Pen', key: now })
    } else {
      toolBeforeEraser.current = current
      propsRef.current.onToolChange('eraser')
      setToast({ text: 'Eraser', key: now })
    }
  }

  // ---------- subscribe to the page document ----------
  useEffect(() => {
    let alive = true
    const update = () => {
      if (!alive) return
      setElements([...page.elements.values()].sort((a, b) => a.z - b.z))
    }
    page.elements.observe(update)
    update()
    page.ready.then(update)
    setSelection(new Set())
    setVp(loadViewport(pageId))
    return () => {
      alive = false
      page.elements.unobserve(update)
    }
  }, [page, pageId, setSelection, setVp])

  // The new stroke is now drawn by React, so hide the live preview without a flicker.
  useLayoutEffect(() => {
    if (clearLiveAfterRender.current) {
      clearLiveAfterRender.current = false
      livePathRef.current?.setAttribute('d', '')
    }
  }, [elements])

  // Drop selected ids that no longer exist (after undo, erase, delete…)
  useEffect(() => {
    const ids = new Set(elements.map((e) => e.id))
    const sel = selectionRef.current
    if ([...sel].some((id) => !ids.has(id))) setSelection(new Set([...sel].filter((id) => ids.has(id))))
  }, [elements, setSelection])

  useEffect(() => {
    const textSelected = elements.some((el) => el.type === 'text' && selection.has(el.id))
    props.onContextChange({ selectionCount: selection.size, textActive: !!focusedText || textSelected })
  }, [selection, focusedText, elements, props.onContextChange])
  useEffect(() => props.onZoomChange(vp.scale), [vp.scale, props.onZoomChange])

  // Remember where each page was scrolled to.
  useEffect(() => {
    const t = setTimeout(() => localStorage.setItem(vpKey(pageId), JSON.stringify(vp)), 300)
    return () => clearTimeout(t)
  }, [vp, pageId])

  // Leaving the select tool clears the selection.
  useEffect(() => {
    if (tool !== 'select') setSelection(new Set())
  }, [tool, setSelection])

  // ---------- coordinate helpers ----------
  const toScreen = (e: { clientX: number; clientY: number }) => {
    const r = rootRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }
  const toWorld = (sx: number, sy: number) => {
    const v = vpRef.current
    return { x: (sx - v.x) / v.scale, y: (sy - v.y) / v.scale }
  }
  const viewportCenterWorld = () => {
    const r = rootRef.current!.getBoundingClientRect()
    return toWorld(r.width / 2, r.height / 2)
  }
  const zoomAround = (sx: number, sy: number, newScale: number) => {
    const v = vpRef.current
    const s = clampScale(newScale)
    const wx = (sx - v.x) / v.scale
    const wy = (sy - v.y) / v.scale
    setVp({ scale: s, x: sx - wx * s, y: sy - wy * s })
  }

  // ---------- editing operations ----------
  /** One undoable step. */
  const transact = (fn: () => void) => {
    page.undo.stopCapturing()
    page.doc.transact(fn, LOCAL)
  }
  const nextZ = () => Date.now() + Math.random()

  const deleteIds = (ids: Iterable<string>) =>
    transact(() => {
      for (const id of ids) page.elements.delete(id)
    })

  const createText = (wx: number, wy: number, text = '') => {
    const { textColor, textSize } = propsRef.current.ink
    const el: TextElement = {
      id: nanoid(12),
      type: 'text',
      z: nextZ(),
      x: wx,
      y: wy - textSize * 0.8,
      w: 360,
      text,
      fontSize: textSize,
      color: textColor,
    }
    transact(() => page.elements.set(el.id, el))
    if (!text) setEditingId(el.id)
    return el
  }

  const insertImages = async (files: Blob[], at?: { x: number; y: number }) => {
    const center = at ?? viewportCenterWorld()
    const rootW = rootRef.current!.clientWidth
    const added: string[] = []
    let offset = 0
    for (const file of files) {
      if (!file.type.startsWith('image/')) continue
      try {
        const img = await storeImage(file)
        const maxW = (rootW * 0.6) / vpRef.current.scale
        const w = Math.min(img.width, maxW)
        const h = (w * img.height) / img.width
        const el: ImageElement = {
          id: nanoid(12),
          type: 'image',
          z: nextZ(),
          x: center.x - w / 2 + offset,
          y: center.y - h / 2 + offset,
          w,
          h,
          imageId: img.id,
        }
        transact(() => page.elements.set(el.id, el))
        added.push(el.id)
        offset += 24 / vpRef.current.scale
      } catch (err) {
        console.error('Could not add image', err)
        alert('Sorry, that image could not be added.')
      }
    }
    if (added.length) {
      propsRef.current.onToolChange('select')
      setSelection(new Set(added))
    }
  }

  /** Handles whatever was pasted: images first (a copied web image also carries its URL as text). */
  const handlePasteData = (data: DataTransfer): boolean => {
    const files: File[] = []
    for (const item of data.items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (!files.length) files.push(...[...data.files].filter((f) => f.type.startsWith('image/')))
    if (files.length) {
      void insertImages(files)
      return true
    }
    const text = data.getData('text/plain')
    if (text.trim()) {
      const c = viewportCenterWorld()
      createText(c.x - 180, c.y, text)
      return true
    }
    return false
  }

  const pasteFromClipboard = async () => {
    // Reading the clipboard from a button needs https. Over plain http (or if the
    // browser refuses) show a box the user can paste into with the system Paste menu.
    if (!window.isSecureContext || !navigator.clipboard?.read) {
      setPasteSheet(true)
      return
    }
    try {
      const items = await navigator.clipboard.read()
      const images: Blob[] = []
      let text = ''
      for (const item of items) {
        const imgType = item.types.find((t) => t.startsWith('image/'))
        if (imgType) images.push(await item.getType(imgType))
        else if (item.types.includes('text/plain')) text += await (await item.getType('text/plain')).text()
      }
      if (images.length) await insertImages(images)
      else if (text.trim()) {
        const c = viewportCenterWorld()
        createText(c.x - 180, c.y, text)
      } else alert('The clipboard is empty.')
    } catch (err) {
      console.warn(err)
      setPasteSheet(true)
    }
  }

  const styleText = (patch: { color?: string; fontSize?: number }) => {
    const recent = lastText.current && performance.now() - lastText.current.blurredAt < 1500 ? lastText.current.id : null
    const target = focusedText ?? recent
    const ids = target ? [target] : [...selectionRef.current]
    transact(() => {
      for (const id of ids) {
        const el = page.elements.get(id)
        if (el?.type === 'text') page.elements.set(id, { ...el, ...patch })
      }
    })
    // keep typing in the box after picking a colour
    if (target && document.activeElement?.tagName !== 'TEXTAREA') {
      rootRef.current?.querySelector<HTMLTextAreaElement>(`.el-text[data-id="${target}"] textarea`)?.focus({ preventScroll: true })
    }
  }

  const commitDrag = (dx: number, dy: number) => {
    if (!dx && !dy) return
    transact(() => {
      for (const id of selectionRef.current) {
        const el = page.elements.get(id)
        if (!el) continue
        if (el.type === 'stroke') page.elements.set(id, { ...el, dx: el.dx + dx, dy: el.dy + dy })
        else page.elements.set(id, { ...el, x: el.x + dx, y: el.y + dy })
      }
    })
  }

  const eraseAt = (wx: number, wy: number) => {
    const r = 8 / vpRef.current.scale
    const hits = elementsRef.current.filter((el) => el.type === 'stroke' && strokeHit(el, wx, wy, r)).map((el) => el.id)
    // no stopCapturing here: everything erased in one drag is a single undo step
    if (hits.length)
      page.doc.transact(() => {
        for (const id of hits) page.elements.delete(id)
      }, LOCAL)
  }

  const hitTest = (wx: number, wy: number): CanvasElement | null => {
    const els = elementsRef.current
    const tol = 6 / vpRef.current.scale
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i]
      if (el.type === 'stroke' && strokeHit(el, wx, wy, tol)) return el
    }
    for (const type of ['text', 'image'] as const) {
      for (let i = els.length - 1; i >= 0; i--) {
        const el = els[i]
        if (el.type === type && pointInRect(wx, wy, elementBounds(el, textHeights.current))) return el
      }
    }
    return null
  }

  apiRef.current = {
    undo: () => page.undo.undo(),
    redo: () => page.undo.redo(),
    insertImages: (files) => void insertImages(files),
    pasteFromClipboard: () => void pasteFromClipboard(),
    zoomBy: (f) => {
      const r = rootRef.current!.getBoundingClientRect()
      zoomAround(r.width / 2, r.height / 2, vpRef.current.scale * f)
    },
    resetZoom: () => {
      const r = rootRef.current!.getBoundingClientRect()
      zoomAround(r.width / 2, r.height / 2, 1)
    },
    deleteSelection: () => deleteIds(selectionRef.current),
    styleText,
  }

  // ---------- live stroke preview ----------
  const renderLive = () => {
    liveFrame.current = 0
    const g = gesture.current
    const path = livePathRef.current
    if (!path || !g || g.kind !== 'draw') return
    path.setAttribute('d', strokePath(withPrediction(g.points, g.times, PREDICT_MS), strokeOptions(g, false)))
  }
  const scheduleLive = () => {
    if (!liveFrame.current) liveFrame.current = requestAnimationFrame(renderLive)
  }
  const cancelDraw = () => {
    if (gesture.current?.kind === 'draw') {
      gesture.current = null
      livePathRef.current?.setAttribute('d', '')
    }
  }

  // ---------- pointer input ----------
  const onPointerDown = (e: React.PointerEvent) => {
    const target = e.target as HTMLElement
    const editingText = target.closest('[data-textedit]') && (tool === 'select' || tool === 'text')
    if (editingText) return // let the textarea handle it

    const active = document.activeElement
    if (isTextInput(active) && active !== target) (active as HTMLElement).blur()
    e.preventDefault()

    const s = toScreen(e)

    if (e.pointerType === 'pen') {
      if (!props.penDetected) props.onPenDetected()
      penDown.current = true
      // A palm touched down first: stop whatever it started.
      const g = gesture.current
      if (g && (g.kind === 'pinch' || (g.kind === 'pan' && touches.current.has(g.pointerId)))) gesture.current = null
      touches.current.clear()
    }

    if (e.pointerType === 'touch') {
      if (penDown.current) return // palm while writing
      touches.current.set(e.pointerId, s)
      if (touches.current.size >= 2) {
        cancelDraw()
        const [a, b] = [...touches.current.entries()]
        const w = toWorld((a[1].x + b[1].x) / 2, (a[1].y + b[1].y) / 2)
        gesture.current = {
          kind: 'pinch',
          ids: [a[0], b[0]],
          startDist: Math.hypot(a[1].x - b[1].x, a[1].y - b[1].y) || 1,
          startScale: vpRef.current.scale,
          worldX: w.x,
          worldY: w.y,
        }
        setDrag(null)
        setBand(null)
        return
      }
    }

    if (gesture.current) return // already busy with another pointer
    try {
      rootRef.current!.setPointerCapture(e.pointerId)
    } catch {
      /* pointer already gone; the gesture still works without capture */
    }
    const w = toWorld(s.x, s.y)
    const startPan = (tap?: 'clear' | 'text' | 'eraser-toggle') => {
      gesture.current = { kind: 'pan', pointerId: e.pointerId, lastX: s.x, lastY: s.y, startX: s.x, startY: s.y, moved: false, tap }
    }

    // Move / resize handles
    const handle = target.closest<HTMLElement>('[data-handle]')
    if (handle && (tool === 'select' || tool === 'text')) {
      const id = handle.dataset.id!
      const el = page.elements.get(id)
      if (!el) return
      if (handle.dataset.handle === 'move') {
        if (!selectionRef.current.has(id)) setSelection(new Set([id]))
        if (tool !== 'select') props.onToolChange('select')
        gesture.current = { kind: 'move', pointerId: e.pointerId, startX: w.x, startY: w.y }
      } else if (el.type === 'image' || el.type === 'text') {
        gesture.current = {
          kind: 'resize',
          pointerId: e.pointerId,
          id,
          startX: w.x,
          startW: el.w,
          ratio: el.type === 'image' ? el.h / el.w : 0,
          isImage: el.type === 'image',
        }
      }
      return
    }

    if (e.button === 1 || spaceHeld.current) return startPan()

    const touch = e.pointerType === 'touch'
    const fingerPans = touch && props.penDetected && !ink.fingerDraw

    switch (tool) {
      case 'pen':
      case 'highlighter': {
        if (fingerPans) return startPan('eraser-toggle')
        const hl = tool === 'highlighter'
        const isPen = e.pointerType === 'pen'
        gesture.current = {
          kind: 'draw',
          pointerId: e.pointerId,
          points: [round1(w.x), round1(w.y), isPen ? e.pressure || 0.5 : 0.5],
          times: [e.timeStamp],
          firstPressureMissing: isPen && !e.pressure,
          color: hl ? ink.hlColor : ink.penColor,
          size: hl ? ink.hlSize : ink.penSize,
          highlighter: hl,
          pressure: isPen && !hl,
        }
        const path = livePathRef.current!
        path.style.fill = inkColor(hl ? ink.hlColor : ink.penColor)
        path.setAttribute('opacity', hl ? '0.35' : '1')
        scheduleLive()
        return
      }
      case 'eraser':
        if (fingerPans) return startPan('eraser-toggle')
        gesture.current = { kind: 'erase', pointerId: e.pointerId }
        page.undo.stopCapturing()
        eraseAt(w.x, w.y)
        return
      case 'text':
        if (touch) return startPan('text')
        createText(w.x, w.y)
        return
      case 'select': {
        const hit = hitTest(w.x, w.y)
        if (hit) {
          const sel = selectionRef.current
          if (e.shiftKey || e.metaKey || e.ctrlKey) {
            const next = new Set(sel)
            if (next.has(hit.id)) next.delete(hit.id)
            else next.add(hit.id)
            setSelection(next)
          } else if (!sel.has(hit.id)) setSelection(new Set([hit.id]))
          gesture.current = { kind: 'move', pointerId: e.pointerId, startX: w.x, startY: w.y }
          return
        }
        if (touch) return startPan('clear')
        if (!e.shiftKey) setSelection(new Set())
        gesture.current = { kind: 'band', pointerId: e.pointerId, sx: s.x, sy: s.y }
        return
      }
    }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const s = toScreen(e)
    if (e.pointerType === 'touch' && touches.current.has(e.pointerId)) touches.current.set(e.pointerId, s)
    const g = gesture.current
    if (!g) return

    if (g.kind === 'pinch') {
      const a = touches.current.get(g.ids[0])
      const b = touches.current.get(g.ids[1])
      if (!a || !b) return
      const scale = clampScale((g.startScale * Math.hypot(a.x - b.x, a.y - b.y)) / g.startDist)
      const cx = (a.x + b.x) / 2
      const cy = (a.y + b.y) / 2
      setVp({ scale, x: cx - g.worldX * scale, y: cy - g.worldY * scale })
      return
    }
    if (e.pointerId !== g.pointerId) return

    switch (g.kind) {
      case 'draw': {
        const evs = e.nativeEvent.getCoalescedEvents?.() ?? []
        for (const ev of evs.length ? evs : [e.nativeEvent]) {
          const p = toScreen(ev)
          const w = toWorld(p.x, p.y)
          const n = g.points.length
          const x = round1(w.x)
          const y = round1(w.y)
          const pressure = g.pressure ? Math.round((ev.pressure || 0.5) * 100) / 100 : 0.5
          if (g.firstPressureMissing && ev.pressure > 0) {
            // iPad often reports 0 at touch-down: keep the real first reading, not the stand-in
            g.points[2] = pressure
            g.firstPressureMissing = false
          }
          if (x === g.points[n - 3] && y === g.points[n - 2]) continue
          g.points.push(x, y, pressure)
          g.times.push(ev.timeStamp)
        }
        scheduleLive()
        return
      }
      case 'erase': {
        const w = toWorld(s.x, s.y)
        eraseAt(w.x, w.y)
        return
      }
      case 'pan': {
        const v = vpRef.current
        setVp({ ...v, x: v.x + s.x - g.lastX, y: v.y + s.y - g.lastY })
        g.lastX = s.x
        g.lastY = s.y
        if (Math.hypot(s.x - g.startX, s.y - g.startY) > 6) g.moved = true
        return
      }
      case 'move': {
        const w = toWorld(s.x, s.y)
        setDrag({ dx: w.x - g.startX, dy: w.y - g.startY })
        return
      }
      case 'resize': {
        const w = toWorld(s.x, s.y)
        const newW = Math.max(g.isImage ? 24 : 80, g.startW + w.x - g.startX)
        setResize({ id: g.id, w: newW, h: newW * g.ratio })
        return
      }
      case 'band':
        setBand(rectFromPoints(g.sx, g.sy, s.x, s.y))
        return
    }
  }

  const onPointerUp = (e: React.PointerEvent) => {
    const cancelled = e.type === 'pointercancel'
    if (e.pointerType === 'touch') touches.current.delete(e.pointerId)
    if (e.pointerType === 'pen') penDown.current = false
    const g = gesture.current
    if (!g) return
    if (g.kind === 'pinch') {
      if (touches.current.size < 2) gesture.current = null
      return
    }
    if (e.pointerId !== g.pointerId) return
    gesture.current = null

    switch (g.kind) {
      case 'draw': {
        if (liveFrame.current) cancelAnimationFrame(liveFrame.current)
        liveFrame.current = 0
        if (cancelled) {
          livePathRef.current?.setAttribute('d', '')
          return
        }
        const el: StrokeElement = {
          id: nanoid(12),
          type: 'stroke',
          z: nextZ(),
          points: g.points,
          color: g.color,
          size: g.size,
          highlighter: g.highlighter,
          pressure: g.pressure,
          dx: 0,
          dy: 0,
          bbox: computeBBox(g.points),
        }
        clearLiveAfterRender.current = true
        transact(() => page.elements.set(el.id, el))
        return
      }
      case 'move': {
        const s = toScreen(e)
        const w = toWorld(s.x, s.y)
        setDrag(null)
        if (!cancelled) commitDrag(w.x - g.startX, w.y - g.startY)
        return
      }
      case 'resize': {
        setResize(null)
        const s = toScreen(e)
        const w = toWorld(s.x, s.y)
        const el = page.elements.get(g.id)
        if (cancelled || !el || el.type === 'stroke') return
        const newW = Math.max(g.isImage ? 24 : 80, g.startW + w.x - g.startX)
        transact(() => page.elements.set(g.id, el.type === 'image' ? { ...el, w: newW, h: newW * g.ratio } : { ...el, w: newW }))
        return
      }
      case 'band': {
        setBand(null)
        const s = toScreen(e)
        const r = rectFromPoints(g.sx, g.sy, s.x, s.y)
        if (r.w < 3 && r.h < 3) return
        const a = toWorld(r.x, r.y)
        const wr = { x: a.x, y: a.y, w: r.w / vpRef.current.scale, h: r.h / vpRef.current.scale }
        const picked = elementsRef.current.filter((el) => elementInRect(el, wr, textHeights.current)).map((el) => el.id)
        setSelection(new Set([...(e.shiftKey ? selectionRef.current : []), ...picked]))
        return
      }
      case 'pan':
        if (!g.moved && !cancelled) {
          if (g.tap === 'eraser-toggle') onFingerTap(g.startX, g.startY)
          if (g.tap === 'clear') setSelection(new Set())
          if (g.tap === 'text') {
            const w = toWorld(g.startX, g.startY)
            createText(w.x, w.y)
          }
        }
        return
    }
  }

  // ---------- wheel, touch defaults, keyboard, paste ----------
  useEffect(() => {
    const root = rootRef.current!
    // Text boxes grow to fit their text, so the wheel always scrolls or zooms the canvas.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const r = root.getBoundingClientRect()
      if (e.ctrlKey || e.metaKey) {
        zoomAround(e.clientX - r.left, e.clientY - r.top, vpRef.current.scale * Math.exp(-e.deltaY * 0.01))
      } else {
        const v = vpRef.current
        const k = e.deltaMode === 1 ? 16 : 1
        setVp({ ...v, x: v.x - e.deltaX * k, y: v.y - e.deltaY * k })
      }
    }
    // iOS: stop page scrolling, text selection loupes and Scribble on the canvas.
    const stopTouch = (e: TouchEvent) => {
      if (!(e.target as Element).closest('[data-textedit]')) e.preventDefault()
    }
    const stopGesture = (e: Event) => e.preventDefault()
    root.addEventListener('wheel', onWheel, { passive: false })
    root.addEventListener('touchstart', stopTouch, { passive: false })
    root.addEventListener('touchmove', stopTouch, { passive: false })
    root.addEventListener('gesturestart', stopGesture)
    return () => {
      root.removeEventListener('wheel', onWheel)
      root.removeEventListener('touchstart', stopTouch)
      root.removeEventListener('touchmove', stopTouch)
      root.removeEventListener('gesturestart', stopGesture)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (isTextInput(document.activeElement)) {
        if (e.key === 'Escape') (document.activeElement as HTMLElement).blur()
        return
      }
      const mod = e.ctrlKey || e.metaKey
      const k = e.key.toLowerCase()
      if (e.key === ' ') {
        spaceHeld.current = true
        e.preventDefault()
      } else if (mod && k === 'z') {
        e.preventDefault()
        if (e.shiftKey) page.undo.redo()
        else page.undo.undo()
      } else if (mod && k === 'y') {
        e.preventDefault()
        page.undo.redo()
      } else if (mod && k === 'a') {
        e.preventDefault()
        propsRef.current.onToolChange('select')
        setSelection(new Set(elementsRef.current.map((el) => el.id)))
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectionRef.current.size) {
          e.preventDefault()
          deleteIds(selectionRef.current)
        }
      } else if (e.key === 'Escape') {
        setSelection(new Set())
      } else if (!mod && !e.altKey) {
        const tools: Record<string, Tool> = { v: 'select', p: 'pen', h: 'highlighter', e: 'eraser', t: 'text' }
        if (tools[k]) propsRef.current.onToolChange(tools[k])
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') spaceHeld.current = false
    }
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData
      if (!data || e.defaultPrevented) return
      // Inside a text box, plain text pastes into the box as usual.
      const hasImage = [...data.items].some((i) => i.kind === 'file' && i.type.startsWith('image/'))
      if (!hasImage && isTextInput(document.activeElement)) return
      if (handlePasteData(data)) e.preventDefault()
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('paste', onPaste)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page])

  // ---------- text box callbacks (stable so TextBox can stay memoised) ----------
  const onText = useCallback(
    (id: string, text: string) => {
      const el = page.elements.get(id)
      if (el?.type === 'text') page.doc.transact(() => page.elements.set(id, { ...el, text }), TYPING)
    },
    [page],
  )
  const onTextBlur = useCallback(
    (id: string, text: string) => {
      setEditingId((cur) => (cur === id ? null : cur))
      lastText.current = { id, blurredAt: performance.now() }
      // Delay hiding the text toolbar so a tap on a colour still lands.
      clearTimeout(blurTimer.current)
      blurTimer.current = window.setTimeout(() => setFocusedText((cur) => (cur === id ? null : cur)), 300)
      if (!text.trim() && page.elements.has(id)) page.doc.transact(() => page.elements.delete(id), TYPING)
    },
    [page],
  )
  const onTextFocus = useCallback(
    (id: string) => {
      clearTimeout(blurTimer.current)
      setFocusedText(id)
      setSelection(new Set())
    },
    [setSelection],
  )
  const onHeight = useCallback((id: string, h: number) => {
    textHeights.current.set(id, h)
  }, [])

  // ---------- rendering ----------
  const offsetFor = (id: string) => (drag && selection.has(id) ? drag : null)
  const images = elements.filter((e): e is ImageElement => e.type === 'image')
  const texts = elements.filter((e): e is TextElement => e.type === 'text')
  const strokes = elements.filter((e): e is StrokeElement => e.type === 'stroke')
  const textEditable = tool === 'select' || tool === 'text'
  const dot = 24 * vp.scale
  const single = selection.size === 1 ? elements.find((e) => selection.has(e.id)) : undefined

  return (
    <>
    <div
      ref={rootRef}
      className={`canvas tool-${tool}`}
      style={{
        backgroundSize: `${dot}px ${dot}px`,
        backgroundPosition: `${vp.x}px ${vp.y}px`,
        backgroundImage: vp.scale < 0.35 ? 'none' : undefined,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => e.preventDefault()}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault()
        const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
        if (!files.length) return
        const s = toScreen(e)
        void insertImages(files, toWorld(s.x, s.y))
      }}
    >
      <div
        className="world"
        style={{
          transform: `translate(${vp.x}px, ${vp.y}px) scale(${vp.scale})`,
          ['--inv' as string]: 1 / vp.scale,
        }}
      >
        {images.map((el) => {
          const o = offsetFor(el.id)
          const r = resize?.id === el.id ? resize : null
          return <ImageView key={el.id} el={el} ox={o?.dx ?? 0} oy={o?.dy ?? 0} w={r?.w} h={r?.h} />
        })}
        {texts.map((el) => {
          const o = offsetFor(el.id)
          return (
            <TextBox
              key={el.id}
              el={el}
              ox={o?.dx ?? 0}
              oy={o?.dy ?? 0}
              w={resize?.id === el.id ? resize.w : undefined}
              editable={textEditable}
              autoFocus={editingId === el.id}
              onText={onText}
              onBlur={onTextBlur}
              onFocus={onTextFocus}
              onHeight={onHeight}
            />
          )
        })}
        <svg className="ink" width="1" height="1">
          {strokes.map((el) => {
            const o = offsetFor(el.id)
            return <StrokePath key={el.id} el={el} ox={o?.dx} oy={o?.dy} />
          })}
          <path ref={livePathRef} />
        </svg>
        {elements
          .filter((el) => selection.has(el.id))
          .map((el) => {
            let b = elementBounds(el, textHeights.current)
            const o = offsetFor(el.id)
            if (o) b = { ...b, x: b.x + o.dx, y: b.y + o.dy }
            if (resize?.id === el.id) b = { ...b, w: resize.w, h: el.type === 'image' ? resize.h : b.h }
            return <div key={el.id} className="sel-box" style={{ left: b.x, top: b.y, width: b.w, height: b.h }} />
          })}
        {single && single.type !== 'stroke' && !drag && (() => {
          let b = elementBounds(single, textHeights.current)
          if (resize?.id === single.id) b = { ...b, w: resize.w, h: single.type === 'image' ? resize.h : b.h }
          return <div className="resize-handle" data-handle="resize" data-id={single.id} style={{ left: b.x + b.w, top: b.y + b.h }} />
        })()}
      </div>
      {band && <div className="band" style={{ left: band.x, top: band.y, width: band.w, height: band.h }} />}
      {toast && (
        <div key={toast.key} className="toast">
          {toast.text}
        </div>
      )}
      {elements.length === 0 && (
        <div className="empty-hint">
          {props.penDetected ? 'Write with your pen, ' : 'Pick the pen to draw, '}
          the <b>T</b> tool to type, or paste an image.
        </div>
      )}
    </div>
    {pasteSheet && <PasteSheet onData={handlePasteData} onImages={(b) => void insertImages(b)} onClose={() => setPasteSheet(false)} />}
    </>
  )
}

/**
 * A box to paste into with the system Paste menu (long-press → Paste on iPad/iPhone,
 * or the paste key above the iPad keyboard). Needed where a page may not read the
 * clipboard directly, e.g. Safari over plain http.
 */
function PasteSheet(props: { onData(d: DataTransfer): boolean; onImages(b: Blob[]): void; onClose(): void }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState('')
  useEffect(() => {
    boxRef.current?.focus()
  }, [])
  return (
    <div className="paste-sheet" onClick={props.onClose}>
      <div className="paste-card" onClick={(e) => e.stopPropagation()}>
        <div className="paste-title">Paste here</div>
        <div
          ref={boxRef}
          className="paste-target"
          contentEditable
          suppressContentEditableWarning
          data-textedit
          onPaste={(e) => {
            if (props.onData(e.clipboardData)) {
              e.preventDefault()
              props.onClose()
              return
            }
            // Some browsers only paste the picture into the box; pick it up from there.
            setStatus('Reading…')
            setTimeout(async () => {
              const img = boxRef.current?.querySelector('img')
              try {
                if (!img?.src) throw new Error('no image')
                const blob = await (await fetch(img.src)).blob()
                props.onImages([blob])
                props.onClose()
              } catch {
                if (boxRef.current) boxRef.current.innerHTML = ''
                setStatus('Could not read that. Try the picture button instead.')
              }
            }, 60)
          }}
          onInput={() => {
            // typing is not useful here; keep the box clean
            if (boxRef.current && !boxRef.current.querySelector('img')) boxRef.current.textContent = ''
          }}
        />
        <p className="paste-help">
          Tap the box above and choose <b>Paste</b>
          <br />
          (or press <b>Ctrl+V</b> / <b>⌘V</b>).
        </p>
        {status && <p className="paste-status">{status}</p>}
        <button className="paste-cancel" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function loadViewport(pageId: string): Viewport {
  try {
    const v = JSON.parse(localStorage.getItem(vpKey(pageId)) ?? '')
    if (typeof v?.x === 'number' && typeof v?.scale === 'number') return v
  } catch {
    /* first visit */
  }
  return { x: 40, y: 40, scale: 1 }
}
