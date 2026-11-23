/** The background of a handwriting page: a colour and a pattern. */
export type PaperPattern = 'plain' | 'dots' | 'grid' | 'lines'

export interface Paper {
  color: string
  pattern: PaperPattern
}

/**
 * Paper colours. Each has a light and a dark shade, so the page follows the
 * light / dark theme and the "black" ink (which turns white) stays readable.
 * On screen they are used through the CSS variables --paper-<id> (see styles.css).
 */
export const PAPER_COLORS: { id: string; label: string; light: string; dark: string }[] = [
  { id: 'white', label: 'White', light: '#fffefb', dark: '#1c1c1f' },
  { id: 'cream', label: 'Cream', light: '#fdf6e1', dark: '#24221b' },
  { id: 'yellow', label: 'Yellow', light: '#fff5b8', dark: '#2a2716' },
  { id: 'green', label: 'Green', light: '#e9f5e6', dark: '#19231b' },
  { id: 'blue', label: 'Blue', light: '#e7f1fb', dark: '#18202a' },
  { id: 'purple', label: 'Purple', light: '#f1ebfb', dark: '#211d2b' },
  { id: 'pink', label: 'Pink', light: '#fcebef', dark: '#2a1c21' },
  { id: 'gray', label: 'Gray', light: '#efefec', dark: '#252528' },
]

export const PAPER_PATTERNS: { id: PaperPattern; label: string }[] = [
  { id: 'plain', label: 'Plain' },
  { id: 'dots', label: 'Dots' },
  { id: 'grid', label: 'Grid' },
  { id: 'lines', label: 'Lines' },
]

/** distance between dots, grid lines and ruled lines, in page (world) pixels */
export const PATTERN_GAP: Record<PaperPattern, number> = { plain: 24, dots: 24, grid: 24, lines: 32 }

/** what pages made before paper settings existed look like */
export const DEFAULT_PAPER: Paper = { color: 'white', pattern: 'dots' }

/** Fills in anything missing or unknown (e.g. a colour from a newer app version). */
export function paperOf(p: Partial<Paper> | undefined): Paper {
  return {
    color: PAPER_COLORS.some((c) => c.id === p?.color) ? p!.color! : DEFAULT_PAPER.color,
    pattern: PAPER_PATTERNS.some((x) => x.id === p?.pattern) ? p!.pattern! : DEFAULT_PAPER.pattern,
  }
}

export const paperCss = (color: string) => `var(--paper-${paperOf({ color }).color})`
export const paperLight = (color: string) => PAPER_COLORS.find((c) => c.id === paperOf({ color }).color)!.light

/** CSS background of the pattern, `gap` screen pixels apart. */
export function patternImage(pattern: PaperPattern): string {
  switch (pattern) {
    case 'dots':
      return 'radial-gradient(circle, var(--pattern-dot) 1.1px, transparent 1.3px)'
    case 'grid':
      return 'linear-gradient(to right, var(--pattern-line) 1px, transparent 1px), linear-gradient(to bottom, var(--pattern-line) 1px, transparent 1px)'
    case 'lines':
      return 'linear-gradient(to bottom, var(--pattern-line) 1px, transparent 1px)'
    default:
      return 'none'
  }
}

// The paper used for new handwriting pages: the one picked last on this device.
const KEY = 'inkpad:paper'
export function lastPaper(): Paper {
  try {
    return paperOf(JSON.parse(localStorage.getItem(KEY) ?? 'null') ?? undefined)
  } catch {
    return DEFAULT_PAPER
  }
}
export const rememberPaper = (p: Paper) => localStorage.setItem(KEY, JSON.stringify(p))
