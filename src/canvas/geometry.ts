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

/** Normalises a rectangle drawn from (x0,y0) to (x1,y1) in any direction. */
export function rectFromPoints(x0: number, y0: number, x1: number, y1: number): Rect {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}
