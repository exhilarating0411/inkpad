import { useState } from 'react'
import type { PageKind, PageMeta } from '../store/types'
import { Icons } from './icons'
import type { SyncState } from '../sync/sync'
import { describe } from './SyncSettings'

interface Props {
  pages: PageMeta[]
  currentId: string | null
  open: boolean
  onSelect(id: string): void
  onCreate(kind: PageKind): void
  onDelete(id: string): void
  onClose(): void
  sync: SyncState
  onOpenSync(): void
}

export default function Sidebar({ pages, currentId, open, onSelect, onCreate, onDelete, onClose, sync, onOpenSync }: Props) {
  const [menu, setMenu] = useState(false)
  const create = (kind: PageKind) => {
    setMenu(false)
    onCreate(kind)
  }
  return (
    <>
      {open && <div className="scrim" onClick={onClose} />}
      <aside className={'sidebar' + (open ? ' open' : '')}>
        <div className="sidebar-head">
          <span className="brand">InkPad</span>
          <button className="tbtn" title="New…" aria-label="New page" onClick={() => setMenu((m) => !m)}>
            {Icons.plus}
          </button>
          {menu && (
            <div className="new-menu" role="menu">
              <button role="menuitem" onClick={() => create('canvas')}>
                {Icons.pen}
                <span>
                  <b>Handwriting page</b>
                  <small>Pen, text boxes and pictures</small>
                </span>
              </button>
              <button role="menuitem" onClick={() => create('markdown')}>
                {Icons.doc}
                <span>
                  <b>Document</b>
                  <small>Formal writing in Markdown</small>
                </span>
              </button>
            </div>
          )}
        </div>
        <ul className="page-list">
          {pages.map((p) => (
            <li key={p.id} className={p.id === currentId ? 'active' : ''}>
              <button className="page-item" onClick={() => onSelect(p.id)}>
                <span className="page-kind">{p.kind === 'markdown' ? Icons.doc : Icons.pen}</span>
                <span className="page-text">
                  <span className="page-title">{p.title || 'Untitled'}</span>
                  <span className="page-date">{new Date(p.updated).toLocaleDateString()}</span>
                </span>
              </button>
              <button
                className="page-del"
                title="Delete page"
                aria-label={`Delete ${p.title}`}
                onClick={() => {
                  if (confirm(`Delete “${p.title || 'Untitled'}”? This cannot be undone.`)) onDelete(p.id)
                }}
              >
                {Icons.close}
              </button>
            </li>
          ))}
        </ul>
        <button className={'sidebar-foot sync-' + sync.kind} onClick={onOpenSync} title="Sync settings">
          <span className="sync-dot" />
          <span>{sync.kind === 'off' ? 'Sync is off · tap to set up' : describe(sync)}</span>
        </button>
      </aside>
    </>
  )
}
