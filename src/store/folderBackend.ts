/**
 * Storage in a folder of files, for the NeatNotes Windows app.
 *
 * The notes folder has the same layout as the GitHub notes repository:
 *   v2/workspace/<file>        the page list
 *   v2/pages/<pageId>/<file>   the contents of one page
 *   images/<imageId>           pictures
 * This computer's own sync bookkeeping is kept apart, in %AppData%\NeatNotes\device.
 *
 * A document is a folder of Yjs updates. Changes are written a moment after
 * they are made, each time as a NEW file with a unique name; existing files
 * are never changed. When a folder has many files they are merged into one
 * snapshot and the merged ones deleted. So the folder can be copied at any
 * time, and kept in sync by e.g. OneDrive without conflicting copies: files
 * that arrive from elsewhere are noticed and merged into open pages.
 */
import * as Y from 'yjs'
import { nanoid } from 'nanoid'
import type { Backend, DocName, DocPersistence, KeyValueStore } from './backend'
import type { DesktopApi, Root } from '../desktop/api'
import { sniffType } from './mime'

/** write this long after the last change… */
const WRITE_DELAY = 400
/** …but at least this often while changes keep coming */
const MAX_WRITE_DELAY = 2_000
/** merge a document's files into one once it has this many */
const COMPACT_AT = 40
/** after a failed write, try again after this long */
const RETRY_DELAY = 5_000

/** unique per app start, so two computers sharing the folder never pick the same file name */
const session = nanoid(6)
let counter = 0
const fileName = (kind: 'u' | 's') => `${kind}-${Date.now().toString(36)}-${session}-${(counter++).toString(36)}.bin`
const isDataFile = (name: string) => name.endsWith('.bin') && !name.startsWith('.')

function locate(name: DocName): { root: Root; dir: string } {
  if (name === 'workspace') return { root: 'notes', dir: 'v2/workspace' }
  if (name.startsWith('page:')) return { root: 'notes', dir: `v2/pages/${name.slice(5)}` }
  return { root: 'device', dir: `shadows/${name.slice(7)}` }
}

/** a write to the folder failed (shown to the user); null once writing works again */
type ProblemListener = (message: string | null) => void
const problemListeners = new Set<ProblemListener>()
let problem: string | null = null
function setProblem(p: string | null) {
  if (p === problem) return
  problem = p
  problemListeners.forEach((fn) => fn(p))
}
export const storageProblem = () => problem
export function onStorageProblem(fn: ProblemListener) {
  problemListeners.add(fn)
  return () => problemListeners.delete(fn)
}

class FolderDoc implements DocPersistence {
  readonly whenSynced: Promise<void>
  /** files whose contents this document has (read or written by it) */
  private known = new Set<string>()
  private pending: Uint8Array[] = []
  private timer = 0
  private firstPendingAt = 0
  /** writes go one after another */
  private chain: Promise<void> = Promise.resolve()
  private closed = false

  constructor(
    private api: DesktopApi,
    readonly root: Root,
    readonly dir: string,
    private doc: Y.Doc,
    private all: Set<FolderDoc>,
  ) {
    doc.on('update', this.onUpdate)
    all.add(this)
    this.whenSynced = this.readNew().then(() => undefined)
  }

