import type { CanvasElement, StrokeElement } from '../store/types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Bounding box of any element in world coordinates. textHeights holds measured text box heights. */
export function elementBounds(el: CanvasElement, textHeights: Map<string, number>): Rect {
  switch (el.type) {
    case 'stroke': {
      const pad = el.size / 2
      const [x0, y0, x1, y1] = el.bbox
      return { x: x0 + el.dx - pad, y: y0 + el.dy - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad }
    }
    case 'text':
      return { x: el.x, y: el.y, w: el.w, h: textHeights.get(el.id) ?? el.fontSize * 1.6 }
    case 'image':
      return { x: el.x, y: el.y, w: el.w, h: el.h }
  }
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax, dy = by - ay
  const len2 = dx * dx + dy * dy
  const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

/** True when the world point (px, py) is within `radius` of the stroke's centre line (plus its width). */
export function strokeHit(s: StrokeElement, px: number, py: number, radius: number): boolean {
  const r = radius + s.size / 2
  const [x0, y0, x1, y1] = s.bbox
  const lx = px - s.dx, ly = py - s.dy
  if (lx < x0 - r || lx > x1 + r || ly < y0 - r || ly > y1 + r) return false
  const p = s.points
  if (p.length <= 3) return Math.hypot(lx - p[0], ly - p[1]) <= r
  for (let i = 0; i + 5 < p.length; i += 3) {
    if (distToSegment(lx, ly, p[i], p[i + 1], p[i + 3], p[i + 4]) <= r) return true
  }
  return false
}

export function pointInRect(px: number, py: number, r: Rect) {
  return px >= r.x && px <= r.x + r.w && py >= r.y && py <= r.y + r.h
}

/** Elements chosen by a selection rectangle: strokes with any point inside, boxes whose centre is inside. */
export function elementInRect(el: CanvasElement, rect: Rect, textHeights: Map<string, number>): boolean {
  if (el.type === 'stroke') {
    const b = elementBounds(el, textHeights)
    if (b.x > rect.x + rect.w || b.x + b.w < rect.x || b.y > rect.y + rect.h || b.y + b.h < rect.y) return false
    for (let i = 0; i < el.points.length; i += 3) {
      if (pointInRect(el.points[i] + el.dx, el.points[i + 1] + el.dy, rect)) return true
    }
    return false
  }
  const b = elementBounds(el, textHeights)
  return pointInRect(b.x + b.w / 2, b.y + b.h / 2, rect)
}

/** Smallest rectangle holding all the elements, or null if there are none. */
export function unionBounds(els: CanvasElement[], textHeights: Map<string, number>): Rect | null {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const el of els) {
    const b = elementBounds(el, textHeights)
    x0 = Math.min(x0, b.x)
    y0 = Math.min(y0, b.y)
    x1 = Math.max(x1, b.x + b.w)
    y1 = Math.max(y1, b.y + b.h)
  }
  return x0 === Infinity ? null : { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

export const rectsOverlap = (a: Rect, b: Rect) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h

/** Bounding box of a flat [x, y, x, y, …] polygon. */
export function polygonBounds(poly: number[]): Rect {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (let i = 0; i < poly.length; i += 2) {
    x0 = Math.min(x0, poly[i])
    y0 = Math.min(y0, poly[i + 1])
    x1 = Math.max(x1, poly[i])
    y1 = Math.max(y1, poly[i + 1])
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
}

/** Area enclosed by a flat [x, y, …] polygon (closed automatically). */
export function polygonArea(poly: number[]): number {
  let a = 0
  const n = poly.length
  for (let i = 0; i < n; i += 2) {
    const j = (i + 2) % n
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1]
  }
  return Math.abs(a) / 2
}

/**
 * A lasso that encloses almost nothing (a straight or slightly bent drag) is
 * meant as a rectangle from corner to corner.
 */
export function lassoIsRect(poly: number[]): boolean {
  if (poly.length < 6) return true
  const b = polygonBounds(poly)
  return polygonArea(poly) < 0.2 * b.w * b.h
}

export function pointInPolygon(px: number, py: number, poly: number[]): boolean {
  let inside = false
  const n = poly.length
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1]
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

/** Elements chosen by a lasso: strokes with at least half their points inside, boxes whose centre is inside. */
export function elementInLasso(el: CanvasElement, poly: number[], polyBox: Rect, textHeights: Map<string, number>): boolean {
  const b = elementBounds(el, textHeights)
  if (!rectsOverlap(b, polyBox)) return false
  if (el.type === 'stroke') {
    const n = el.points.length / 3
    let inside = 0
    for (let i = 0; i < el.points.length; i += 3) {
      if (pointInPolygon(el.points[i] + el.dx, el.points[i + 1] + el.dy, poly)) inside++
    }
    return inside * 2 >= n
  }
  return pointInPolygon(b.x + b.w / 2, b.y + b.h / 2, poly)
}

/** Scaling about a fixed point (ax, ay) by factor k. */
export interface Scale {
  ax: number
  ay: number
  k: number
}

const r1 = (n: number) => Math.round(n * 10) / 10

/**
 * The element made k times bigger (or smaller) about (ax, ay): handwriting
 * keeps its shape and gets proportionally thicker or thinner lines, text gets
 * a proportional font size and width, pictures keep their proportions.
 */
export function scaleElement(el: CanvasElement, { ax, ay, k }: Scale): CanvasElement {
  const sx = (x: number) => ax + (x - ax) * k
  const sy = (y: number) => ay + (y - ay) * k
  switch (el.type) {
    case 'stroke': {
      const points = el.points.slice()
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (let i = 0; i < points.length; i += 3) {
        const x = r1(sx(points[i] + el.dx))
        const y = r1(sy(points[i + 1] + el.dy))
        points[i] = x
        points[i + 1] = y
        x0 = Math.min(x0, x)
        y0 = Math.min(y0, y)
        x1 = Math.max(x1, x)
        y1 = Math.max(y1, y)
      }
      return { ...el, points, dx: 0, dy: 0, size: Math.max(0.3, r1(el.size * k)), bbox: [x0, y0, x1, y1] }
    }
    case 'text':
      return { ...el, x: sx(el.x), y: sy(el.y), w: Math.max(40, el.w * k), fontSize: Math.max(4, r1(el.fontSize * k)) }
    case 'image':
      return { ...el, x: sx(el.x), y: sy(el.y), w: el.w * k, h: el.h * k }
  }
}

/** A rectangle after scaling. */
export const scaleRect = (r: Rect, { ax, ay, k }: Scale): Rect => ({ x: ax + (r.x - ax) * k, y: ay + (r.y - ay) * k, w: r.w * k, h: r.h * k })

/** Normalises a rectangle drawn from (x0,y0) to (x1,y1) in any direction. */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}
