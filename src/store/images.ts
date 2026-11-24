import { nanoid } from 'nanoid'
import { backend } from './backend'

const store = backend.images
const urlCache = new Map<string, Promise<string | null>>()

// ---------- sync support ----------

const PENDING_KEY = 'inkpad:img-pending'
const pending = new Set<string>(JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]'))
const savePending = () => localStorage.setItem(PENDING_KEY, JSON.stringify([...pending]))
export const pendingImages = () => [...pending]
export function clearPendingImage(id: string) {
  pending.delete(id)
  savePending()
}
export const getImageBlob = (id: string) => store.get(id)

/** Set by the sync engine: downloads a picture this device does not have yet. */
let fetchRemote: ((id: string) => Promise<Uint8Array | null>) | null = null
export function setRemoteImageFetcher(fn: typeof fetchRemote) {
  fetchRemote = fn
}

function sniffType(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xff && b[1] === 0xd8) return 'image/jpeg'
  if (b[0] === 0x47 && b[1] === 0x49) return 'image/gif'
  if (b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp'
  return 'application/octet-stream'
}

async function loadImage(id: string): Promise<string | null> {
  let blob = await store.get(id)
  if (!blob && fetchRemote) {
    const bytes = await fetchRemote(id).catch(() => null)
    if (bytes) {
      blob = new Blob([bytes as BlobPart], { type: sniffType(bytes) })
      await store.set(id, blob)
    }
  }
  return blob ? URL.createObjectURL(blob) : null
}

/** Longest side, in pixels, kept for pasted images. Larger ones are scaled down. */
const MAX_SIDE = 2000
const MAX_BYTES_UNTOUCHED = 1_500_000

export interface StoredImage {
  id: string
  width: number
  height: number
}

/** Shrinks big images, stores the blob locally and returns its id and size. */
export async function storeImage(input: Blob): Promise<StoredImage> {
  const bitmap = await createImageBitmap(input)
  let { width, height } = bitmap
  let blob: Blob = input
  const scale = Math.min(1, MAX_SIDE / Math.max(width, height))
  if (scale < 1 || input.size > MAX_BYTES_UNTOUCHED) {
    width = Math.round(width * scale)
    height = Math.round(height * scale)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height)
    blob = (await toBlob(canvas, 'image/webp', 0.85)) ?? blob
    // Safari cannot encode WebP and silently returns PNG; JPEG is much smaller then.
    if (blob.type !== 'image/webp' && blob.size > MAX_BYTES_UNTOUCHED) {
      blob = (await toBlob(canvas, 'image/jpeg', 0.85)) ?? blob
    }
  }
  bitmap.close()
  const id = await contentId(blob)
  if (!(await store.get(id))) {
    await store.set(id, blob)
    pending.add(id)
    savePending()
  }
  return { id, width, height }
}

export function imageUrl(id: string): Promise<string | null> {
  let p = urlCache.get(id)
  if (!p) {
    p = loadImage(id)
    urlCache.set(id, p)
    // not available yet (offline, or not synced): allow a later retry
    p.then((u) => u || urlCache.delete(id))
  }
  return p
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Same image → same id, so syncing later never uploads duplicates. */
async function contentId(blob: Blob): Promise<string> {
  // crypto.subtle only exists on https / localhost
  if (!crypto?.subtle) return nanoid(24)
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return [...new Uint8Array(hash)].slice(0, 16).map((b) => b.toString(16).padStart(2, '0')).join('')
}
