export type ThemeChoice = 'auto' | 'light' | 'dark'

export const THEMES: { id: ThemeChoice; label: string; paper: string; dot: string }[] = [
  { id: 'auto', label: 'Auto (follow device)', paper: 'linear-gradient(135deg, #fffefb 50%, #1c1c1f 50%)', dot: '#7b4fd6' },
  { id: 'light', label: 'Light', paper: '#fffefb', dot: '#7b4fd6' },
  { id: 'dark', label: 'Dark', paper: '#1c1c1f', dot: '#a78bfa' },
]

/** The "black" pen and text colour. It is drawn with --ink so it turns white in dark mode. */
export const INK = '#1f1f1f'
export const inkColor = (c: string) => (c === INK ? 'var(--ink)' : c)

const KEY = 'inkpad:theme'
const darkQuery = window.matchMedia('(prefers-color-scheme: dark)')

export function getTheme(): ThemeChoice {
  const t = localStorage.getItem(KEY) as ThemeChoice | null
  return t && THEMES.some((x) => x.id === t) ? t : 'auto'
}

export function setTheme(t: ThemeChoice) {
  localStorage.setItem(KEY, t)
  applyTheme()
}

export function applyTheme() {
  const choice = getTheme()
  const resolved = choice === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : choice
  document.documentElement.dataset.theme = resolved
  // colour of the iPhone/iPad status bar and the browser's title bar
  const paper = getComputedStyle(document.documentElement).getPropertyValue('--paper').trim()
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', paper || '#fffefb')
}

// "Auto" follows the device when it switches between light and dark.
darkQuery.addEventListener('change', () => getTheme() === 'auto' && applyTheme())
