import type { Rect } from '../ports/graphics.ts'
import { dimension, intersect } from './bitmap.ts'

/** An independently sized, exclusively owned 8-bit image without a drawing clip. */
export class ProvincePlane {
  private plane: { width: number; height: number; data: Uint8Array }

  constructor(width: number, height: number, data?: Uint8Array) {
    dimension(width)
    dimension(height)
    if (data && data.length !== width * height)
      throw new Error('Province data length does not match its dimensions')
    this.plane = {
      width,
      height,
      data: data ? new Uint8Array(data) : new Uint8Array(width * height),
    }
  }

  get width(): number {
    return this.plane.width
  }

  get height(): number {
    return this.plane.height
  }

  get data(): Uint8Array {
    return this.plane.data
  }

  get bytes(): number {
    return this.plane.data.length
  }

  private contains(x: number, y: number): boolean {
    return (
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < this.width &&
      y < this.height
    )
  }

  getPixel(x: number, y: number): number {
    return this.contains(x, y) ? this.data[y * this.width + x]! : 0
  }

  setPixel(x: number, y: number, value: number): void {
    if (!this.contains(x, y)) throw new Error('Pixel is outside the province image')
    this.data[y * this.width + x] = value & 255
  }

  /** Returns whether a nonempty region was written, even when its bytes were unchanged. */
  fill(rect: Rect, color: number): boolean {
    const area = intersect(rect, { x: 0, y: 0, width: this.width, height: this.height })
    if (!area.width || !area.height) return false
    for (let y = area.y; y < area.y + area.height; y++) {
      const start = y * this.width + area.x
      this.data.fill(color & 255, start, start + area.width)
    }
    return true
  }

  resize(width: number, height: number): void {
    dimension(width)
    dimension(height)
    if (width === this.width && height === this.height) return
    const data = new Uint8Array(width * height),
      rows = Math.min(height, this.height),
      columns = Math.min(width, this.width)
    for (let y = 0; y < rows; y++)
      data.set(this.data.subarray(y * this.width, y * this.width + columns), y * width)
    this.plane = { width, height, data }
  }

  clone(): ProvincePlane {
    return new ProvincePlane(this.width, this.height, this.data)
  }

  copy(source: ProvincePlane, left: number, top: number, rect: Rect): boolean {
    const target = intersect(
      intersect(
        { x: 0, y: 0, width: this.width, height: this.height },
        { x: left, y: top, width: rect.width, height: rect.height },
      ),
      { x: left - rect.x, y: top - rect.y, width: source.width, height: source.height },
    )
    if (!target.width || !target.height) return false
    let sourceLeft = target.x - left + rect.x,
      sourceTop = target.y - top + rect.y,
      sourceWidth = source.width,
      data = source.data
    if (
      source === this &&
      (sourceLeft !== target.x || sourceTop !== target.y) &&
      target.x < sourceLeft + target.width &&
      sourceLeft < target.x + target.width &&
      target.y < sourceTop + target.height &&
      sourceTop < target.y + target.height
    ) {
      // Snapshot only the transferred rectangle when earlier writes could
      // overwrite a later source row or pixel of this same plane.
      const snapshot = new Uint8Array(target.width * target.height)
      for (let y = 0; y < target.height; y++) {
        const start = (sourceTop + y) * sourceWidth + sourceLeft
        snapshot.set(data.subarray(start, start + target.width), y * target.width)
      }
      data = snapshot
      sourceWidth = target.width
      sourceLeft = 0
      sourceTop = 0
    }
    for (let y = 0; y < target.height; y++) {
      const start = (sourceTop + y) * sourceWidth + sourceLeft
      this.data.set(
        data.subarray(start, start + target.width),
        (target.y + y) * this.width + target.x,
      )
    }
    return true
  }

  flip(horizontal: boolean): void {
    const count = horizontal ? Math.floor(this.width / 2) : Math.floor(this.height / 2),
      rows = horizontal ? this.height : this.width,
      data = this.data
    for (let row = 0; row < rows; row++)
      for (let i = 0; i < count; i++) {
        const first = horizontal ? row * this.width + i : i * this.width + row,
          last = horizontal
            ? row * this.width + this.width - 1 - i
            : (this.height - 1 - i) * this.width + row,
          value = data[first]!
        data[first] = data[last]!
        data[last] = value
      }
  }
}
