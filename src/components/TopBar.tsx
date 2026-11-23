import { useEffect, useRef, useState } from 'react'
import { notebooksMap, pagesMap } from '../store/workspace'
import {
  SECTION_COLORS,
  createNotebook,
  createSection,
  deleteNotebook,
  deleteSection,
  moveSectionToNotebook,
  notebooks,
  renameNotebook,
  sectionsOf,
  shiftSection,
  updateSection,
} from '../store/structure'
import type { SectionMeta } from '../store/types'
import type { SyncState } from '../sync/sync'
import { describe } from './SyncSettings'
import ThemeMenu from './ThemeMenu'
import { ActionMenu, PickDialog, SectionDialog, menuAt, useWorkspaceVersion, type OpenMenu } from './Menu'
import { Icons } from './icons'
import { notebookExport, sectionExport, type ExportRequest } from '../export/plan'

interface Props {
  notebookId: string
  sectionId: string
  onNotebook(id: string): void
  onSection(id: string): void
  treeOpen: boolean
  onToggleTree(): void
  onSearch(): void
  sync: SyncState
  onOpenSync(): void
  onExport(req: ExportRequest): void
}

const pageCount = (sectionId: string) => [...pagesMap.values()].filter((p) => p.sectionId === sectionId).length

export default function TopBar(props: Props) {
  useWorkspaceVersion()
  const [menu, setMenu] = useState<OpenMenu>(null)
  const [editing, setEditing] = useState<{ section?: SectionMeta } | null>(null)
  const [movingSection, setMovingSection] = useState<SectionMeta | null>(null)
  const tabsRef = useRef<HTMLDivElement>(null)

  const nb = notebooksMap.get(props.notebookId)
  const sections = nb ? sectionsOf(nb.id) : []

  // keep the open tab in view
  useEffect(() => {
    tabsRef.current?.querySelector<HTMLElement>('.tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [props.sectionId])

  const notebookMenu = (e: React.MouseEvent) => {
    const all = notebooks()
    setMenu(
      menuAt(
        e,
        [
          ...all.map((n) => ({ label: n.name, icon: Icons.book, checked: n.id === props.notebookId, onClick: () => props.onNotebook(n.id) })),
          {
            label: 'New notebook',
            icon: Icons.plus,
            separator: true,
            onClick: () => {
              const name = prompt('Name of the new notebook', '')
              if (!name?.trim()) return
              const { notebook } = createNotebook(name)
              props.onNotebook(notebook.id)
            },
          },
          {
            label: 'Rename notebook',
            icon: Icons.text,
            disabled: !nb,
            onClick: () => {
              const name = nb && prompt('Notebook name', nb.name)
              if (nb && name) renameNotebook(nb.id, name)
            },
          },
          { label: 'Export notebook (PDF)', icon: Icons.download, disabled: !nb, onClick: () => nb && props.onExport(notebookExport(nb.id)) },
          {
            label: 'Delete notebook',
            icon: Icons.trash,
            danger: true,
            separator: true,
            disabled: !nb || all.length < 2,
            onClick: () => {
              if (!nb) return
              const pages = sections.reduce((n, s) => n + pageCount(s.id), 0)
              if (!confirm(`Delete the notebook “${nb.name}” with its ${sections.length} section(s) and ${pages} page(s)?\nThis cannot be undone.`)) return
              const next = all.find((n) => n.id !== nb.id)
              if (next) props.onNotebook(next.id)
              void deleteNotebook(nb.id)
            },
          },
        ],
        'left',
      ),
    )
  }

  const sectionMenu = (s: SectionMeta) => (e: React.MouseEvent) => {
    e.preventDefault()
    const i = sections.findIndex((x) => x.id === s.id)
    setMenu(
      menuAt(
        e,
        [
          { label: 'Rename / colour…', icon: Icons.palette, onClick: () => setEditing({ section: s }) },
          { label: 'Move left', icon: Icons.left, disabled: i <= 0, onClick: () => shiftSection(s.id, -1) },
          { label: 'Move right', icon: Icons.right, disabled: i >= sections.length - 1, onClick: () => shiftSection(s.id, 1) },
          { label: 'Move to notebook…', icon: Icons.book, disabled: notebooks().length < 2, onClick: () => setMovingSection(s) },
          { label: 'Export section (PDF)', icon: Icons.download, separator: true, onClick: () => props.onExport(sectionExport(s.id)) },
          {
            label: 'Delete section',
            icon: Icons.trash,
            danger: true,
            separator: true,
            onClick: () => {
              const n = pageCount(s.id)
              if (!confirm(`Delete the section “${s.name}”${n ? ` and its ${n} page(s)` : ''}?\nThis cannot be undone.`)) return
              void deleteSection(s.id)
            },
          },
        ],
        'left',
      ),
    )
  }

  return (
    <header className="topbar">
      <button
        className={'tbtn' + (props.treeOpen ? ' active' : '')}
        aria-label="Pages"
        title="Show / hide pages"
        onClick={props.onToggleTree}
      >
        {Icons.sidebar}
      </button>
      <button className="nb-switch" title="Notebooks" onClick={notebookMenu}>
        {Icons.book}
        <span>{nb?.name ?? 'Notebook'}</span>
        <span className="nb-caret">▾</span>
      </button>
      <div className="tabs" role="tablist" ref={tabsRef}>
        {sections.map((s) => {
          const active = s.id === props.sectionId
          return (
            <button
              key={s.id}
              role="tab"
              aria-selected={active}
              data-section-id={s.id}
              className={'tab' + (active ? ' active' : '')}
              style={{ ['--tab' as string]: s.color }}
              title={active ? `${s.name} · tap again for options` : s.name}
              onClick={(e) => (active ? sectionMenu(s)(e) : props.onSection(s.id))}
              onContextMenu={sectionMenu(s)}
            >
              <span className="tab-name">{s.name}</span>
              {active && <span className="tab-caret">▾</span>}
            </button>
          )
        })}
        <button className="tab tab-add" aria-label="New section" title="New section" disabled={!nb} onClick={() => setEditing({})}>
          {Icons.plus}
        </button>
      </div>
      <button className="tbtn" aria-label="Search" title="Search (Ctrl/⌘+K)" onClick={props.onSearch}>
        {Icons.search}
      </button>
      <button className={'sync-mini sync-' + props.sync.kind} title={props.sync.kind === 'off' ? 'Sync is off' : describe(props.sync)} onClick={props.onOpenSync}>
        <span className="sync-dot" />
      </button>
      <ThemeMenu />

      {menu && <ActionMenu menu={menu} onClose={() => setMenu(null)} />}
      {editing && nb && (
        <SectionDialog
          title={editing.section ? 'Section' : 'New section'}
          name={editing.section?.name}
          color={editing.section?.color ?? SECTION_COLORS[sections.length % SECTION_COLORS.length]}
          onSave={(name, color) => {
            if (editing.section) updateSection(editing.section.id, { name, color })
            else props.onSection(createSection(nb.id, name, color).id)
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {movingSection && (
        <PickDialog
          title={`Move “${movingSection.name}” to…`}
          items={notebooks().map((n) => ({ id: n.id, label: n.name, icon: Icons.book, disabled: n.id === movingSection.notebookId }))}
          onPick={(id) => {
            moveSectionToNotebook(movingSection.id, id)
            setMovingSection(null)
          }}
          onClose={() => setMovingSection(null)}
        />
      )}
    </header>
  )
}

