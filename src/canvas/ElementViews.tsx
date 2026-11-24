import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ImageElement, StrokeElement, TextElement } from '../store/types'
import { imageUrl } from '../store/images'
import { strokeOptions, strokePath } from './ink'
import { inkColor } from '../theme'
import type { Scale } from './geometry'

// ---------- ink ----------

export const StrokePath = memo(function StrokePath({ el, ox = 0, oy = 0, scale }: { el: StrokeElement; ox?: number; oy?: number; scale?: Scale }) {
  const d = useMemo(() => strokePath(el.points, strokeOptions(el)), [el.points, el.size, el.highlighter, el.pressure])
  const tx = el.dx + ox
  const ty = el.dy + oy
  // while being resized: shown scaled (line width included) until the new size is saved
  const transform = scale
    ? `translate(${scale.ax} ${scale.ay}) scale(${scale.k}) translate(${tx - scale.ax} ${ty - scale.ay})`
    : tx || ty
      ? `translate(${tx} ${ty})`
      : undefined
  return <path d={d} style={{ fill: inkColor(el.color) }} opacity={el.highlighter ? 0.35 : 1} transform={transform} />
})

// ---------- images ----------

export const ImageView = memo(function ImageView(props: {
  el: ImageElement
  ox: number
  oy: number
  w?: number
  h?: number
}) {
  const { el, ox, oy } = props
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    let timer = 0
    const load = () =>
      imageUrl(el.imageId).then((u) => {
        if (!alive) return
        setSrc(u)
        // picture made on another device and not downloaded yet: try again shortly
        if (!u) timer = window.setTimeout(load, 8000)
      })
    void load()
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [el.imageId])
  return (
    <div
      className="el-image"
      style={{ left: el.x + ox, top: el.y + oy, width: props.w ?? el.w, height: props.h ?? el.h }}
    >
      {src ? <img src={src} draggable={false} alt="" /> : <div className="img-missing">image not available on this device yet</div>}
    </div>
  )
})

// ---------- text boxes ----------

export const TextBox = memo(function TextBox(props: {
  el: TextElement
  ox: number
  oy: number
  w?: number
  /** shown this many times bigger while a selection is being resized */
  scale?: number
  editable: boolean
  autoFocus: boolean
  onText: (id: string, text: string) => void
  onBlur: (id: string, text: string) => void
  onFocus: (id: string) => void
  onHeight: (id: string, h: number) => void
}) {
  const { el, ox, oy, editable, autoFocus, onText, onBlur, onFocus, onHeight } = props
  const ref = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState(el.text)
  const focused = useRef(false)

  // Take changes from elsewhere (undo, another device) unless the user is typing here.
  useEffect(() => {
    if (!focused.current) setText(el.text)
  }, [el.text])

  useLayoutEffect(() => {
    const ta = ref.current!
    ta.style.height = '0px'
    ta.style.height = ta.scrollHeight + 'px'
    onHeight(el.id, ta.scrollHeight + 10)
  }, [text, props.w, el.w, el.fontSize, el.id, onHeight])

  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true })
  }, [autoFocus])

  return (
    <div
      className={'el-text' + (editable ? ' editable' : '')}
      data-id={el.id}
      style={{
        left: el.x + ox,
        top: el.y + oy,
        width: props.w ?? el.w,
        ...(props.scale ? { transform: `scale(${props.scale})`, transformOrigin: '0 0' } : null),
      }}
    >
      <div className="tb-handle" data-handle="move" data-id={el.id} title="Drag to move" />
      <textarea
        ref={ref}
        data-textedit
        value={text}
        spellCheck
        placeholder="Type here…"
        style={{ fontSize: el.fontSize, color: el.color ? inkColor(el.color) : undefined }}
        onFocus={() => {
          focused.current = true
          onFocus(el.id)
        }}
        onChange={(e) => {
          setText(e.target.value)
          onText(el.id, e.target.value)
        }}
        onBlur={(e) => {
          focused.current = false
          onBlur(el.id, e.target.value)
        }}
      />
    </div>
  )
})
