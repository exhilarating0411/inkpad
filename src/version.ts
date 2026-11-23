/** Which build of the app is running, and whether a newer one is online. */
import { useEffect, useState } from 'react'

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
  return `${when} · ${v.commit}`
}

/** The version published on the website (null when offline, or when running the dev server). */
async function onlineVersion(): Promise<AppVersion | null> {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' })
    if (!res.ok) return null
    const v = (await res.json()) as AppVersion
    return v.commit && v.built ? v : null
  } catch {
    return null
  }
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
