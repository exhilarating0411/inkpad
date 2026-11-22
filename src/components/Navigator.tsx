import { useEffect, useReducer, useRef, useState } from 'react'
import type { PageKind, PageMeta } from '../store/types'
import { createPage, deletePage, foldersMap, pagesMap } from '../store/workspace'
import {
  UNSORTED,
  childFolders,
  createFolder,
  deleteFolder,
  descendants,
  folderLabel,
  folderPath,
  moveFolder,
  movePage,
  pageCount,
  pageFolder,
  pagesIn,
  parentOf,
  placePage,
  renameFolder,
  shiftFolder,
} from '../store/folders'
import { searchPages, type SearchResult } from '../store/search'
import type { SyncState } from '../sync/sync'
import { describe } from './SyncSettings'
import { Icons } from './icons'

export type NavMode = 'docked' | 'overlay' | 'phone'

interface Props {
  mode: NavMode
  currentId: string
  folder: string
  onFolder(folder: string): void
  onOpenPage(id: string): void
  onClose(): void
  sync: SyncState
  onOpenSync(): void
  /** changes when the search box should get focus (Ctrl/⌘+K) */
  searchFocus: number
}

/** Re-render whenever pages or folders change (also when they change on another device). */
export function useWorkspaceVersion() {
  const [v, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const on = () => bump()
    pagesMap.observe(on)
    foldersMap.observe(on)
    return () => {
      pagesMap.unobserve(on)
      foldersMap.unobserve(on)
    }
  }, [])
  return v
}

// ---------- small building blocks ----------

interface MenuItem {
  label: string
  onClick(): void
  danger?: boolean
  icon?: React.ReactNode
}
type OpenMenu = { x: number; y: number; items: MenuItem[] } | null

function ActionMenu({ menu, onClose }: { menu: NonNullable<OpenMenu>; onClose(): void }) {
  // keep the menu on screen
  const left = Math.min(menu.x, window.innerWidth - 220)
  const top = Math.min(menu.y, window.innerHeight - menu.items.length * 42 - 16)
  return (
    <>
      <div className="menu-scrim" onClick={onClose} />
      <div className="action-menu" role="menu" style={{ left, top }}>
        {menu.items.map((it) => (
          <button
            key={it.label}
            role="menuitem"
            className={it.danger ? 'danger' : ''}
            onClick={() => {
              onClose()
              it.onClick()
            }}
          >
            {it.icon}
            <span>{it.label}</span>
          </button>
        ))}
      </div>
    </>
  )
}

const menuAt = (e: React.MouseEvent, items: MenuItem[]): OpenMenu => {
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
  return { x: r.right - 200, y: r.bottom + 4, items }
}

/** Lets the user pick a destination folder. */
function MoveDialog(props: { title: string; disabled: Set<string>; allowTop: boolean; allowUnsorted: boolean; onPick(folder: string | null): void; onClose(): void }) {
  const rows: { id: string; name: string; depth: number }[] = []
  const walk = (parent: string | null, depth: number) => {
    for (const f of childFolders(parent)) {
      rows.push({ id: f.id, name: f.name, depth })
      walk(f.id, depth + 1)
    }
  }
  walk(null, 0)
  return (
    <div className="paste-sheet" onClick={props.onClose}>
      <div className="sync-card move-card" onClick={(e) => e.stopPropagation()}>
        <div className="paste-title">{props.title}</div>
        <div className="move-list">
          {props.allowTop && (
            <button onClick={() => props.onPick(null)}>
              {Icons.folder}
              <span>Top level</span>
            </button>
          )}
          {rows.map((r) => (
            <button key={r.id} disabled={props.disabled.has(r.id)} style={{ paddingLeft: 12 + r.depth * 20 }} onClick={() => props.onPick(r.id)}>
              {Icons.folder}
              <span>{r.name}</span>
            </button>
          ))}
          {props.allowUnsorted && (
            <button disabled={props.disabled.has(UNSORTED)} onClick={() => props.onPick(UNSORTED)}>
              {Icons.inbox}
              <span>Unsorted</span>
            </button>
          )}
          {!rows.length && !props.allowTop && <p className="sync-help">No folders yet. Create one with the + next to “Folders”.</p>}
        </div>
        <button type="button" className="link-btn" onClick={props.onClose}>
          Cancel
        </button>
      </div>
    </div>
  )
}

function shortDate(t: number) {
  return new Date(t).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })
}

