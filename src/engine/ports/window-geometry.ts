import type { Rect } from './graphics.ts'
import type { MenuSnapshot } from '../scene/menus.ts'
import type { WindowView } from '../scene/window.ts'

/** Rectangles share the logical outer-window origin; page fitting is not here.
 * Pointer/IME/cursor transport remains viewport-local, not outer-local. */
export interface WindowGeometry {
  revision: number
  /** Zero denotes an explicitly unframed headless surface, never browser DOM. */
  surfaceEpoch: number
  platform: 'dom' | 'headless'
  outer: Rect
  client: Rect
  inner: Rect
  viewport: Rect
  paintBox: Rect
  /** Drawing zoom can differ from the public requested zoom in fullscreen. */
  actualZoom: { numer: number; denom: number }
  /** Occupied pixels, not nominal OS metrics; overlay scrollbars can be zero. */
  scrollbars: { horizontal: number; vertical: number }
  scroll: { x: number; y: number; maxX: number; maxY: number }
}
export interface WindowGeometryRequest {
  requestId: number
  windowId: number
  revision: number
  view: WindowView
  menus: MenuSnapshot
  primary: { width: number; height: number }
  /** Only explicit inner setters update this fullscreen preference. */
  innerRequest: { width: number; height: number }
  operation: 'create' | 'outer' | 'inner' | 'chrome' | 'content'
  /** Missing axes retain that axis in the operation's own coordinate domain. */
  size?: { width?: number; height?: number }
  resetScroll: boolean
}
export interface WindowGeometryScroll {
  windowId: number
  surfaceEpoch: number
  baseRevision: number
  sequence: number
  x: number
  y: number
}
export interface WindowGeometryPort {
  measure(request: WindowGeometryRequest): Promise<WindowGeometry>
  subscribe(listener: (observation: WindowGeometryScroll) => void): () => void
  retire(windowId: number): void
  dispose(): void
}
