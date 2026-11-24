/**
 * Persistent storage: asks the browser not to clear this app's data (notes,
 * pictures, sync state) when the device runs low on space.
 *
 * Without it, the data is "best effort": Chrome/Edge may delete it under
 * storage pressure, and Safari may delete website data that has not been used
 * for 7 days (apps added to the home screen are exempt). With it, only the
 * user can delete it.
 *
 * Browsers decide differently: Chrome/Edge grant it without asking once the
 * app is installed or used often, Firefox asks the user, Safari mostly grants
 * it. A refusal is not final, so the request is repeated at every start, when
 * the app is installed, and from the settings.
 */

export interface StorageStatus {
  /** null: this browser cannot tell */
  persisted: boolean | null
  /** bytes used by this app on this device, if the browser says */
  usage?: number
}

export async function requestPersistence(): Promise<boolean> {
  try {
    if (await navigator.storage?.persisted?.()) return true
    return (await navigator.storage?.persist?.()) ?? false
  } catch {
    return false
  }
}

export async function storageStatus(): Promise<StorageStatus> {
  let persisted: boolean | null = null
  let usage: number | undefined
  try {
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted()
  } catch {
    /* unknown */
  }
  try {
    usage = (await navigator.storage?.estimate?.())?.usage
  } catch {
    /* unknown */
  }
  return { persisted, usage }
}

export function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 ** 3) return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`
  return `${(n / 1024 ** 3).toFixed(1)} GB`
}

/** At start, and again once the app is installed (Chrome/Edge grant it to installed apps). */
export function keepDataSafe() {
  void requestPersistence()
  window.addEventListener('appinstalled', () => void requestPersistence())
}
