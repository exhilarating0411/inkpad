import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Canvas, { type CanvasApi, type CanvasContext, type InkSettings } from './canvas/Canvas'
import Toolbar, { HL_COLORS, HL_SIZES, PEN_COLORS, PEN_SIZES, TEXT_SIZES } from './components/Toolbar'
import Sidebar from './components/Sidebar'
import { Icons } from './components/icons'
import type { PageKind, PageMeta, Tool } from './store/types'

// The document editor is only downloaded when a document is opened.
const MarkdownPage = lazy(() => import('./markdown/MarkdownPage'))
import SyncSettings from './components/SyncSettings'
import { getSyncState, onSyncState, type SyncState } from './sync/sync'
import { createPage, deletePage, listPages, pagesMap, renamePage, workspaceReady } from './store/workspace'

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

const isWide = () => window.matchMedia('(min-width: 900px)').matches
const hasTouch = () => navigator.maxTouchPoints > 0

export default function App() {
  const [ready, setReady] = useState(false)
  const [pages, setPages] = useState<PageMeta[]>([])
  const [currentId, setCurrentId] = useStoredString<string>('inkpad:current', '')
  const [tool, setTool] = useStoredString<Tool>('inkpad:tool', 'pen')
  const [ink, setInk] = useStored<InkSettings>('inkpad:ink', DEFAULT_INK)
  const [penDetected, setPenDetected] = useState(() => localStorage.getItem('inkpad:pen') === '1')
  const [sidebarOpen, setSidebarOpen] = useState(isWide)
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
    const update = () => setPages(listPages())
    pagesMap.observe(update)
    workspaceReady.then(() => {
      update()
      setReady(true)
    })
    return () => pagesMap.unobserve(update)
  }, [])

  // Fall back to the first page when the remembered one is gone.
  useEffect(() => {
    if (ready && pages.length && !pages.some((p) => p.id === currentId)) setCurrentId(pages[0].id)
  }, [ready, pages, currentId, setCurrentId])

  const current = pages.find((p) => p.id === currentId)

  const selectPage = (id: string) => {
    setCurrentId(id)
    if (!isWide()) setSidebarOpen(false)
  }
  const onPenDetected = useCallback(() => {
    localStorage.setItem('inkpad:pen', '1')
    setPenDetected(true)
  }, [])

  if (!ready) return <div className="loading">Loading…</div>

  return (
    <div className={'app' + (sidebarOpen ? ' with-sidebar' : '')}>
      <Sidebar
        pages={pages}
        currentId={currentId}
        open={sidebarOpen}
        onSelect={selectPage}
        onCreate={(kind: PageKind) => selectPage(createPage(kind).id)}
        onDelete={(id) => void deletePage(id)}
        onClose={() => setSidebarOpen(false)}
        sync={sync}
        onOpenSync={() => setSyncOpen(true)}
      />
      {syncOpen && <SyncSettings state={sync} onClose={() => setSyncOpen(false)} />}
      <main className="main">
        <header className="header">
          <button className="tbtn" aria-label="Pages" title="Pages" onClick={() => setSidebarOpen((o) => !o)}>
            {Icons.menu}
          </button>
          {current && <TitleInput key={current.id} page={current} />}
        </header>
        {current?.kind === 'markdown' && (
          <Suspense fallback={<div className="loading">Loading editor…</div>}>
            <MarkdownPage key={current.id} pageId={current.id} title={current.title} />
          </Suspense>
        )}
        {current?.kind !== 'markdown' && (
        <Toolbar
          tool={tool}
          onTool={setTool}
          ink={ink}
          onInk={(patch) => setInk((s) => ({ ...s, ...patch }))}
          api={api}
          zoom={zoom}
          selectionCount={canvasCtx.selectionCount}
          textActive={canvasCtx.textActive}
          showFingerToggle={hasTouch() && penDetected}
        />
        )}
        {current && current.kind !== 'markdown' && (
          <Canvas
            key={current.id}
            pageId={current.id}
            tool={tool}
            ink={ink}
            apiRef={api}
            onToolChange={setTool}
            penDetected={penDetected}
            onPenDetected={onPenDetected}
            onZoomChange={setZoom}
            onContextChange={setCanvasCtx}
          />
        )}
      </main>
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
