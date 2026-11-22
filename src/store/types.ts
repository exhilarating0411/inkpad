export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'text'

/** canvas = free handwriting page, markdown = written document */
export type PageKind = 'canvas' | 'markdown'

export interface PageMeta {
  id: string
  title: string
  kind: PageKind
  created: number
  updated: number
}

interface ElementBase {
  id: string
  /** stacking order inside its layer (images < text < ink) */
  z: number
}

export interface StrokeElement extends ElementBase {
  type: 'stroke'
  /** flat list of x, y, pressure triples in world coordinates (before dx/dy) */
  points: number[]
  color: string
  size: number
  highlighter: boolean
  /** true when pressure came from a real pen (Apple Pencil, Surface Pen) */
  pressure: boolean
  /** translation applied when the stroke is moved */
  dx: number
  dy: number
  /** untranslated bounding box: minX, minY, maxX, maxY */
  bbox: [number, number, number, number]
}

export interface TextElement extends ElementBase {
  type: 'text'
  x: number
  y: number
  w: number
  text: string
  fontSize: number
  /** text colour; missing means the default ink colour */
  color?: string
}

export interface ImageElement extends ElementBase {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  imageId: string
}

export type CanvasElement = StrokeElement | TextElement | ImageElement

export interface Viewport {
  x: number
  y: number
  scale: number
}
