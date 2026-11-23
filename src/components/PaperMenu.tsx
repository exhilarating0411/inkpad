import { useState } from 'react'
import { PAPER_COLORS, PAPER_PATTERNS, paperCss, patternImage, type Paper } from '../paper'

const WIDTH = 292

/** Toolbar button that picks the colour and pattern (plain, dots, grid, lines) of the page. */
export default function PaperMenu({ paper, onChange }: { paper: Paper; onChange(p: Paper): void }) {
  const [at, setAt] = useState<{ x: number; y: number } | null>(null)

  const preview = (p: Paper, size: number) => ({
    backgroundColor: paperCss(p.color),
    backgroundImage: patternImage(p.pattern),
    backgroundSize: `${size}px ${size}px`,
    backgroundPosition: `${size / 2 - 1}px ${size / 2 - 1}px`,
  })

  return (
    <>
      <button
        className={'tbtn' + (at ? ' active' : '')}
        title="Paper"
        aria-label="Paper"
        onClick={(e) => {
          if (at) return setAt(null)
          const r = e.currentTarget.getBoundingClientRect()
          // the toolbar scrolls sideways, so the panel is placed on the screen, not inside it
          setAt({ x: Math.max(8, Math.min(r.left, window.innerWidth - WIDTH - 8)), y: r.bottom + 6 })
        }}
      >
        <span className="paper-icon" style={preview(paper, 6)} />
      </button>
      {at && (
        <>
          <div className="menu-scrim" onClick={() => setAt(null)} />
          <div className="paper-menu" style={{ left: at.x, top: at.y, width: WIDTH }} role="dialog" aria-label="Paper">
            <div className="paper-title">Paper colour</div>
            <div className="paper-colors">
              {PAPER_COLORS.map((c) => (
                <button
                  key={c.id}
                  className={'paper-color' + (paper.color === c.id ? ' active' : '')}
                  style={{ background: paperCss(c.id) }}
                  title={c.label}
                  aria-label={c.label}
                  aria-pressed={paper.color === c.id}
                  onClick={() => onChange({ ...paper, color: c.id })}
                />
              ))}
            </div>
            <div className="paper-title">Pattern</div>
            <div className="paper-patterns">
              {PAPER_PATTERNS.map((p) => (
                <button
                  key={p.id}
                  className={'paper-pattern' + (paper.pattern === p.id ? ' active' : '')}
                  aria-pressed={paper.pattern === p.id}
                  onClick={() => onChange({ ...paper, pattern: p.id })}
                >
                  <span className="paper-sample" style={preview({ color: paper.color, pattern: p.id }, 10)} />
                  <span>{p.label}</span>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </>
  )
}
