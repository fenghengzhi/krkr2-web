import type { Rect } from '../ports/graphics.ts'
import type { WindowGeometry, WindowGeometryPort, WindowGeometryRequest, WindowGeometryScroll } from '../ports/window-geometry.ts'
import { deviceMulDiv } from './draw-device.ts'

export const windowGeometryLimit = 4096
const integer = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
function fail(): never { throw new Error('Invalid Window geometry') }
const copyRect = (value: Rect): Rect => ({ x: value.x, y: value.y, width: value.width, height: value.height })
export function copyWindowGeometry(value: WindowGeometry): WindowGeometry {
  if (!value || !integer(value.revision, 0, Number.MAX_SAFE_INTEGER) ||
      !integer(value.surfaceEpoch, 0, Number.MAX_SAFE_INTEGER) ||
      (value.platform !== 'headless' && value.platform !== 'dom') ||
      (value.platform === 'dom' && value.surfaceEpoch < 1)) fail()
  for (const name of ['outer', 'client', 'inner', 'viewport', 'paintBox'] as const) {
    const r = value[name]
    if (!r || !integer(r.x, -0x80000000, 0x7fffffff) || !integer(r.y, -0x80000000, 0x7fffffff) ||
        !integer(r.width, 0, name === 'paintBox' ? 0x7fffffff : windowGeometryLimit) ||
        !integer(r.height, 0, name === 'paintBox' ? 0x7fffffff : windowGeometryLimit)) fail()
  }
  const contained = (outer: Rect, inner: Rect) => inner.x >= outer.x && inner.y >= outer.y &&
    inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height
  if (value.outer.x !== 0 || value.outer.y !== 0 || !value.outer.width || !value.outer.height ||
      !contained(value.outer, value.client) || !contained(value.client, value.inner) ||
      !contained(value.inner, value.viewport)) fail()
  const z = value.actualZoom, s = value.scroll, bars = value.scrollbars
  if (!z || !integer(z.numer, 1, 0x7fffffff) || !integer(z.denom, 1, 0x7fffffff) ||
      !s || !integer(s.maxX, 0, 0x7fffffff) || !integer(s.maxY, 0, 0x7fffffff) ||
      !integer(s.x, 0, s.maxX) || !integer(s.y, 0, s.maxY) || !bars ||
      !integer(bars.horizontal, 0, windowGeometryLimit) || !integer(bars.vertical, 0, windowGeometryLimit) ||
      value.viewport.x + value.viewport.width + bars.vertical > value.inner.x + value.inner.width ||
      value.viewport.y + value.viewport.height + bars.horizontal > value.inner.y + value.inner.height) fail()
  return { revision: value.revision, surfaceEpoch: value.surfaceEpoch, platform: value.platform,
    outer: copyRect(value.outer), client: copyRect(value.client), inner: copyRect(value.inner),
    viewport: copyRect(value.viewport), paintBox: copyRect(value.paintBox),
    actualZoom: { ...z }, scrollbars: { ...bars }, scroll: { ...s } }
}
export function validateWindowGeometry(request: WindowGeometryRequest, value: WindowGeometry): WindowGeometry {
  const g = copyWindowGeometry(value), inset = request.view.innerSunken && !request.view.fullScreen ? 2 : 0,
    width = deviceMulDiv(request.primary.width, g.actualZoom.numer, g.actualZoom.denom),
    height = deviceMulDiv(request.primary.height, g.actualZoom.numer, g.actualZoom.denom),
    x = deviceMulDiv(request.view.layerLeft, g.actualZoom.numer, g.actualZoom.denom),
    y = deviceMulDiv(request.view.layerTop, g.actualZoom.numer, g.actualZoom.denom)
  if (g.revision !== request.revision ||
      g.inner.x !== g.client.x + Math.min(inset, g.client.width) ||
      g.inner.y !== g.client.y + Math.min(inset, g.client.height) ||
      g.inner.width !== Math.max(0, g.client.width - inset * 2) ||
      g.inner.height !== Math.max(0, g.client.height - inset * 2) ||
      g.paintBox.x !== g.viewport.x + x - g.scroll.x || g.paintBox.y !== g.viewport.y + y - g.scroll.y ||
      g.paintBox.width !== Math.max(0, width) || g.paintBox.height !== Math.max(0, height)) fail()
  return g
}
export function scrollWindowGeometry(source: WindowGeometry, x: number, y: number): WindowGeometry {
  const g = copyWindowGeometry(source)
  if (!integer(x, 0, g.scroll.maxX) || !integer(y, 0, g.scroll.maxY)) fail()
  g.paintBox.x += g.scroll.x - x
  g.paintBox.y += g.scroll.y - y
  g.scroll.x = x; g.scroll.y = y
  return g
}
export function initialWindowGeometry(width = 800, height = 600): WindowGeometry {
  const area = { x: 0, y: 0, width, height }
  return { revision: 0, surfaceEpoch: 0, platform: 'headless', outer: { ...area },
    client: { ...area }, inner: { ...area }, viewport: { ...area },
    paintBox: { x: 0, y: 0, width: 0, height: 0 }, actualZoom: { numer: 1, denom: 1 },
    scrollbars: { horizontal: 0, vertical: 0 }, scroll: { x: 0, y: 0, maxX: 0, maxY: 0 } }
}

