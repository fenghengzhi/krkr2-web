import type { WindowGeometry, WindowGeometryRequest, WindowGeometryScroll } from '../engine/ports/window-geometry.ts'
export type WindowGeometryMessage =
  | { type: 'request'; generation: number; request: WindowGeometryRequest }
  | { type: 'reply'; generation: number; requestId: number; windowId: number; revision: number;
      ok: true; geometry: WindowGeometry }
  | { type: 'reply'; generation: number; requestId: number; windowId: number; revision: number;
      ok: false; error: string }
  | { type: 'scroll'; generation: number; observation: WindowGeometryScroll }
  | { type: 'retire'; generation: number; windowId: number }
  | { type: 'close'; generation: number }
