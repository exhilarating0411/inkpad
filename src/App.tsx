import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Canvas, { type CanvasApi, type CanvasContext, type InkSettings } from './canvas/Canvas'
import Toolbar, { HL_COLORS, HL_SIZES, PEN_COLORS, PEN_SIZES, TEXT_SIZES } from './components/Toolbar'
import PageTree, { type TreeMode } from './components/PageTree'
import TopBar from './components/TopBar'
import ExportDialog from './components/ExportDialog'
import { useWorkspaceVersion } from './components/Menu'
import { Icons } from './components/icons'
import type { NotebookMeta, PageKind, PageMeta, SectionMeta, Tool } from './store/types'
import { addPage, ancestors, flatTree, notebooks, sectionsOf, structureReady } from './store/structure'
import type { ExportRequest } from './export/plan'

// The document editor is only downloaded when a document is opened.
const MarkdownPage = lazy(() => import('./markdown/MarkdownPage'))
import SyncSettings from './components/SyncSettings'
import { getSyncState, onSyncState, type SyncState } from './sync/sync'
import { notebooksMap, pagesMap, renamePage, sectionsMap, updatePage } from './store/workspace'
import { paperOf, rememberPaper } from './paper'

const DEFAULT_INK: InkSettings = {
  penColor: PEN_COLORS[0],
  penSize: PEN_SIZES[1],
  hlColor: HL_COLORS[0],
  hlSize: HL_SIZES[1],
  textColor: PEN_COLORS[0],
  textSize: TEXT_SIZES[1],
  fingerDraw: false,
}

function useStored<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : { ...initial, ...JSON.parse(raw) }
    } catch {
      return initial
    }
  })
  useEffect(() => localStorage.setItem(key, JSON.stringify(value)), [key, value])
  return [value, setValue] as const
}

function useStoredString<T extends string>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => (localStorage.getItem(key) as T) ?? initial)
  useEffect(() => localStorage.setItem(key, value), [key, value])
  return [value, setValue] as const
}

/** docked: the page list stays next to the page; overlay: it slides over it */
const treeModeFor = (w: number): TreeMode => (w >= 900 ? 'docked' : 'overlay')