function PageRow(props: {
  page: PageMeta
  active: boolean
  sub?: string
  onOpen(): void
  onMenu?(e: React.MouseEvent): void
  onHandleDown?(e: React.PointerEvent): void
  className?: string
}) {
  const { page } = props
  return (
    <li className={'page-row' + (props.active ? ' active' : '') + (props.className ? ' ' + props.className : '')} data-id={page.id}>
      <button className="page-open" onClick={props.onOpen}>
        <span className="page-kind">{page.kind === 'markdown' ? Icons.doc : Icons.pen}</span>
        <span className="page-text">
          <span className="page-title">{page.title || 'Untitled'}</span>
          <span className="page-date">{props.sub ?? shortDate(page.created)}</span>
        </span>
      </button>
      {props.onMenu && (
        <button className="row-btn" aria-label={`More for ${page.title}`} onClick={props.onMenu}>
          {Icons.more}
        </button>
      )}
      {props.onHandleDown && (
        <span className="drag-handle" aria-label="Drag to rearrange" onPointerDown={props.onHandleDown}>
          {Icons.grip}
        </span>
      )}
    </li>
  )
}

// ---------- the main component ----------

export default function Navigator(props: Props) {
  const { mode, folder, currentId } = props
  useWorkspaceVersion()
  const [menu, setMenu] = useState<OpenMenu>(null)
  const [moving, setMoving] = useState<{ kind: 'page' | 'folder'; id: string } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('inkpad:expanded') ?? '[]')))
  // where the phone view is: a folder, or null for the start screen
  const [phoneAt, setPhoneAt] = useState<string | null>(folder)

  useEffect(() => localStorage.setItem('inkpad:expanded', JSON.stringify([...expanded])), [expanded])

  // the selected folder's parents are always open in the tree
  useEffect(() => {
    if (folder === UNSORTED) return
    const path = folderPath(folder).slice(0, -1)
    if (path.some((f) => !expanded.has(f.id))) setExpanded((s) => new Set([...s, ...path.map((f) => f.id)]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder])

  useEffect(() => {
    if (props.searchFocus) {
      setPhoneAt(null)
      setTimeout(() => searchRef.current?.focus(), 50)
    }
  }, [props.searchFocus])

  // search as you type (short pause so it doesn't run on every key)
  useEffect(() => {
    setResults(null)
    if (!query.trim()) return
    let alive = true
    const t = setTimeout(() => searchPages(query).then((r) => alive && setResults(r)), 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  const openPage = (p: PageMeta) => {
    props.onFolder(pageFolder(p))
    props.onOpenPage(p.id)
  }
  const newPage = (kind: PageKind, where: string) => {
    const meta = createPage(kind, undefined, where === UNSORTED ? null : where)
    props.onFolder(where)
    props.onOpenPage(meta.id)
  }
  const newFolder = (parent: string | null) => {
    const name = prompt(parent ? 'Name of the new sub-folder' : 'Name of the new folder')
    if (!name?.trim()) return
    const f = createFolder(name, parent)
    if (parent) setExpanded((s) => new Set([...s, parent]))
    props.onFolder(f.id)
    if (mode === 'phone') setPhoneAt(f.id)
  }

  const pageMenu = (p: PageMeta) => (e: React.MouseEvent) =>
    setMenu(
      menuAt(e, [
        { label: 'Move to…', icon: Icons.folder, onClick: () => setMoving({ kind: 'page', id: p.id }) },
        {
          label: 'Delete page',
          icon: Icons.trash,
          danger: true,
          onClick: () => confirm(`Delete “${p.title || 'Untitled'}”? This cannot be undone.`) && void deletePage(p.id),
        },
      ]),
    )
  const folderMenu = (id: string) => (e: React.MouseEvent) => {
    const f = foldersMap.get(id)!
    setMenu(
      menuAt(e, [
        { label: 'New sub-folder', icon: Icons.plus, onClick: () => newFolder(id) },
        {
          label: 'Rename',
          icon: Icons.text,
          onClick: () => {
            const name = prompt('Folder name', f.name)
            if (name) renameFolder(id, name)
          },
        },
        { label: 'Move up', icon: Icons.up, onClick: () => shiftFolder(id, -1) },
        { label: 'Move down', icon: Icons.down, onClick: () => shiftFolder(id, 1) },
        { label: 'Move to…', icon: Icons.folder, onClick: () => setMoving({ kind: 'folder', id }) },
        {
          label: 'Delete folder',
          icon: Icons.trash,
          danger: true,
          onClick: () => {
            const parent = parentOf(id)
            const dest = parent ? foldersMap.get(parent)?.name : 'Unsorted / top level'
            if (!confirm(`Delete the folder “${f.name}”?\nIts pages and sub-folders are kept and move to “${dest}”.`)) return
            deleteFolder(id)
            if (folder === id) props.onFolder(parent ?? UNSORTED)
            if (phoneAt === id) setPhoneAt(parent)
          },
        },
      ]),
    )
  }

  const recent = [...pagesMap.values()].sort((a, b) => b.updated - a.updated).slice(0, 5)
  const searching = query.trim() !== ''

  // ---------- pieces shared by the layouts ----------

  const searchBox = (
    <div className="search-box">
      {Icons.search}
      <input
        ref={searchRef}
        type="search"
        placeholder="Search all notes…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
        autoCapitalize="off"
        autoCorrect="off"
      />
    </div>
  )

  const searchResults = searching && (
    <div className="nav-section">
      <div className="nav-label">
        {results === null ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}
        <button className="link-btn" onClick={() => setQuery('')}>
          Clear
        </button>
      </div>
      <ul className="page-list">
        {(results ?? []).map((r) => (
          <li key={r.page.id} className={'page-row result' + (r.page.id === currentId ? ' active' : '')}>
            <button className="page-open" onClick={() => openPage(r.page)}>
              <span className="page-kind">{r.page.kind === 'markdown' ? Icons.doc : Icons.pen}</span>
              <span className="page-text">
                <span className="page-title">{r.page.title || 'Untitled'}</span>
                <span className="page-date">{folderLabel(pageFolder(r.page))}</span>
                {r.snippet && <span className="snippet">{highlight(r.snippet, query)}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>
      {results?.length === 0 && <p className="nav-empty">Nothing found. Search looks in titles, typed text and documents (not handwriting).</p>}
    </div>
  )

  const recentList = (
    <div className="nav-section">
      <div className="nav-label">{Icons.clock} Recent</div>
      <ul className="page-list">
        {recent.map((p) => (
          <PageRow key={p.id} page={p} active={p.id === currentId} sub={folderLabel(pageFolder(p))} onOpen={() => openPage(p)} />
        ))}
      </ul>
    </div>
  )

  const syncFooter = (
    <button className={'sidebar-foot sync-' + props.sync.kind} onClick={props.onOpenSync} title="Sync settings">
      <span className="sync-dot" />
      <span>{props.sync.kind === 'off' ? 'Sync is off · tap to set up' : describe(props.sync)}</span>
    </button>
  )

  const overlays = (
    <>
      {menu && <ActionMenu menu={menu} onClose={() => setMenu(null)} />}
      {moving && (
        <MoveDialog
          title={moving.kind === 'page' ? 'Move page to…' : 'Move folder to…'}
          allowTop={moving.kind === 'folder'}
          allowUnsorted={moving.kind === 'page'}
          disabled={
            moving.kind === 'folder'
              ? descendants(moving.id)
              : new Set([pageFolder(pagesMap.get(moving.id) ?? ({} as PageMeta))])
          }
          onPick={(dest) => {
            if (moving.kind === 'page') {
              movePage(moving.id, dest ?? UNSORTED)
              if (moving.id === currentId) props.onFolder(dest ?? UNSORTED)
            } else if (!moveFolder(moving.id, dest)) alert('A folder cannot be moved into itself.')
            setMoving(null)
          }}
          onClose={() => setMoving(null)}
        />
      )}
    </>
  )

  // ---------- phone: one column, step into folders like the Files app ----------
  if (mode === 'phone') {
    const here = phoneAt && (phoneAt === UNSORTED || foldersMap.has(phoneAt)) ? phoneAt : null
    const title = here === null ? 'InkPad' : here === UNSORTED ? 'Unsorted' : foldersMap.get(here)!.name
    const up = here === null || here === UNSORTED ? null : parentOf(here)
    const plusMenu = (e: React.MouseEvent) =>
      setMenu(
        menuAt(e, [
          { label: 'Handwriting page', icon: Icons.pen, onClick: () => newPage('canvas', here ?? UNSORTED) },
          { label: 'Document', icon: Icons.doc, onClick: () => newPage('markdown', here ?? UNSORTED) },
          {
            label: here && here !== UNSORTED ? 'New sub-folder' : 'New folder',
            icon: Icons.folder,
            onClick: () => newFolder(here === UNSORTED ? null : here),
          },
        ]),
      )
    return (
      <>
        <div className="scrim" onClick={props.onClose} />
        <aside className="nav nav-phone">
          <div className="nav-head">
            {here !== null ? (
              <button className="back-btn" onClick={() => setPhoneAt(up)}>
                ‹ {up ? foldersMap.get(up)?.name : 'All folders'}
              </button>
            ) : (
              <span className="brand">InkPad</span>
            )}
            <button className="tbtn" aria-label="New" title="New" onClick={plusMenu}>
              {Icons.plus}
            </button>
          </div>
          {here !== null && <div className="phone-title">{title}</div>}
          {here === null && searchBox}
          <div className="nav-scroll">
            {here === null && searching && searchResults}
            {here === null && !searching && (
              <>
                {recent.length > 0 && recentList}
                <div className="nav-section">
                  <div className="nav-label">{Icons.folder} Folders</div>
                  <ul className="folder-list">
                    {childFolders(null).map((f) => (
                      <FolderRowFlat key={f.id} id={f.id} name={f.name} onOpen={() => setPhoneAt(f.id)} onMenu={folderMenu(f.id)} />
                    ))}
                    {pageCount(UNSORTED) > 0 && <FolderRowFlat id={UNSORTED} name="Unsorted" onOpen={() => setPhoneAt(UNSORTED)} />}
                  </ul>
                  {childFolders(null).length === 0 && <p className="nav-empty">Tap + to create your first folder.</p>}
                </div>
              </>
            )}
            {here !== null && (
              <>
                {here !== UNSORTED && childFolders(here).length > 0 && (
                  <ul className="folder-list">
                    {childFolders(here).map((f) => (
                      <FolderRowFlat key={f.id} id={f.id} name={f.name} onOpen={() => setPhoneAt(f.id)} onMenu={folderMenu(f.id)} />
                    ))}
                  </ul>
                )}
                <PageList folder={here} currentId={currentId} onOpen={(p) => openPage(p)} onMenu={pageMenu} />
              </>
            )}
          </div>
          {syncFooter}
        </aside>
        {overlays}
      </>
    )
  }

  // ---------- iPad / PC: folders | pages ----------
  const folderName = folder === UNSORTED ? 'Unsorted' : foldersMap.get(folder)?.name ?? 'Unsorted'
  return (
    <>
      {mode === 'overlay' && <div className="scrim" onClick={props.onClose} />}
      <aside className={`nav nav-two nav-${mode}`}>
        <div className="nav-col nav-folders">
          <div className="nav-head">
            <span className="brand">InkPad</span>
          </div>
          {searchBox}
          <div className="nav-scroll">
            {searching ? (
              searchResults
            ) : (
              <>
                {recent.length > 0 && recentList}
                <div className="nav-section">
                  <div className="nav-label">
                    {Icons.folder} Folders
                    <button className="row-btn" aria-label="New folder" title="New folder" onClick={() => newFolder(null)}>
                      {Icons.plus}
                    </button>
                  </div>
                  <ul className="folder-tree">
                    {childFolders(null).map((f) => (
                      <FolderNode
                        key={f.id}
                        id={f.id}
                        depth={0}
                        selected={folder}
                        expanded={expanded}
                        onToggle={(id) =>
                          setExpanded((s) => {
                            const n = new Set(s)
                            if (n.has(id)) n.delete(id)
                            else n.add(id)
                            return n
                          })
                        }
                        onSelect={props.onFolder}
                        onMenu={folderMenu}
                      />
                    ))}
                    {(pageCount(UNSORTED) > 0 || folder === UNSORTED) && (
                      <li>
                        <div className={'folder-row' + (folder === UNSORTED ? ' active' : '')} style={{ paddingLeft: 26 }}>
                          <button className="folder-name" onClick={() => props.onFolder(UNSORTED)}>
                            {Icons.inbox}
                            <span>Unsorted</span>
                            <span className="count">{pageCount(UNSORTED)}</span>
                          </button>
                        </div>
                      </li>
                    )}
                  </ul>
                  {childFolders(null).length === 0 && <p className="nav-empty">Create folders with the + above, e.g. “Mathematics”.</p>}
                </div>
              </>
            )}
          </div>
          {syncFooter}
        </div>
        <div className="nav-col nav-pages">
          <div className="nav-head">
            <span className="pages-title" title={folderLabel(folder)}>
              {folderName}
            </span>
            <button
              className="tbtn"
              aria-label="New page"
              title="New page in this folder"
              onClick={(e) =>
                setMenu(
                  menuAt(e, [
                    { label: 'Handwriting page', icon: Icons.pen, onClick: () => newPage('canvas', folder) },
                    { label: 'Document', icon: Icons.doc, onClick: () => newPage('markdown', folder) },
                  ]),
                )
              }
            >
              {Icons.plus}
            </button>
          </div>
          <div className="nav-scroll">
            {folder !== UNSORTED && childFolders(folder).length > 0 && (
              <ul className="folder-list">
                {childFolders(folder).map((f) => (
                  <FolderRowFlat key={f.id} id={f.id} name={f.name} onOpen={() => props.onFolder(f.id)} />
                ))}
              </ul>
            )}
            <PageList folder={folder} currentId={currentId} onOpen={(p) => props.onOpenPage(p.id)} onMenu={pageMenu} />
          </div>
        </div>
      </aside>
      {overlays}
    </>
  )
}

function highlight(text: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return text
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))
}

// ---------- folder tree (iPad / PC) ----------

function FolderNode(props: {
  id: string
  depth: number
  selected: string
  expanded: Set<string>
  onToggle(id: string): void
  onSelect(id: string): void
  onMenu(id: string): (e: React.MouseEvent) => void
}) {
  const f = foldersMap.get(props.id)
  if (!f) return null
  const kids = childFolders(props.id)
  const open = props.expanded.has(props.id)
  return (
    <li>
      <div className={'folder-row' + (props.selected === props.id ? ' active' : '')} style={{ paddingLeft: 4 + props.depth * 16 }}>
        <button
          className={'caret' + (kids.length ? '' : ' empty')}
          aria-label={open ? 'Close folder' : 'Open folder'}
          onClick={() => kids.length && props.onToggle(props.id)}
        >
          {kids.length ? (open ? '▾' : '▸') : ''}
        </button>
        <button
          className="folder-name"
          onClick={() => {
            props.onSelect(props.id)
            if (kids.length && !open) props.onToggle(props.id)
          }}
        >
          {Icons.folder}
          <span>{f.name}</span>
          <span className="count">{pageCount(props.id)}</span>
        </button>
        <button className="row-btn" aria-label={`More for ${f.name}`} onClick={props.onMenu(props.id)}>
          {Icons.more}
        </button>
      </div>
      {open && kids.length > 0 && (
        <ul>
          {kids.map((k) => (
            <FolderNode key={k.id} {...props} id={k.id} depth={props.depth + 1} />
          ))}
        </ul>
      )}
    </li>
  )
}

function FolderRowFlat(props: { id: string; name: string; onOpen(): void; onMenu?(e: React.MouseEvent): void }) {
  return (
    <li className="folder-row flat">
      <button className="folder-name" onClick={props.onOpen}>
        {props.id === UNSORTED ? Icons.inbox : Icons.folder}
        <span>{props.name}</span>
        <span className="count">{pageCount(props.id)}</span>
        <span className="chev">›</span>
      </button>
      {props.onMenu && (
        <button className="row-btn" aria-label={`More for ${props.name}`} onClick={props.onMenu}>
          {Icons.more}
        </button>
      )}
    </li>
  )
}

// ---------- pages of one folder, arranged by dragging the ≡ handle ----------

function PageList(props: { folder: string; currentId: string; onOpen(p: PageMeta): void; onMenu(p: PageMeta): (e: React.MouseEvent) => void }) {
  const pages = pagesIn(props.folder)
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<{ id: string; index: number } | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  useEffect(() => {
    if (!drag) return
    const move = (e: PointerEvent) => {
      const rows = [...listRef.current!.querySelectorAll<HTMLElement>('li[data-id]:not(.ghost)')]
      let index = rows.length
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      if (index !== dragRef.current?.index) setDrag((d) => (d ? { ...d, index } : d))
    }
    const up = () => {
      const d = dragRef.current
      if (d) placePage(d.id, d.index)
      setDrag(null)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
  }, [drag?.id])

  if (!pages.length) return <p className="nav-empty">No pages here yet. Tap + to add one.</p>

  const others = drag ? pages.filter((p) => p.id !== drag.id) : pages
  const dragged = drag ? pages.find((p) => p.id === drag.id) : undefined
  const rows: React.ReactNode[] = others.map((p) => (
    <PageRow
      key={p.id}
      page={p}
      active={p.id === props.currentId}
      onOpen={() => props.onOpen(p)}
      onMenu={props.onMenu(p)}
      onHandleDown={(e) => {
        e.preventDefault()
        setDrag({ id: p.id, index: pages.findIndex((x) => x.id === p.id) })
      }}
    />
  ))
  if (drag && dragged) {
    rows.splice(drag.index, 0, <PageRow key="ghost" page={dragged} active={false} className="ghost" onOpen={() => {}} />)
  }
  return (
    <ul className={'page-list' + (drag ? ' dragging' : '')} ref={listRef}>
      {rows}
    </ul>
  )
}
