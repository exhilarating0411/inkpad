import { useEffect, useRef, useState } from 'react'
import type { PageKind, PageMeta } from '../store/types'
import { notebooksMap, pagesMap, sectionsMap } from '../store/workspace'
import {
  MAX_DEPTH,
  addPage,
  ancestors,
  canIndent,
  canOutdent,
  deletePageKeepChildren,
  depthOf,
  flatTree,
  indentPage,
  levelsBelow,
  locationLabel,
  movePageToSection,
  notebooks,
  outdentPage,
  placePage,
  sectionsOf,
  type TreeRow,
} from '../store/structure'
import { searchPages, type SearchResult } from '../store/search'
import type { SyncState } from '../sync/sync'
import { describe, isPending, usePending } from './SyncSettings'
import { ActionMenu, PickDialog, menuAt, useWorkspaceVersion, type OpenMenu, type PickItem } from './Menu'
import { Icons } from './icons'
import { APP_VERSION, useNewerVersion, versionLabel } from '../version'
import type { ExportRequest } from '../export/plan'
import { pageExport } from '../export/plan'

export type TreeMode = 'docked' | 'overlay'

interface Props {
  mode: TreeMode
  notebookId: string
  sectionId: string
  currentId: string
  onOpenPage(id: string): void
  onClose(): void
  searching: boolean
  onSearching(on: boolean): void
  /** changes when the search box should get focus (Ctrl/⌘+K) */
  searchFocus: number
  sync: SyncState
  onOpenSync(): void
  onExport(req: ExportRequest): void
}

/** indentation of one level, in pixels */
const INDENT = 18

const kindIcon = (k: PageKind) => (k === 'markdown' ? Icons.doc : Icons.pen)

