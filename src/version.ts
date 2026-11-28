/** Which build of the app is running, and whether a newer one is online. */
import { useEffect, useState } from 'react'
import { desktop, isDesktop } from './desktop/api'

export interface AppVersion {
  /** short commit id, or "dev" for a build made on a computer */
  commit: string
  /** build time, ISO */
  built: string
}

declare const __APP_VERSION__: AppVersion
export const APP_VERSION: AppVersion = __APP_VERSION__

/** e.g. "Nov 23, 14:05 · 256e8ef", in the device's own time zone */
export function versionLabel(v: AppVersion): string {
  const when = new Date(v.built).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return `${desktop ? `${desktop.version} · ` : ''}${when} · ${v.commit}`
}

/** The version published on the website (null when offline, or when running the dev server). */
async function onlineVersion(): Promise<AppVersion | null> {
  // the Windows app updates itself from its own releases, not from the website
  if (isDesktop) return null
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const v = (await res.json()) as AppVersion
    return v.commit && v.built ? v : null
  } catch {
    return null
  }
}

/**
 * Website / home-screen app: fetches the newer version into the offline cache, then reloads into it.
 * (Without this, the cache only changes when the app is closed completely, and the new version
 * shows the time after that.) Fails when the new version cannot be downloaded, e.g. offline.
 */
export async function installWebUpdate(): Promise<void> {
  const reg = 'serviceWorker' in navigator ? await navigator.serviceWorker.getRegistration() : undefined
  if (reg) {
    await reg.update()
    const worker = reg.installing ?? reg.waiting
    if (worker)
      await new Promise<void>((resolve, reject) => {
        // a new version takes over as soon as it is installed (registerType: 'autoUpdate')
        const timer = window.setTimeout(resolve, 60_000)
        const check = () => {
          if (worker.state === 'activated') {
            window.clearTimeout(timer)
            resolve()
          } else if (worker.state === 'redundant') {
            window.clearTimeout(timer)
            reject(new Error('the new version could not be installed'))
          }
        }
        worker.addEventListener('statechange', check)
        check()
      })
  }
  location.reload()
}

/** Windows app: a newer version that was downloaded and is ready to install. */
export function useDesktopUpdate(): string | null {
  const [ready, setReady] = useState<string | null>(null)
  useEffect(() => (desktop ? desktop.onUpdateReady(setReady) : undefined), [])
  return ready
}

/** The newer version online, if there is one. Checked on start and whenever the app comes back to the screen. */
export function useNewerVersion(): AppVersion | null {
  const [newer, setNewer] = useState<AppVersion | null>(null)
  useEffect(() => {
    let alive = true
    const check = () =>
      void onlineVersion().then((v) => {
        if (alive) setNewer(v && v.commit !== APP_VERSION.commit && v.built > APP_VERSION.built ? v : null)
      })
    const onVisible = () => document.visibilityState === 'visible' && check()
    check()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      alive = false
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])
  return newer
}
