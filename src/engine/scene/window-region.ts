import type { Pixels } from '../ports/graphics.ts'

/** Native window-region pixels, relative to the outer Window's top-left.
 * Every consecutive four unsigned values are x, y, width, height. Rectangles
 * are disjoint and half-open. An empty region clips everything; null removes
 * the region. The primary image and all later drawing are independent. */
export interface WindowRegion {
  readonly width: number
  readonly height: number
  readonly rectangles: Uint16Array<ArrayBuffer>
}
export const WINDOW_REGION_RECTANGLE_LIMIT = 65536
export const WINDOW_REGION_BYTES_LIMIT = 8 * 1024 * 1024

/** Validate an owned protocol payload without an expensive overlap test. */
export function validateWindowRegion(region: unknown): asserts region is WindowRegion {
  if (!region || typeof region !== 'object') throw new Error('Invalid Window region')
  const candidate = region as Partial<WindowRegion>, rectangles = candidate.rectangles
  if (![candidate.width, candidate.height].every((value) => typeof value === 'number' &&
      Number.isInteger(value) && value >= 0 && value <= 4096) ||
      !(rectangles instanceof Uint16Array) || !(rectangles.buffer instanceof ArrayBuffer) ||
      rectangles.length % 4 !== 0 || rectangles.length / 4 > WINDOW_REGION_RECTANGLE_LIMIT)
    throw new Error('Invalid Window region geometry')
  for (let at = 0; at < rectangles.length; at += 4)
    if (!rectangles[at + 2] || !rectangles[at + 3] ||
        rectangles[at]! + rectangles[at + 2]! > candidate.width! ||
        rectangles[at + 1]! + rectangles[at + 3]! > candidate.height!)
      throw new Error('Invalid Window region rectangle')
}

export interface WindowRegionOptions {
  /** Lower limits permit transactional preparation against a Session budget. */
  maxRectangles?: number
  checkpoint?(): void
  yieldControl?(): Promise<void>
}

/** Fixed 2.32stable win32/LayerImpl.cpp CreateMaskRgn: full MainImage alpha
 * >= unsigned threshold, with no display type, opacity, child composition,
 * image offset, drawing clip, zoom or client-area translation. Adjacent equal
 * horizontal runs are merged vertically without changing the native union. */
export async function createWindowRegion(pixels: Pixels, threshold: number,
  options: WindowRegionOptions = {}): Promise<WindowRegion> {
  const { width, height, data } = pixels,
    limit = options.maxRectangles ?? WINDOW_REGION_RECTANGLE_LIMIT
  if (![width, height].every((value) => Number.isInteger(value) && value >= 0 && value <= 4096) ||
      !(data instanceof Uint8Array) || data.byteLength !== width * height * 4)
    throw new Error('Invalid Window region image')
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 0xffffffff)
    throw new Error('Invalid unsigned Window region threshold')
  if (!Number.isInteger(limit) || limit < 0 || limit > WINDOW_REGION_RECTANGLE_LIMIT)
    throw new Error('Invalid Window region rectangle budget')
  options.checkpoint?.()
  // Snapshot only the alpha plane before yielding. At most 16 MiB temporary
  // bytes are allocated; no RGBA copy or script Layer ownership is acquired.
  const alpha = new Uint8Array(width * height)
  for (let at = 0; at < alpha.length; at++) alpha[at] = data[at * 4 + 3]!
  const rectangles: number[] = []
  let previous = new Map<number, number>()
  for (let y = 0; y < height; y++) {
    if ((y & 31) === 0) {
      options.checkpoint?.()
      if (options.yieldControl) await options.yieldControl()
      options.checkpoint?.()
    }
    const next = new Map<number, number>()
    for (let x = 0; x < width;) {
      while (x < width && alpha[y * width + x]! < threshold) x++
      if (x === width) break
      const left = x
      while (x < width && alpha[y * width + x]! >= threshold) x++
      const key = left * (width + 1) + x, existing = previous.get(key)
      if (existing !== undefined) {
        rectangles[existing + 3] = rectangles[existing + 3]! + 1
        next.set(key, existing)
      } else {
        if (rectangles.length / 4 >= limit)
          throw new Error('Window region rectangle budget exceeded')
        const at = rectangles.length
        rectangles.push(left, y, x - left, 1)
        next.set(key, at)
      }
    }
    previous = next
  }
  options.checkpoint?.()
  return Object.freeze({ width, height, rectangles: new Uint16Array(rectangles) })
}

export function windowRegionContains(region: WindowRegion | null, x: number, y: number): boolean {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false
  if (!region) return true
  const rectangles = region.rectangles
  for (let at = 0; at < rectangles.length; at += 4)
    if (x >= rectangles[at]! && y >= rectangles[at + 1]! &&
        x < rectangles[at]! + rectangles[at + 2]! && y < rectangles[at + 1]! + rectangles[at + 3]!)
      return true
  return false
}

export function copyWindowRegion(region: WindowRegion): WindowRegion {
  validateWindowRegion(region)
  return Object.freeze({ width: region.width, height: region.height,
    rectangles: new Uint16Array(region.rectangles) })
}

/** Region storage is separate from WindowView, so each frame's small roster
 * does not serialize all pixel runs. Candidates replace old regions only once
 * preparation and budget validation have succeeded. */
export class WindowRegions {
  private readonly regions = new Map<number, WindowRegion>()
  private bytes = 0
  constructor(private readonly limit = WINDOW_REGION_BYTES_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > WINDOW_REGION_BYTES_LIMIT)
      throw new Error('Invalid Window region storage budget')
  }
  availableRectangles(windowId: number): number {
    const previous = this.regions.get(windowId)?.rectangles.byteLength ?? 0
    return Math.min(WINDOW_REGION_RECTANGLE_LIMIT, Math.floor((this.limit - this.bytes + previous) / 8))
  }
  replace(windowId: number, region: WindowRegion | null): void {
    if (!Number.isSafeInteger(windowId) || windowId <= 0) throw new Error('Invalid Window region owner')
    if (region) validateWindowRegion(region)
    const previous = this.regions.get(windowId)?.rectangles.byteLength ?? 0,
      next = this.bytes - previous + (region?.rectangles.byteLength ?? 0)
    if (next > this.limit) throw new Error('Window regions exceed Session budget')
    if (region) this.regions.set(windowId, region)
    else this.regions.delete(windowId)
    this.bytes = next
  }
  get(windowId: number): WindowRegion | null { return this.regions.get(windowId) ?? null }
  clear(): void { this.regions.clear(); this.bytes = 0 }
  inspect(): { regions: number; bytes: number } { return { regions: this.regions.size, bytes: this.bytes } }
}
