import { useEffect, useReducer, useState } from 'react'
import { notebooksMap, pagesMap, sectionsMap } from '../store/workspace'
import { SECTION_COLORS } from '../store/structure'

/** Re-render whenever notebooks, sections or pages change (also when they change on another device). */
export function useWorkspaceVersion() {
  const [v, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const on = () => bump()
    pagesMap.observe(on)
    sectionsMap.observe(on)
    notebooksMap.observe(on)
    return () => {
      pagesMap.unobserve(on)
      sectionsMap.unobserve(on)
      notebooksMap.unobserve(on)
    }
  }, [])
  return v
}

// ---------- pop-up menu ----------

export interface MenuItem {
  label: string
  onClick(): void
  danger?: boolean
  icon?: React.ReactNode
  checked?: boolean
  disabled?: boolean
  /** draw a line above this item */
  separator?: boolean
}
export type OpenMenu = { x: number; y: number; items: MenuItem[] } | null

export function ActionMenu({ menu, onClose }: { menu: NonNullable<OpenMenu>; onClose(): void }) {
  // keep the menu on screen
  const left = Math.max(8, Math.min(menu.x, window.innerWidth - 228))
  const top = Math.max(8, Math.min(menu.y, window.innerHeight - menu.items.length * 40 - 24))
  return (
    <>
      <div className="menu-scrim" onClick={onClose} onContextMenu={(e) => (e.preventDefault(), onClose())} />
      <div className="action-menu" role="menu" style={{ left, top }}>
        {menu.items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            disabled={it.disabled}
            className={(it.danger ? 'danger' : '') + (it.separator ? ' sep-above' : '') + (it.checked ? ' checked' : '')}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon ?? <span className="menu-icon-space" />}
            <span>{it.label}</span>
            {it.checked && <span className="menu-check">✓</span>}
          </button>
        ))}
      </div>
    </>
  )
}

/** Menu below the element that was clicked (or at the pointer for a right-click). */
export function menuAt(e: React.MouseEvent, items: MenuItem[], align: 'left' | 'right' = 'right'): OpenMenu {
  if (e.type === 'contextmenu') return { x: e.clientX, y: e.clientY, items }
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: align === 'right' ? r.right - 220 : r.left, y: r.bottom + 4, items }
}

// ---------- pick one item from a list ----------

export interface PickItem {
  id: string
  label: string
  icon?: React.ReactNode
  color?: string
  depth?: number
  disabled?: boolean
}

export function PickDialog(props: { title: string; items: PickItem[]; empty?: string; onPick(id: string): void; onClose(): void }) {
  return (
    <div className="paste-sheet" onClick={props.onClose}>
      <div className="sync-card move-card" onClick={(e) => e.stopPropagation()}>
        <div className="paste-title">{props.title}</div>
        <div className="move-list">
          {props.items.map((it) =>
            it.depth === -1 ? (
              <div key={it.id} className="move-group">
                {it.label}
              </div>
            ) : (
              <button key={it.id} disabled={it.disabled} style={{ paddingLeft: 12 + (it.depth ?? 0) * 18 }} onClick={() => props.onPick(it.id)}>
                {it.color ? <span className="color-dot" style={{ background: it.color }} /> : it.icon}
                <span>{it.label}</span>
              </button>
            ),
          )}
          {!props.items.length && <p className="sync-help">{props.empty ?? 'Nothing to choose from.'}</p>}
        </div>
        <button type="button" className="link-btn" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

// ---------- name + colour of a section ----------

export function SectionDialog(props: { title: string; name?: string; color?: string; onSave(name: string, color: string): void; onClose(): void }) {
  const [name, setName] = useState(props.name ?? '')
  const [color, setColor] = useState(props.color ?? SECTION_COLORS[0])
  return (
    <div className="paste-sheet" onClick={props.onClose}>
      <form
        className="sync-card section-card"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault()
          if (!name.trim()) return
          props.onSave(name, color)
          props.onClose()
        }}
      >
        <div className="paste-title">{props.title}</div>
        <label>
          Name
          <input autoFocus value={name} placeholder="e.g. Calculus" onChange={(e) => setName(e.target.value)} />
        </label>
        <div className="color-row" role="radiogroup" aria-label="Colour">
          {SECTION_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              role="radio"
              aria-checked={c === color}
              aria-label={c}
              className={'color-pick' + (c === color ? ' active' : '')}
              style={{ background: c }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>
        <div className="sync-actions">
          <button type="button" className="link-btn" onClick={props.onClose}>
            Cancel
          </button>
          <button className="primary-btn" disabled={!name.trim()}>
            Save
          </button>
        </div>
      </form>
    </div>
  )
}
