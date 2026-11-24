/**
 * Where this device keeps its data. Everything that stores notes goes through
 * here, so the same app can keep them in the browser (web app, iPad) or in a
 * folder of files (NeatNotes for Windows, see folderBackend.ts).
 *
 * Three kinds of data:
 * - documents (Yjs): the page list, each page, and for sync the "shadow" copy
 *   of what GitHub already has of a document
 * - pictures, by id
 * - small sync bookkeeping (which GitHub files were taken in, …)
 */
import type * as Y from 'yjs'
import { IndexeddbPersistence } from 'y-indexeddb'
import { createStore, get, set } from 'idb-keyval'
import { desktop } from '../desktop/api'
import { folderBackend } from './folderBackend'

/**
 * Keeps a Y.Doc stored: loads what is stored into it (as a transaction whose
 * origin is this object), then stores every later change.
 */
export interface DocPersistence {
  readonly whenSynced: Promise<unknown>
  /** stops storing; resolves once everything is written */
  destroy(): Promise<void>
  /** deletes the stored document */
  clearData(): Promise<void>
}

/** The page list, one page, or (sync) what GitHub already has of a document. */
export type DocName = 'workspace' | `page:${string}` | `shadow:${string}`

export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
}

export interface Backend {
  persistDoc(name: DocName, doc: Y.Doc): DocPersistence
  images: {
    get(id: string): Promise<Blob | undefined>
    set(id: string, blob: Blob): Promise<void>
  }
  syncMeta: KeyValueStore
  /** a stored document was changed from outside this app (files that arrived e.g. through OneDrive) */
  onExternalChange?(fn: (name: DocName) => void): () => void
}

// ---------- in the browser (IndexedDB) ----------

function browserBackend(): Backend {
  const images = createStore('inkpad-images', 'blobs')
  const meta = createStore('inkpad-sync', 'meta')
  return {
    // database names as they have always been, so existing data is found
    persistDoc: (name, doc) => new IndexeddbPersistence(`inkpad:${name}`, doc),
    images: {
      get: (id) => get<Blob>(id, images),
      set: (id, blob) => set(id, blob, images),
    },
    syncMeta: {
      get: <T>(key: string) => get<T>(key, meta),
      set: (key, value) => set(key, value, meta),
    },
  }
}

/** The Windows app keeps notes as files in a folder; the web app in the browser. */
export const backend: Backend = desktop ? folderBackend(desktop) : browserBackend()
