import { useEffect, useReducer, useState } from 'react'
import { connect, disconnect, loadConfig, syncNow, type SyncState } from '../sync/sync'
import { WORKSPACE_DOC, dirtyDocs, onDirtyChange, pagesMap } from '../store/workspace'

export default function SyncSettings({ state, onClose }: { state: SyncState; onClose(): void }) {
  const saved = loadConfig()
  const pending = usePending()
  const [owner, setOwner] = useState(saved?.owner ?? '')
  const [repo, setRepo] = useState(saved?.repo ?? 'inkpad-notes')
  const [token, setToken] = useState(saved?.token ?? '')
  const [branch, setBranch] = useState(saved?.branch ?? 'main')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      // tests point the app at a fake GitHub; real use never sets this
      const apiBase = localStorage.getItem('inkpad:test-api') ?? undefined
      await connect({ owner, repo, token, branch, apiBase })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="paste-sheet" onClick={onClose}>
      <form className="sync-card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="paste-title">Sync with GitHub</div>
        <p className="sync-help">
          Your notes are saved in a <b>private</b> GitHub repository, and every device with these settings stays in sync.
        </p>
        <label>
          GitHub user name
          <input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="your-name" autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
        </label>
        <label>
          Notes repository
          <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="inkpad-notes" autoCapitalize="off" autoCorrect="off" spellCheck={false} required />
        </label>
        <label>
          Access token
          <input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="github_pat_…"
            type="password"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </label>
        <details>
          <summary>Advanced</summary>
          <label>
            Branch
            <input value={branch} onChange={(e) => setBranch(e.target.value)} autoCapitalize="off" spellCheck={false} />
          </label>
        </details>

        {error && <p className="sync-error">{error}</p>}
        {saved && !error && <p className={isPending(state, pending) ? 'sync-waiting' : 'sync-ok'}>{describe(state, pending)}</p>}

        <div className="sync-actions">
          {saved && (
            <button
              type="button"
              className="paste-cancel"
              onClick={() => {
                if (confirm('Stop syncing on this device? Your notes stay on this device and on GitHub.')) {
                  disconnect()
                  onClose()
                }
              }}
            >
              Turn off
            </button>
          )}
          {saved && (
            <button type="button" className="paste-cancel" onClick={() => void syncNow()}>
              Sync now
            </button>
          )}
          <button type="submit" className="primary-btn" disabled={busy}>
            {busy ? 'Checking…' : saved ? 'Save' : 'Connect'}
          </button>
        </div>
        <button type="button" className="link-btn" onClick={onClose}>
          Close
        </button>
      </form>
    </div>
  )
}

/** What this device has not uploaded yet. */
export interface Pending {
  pages: number
  /** the list of notebooks, sections and pages changed */
  structure: boolean
}

export function usePending(): Pending {
  const [, bump] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    const off = onDirtyChange(bump)
    return () => void off()
  }, [])
  const ids = dirtyDocs()
  return { pages: ids.filter((id) => pagesMap.has(id)).length, structure: ids.includes(WORKSPACE_DOC) }
}

function pendingText(p: Pending): string {
  if (p.pages) return `${p.pages} page${p.pages === 1 ? '' : 's'} not uploaded yet`
  if (p.structure) return 'Page list not uploaded yet'
  return ''
}

/** Sync is on but something is still waiting to be uploaded (and no sync is running). */
export const isPending = (s: SyncState, p: Pending) => s.kind !== 'off' && s.kind !== 'syncing' && (p.pages > 0 || p.structure)

export function describe(s: SyncState, p: Pending = { pages: 0, structure: false }): string {
  const waiting = pendingText(p)
  switch (s.kind) {
    case 'off':
      return 'Saved on this device · sync is off'
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return waiting ? `Offline · ${waiting}` : 'Offline · will sync when back online'
    case 'error':
      return `Sync problem: ${s.message}${waiting ? ` · ${waiting}` : ''}`
    case 'idle':
      if (waiting) return waiting
      return s.lastSync ? `Synced ${new Date(s.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Sync on'
  }
}
