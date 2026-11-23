import { useRef } from 'react'
import type { Tool } from '../store/types'
import type { CanvasApi, InkSettings } from '../canvas/Canvas'
import { Icons } from './icons'
import { INK, inkColor } from '../theme'
import type { Paper } from '../paper'
import PaperMenu from './PaperMenu'

export const PEN_COLORS = [INK, '#2563eb', '#dc2626', '#16a34a', '#7c3aed', '#ea580c']
export const HL_COLORS = ['#facc15', '#4ade80', '#38bdf8', '#f472b6', '#fb923c']
export const PEN_SIZES = [2, 4, 7]
export const HL_SIZES = [12, 20, 30]
export const TEXT_SIZES = [14, 18, 26]

/** Keeps the text box focused (and the iPad keyboard up) when a style button is tapped. */
const keepFocus = {
  onPointerDown: (e: React.PointerEvent) => e.preventDefault(),
  onMouseDown: (e: React.MouseEvent) => e.preventDefault(),
}

interface Props {
  tool: Tool
  onTool(t: Tool): void
  ink: InkSettings
  onInk(patch: Partial<InkSettings>): void
  api: React.RefObject<CanvasApi | null>
  zoom: number
  paper: Paper
  onPaper(p: Paper): void
  selectionCount: number
  textActive: boolean
  showFingerToggle: boolean
}

const TOOLS: { id: Tool; label: string; key: string }[] = [
  { id: 'select', label: 'Select & move', key: 'V' },
  { id: 'pen', label: 'Pen', key: 'P' },
  { id: 'highlighter', label: 'Highlighter', key: 'H' },
  { id: 'eraser', label: 'Eraser', key: 'E' },
  { id: 'text', label: 'Text', key: 'T' },
]

export default function Toolbar({ tool, onTool, ink, onInk, api, zoom, paper, onPaper, selectionCount, textActive, showFingerToggle }: Props) {
  const fileRef = useRef<HTMLInputElement>(null)
  const isHl = tool === 'highlighter'
  const showInk = tool === 'pen' || isHl
  const showText = tool === 'text' || (tool === 'select' && textActive)

  return (
    <div className="toolbar" role="toolbar">
      <div className="group">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className={'tbtn' + (tool === t.id ? ' active' : '')}
            title={`${t.label} (${t.key})`}
            aria-label={t.label}
            onClick={() => onTool(t.id)}
          >
            {Icons[t.id]}
          </button>
        ))}
      </div>

      {showInk && (
        <div className="group">
          {(isHl ? HL_COLORS : PEN_COLORS).map((c) => (
            <button
              key={c}
              className={'swatch' + ((isHl ? ink.hlColor : ink.penColor) === c ? ' active' : '')}
              style={{ ['--c' as string]: inkColor(c) }}
              aria-label={`Colour ${c}`}
              onClick={() => onInk(isHl ? { hlColor: c } : { penColor: c })}
            />
          ))}
          <span className="sep" />
          {(isHl ? HL_SIZES : PEN_SIZES).map((s, i) => (
            <button
              key={s}
              className={'size' + ((isHl ? ink.hlSize : ink.penSize) === s ? ' active' : '')}
              aria-label={['Thin', 'Medium', 'Thick'][i]}
              onClick={() => onInk(isHl ? { hlSize: s } : { penSize: s })}
            >
              <span style={{ width: 4 + i * 5, height: 4 + i * 5 }} />
            </button>
          ))}
        </div>
      )}

      {showText && (
        <div className="group" aria-label="Text style">
          {PEN_COLORS.map((c) => (
            <button
              key={c}
              {...keepFocus}
              className={'swatch' + (ink.textColor === c ? ' active' : '')}
              style={{ ['--c' as string]: inkColor(c) }}
              aria-label={`Text colour ${c}`}
              onClick={() => {
                onInk({ textColor: c })
                api.current?.styleText({ color: c })
              }}
            />
          ))}
          <span className="sep" />
          {TEXT_SIZES.map((s, i) => (
            <button
              key={s}
              {...keepFocus}
              className={'text-size' + (ink.textSize === s ? ' active' : '')}
              style={{ fontSize: 12 + i * 4 }}
              aria-label={['Small text', 'Medium text', 'Large text'][i]}
              onClick={() => {
                onInk({ textSize: s })
                api.current?.styleText({ fontSize: s })
              }}
            >
              A
            </button>
          ))}
        </div>
      )}

      {tool === 'select' && selectionCount > 0 && (
        <div className="group">
          <button className="tbtn" title="Delete selection (Del)" aria-label="Delete selection" onClick={() => api.current?.deleteSelection()}>
            {Icons.trash}
          </button>
        </div>
      )}

      <div className="group">
        <button className="tbtn" title="Insert picture" aria-label="Insert picture" onClick={() => fileRef.current?.click()}>
          {Icons.image}
        </button>
        <button className="tbtn" title="Paste (Ctrl/⌘+V)" aria-label="Paste" onClick={() => api.current?.pasteFromClipboard()}>
          {Icons.paste}
        </button>
        <PaperMenu paper={paper} onChange={onPaper} />
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.target.files ?? [])]
            e.target.value = ''
            if (files.length) api.current?.insertImages(files)
          }}
        />
      </div>

      <div className="group">
        <button className="tbtn" title="Undo (Ctrl/⌘+Z)" aria-label="Undo" onClick={() => api.current?.undo()}>
          {Icons.undo}
        </button>
        <button className="tbtn" title="Redo (Ctrl/⌘+Shift+Z)" aria-label="Redo" onClick={() => api.current?.redo()}>
          {Icons.redo}
        </button>
      </div>

      {showFingerToggle && (
        <div className="group">
          <button
            className={'tbtn' + (ink.fingerDraw ? ' active' : '')}
            title={ink.fingerDraw ? 'Finger draws (tap to make finger scroll)' : 'Finger scrolls (tap to draw with finger)'}
            aria-label="Draw with finger"
            onClick={() => onInk({ fingerDraw: !ink.fingerDraw })}
          >
            {Icons.finger}
          </button>
        </div>
      )}

      <div className="group zoom">
        <button className="tbtn" aria-label="Zoom out" onClick={() => api.current?.zoomBy(1 / 1.25)}>
          {Icons.minus}
        </button>
        <button className="zoom-label" title="Reset zoom" onClick={() => api.current?.resetZoom()}>
          {Math.round(zoom * 100)}%
        </button>
        <button className="tbtn" aria-label="Zoom in" onClick={() => api.current?.zoomBy(1.25)}>
          {Icons.plus}
        </button>
      </div>
    </div>
  )
}
