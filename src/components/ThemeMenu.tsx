import { useState } from 'react'
import { THEMES, getTheme, setTheme, type ThemeChoice } from '../theme'
import { Icons } from './icons'

export default function ThemeMenu() {
  const [open, setOpen] = useState(false)
  const [current, setCurrent] = useState<ThemeChoice>(getTheme)
  return (
    <div className="theme-wrap">
      <button className="tbtn" title="Theme" aria-label="Theme" onClick={() => setOpen((o) => !o)}>
        {Icons.theme}
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="theme-menu" role="menu">
            {THEMES.map((t) => (
              <button
                key={t.id}
                role="menuitemradio"
                aria-checked={current === t.id}
                className={current === t.id ? 'active' : ''}
                onClick={() => {
                  setTheme(t.id)
                  setCurrent(t.id)
                  setOpen(false)
                }}
              >
                <span className="theme-swatch" style={{ background: t.paper }}>
                  <span style={{ background: t.dot }} />
                </span>
                <span className="theme-label">{t.label}</span>
                {current === t.id && <span className="theme-check">✓</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
