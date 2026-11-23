import { useEffect, useRef, useState } from 'react'
import type { ExportRequest } from '../export/plan'
import { exportPages } from '../export/plan'
import type { Progress } from '../export/pdf'
import { Icons } from './icons'

type State = { kind: 'working'; progress: Progress | null } | { kind: 'done'; file: File } | { kind: 'error'; message: string }

const fileName = (title: string) => `${(title.trim() || 'InkPad').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80)}.pdf`

/**
 * Builds the PDF, then offers it. The download (or share sheet) starts from a
 * button press, because browsers only allow that right after a tap or click,
 * and building a big PDF takes longer than that allowance lasts.
 */
export default function ExportDialog({ req, onClose }: { req: ExportRequest; onClose(): void }) {
  const [state, setState] = useState<State>({ kind: 'working', progress: null })
  const cancelled = useRef(false)
  const count = exportPages(req).length

  useEffect(() => {
    cancelled.current = false
    import('../export/pdf')
      .then(({ exportPdf }) =>
        exportPdf(req, (progress) => !cancelled.current && setState({ kind: 'working', progress }), () => cancelled.current),
      )
      .then((blob) => !cancelled.current && setState({ kind: 'done', file: new File([blob], fileName(req.title), { type: 'application/pdf' }) }))
      .catch((e: Error) => {
        if (cancelled.current || e.name === 'Cancelled') return
        console.error(e)
        setState({ kind: 'error', message: e.message || String(e) })
      })
    return () => {
      cancelled.current = true
    }
  }, [req])

  const close = () => {
    cancelled.current = true
    onClose()
  }

  const download = (file: File) => {
    const a = document.createElement('a')
    a.href = URL.createObjectURL(file)
    a.download = file.name
    document.body.append(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(a.href), 60_000)
  }
  const canShare = (file: File) => navigator.maxTouchPoints > 0 && !!navigator.canShare?.({ files: [file] })

  return (
    <div className="paste-sheet" onClick={state.kind === 'working' ? undefined : close}>
      <div className="sync-card export-card" onClick={(e) => e.stopPropagation()}>
        <div className="paste-title">Export “{req.title}” as PDF</div>
        {state.kind === 'working' && (
          <>
            <p className="sync-help">
              {state.progress && state.progress.total > 0
                ? `Page ${Math.min(state.progress.done + 1, state.progress.total)} of ${state.progress.total}${state.progress.page ? ` · ${state.progress.page}` : ''}`
                : `Preparing ${count} page${count === 1 ? '' : 's'}…`}
            </p>
            <div className="progress">
              <span style={{ width: `${state.progress?.total ? (100 * state.progress.done) / state.progress.total : 3}%` }} />
            </div>
            <div className="sync-actions">
              <button className="link-btn" onClick={close}>
                Cancel
              </button>
            </div>
          </>
        )}
        {state.kind === 'done' && (
          <>
            <p className="sync-ok">
              Ready: {state.file.name} ({(state.file.size / 1024 / 1024).toFixed(state.file.size > 1e6 ? 1 : 2)} MB)
            </p>
            <div className="sync-actions">
              <button className="link-btn" onClick={close}>
                Close
              </button>
              {canShare(state.file) && (
                <button
                  className="primary-btn secondary"
                  onClick={() => navigator.share({ files: [state.file], title: state.file.name }).catch(() => undefined)}
                >
                  {Icons.share} Share / Save to Files
                </button>
              )}
              <button className="primary-btn" onClick={() => download(state.file)}>
                {Icons.download} Download
              </button>
            </div>
          </>
        )}
        {state.kind === 'error' && (
          <>
            <p className="sync-error">Export failed: {state.message}</p>
            <div className="sync-actions">
              <button className="link-btn" onClick={close}>
                Close
              </button>
            </div>
          </>
        )}
        {count === 0 && state.kind !== 'error' && <p className="sync-help">There are no pages to export.</p>}
      </div>
    </div>
  )
}