function useCollapsed() {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set(JSON.parse(localStorage.getItem('inkpad:collapsed') ?? '[]')))
  useEffect(() => {
    // forget pages that no longer exist
    const ids = [...collapsed].filter((id) => pagesMap.has(id))
    localStorage.setItem('inkpad:collapsed', JSON.stringify(ids))
  }, [collapsed])
  const toggle = (id: string, open?: boolean) =>
    setCollapsed((s) => {
      const n = new Set(s)
      if (open ?? n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  return [collapsed, setCollapsed, toggle] as const
}

export default function PageTree(props: Props) {
  const { sectionId, currentId } = props
  useWorkspaceVersion()
  const [menu, setMenu] = useState<OpenMenu>(null)
  const [picking, setPicking] = useState<{ title: string; items: PickItem[]; onPick(id: string): void } | null>(null)
  const [collapsed, setCollapsed, toggle] = useCollapsed()
  const pending = usePending()
  const newer = useNewerVersion()

  // the open page is always visible: its parents are expanded
  useEffect(() => {
    const up = ancestors(currentId).filter((p) => collapsed.has(p.id))
    if (up.length) setCollapsed((s) => new Set([...s].filter((id) => !up.some((p) => p.id === id))))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentId])

  const section = sectionsMap.get(sectionId)

  const newPage = (kind: PageKind, parentId: string | null = null) => {
    if (!section) return
    const meta = addPage(kind, section.id, parentId)
    if (parentId) toggle(parentId, true)
    props.onOpenPage(meta.id)
  }
  const kindMenu = (e: React.MouseEvent, parentId: string | null = null) =>
    setMenu(
      menuAt(e, [
        { label: 'Handwriting page', icon: Icons.pen, onClick: () => newPage('canvas', parentId) },
        { label: 'Document', icon: Icons.doc, onClick: () => newPage('markdown', parentId) },
      ]),
    )

  const pageMenu = (row: TreeRow) => (e: React.MouseEvent) => {
    e.preventDefault()
    const p = row.page
    const at = menuAt(e, [])!
    setMenu({
      ...at,
      items: [
        {
          label: 'Add sub-page',
          icon: Icons.plus,
          disabled: depthOf(p.id) >= MAX_DEPTH - 1,
          onClick: () =>
            setMenu({
              ...at,
              items: [
                { label: 'Handwriting page', icon: Icons.pen, onClick: () => newPage('canvas', p.id) },
                { label: 'Document', icon: Icons.doc, onClick: () => newPage('markdown', p.id) },
              ],
            }),
        },
        { label: 'Make sub-page', icon: Icons.indent, disabled: !canIndent(p.id), onClick: () => indentPage(p.id) },
        { label: 'Promote', icon: Icons.outdent, disabled: !canOutdent(p.id), onClick: () => outdentPage(p.id) },
        { label: 'Move to section…', icon: Icons.right, onClick: () => moveToSection(p) },
        {
          label: row.childCount ? 'Export with sub-pages (PDF)' : 'Export as PDF',
          icon: Icons.download,
          separator: true,
          onClick: () => props.onExport(pageExport(p.id)),
        },
        {
          label: 'Delete page',
          icon: Icons.trash,
          danger: true,
          separator: true,
          onClick: () => {
            const extra = row.childCount ? `\nIts ${row.childCount} sub-page${row.childCount > 1 ? 's are' : ' is'} kept and move up one level.` : ''
            if (confirm(`Delete “${p.title || 'Untitled'}”? This cannot be undone.${extra}`)) void deletePageKeepChildren(p.id)
          },
        },
      ],
    })
  }

  const moveToSection = (p: PageMeta) => {
    const items: PickItem[] = []
    for (const nb of notebooks()) {
      items.push({ id: 'nb:' + nb.id, label: nb.name, depth: -1 })
      for (const s of sectionsOf(nb.id)) items.push({ id: s.id, label: s.name, color: s.color, disabled: s.id === p.sectionId })
    }
    setPicking({
      title: `Move “${p.title || 'Untitled'}” to…`,
      items,
      onPick: (id) => {
        movePageToSection(p.id, id)
        setPicking(null)
      },
    })
  }

  const overlays = (
    <>
      {menu && <ActionMenu menu={menu} onClose={() => setMenu(null)} />}
      {picking && <PickDialog title={picking.title} items={picking.items} onPick={picking.onPick} onClose={() => setPicking(null)} />}
    </>
  )

  return (
    <>
      {props.mode === 'overlay' && <div className="scrim" onClick={props.onClose} />}
      <aside className={`tree-panel tree-${props.mode}`}>
        {props.searching ? (
          <SearchPanel {...props} />
        ) : (
          <>
            <div className="tree-head">
              {section && <span className="tree-color" style={{ background: section.color }} />}
              <span className="tree-title">{section?.name ?? 'No section'}</span>
              {section && (
                <button className="tbtn" aria-label="New page" title="New page" onClick={(e) => kindMenu(e)}>
                  {Icons.plus}
                </button>
              )}
            </div>
            <div className="nav-scroll">
              {section ? (
                <Tree
                  sectionId={section.id}
                  currentId={currentId}
                  collapsed={collapsed}
                  onToggle={toggle}
                  onOpen={props.onOpenPage}
                  onMenu={pageMenu}
                  onNew={kindMenu}
                />
              ) : (
                <p className="nav-empty">Add a section with the + next to the tabs.</p>
              )}
            </div>
          </>
        )}
        <div className="version-line">
          <span>Version {versionLabel(APP_VERSION)}</span>
          {newer && (
            <span className="version-new">
              Newer version online ({versionLabel(newer)}). Close Notes completely and open it again to update.
            </span>
          )}
        </div>
        <button
          className={'sidebar-foot sync-' + props.sync.kind + (isPending(props.sync, pending) ? ' sync-pending' : '')}
          onClick={props.onOpenSync}
          title="Sync settings"
        >
          <span className="sync-dot" />
          <span>{props.sync.kind === 'off' ? 'Sync is off · tap to set up' : describe(props.sync, pending)}</span>
        </button>
      </aside>
      {overlays}
    </>
  )
}

// ---------- the tree, arranged by dragging the ≡ handle ----------

interface Drag {
  id: string
  pointerId: number
  startX: number
  startDepth: number
  startIndex: number
  index: number
  depth: number
  /** a section tab the page is held over */
  overSection: string | null
}

function Tree(props: {
  sectionId: string
  currentId: string
  collapsed: Set<string>
  onToggle(id: string, open?: boolean): void
  onOpen(id: string): void
  onMenu(row: TreeRow): (e: React.MouseEvent) => void
  onNew(e: React.MouseEvent): void
}) {
  const listRef = useRef<HTMLUListElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const dragRef = useRef(drag)
  dragRef.current = drag

  // rows without the dragged page's sub-pages (they travel with it)
  const rows = flatTree(props.sectionId, props.collapsed, drag?.id)
  const others = drag ? rows.filter((r) => r.page.id !== drag.id) : rows
  const othersRef = useRef(others)
  othersRef.current = others

  useEffect(() => {
    if (!drag) return
    let tab: HTMLElement | null = null
    const setTab = (el: HTMLElement | null) => {
      if (el === tab) return
      tab?.classList.remove('drop-target')
      tab = el
      tab?.classList.add('drop-target')
    }
    const move = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      const list = othersRef.current
      // over a section tab?
      const hit = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-section-id]')
      const over = hit && hit.dataset.sectionId !== props.sectionId ? hit.dataset.sectionId! : null
      setTab(over ? hit! : null)
      // position in the list
      const els = [...listRef.current!.querySelectorAll<HTMLElement>('li[data-id]:not(.ghost)')]
      let index = els.length
      for (let i = 0; i < els.length; i++) {
        const r = els[i].getBoundingClientRect()
        if (e.clientY < r.top + r.height / 2) {
          index = i
          break
        }
      }
      // level: follow the pointer sideways, within what the neighbours allow
      const prev = list[index - 1]
      const next = list[index]
      const maxD = Math.min(prev ? prev.depth + 1 : 0, MAX_DEPTH - 1 - levelsBelow(d.id))
      const minD = Math.min(next ? next.depth : 0, maxD)
      const want = d.startDepth + Math.round((e.clientX - d.startX) / INDENT)
      const depth = Math.max(0, Math.max(minD, Math.min(maxD, want)))
      if (index !== d.index || depth !== d.depth || over !== d.overSection) setDrag({ ...d, index, depth, overSection: over })
    }
    const up = (e: PointerEvent) => {
      const d = dragRef.current
      if (!d || e.pointerId !== d.pointerId) return
      setTab(null)
      setDrag(null)
      if (e.type === 'pointercancel') return
      if (d.overSection) {
        movePageToSection(d.id, d.overSection)
        return
      }
      if (d.index === d.startIndex && d.depth === d.startDepth) return
      const list = othersRef.current
      const prev = list[d.index - 1]
      let parent: string | null = null
      let after: string | null = null
      if (prev && d.depth === prev.depth + 1) {
        parent = prev.page.id
      } else if (prev) {
        // the row above at the chosen level: the page goes right after it
        let i = d.index - 1
        while (i >= 0 && list[i].depth > d.depth) i--
        const anchor = list[i]
        after = anchor.page.id
        for (let j = i - 1; j >= 0 && anchor.depth > 0; j--) {
          if (list[j].depth === anchor.depth - 1) {
            parent = list[j].page.id
            break
          }
        }
      }
      placePage(d.id, parent, after)
      if (parent) props.onToggle(parent, true)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', up)
    return () => {
      setTab(null)
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', up)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.id])

  if (!rows.length) {
    return (
      <div className="nav-empty">
        <p>No pages in this section yet.</p>
        <button className="primary-btn" onClick={props.onNew}>
          New page
        </button>
      </div>
    )
  }

  const dragged = drag ? rows.find((r) => r.page.id === drag.id) : undefined
  const items: React.ReactNode[] = others.map((row) => (
    <TreeItem
      key={row.page.id}
      row={row}
      active={row.page.id === props.currentId}
      open={!props.collapsed.has(row.page.id)}
      onToggle={() => props.onToggle(row.page.id)}
      onOpen={() => props.onOpen(row.page.id)}
      onMenu={props.onMenu(row)}
      onHandleDown={(e) => {
        e.preventDefault()
        const index = rows.findIndex((r) => r.page.id === row.page.id)
        setDrag({ id: row.page.id, pointerId: e.pointerId, startX: e.clientX, startDepth: row.depth, startIndex: index, index, depth: row.depth, overSection: null })
      }}
    />
  ))
  if (drag && dragged && !drag.overSection) {
    items.splice(
      drag.index,
      0,
      <TreeItem key="ghost" row={{ ...dragged, depth: drag.depth }} active={false} open={false} ghost onOpen={() => {}} />,
    )
  }
  return (
    <ul className={'page-list tree' + (drag ? ' dragging' : '')} ref={listRef}>
      {items}
    </ul>
  )
}

function TreeItem(props: {
  row: TreeRow
  active: boolean
  open: boolean
  ghost?: boolean
  onToggle?(): void
  onOpen(): void
  onMenu?(e: React.MouseEvent): void
  onHandleDown?(e: React.PointerEvent): void
}) {
  const { page, depth, childCount } = props.row
  return (
    <li
      className={'page-row tree-row' + (props.active ? ' active' : '') + (props.ghost ? ' ghost' : '')}
      data-id={props.ghost ? undefined : page.id}
      style={{ paddingLeft: depth * INDENT }}
      onContextMenu={props.onMenu}
    >
      <button
        className={'caret' + (childCount ? '' : ' empty')}
        aria-label={props.open ? 'Collapse sub-pages' : 'Expand sub-pages'}
        tabIndex={childCount ? 0 : -1}
        onClick={() => childCount && props.onToggle?.()}
      >
        {childCount ? (props.open ? '▾' : '▸') : ''}
      </button>
      <button className="page-open" onClick={props.onOpen}>
        <span className="page-kind">{kindIcon(page.kind)}</span>
        <span className="page-title">{page.title || 'Untitled'}</span>
        {childCount > 0 && !props.open && <span className="count">{childCount}</span>}
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

// ---------- search ----------

function SearchPanel(props: Props) {
  const [query, setQuery] = useState('')
  const [everywhere, setEverywhere] = useState(false)
  const [results, setResults] = useState<SearchResult[] | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    setTimeout(() => inputRef.current?.focus(), 30)
  }, [props.searchFocus])

  // search as you type (short pause so it doesn't run on every key)
  useEffect(() => {
    setResults(null)
    if (!query.trim()) return
    let alive = true
    const inNotebook = (p: PageMeta) => sectionsMap.get(p.sectionId ?? '')?.notebookId === props.notebookId
    const t = setTimeout(() => searchPages(query, everywhere ? undefined : inNotebook).then((r) => alive && setResults(r)), 180)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query, everywhere, props.notebookId])

  const nbName = notebooksMap.get(props.notebookId)?.name ?? 'this notebook'
  const recent = [...pagesMap.values()].sort((a, b) => b.updated - a.updated).slice(0, 8)
  const row = (p: PageMeta, snippet?: string) => (
    <li key={p.id} className={'page-row result' + (p.id === props.currentId ? ' active' : '')}>
      <button className="page-open" onClick={() => props.onOpenPage(p.id)}>
        <span className="page-kind">{kindIcon(p.kind)}</span>
        <span className="page-text">
          <span className="page-title">{p.title || 'Untitled'}</span>
          <span className="page-date">
            <span className="color-dot small" style={{ background: sectionsMap.get(p.sectionId ?? '')?.color }} />
            {locationLabel(p, everywhere || !query.trim())}
          </span>
          {snippet && <span className="snippet">{highlight(snippet, query)}</span>}
        </span>
      </button>
    </li>
  )

  return (
    <>
      <div className="tree-head">
        <div className="search-box">
          {Icons.search}
          <input
            ref={inputRef}
            type="search"
            placeholder={everywhere ? 'Search all notebooks…' : `Search ${nbName}…`}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (query ? setQuery('') : props.onSearching(false))}
            autoCapitalize="off"
            autoCorrect="off"
          />
        </div>
        <button className="tbtn" aria-label="Close search" title="Close search" onClick={() => props.onSearching(false)}>
          {Icons.close}
        </button>
      </div>
      <div className="nav-scroll">
        {!query.trim() ? (
          <div className="nav-section">
            <div className="nav-label">{Icons.clock} Recent</div>
            <ul className="page-list">{recent.map((p) => row(p))}</ul>
          </div>
        ) : (
          <div className="nav-section">
            <div className="nav-label">
              {results === null ? 'Searching…' : `${results.length} result${results.length === 1 ? '' : 's'}`}
              {everywhere ? ' · all notebooks' : ` · ${nbName}`}
            </div>
            <ul className="page-list">{(results ?? []).map((r) => row(r.page, r.snippet))}</ul>
            {results?.length === 0 && <p className="nav-empty">Nothing found. Search looks in titles, typed text and documents (not handwriting).</p>}
            {results !== null && (
              <button className="link-btn scope-btn" onClick={() => setEverywhere((x) => !x)}>
                {everywhere ? `Search only in ${nbName}` : 'Search all notebooks'}
              </button>
            )}
          </div>
        )}
      </div>
    </>
  )
}

function highlight(text: string, query: string) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return text
  const re = new RegExp(`(${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi')
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part))
}