/** Explicit unframed platform for renderer/input injection without a DOM.
 * It has no caption/menu/OS scrollbar pixels and makes no desktop-VCL claim.
 * Nonzero host insets must be provided by a real/custom geometry backend. */
export class HeadlessWindowGeometry implements WindowGeometryPort {
  private closed = false
  private retired = new Set<number>()
  async measure(request: WindowGeometryRequest): Promise<WindowGeometry> {
    if (this.closed || this.retired.has(request.windowId)) throw new Error('Window geometry is retired')
    const view = request.view, prior = view.geometry ?? initialWindowGeometry(view.width, view.height),
      inset = view.innerSunken && !view.fullScreen ? 2 : 0,
      limit = (n: number, min: number, max: number) => Math.max(1, min, Math.min(max || windowGeometryLimit, n)),
      requestedWidth = request.operation === 'inner' && request.size?.width !== undefined
        ? request.size.width + inset * 2 : request.size?.width ?? view.width,
      requestedHeight = request.operation === 'inner' && request.size?.height !== undefined
        ? request.size.height + inset * 2 : request.size?.height ?? view.height,
      width = limit(requestedWidth, view.minWidth ?? 0, view.maxWidth ?? 0),
      height = limit(requestedHeight, view.minHeight ?? 0, view.maxHeight ?? 0),
      outer = { x: 0, y: 0, width, height }, client = { ...outer },
      inner = { x: Math.min(inset, width), y: Math.min(inset, height),
        width: Math.max(0, width - inset * 2), height: Math.max(0, height - inset * 2) },
      actualZoom = view.fullScreen
        ? width * request.innerRequest.height <= height * request.innerRequest.width
          ? { numer: width, denom: request.innerRequest.width }
          : { numer: height, denom: request.innerRequest.height }
        : { numer: view.zoomNumer, denom: view.zoomDenom },
      fittedWidth = view.fullScreen ? Math.trunc(request.innerRequest.width * actualZoom.numer / actualZoom.denom) : inner.width,
      fittedHeight = view.fullScreen ? Math.trunc(request.innerRequest.height * actualZoom.numer / actualZoom.denom) : inner.height,
      viewport = { x: inner.x + Math.trunc((inner.width - fittedWidth) / 2),
        y: inner.y + Math.trunc((inner.height - fittedHeight) / 2), width: fittedWidth, height: fittedHeight },
      paintWidth = Math.max(0, deviceMulDiv(request.primary.width, actualZoom.numer, actualZoom.denom)),
      paintHeight = Math.max(0, deviceMulDiv(request.primary.height, actualZoom.numer, actualZoom.denom)),
      left = deviceMulDiv(view.layerLeft, actualZoom.numer, actualZoom.denom),
      top = deviceMulDiv(view.layerTop, actualZoom.numer, actualZoom.denom),
      maxX = view.showScrollBars ? Math.max(0, left + paintWidth - viewport.width) : 0,
      maxY = view.showScrollBars ? Math.max(0, top + paintHeight - viewport.height) : 0,
      x = request.resetScroll ? 0 : Math.min(maxX, prior.scroll.x),
      y = request.resetScroll ? 0 : Math.min(maxY, prior.scroll.y)
    return validateWindowGeometry(request, { revision: request.revision, surfaceEpoch: 0, platform: 'headless',
      outer, client, inner, viewport, actualZoom, scrollbars: { horizontal: 0, vertical: 0 }, scroll: { x, y, maxX, maxY },
      paintBox: { x: viewport.x + left - x, y: viewport.y + top - y, width: paintWidth, height: paintHeight } })
  }
  subscribe(_listener: (observation: WindowGeometryScroll) => void): () => void { return () => {} }
  retire(windowId: number): void { if (!this.closed) this.retired.add(windowId) }
  dispose(): void { this.closed = true; this.retired.clear() }
}
