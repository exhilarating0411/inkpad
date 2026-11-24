import { getStroke } from 'perfect-freehand'
import type { StrokeElement } from '../store/types'

/**
 * Shape of a stroke. Computed when drawing, not stored, so a change here also
 * applies to everything written before.
 *
 * Ink feels like a gel pen: the same width whatever the pressure (light
 * pressure used to make thin lines that looked grey). A little streamline
 * steadies the line without letting it trail far behind the pen.
 */
export function strokeOptions(s: Pick<StrokeElement, 'size' | 'highlighter' | 'pressure'>, last = true) {
  if (s.highlighter) return { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.4, simulatePressure: false, last }
  return { size: s.size, thinning: 0, smoothing: 0.5, streamline: 0.2, simulatePressure: false, last }
}

/** The live line is drawn this many milliseconds ahead of the pen, guessed from its movement. */
export const PREDICT_MS = 12

/** flat [x,y,p,x,y,p,...] → [[x,y,p], ...] */
export function toTriples(flat: number[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i < flat.length; i += 3) out.push([flat[i], flat[i + 1], flat[i + 2]])
  return out
}

/** gaps between recorded points longer than this (world px) are filled in along a curve */
const CURVE_STEP = 2

/**
 * The recorded points with the gaps filled in along a smooth curve
 * (centripetal Catmull-Rom, which passes through every recorded point and
 * does not overshoot on sharp turns).
 *
 * When the device is busy (or the browser sends fewer pen events, e.g. while
 * syncing), points arrive farther apart; joined by straight lines a curve then
 * looks slightly jagged. Filling the gaps keeps it round.
 */
export function smoothTriples(flat: number[]): number[][] {
  const n = flat.length / 3
  if (n < 3) return toTriples(flat)
  const at = (i: number): number[] => {
    // beyond the ends: continue the first / last segment in a straight line
    if (i < 0) return [2 * flat[0] - flat[3], 2 * flat[1] - flat[4], flat[2]]
    if (i >= n) {
      const a = (n - 1) * 3
      const b = (n - 2) * 3
      return [2 * flat[a] - flat[b], 2 * flat[a + 1] - flat[b + 1], flat[a + 2]]
    }
    return [flat[i * 3], flat[i * 3 + 1], flat[i * 3 + 2]]
  }
  const out: number[][] = []
  for (let i = 0; i < n - 1; i++) {
    const p1 = at(i)
    const p2 = at(i + 1)
    out.push(p1)
    const len = Math.hypot(p2[0] - p1[0], p2[1] - p1[1])
    const steps = Math.min(24, Math.floor(len / CURVE_STEP))
    if (steps < 2) continue
    const p0 = at(i - 1)
    const p3 = at(i + 2)
    // knot spacing: square root of the distance (centripetal)
    const k = (a: number[], b: number[]) => Math.max(1e-4, Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])))
    const t0 = 0
    const t1 = t0 + k(p0, p1)
    const t2 = t1 + k(p1, p2)
    const t3 = t2 + k(p2, p3)
    for (let s = 1; s < steps; s++) {
      const t = t1 + ((t2 - t1) * s) / steps
      const mix = (a: number[], b: number[], ta: number, tb: number) => {
        const u = (t - ta) / (tb - ta)
        return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]
      }
      const a1 = mix(p0, p1, t0, t1)
      const a2 = mix(p1, p2, t1, t2)
      const a3 = mix(p2, p3, t2, t3)
      const b1 = mix(a1, a2, t0, t2)
      const b2 = mix(a2, a3, t1, t3)
      const c = mix(b1, b2, t1, t2)
      out.push([c[0], c[1], p1[2] + ((p2[2] - p1[2]) * s) / steps])
    }
  }
  out.push(at(n - 1))
  return out
}

export function strokePath(flat: number[], opts: ReturnType<typeof strokeOptions>): string {
  return outlineToPath(getStroke(smoothTriples(flat), opts))
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
  const points = getStroke(smoothTriples(flat), opts)
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