  private onUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === this || this.closed) return
    this.pending.push(update)
    const now = Date.now()
    if (this.pending.length === 1) this.firstPendingAt = now
    clearTimeout(this.timer)
    const wait = Math.max(0, Math.min(WRITE_DELAY, this.firstPendingAt + MAX_WRITE_DELAY - now))
    this.timer = window.setTimeout(() => void this.flush(), wait)
  }

  /** Takes in the files of the folder this document does not have yet; true if there were any. */
  async readNew(): Promise<boolean> {
    const names = (await this.api.list(this.root, this.dir)).filter((n) => isDataFile(n) && !this.known.has(n))
    if (!names.length || this.closed) return false
    const contents = await Promise.all(names.map((n) => this.api.read(this.root, `${this.dir}/${n}`)))
    if (this.closed) return false
    let took = false
    this.doc.transact(() => {
      names.forEach((n, i) => {
        const data = contents[i]
        if (!data) return // deleted in the meantime (merged elsewhere)
        try {
          Y.applyUpdate(this.doc, data, this)
          this.known.add(n)
          took = true
        } catch (e) {
          console.warn('NeatNotes: skipped an unreadable file', `${this.dir}/${n}`, e)
        }
      })
    }, this)
    return took
  }

  /** Writes the changes not written yet. */
  flush(): Promise<void> {
    clearTimeout(this.timer)
    if (!this.pending.length) return this.chain
    const updates = this.pending
    this.pending = []
    const update = updates.length === 1 ? updates[0] : Y.mergeUpdates(updates)
    const name = fileName('u')
    this.known.add(name) // before writing, so the folder watcher does not read it back
    this.chain = this.chain
      .then(() => this.api.write(this.root, `${this.dir}/${name}`, update))
      .then(
        () => {
          setProblem(null)
          return this.compact()
        },
        (e) => {
          // keep the changes and try again later
          this.known.delete(name)
          this.pending.unshift(update)
          if (!this.closed) this.timer = window.setTimeout(() => void this.flush(), RETRY_DELAY)
          setProblem(`Could not save to the notes folder: ${e instanceof Error ? e.message : String(e)}`)
        },
      )
    return this.chain
  }

  /** Many files: one snapshot instead. Only files this document has taken in are deleted. */
  private async compact() {
    if (this.known.size < COMPACT_AT || this.closed) return
    const old = [...this.known]
    const name = fileName('s')
    try {
      this.known.add(name)
      await this.api.write(this.root, `${this.dir}/${name}`, Y.encodeStateAsUpdate(this.doc))
    } catch (e) {
      // nothing lost: the small files are still there; merged another time
      this.known.delete(name)
      console.warn('NeatNotes: could not merge', this.dir, e)
      return
    }
    for (const n of old) {
      try {
        await this.api.remove(this.root, `${this.dir}/${n}`)
        this.known.delete(n)
      } catch (e) {
        console.warn('NeatNotes: could not delete a merged file', `${this.dir}/${n}`, e)
      }
    }
  }

  async destroy() {
    await this.flush()
    this.close()
  }

  async clearData() {
    this.pending = []
    this.close()
    await this.chain.catch(() => {})
    await this.api.removeDir(this.root, this.dir)
  }

  private close() {
    this.closed = true
    clearTimeout(this.timer)
    this.doc.off('update', this.onUpdate)
    this.all.delete(this)
  }
}

/** Small values, one JSON file each. */
function jsonStore(api: DesktopApi, root: Root, dir: string): KeyValueStore {
  return {
    async get<T>(key: string) {
      const data = await api.read(root, `${dir}/${key}.json`)
      if (!data) return undefined
      return (JSON.parse(new TextDecoder().decode(data)) ?? undefined) as T | undefined
    },
    set: (key, value) => api.write(root, `${dir}/${key}.json`, new TextEncoder().encode(JSON.stringify(value ?? null))),
  }
}

export function folderBackend(api: DesktopApi): Backend {
  const open = new Set<FolderDoc>()
  const externalListeners = new Set<(name: DocName) => void>()

  // Files that arrived from elsewhere (e.g. OneDrive): merge them into the open documents.
  api.onNotesChanged((paths) => {
    const dirs = new Set(paths.map((p) => p.slice(0, p.lastIndexOf('/'))))
    for (const d of open) {
      if (d.root !== 'notes' || !dirs.has(d.dir)) continue
      void d.readNew().then((took) => {
        if (!took) return
        const name: DocName = d.dir === 'v2/workspace' ? 'workspace' : `page:${d.dir.slice('v2/pages/'.length)}`
        externalListeners.forEach((fn) => fn(name))
      })
    }
  })
  // write everything before the window closes, and when the app is put away
  const flushAll = async () => {
    await Promise.all([...open].map((d) => d.flush()))
  }
  api.onFlushRequest(flushAll)
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void flushAll())

  return {
    persistDoc(name, doc) {
      const { root, dir } = locate(name)
      return new FolderDoc(api, root, dir, doc, open)
    },
    images: {
      async get(id) {
        const data = await api.read('notes', `images/${id}`)
        return data ? new Blob([data as BlobPart], { type: sniffType(data) }) : undefined
      },
      set: async (id, blob) => api.write('notes', `images/${id}`, new Uint8Array(await blob.arrayBuffer())),
    },
    syncMeta: jsonStore(api, 'device', 'sync'),
    onExternalChange(fn) {
      externalListeners.add(fn)
      return () => externalListeners.delete(fn)
    },
  }
}
