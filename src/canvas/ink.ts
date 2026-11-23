import { getStroke } from 'perfect-freehand'
import type { StrokeElement } from '../store/types'

export function strokeOptions(s: Pick<StrokeElement, 'size' | 'highlighter' | 'pressure'>, last = true) {
  return s.highlighter
    ? { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last }
    : {
        size: s.size,
        thinning: s.pressure ? 0.65 : 0.5,
        smoothing: 0.5,
        streamline: s.pressure ? 0.35 : 0.5,
        simulatePressure: !s.pressure,
        last,
      }
}

/** flat [x,y,p,x,y,p,...] → [[x,y,p], ...] */
export function toTriples(flat: number[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]])
  return out
}

export function strokePath(flat: number[], opts: ReturnType<typeof strokeOptions>): string {
  return outlineToPath(getStroke(toTriples(flat), opts))
}

/** Converts perfect-freehand's outline polygon into a smooth SVG path. */
function outlineToPath(points: number[][]): string {
  const len = points.length
  if (len < 4) return ''
  const avg = (a: number, b: number) => ((a + b) / 2).toFixed(2)
  let a = points[0]
  let b = points[1]
  const c = points[2]
  let d = `M${a[0].toFixed(2)},${a[1].toFixed(2)} Q${b[0].toFixed(2)},${b[1].toFixed(2)} ${avg(b[0], c[0])},${avg(b[1], c[1])} T`
  for (let i = 2; i < len - 1; i++) {
    a = points[i]
    b = points[i + 1]
    d += `${avg(a[0], b[0])},${avg(a[1], b[1])} `
  }
  return d + 'Z'
}

/**
 * The same smooth outline written with explicit Q commands only (each chained T
 * becomes Q with its reflected control point). Used for PDF export, whose path
 * reader does not handle chained T commands.
 */
export function strokePathExplicit(flat: number[], opts: ReturnType<typeof strokeOptions>): string {
  const points = getStroke(toTriples(flat), opts)
  const len = points.length
  if (len < 4) return ''
  const f = (n: number) => n.toFixed(2)
  const mid = (a: number[], b: number[]) => `${f((a[0] + b[0]) / 2)},${f((a[1] + b[1]) / 2)}`
  let d = `M${f(points[0][0])},${f(points[0][1])}`
  for (let i = 1; i < len - 1; i++) d += ` Q${f(points[i][0])},${f(points[i][1])} ${mid(points[i], points[i + 1])}`
  return d + ' Z'
}

export function computeBBox(flat: number[]): [number, number, number, number] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (let i = 0; i < flat.length; i += 3) {
    const x = flat[i], y = flat[i + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return [minX, minY, maxX, maxY]
}
