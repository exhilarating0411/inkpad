import type { Paper } from '../paper'

export type Tool = 'select' | 'pen' | 'highlighter' | 'eraser' | 'text'

/** canvas = free handwriting page, markdown = written document */
export type PageKind = 'canvas' | 'markdown'

export interface PageMeta {
  id: string
  title: string
  kind: PageKind
  created: number
  updated: number
  /** section the page belongs to */
  sectionId?: string
  /** parent page (for sub-pages); missing or null = top level of the section */
  parentId?: string | null
  /** position among its siblings (smaller = higher); missing = created time */
  order?: number
  /** background of a handwriting page; missing = white with dots */
  paper?: Paper
  /** folder from the old layout; only read once, when the workspace is converted */
  folderId?: string | null
}

/** A notebook: the biggest unit, holds sections. */
export interface NotebookMeta {
  id: string
  name: string
  created: number
  order: number
}

/** A section: one tab in a notebook (e.g. "Calculus"), holds pages. */
export interface SectionMeta {
  id: string
  notebookId: string
  name: string
  color: string
  created: number
  order: number
}

/** Folder from the old layout. Kept only so old data can be converted. */
export interface FolderMeta {
  id: string
  name: string
  parentId: string | null
  created: number
  order: number
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
