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

export interface LinkPart {
  text: string
  /** set for a web address: where it leads */
  href?: string
}

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'，。、；：！？「」『』（）【】]+/gi

/** Splits text into plain parts and web addresses (http://…, https://…, www.…). */
export function linkParts(text: string): LinkPart[] {
  const out: LinkPart[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    // punctuation right after an address belongs to the sentence, not the address
    for (;;) {
      const trimmed = url.replace(/[.,;:!?'"\]}>]+$/, '')
      // a closing bracket stays if the address opened one (e.g. Wikipedia links)
      const t2 = trimmed.endsWith(')') && (trimmed.match(/\(/g)?.length ?? 0) < (trimmed.match(/\)/g)?.length ?? 0) ? trimmed.slice(0, -1) : trimmed
      if (t2 === url) break
      url = t2
    }
    if (!url.includes('.') || /^www\.$/i.test(url)) continue
    const start = m.index
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: url, href: /^www\./i.test(url) ? `https://${url}` : url })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}

/** The web address the text position `pos` is in, if any. */
function linkAt(parts: LinkPart[], pos: number): string | null {
  let i = 0
  for (const p of parts) {
    if (p.href && pos >= i && pos <= i + p.text.length) return p.href
    i += p.text.length
  }
  return null
}

export function openLink(href: string) {
  window.open(href, '_blank', 'noopener,noreferrer')
}

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
  const parts = useMemo(() => linkParts(text), [text])
  const hasLinks = parts.some((p) => p.href)
  /** the address the cursor is in while typing: offered as a button to open it */
  const [caretLink, setCaretLink] = useState<string | null>(null)
  const blurTimer = useRef(0)
  const updateCaretLink = () => {
    const ta = ref.current
    if (!ta || !focused.current || !hasLinks) return setCaretLink(null)
    setCaretLink(linkAt(parts, ta.selectionStart) ?? (ta.selectionEnd !== ta.selectionStart ? linkAt(parts, ta.selectionEnd) : null))
  }
  useEffect(updateCaretLink, [parts])
  useEffect(() => () => clearTimeout(blurTimer.current), [])
  const color = el.color ? inkColor(el.color) : undefined

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
      className={'el-text' + (editable ? ' editable' : '') + (hasLinks ? ' has-links' : '')}
      data-id={el.id}
      style={{
        left: el.x + ox,
        top: el.y + oy,
        width: props.w ?? el.w,
        ...(props.scale ? { transform: `scale(${props.scale})`, transformOrigin: '0 0' } : null),
      }}
    >
      <div className="tb-handle" data-handle="move" data-id={el.id} title="Drag to move" />
      {caretLink && (
        <a
          className="tb-open"
          href={caretLink}
          target="_blank"
          rel="noopener noreferrer"
          data-textedit
          // keep the cursor in the text box
          onPointerDown={(e) => e.preventDefault()}
          onMouseDown={(e) => e.preventDefault()}
        >
          Open link ↗
        </a>
      )}
      <div className="tb-body">
        <textarea
          ref={ref}
          data-textedit
          value={text}
          spellCheck
          placeholder="Type here…"
          // with links the text is shown by the layer on top; the box keeps the cursor and selection
          style={{ fontSize: el.fontSize, color: hasLinks ? 'transparent' : color, caretColor: color }}
          onFocus={() => {
            clearTimeout(blurTimer.current)
            focused.current = true
            onFocus(el.id)
            updateCaretLink()
          }}
          onSelect={updateCaretLink}
          onChange={(e) => {
            setText(e.target.value)
            onText(el.id, e.target.value)
          }}
          onBlur={(e) => {
            focused.current = false
            onBlur(el.id, e.target.value)
            // a moment later, so a tap on "Open link" still lands
            blurTimer.current = window.setTimeout(() => setCaretLink(null), 300)
          }}
        />
        {hasLinks && (
          <div className="tb-links" aria-hidden style={{ fontSize: el.fontSize, color }}>
            {parts.map((p, i) =>
              p.href ? (
                <a key={i} href={p.href} tabIndex={-1}>
                  {p.text}
                </a>
              ) : (
                p.text
              ),
            )}
            {/* a final line break still takes a line, as in the text box */}
            {text.endsWith('\n') ? '​' : null}
          </div>
        )}
      </div>
    </div>
  )
})
