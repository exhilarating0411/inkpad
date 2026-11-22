import { useState } from 'react'
import { connect, disconnect, loadConfig, syncNow, type SyncState } from '../sync/sync'

export default function SyncSettings({ state, onClose }: { state: SyncState; onClose(): void }) {
  const saved = loadConfig()
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
        {saved && !error && <p className="sync-ok">{describe(state)}</p>}

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

export function describe(s: SyncState): string {
  switch (s.kind) {
    case 'off':
      return 'Saved on this device · sync is off'
    case 'syncing':
      return 'Syncing…'
    case 'offline':
      return 'Offline · will sync when back online'
    case 'error':
      return `Sync problem: ${s.message}`
    case 'idle':
      return s.lastSync ? `Synced ${new Date(s.lastSync).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Sync on'
  }
}
