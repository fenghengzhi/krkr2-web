import type { Rect } from '../ports/graphics.ts'
import type { WindowView } from './window.ts'

export interface DevicePoint { x: number; y: number }
type DrawingView = Pick<WindowView, 'layerLeft' | 'layerTop' | 'zoomNumer' | 'zoomDenom' | 'geometry'>

/** tjs_int at a legacy mouse/DrawDevice boundary. Raw DOM and touch samples
 * remain real-valued outside these explicit conversions. */
export function deviceInt(value: number): number {
  if (!Number.isFinite(value)) throw new Error('Invalid drawing coordinate')
  return Number(BigInt.asIntN(32, BigInt(Math.trunc(value))))
}

/** Win32 MulDiv used by InternalSetPaintBoxSize: a 64-bit product, nearest
 * integer with half ties away from zero, and -1 for an invalid int32 result. */
export function deviceMulDiv(value: number, numer: number, denom: number): number {
  const product = BigInt(deviceInt(value)) * BigInt(deviceInt(numer)),
    divisor = BigInt(deviceInt(denom))
  if (!divisor) return -1
  const magnitude = product < 0n ? -product : product,
    width = divisor < 0n ? -divisor : divisor,
    rounded = (magnitude + width / 2n) / width,
    result = (product < 0n) !== (divisor < 0n) ? -rounded : rounded
  return result < -2147483648n || result > 2147483647n ? -1 : Number(result)
}

export function drawDeviceGeometry(view: DrawingView, primaryWidth: number, primaryHeight: number): Rect {
  const zoom = view.geometry?.actualZoom ?? { numer: view.zoomNumer, denom: view.zoomDenom },
    scroll = view.geometry?.scroll
  return {
    x: deviceMulDiv(view.layerLeft, zoom.numer, zoom.denom) - (scroll?.x ?? 0),
    y: deviceMulDiv(view.layerTop, zoom.numer, zoom.denom) - (scroll?.y ?? 0),
    width: deviceMulDiv(primaryWidth, zoom.numer, zoom.denom),
    height: deviceMulDiv(primaryHeight, zoom.numer, zoom.denom),
  }
}

/** Capture this before queueing/delivering the Window callback. In native VCL
 * its arguments already refer to the PaintBox that received the event. */
export function paintBoxPoint(view: DrawingView, x: number, y: number): DevicePoint {
  const geometry = drawDeviceGeometry(view, 0, 0)
  return {
    x: deviceInt(deviceInt(x) - geometry.x),
    y: deviceInt(deviceInt(y) - geometry.y),
  }
}

function project(value: number, numer: number, denom: number): number {
  if (!denom) return 0
  // BigInt keeps the truncation exact. This does not emulate undefined C++
  // signed multiplication overflow outside the supported drawing dimensions.
  return Number(BigInt.asIntN(32,
    BigInt(deviceInt(value)) * BigInt(numer) / BigInt(denom)))
}

/** DrawDevice samples its current destination size after the Window callback.
 * Its input already excludes the origin; never subtract a new origin here. */
export function toPrimary(point: DevicePoint, geometry: Rect, primaryWidth: number, primaryHeight: number): DevicePoint {
  return {
    x: project(point.x, primaryWidth, geometry.width),
    y: project(point.y, primaryHeight, geometry.height),
  }
}

/** Primary integer point to full Window client pixels, including PaintBox
 * origin. Shared by script cursor writes and the IME attention anchor. */
export function fromPrimary(point: DevicePoint, geometry: Rect, primaryWidth: number, primaryHeight: number): DevicePoint {
  return {
    x: deviceInt(project(point.x, geometry.width, primaryWidth) + geometry.x),
    y: deviceInt(project(point.y, geometry.height, primaryHeight) + geometry.y),
  }
}