function useTreeMode() {
  const [mode, setMode] = useState(() => treeModeFor(window.innerWidth))
  useEffect(() => {
    const on = () => setMode(treeModeFor(window.innerWidth))
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  return mode
}
const hasTouch = () => navigator.maxTouchPoints > 0

/** Remembers, per notebook, the section last open, and per section, the page last open. */
const lastOpen = {
  read(key: string): Record<string, string> {
    try {
      return JSON.parse(localStorage.getItem(key) ?? '{}')
    } catch {
      return {}
    }
  },
  write(key: string, id: string, value: string) {
    const m = lastOpen.read(key)
    if (m[id] === value) return
    m[id] = value
    localStorage.setItem(key, JSON.stringify(m))
  },
}
const LAST_SECTION = 'inkpad:last-section'
const LAST_PAGE = 'inkpad:last-page'

/**
 * Turns the remembered notebook / section / page into ones that exist and fit
 * together (something may have been deleted, here or on another device).
 */
function resolve(nbId: string, secId: string, pageId: string): { nb?: NotebookMeta; sec?: SectionMeta; page?: PageMeta } {
  const page0 = pagesMap.get(pageId)
  const sec0 = sectionsMap.get(secId)
  const pageSec = page0?.sectionId ? sectionsMap.get(page0.sectionId) : undefined
  const nb =
    notebooksMap.get(nbId) ??
    (sec0 && notebooksMap.get(sec0.notebookId)) ??
    (pageSec && notebooksMap.get(pageSec.notebookId)) ??
    notebooks()[0]
  if (!nb) return { nb: undefined, sec: undefined, page: undefined }
  const inNb = (id?: string) => {
    const s = id ? sectionsMap.get(id) : undefined
    return s && s.notebookId === nb.id ? s : undefined
  }
  const sec = inNb(sec0?.id) ?? inNb(pageSec?.id) ?? inNb(lastOpen.read(LAST_SECTION)[nb.id]) ?? sectionsOf(nb.id)[0]
  if (!sec) return { nb, sec: undefined, page: undefined }
  const inSec = (id?: string) => {
    const p = id ? pagesMap.get(id) : undefined
    return p && p.sectionId === sec.id ? p : undefined
  }
  const page = inSec(page0?.id) ?? inSec(lastOpen.read(LAST_PAGE)[sec.id]) ?? flatTree(sec.id)[0]?.page
  return { nb, sec, page }
}

export default function App() {
  const [ready, setReady] = useState(false)
  const [nbId, setNbId] = useStoredString<string>('inkpad:notebook', '')
  const [secId, setSecId] = useStoredString<string>('inkpad:section', '')
  const [currentId, setCurrentId] = useStoredString<string>('inkpad:current', '')
  const [tool, setTool] = useStoredString<Tool>('inkpad:tool', 'pen')
  const [ink, setInk] = useStored<InkSettings>('inkpad:ink', DEFAULT_INK)
  const [penDetected, setPenDetected] = useState(() => localStorage.getItem('inkpad:pen') === '1')
  const treeMode = useTreeMode()
  const [dockedOpen, setDockedOpen] = useStoredString<'1' | '0'>('inkpad:tree', '1')
  const [overlayOpen, setOverlayOpen] = useState(false)
  const treeOpen = treeMode === 'docked' ? dockedOpen === '1' : overlayOpen
  const setTreeOpen = (open: boolean) => (treeMode === 'docked' ? setDockedOpen(open ? '1' : '0') : setOverlayOpen(open))
  const [searching, setSearching] = useState(false)
  const [searchFocus, setSearchFocus] = useState(0)
  const [exporting, setExporting] = useState<ExportRequest | null>(null)
  useWorkspaceVersion()
  const [zoom, setZoom] = useState(1)
  const [canvasCtx, setCanvasCtx] = useState<CanvasContext>({ selectionCount: 0, textActive: false })
  const api = useRef<CanvasApi | null>(null)
  const [sync, setSync] = useState<SyncState>(getSyncState)
  const [syncOpen, setSyncOpen] = useState(false)
  useEffect(() => {
    const off = onSyncState(setSync)
    return () => void off()
  }, [])

  useEffect(() => {
    void structureReady.then(() => setReady(true))
  }, [])

  const { nb, sec, page: current } = ready ? resolve(nbId, secId, currentId) : {}

  // keep the stored ids in step with what is really shown, and remember it
  useEffect(() => {
    if (!ready) return
    if (nb && nb.id !== nbId) setNbId(nb.id)
    if (sec && sec.id !== secId) setSecId(sec.id)
    if (current && current.id !== currentId) setCurrentId(current.id)
    if (nb && sec) lastOpen.write(LAST_SECTION, nb.id, sec.id)
    if (sec && current) lastOpen.write(LAST_PAGE, sec.id, current.id)
  })

  const openPage = (id: string) => {
    const p = pagesMap.get(id)
    const s = p?.sectionId ? sectionsMap.get(p.sectionId) : undefined
    if (!p || !s) return
    setNbId(s.notebookId)
    setSecId(s.id)
    setCurrentId(id)
    if (treeMode !== 'docked') setOverlayOpen(false)
  }
  const openSection = (id: string) => {
    setSecId(id)
    setCurrentId(lastOpen.read(LAST_PAGE)[id] ?? '')
  }
  const openNotebook = (id: string) => {
    setNbId(id)
    setSecId(lastOpen.read(LAST_SECTION)[id] ?? '')
  }
  const newPage = (kind: PageKind) => sec && openPage(addPage(kind, sec.id).id)
  const startSearch = () => {
    setTreeOpen(true)
    setSearching(true)
    setSearchFocus((n) => n + 1)
  }

  // Ctrl/⌘+K: search
  const startSearchRef = useRef(startSearch)
  startSearchRef.current = startSearch
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k' && !document.querySelector('.cm-focused')) {
        e.preventDefault()
        startSearchRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  const onPenDetected = useCallback(() => {
    localStorage.setItem('inkpad:pen', '1')
    setPenDetected(true)
  }, [])

  if (!ready) return <div className="loading">Loading…</div>

  const parents = current ? ancestors(current.id) : []

  return (
    <div className="app">
      <TopBar
        notebookId={nb?.id ?? ''}
        sectionId={sec?.id ?? ''}
        onNotebook={openNotebook}
        onSection={openSection}
        treeOpen={treeOpen}
        onToggleTree={() => {
          setTreeOpen(!treeOpen)
          setSearching(false)
        }}
        onSearch={startSearch}
        sync={sync}
        onOpenSync={() => setSyncOpen(true)}
        onExport={setExporting}
      />
      <div className="body">
        {treeOpen && (
          <PageTree
            mode={treeMode}
            notebookId={nb?.id ?? ''}
            sectionId={sec?.id ?? ''}
            currentId={current?.id ?? ''}
            onOpenPage={openPage}
            onClose={() => setTreeOpen(false)}
            searching={searching}
            onSearching={setSearching}
            searchFocus={searchFocus}
            sync={sync}
            onOpenSync={() => setSyncOpen(true)}
            onExport={setExporting}
          />
        )}
        <main className="main">
          {current ? (
            <>
              <header className="header">
                <div className="title-stack">
                  {parents.length > 0 && (
                    <nav className="crumbs" aria-label="Parent pages">
                      {parents.map((p, i) => (
                        <span key={p.id}>
                          {i > 0 && <span className="sep-crumb">›</span>}
                          <button onClick={() => openPage(p.id)}>{p.title || 'Untitled'}</button>
                        </span>
                      ))}
                    </nav>
                  )}
                  <TitleInput key={current.id} page={current} />
                </div>
              </header>
              {current.kind === 'markdown' ? (
                <Suspense fallback={<div className="loading">Loading editor…</div>}>
                  <MarkdownPage key={current.id} pageId={current.id} title={current.title} />
                </Suspense>
              ) : (
                <>
                  <Toolbar
                    tool={tool}
                    onTool={setTool}
                    ink={ink}
                    onInk={(patch) => setInk((s) => ({ ...s, ...patch }))}
                    api={api}
                    zoom={zoom}
                    paper={paperOf(current.paper)}
                    onPaper={(paper) => {
                      rememberPaper(paper)
                      updatePage(current.id, { paper })
                    }}
                    selectionCount={canvasCtx.selectionCount}
                    textActive={canvasCtx.textActive}
                    showFingerToggle={hasTouch() && penDetected}
                  />
                  <Canvas
                    key={current.id}
                    pageId={current.id}
                    paper={paperOf(current.paper)}
                    tool={tool}
                    ink={ink}
                    apiRef={api}
                    onToolChange={setTool}
                    penDetected={penDetected}
                    onPenDetected={onPenDetected}
                    onZoomChange={setZoom}
                    onContextChange={setCanvasCtx}
                  />
                </>
              )}
            </>
          ) : (
            <div className="main-empty">
              {sec ? (
                <>
                  <p>
                    <b>{sec.name}</b> has no pages yet.
                  </p>
                  <div className="main-empty-actions">
                    <button className="primary-btn" onClick={() => newPage('canvas')}>
                      {Icons.pen} Handwriting page
                    </button>
                    <button className="primary-btn secondary" onClick={() => newPage('markdown')}>
                      {Icons.doc} Document
                    </button>
                  </div>
                </>
              ) : (
                <p>This notebook has no sections yet. Add one with the + next to the tabs at the top.</p>
              )}
            </div>
          )}
        </main>
      </div>
      {syncOpen && <SyncSettings state={sync} onClose={() => setSyncOpen(false)} />}
      {exporting && <ExportDialog req={exporting} onClose={() => setExporting(null)} />}
    </div>
  )
}

function TitleInput({ page }: { page: PageMeta }) {
  const [title, setTitle] = useState(page.title)
  useEffect(() => {
    if (document.activeElement?.id !== 'page-title') setTitle(page.title)
  }, [page.title])
  return (
    <input
      id="page-title"
      className="title-input"
      value={title}
      placeholder="Untitled page"
      onChange={(e) => {
        setTitle(e.target.value)
        renamePage(page.id, e.target.value)
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  )
}
