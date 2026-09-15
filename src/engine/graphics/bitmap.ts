import type { Pixels, Rect } from '../ports/graphics.ts'
import { blendColor } from './color.ts'
import { blendPixel, blendOpacity, validateBlend } from './blend.ts'
import type { AffineRaster } from './affine.ts'
import { gammaTable, type GammaChannel } from './gamma.ts'
import { convertAlpha, grayscale } from './processing.ts'

export const intersect = (a: Rect, b: Rect): Rect => {
  const x = Math.max(a.x, b.x),
    y = Math.max(a.y, b.y)
  return {
    x,
    y,
    width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x),
    height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y),
  }
}
export const dimension = (value: number): number => {
  if (!Number.isInteger(value) || value < 0 || value > 4096)
    throw new Error('Bitmap dimensions must be integers between 0 and 4096')
  return value
}
const byte = (value: number) => Math.max(0, Math.min(255, Math.trunc(value)))

/** Layer.DrawText selects its face before the bitmap clamps opacity. */
export function textOpacity(face: number, value: number): number {
  if (face !== 0 && face !== 1 && face !== 4)
    throw new Error('Text drawing requires dfAlpha, dfOpaque or dfAddAlpha')
  if (face === 4 && value < 0)
    throw new Error('Negative text opacity is not supported on dfAddAlpha')
  return Math.max(face === 0 ? -255 : 0, Math.min(255, Math.trunc(value)))
}

let nextRevision = 1

export class Bitmap {
  pixels: Pixels
  province?: Uint8Array
  clip: Rect
  revision = nextRevision++
  constructor(width: number, height: number, color = 0x00ffffff) {
    dimension(width)
    dimension(height)
    this.pixels = { width, height, data: new Uint8Array(width * height * 4) }
    this.clip = { x: 0, y: 0, width, height }
    this.fill(this.clip, color, 0, false)
  }
  touch(): void {
    this.revision = nextRevision++
  }
  get bytes(): number {
    return this.pixels.data.length + (this.province?.length ?? 0)
  }
  get width(): number {
    return this.pixels.width
  }
  get height(): number {
    return this.pixels.height
  }
  resize(width: number, height: number, color = 0x00ffffff): void {
    const replacement = new Bitmap(width, height, color)
    const rows = Math.min(height, this.height),
      columns = Math.min(width, this.width)
    for (let y = 0; y < rows; y++)
      replacement.pixels.data.set(
        this.pixels.data.subarray(y * this.width * 4, (y * this.width + columns) * 4),
        y * width * 4,
      )
    if (this.province) {
      replacement.province = new Uint8Array(width * height)
      for (let y = 0; y < rows; y++)
        replacement.province.set(
          this.province.subarray(y * this.width, y * this.width + columns),
          y * width,
        )
    }
    this.pixels = replacement.pixels
    this.province = replacement.province
    this.resetClip()
    this.touch()
  }
  resetClip(): void {
    this.clip = { x: 0, y: 0, width: this.width, height: this.height }
  }
  setClip(rect: Rect): void {
    if (!Object.values(rect).every(Number.isSafeInteger)) throw new Error('Invalid drawing clip')
    // Native SetClip clamps each far edge to its near edge. Negative extents
    // therefore produce an empty drawing area rather than an invalid size.
    this.clip = intersect(rect, { x: 0, y: 0, width: this.width, height: this.height })
  }
  private offset(x: number, y: number): number {
    if (
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.width ||
      y >= this.height
    )
      throw new Error('Pixel is outside the image')
    return y * this.width + x
  }
  private writable(x: number, y: number): boolean {
    const c = this.clip
    return x >= c.x && y >= c.y && x < c.x + c.width && y < c.y + c.height
  }
  getPixel(x: number, y: number, plane: 'main' | 'mask' | 'province'): number {
    if (
      plane === 'province' &&
      (!this.province || x < 0 || y < 0 || x >= this.width || y >= this.height)
    )
      return 0
    const index = this.offset(x, y),
      data = this.pixels.data
    return plane === 'province'
      ? this.province![index]!
      : plane === 'mask'
        ? data[index * 4 + 3]!
        : data[index * 4]! * 65536 + data[index * 4 + 1]! * 256 + data[index * 4 + 2]!
  }
  setPixel(x: number, y: number, value: number, plane: 'main' | 'mask' | 'province'): boolean {
    if (!this.writable(x, y)) return false
    const index = this.offset(x, y),
      data = this.pixels.data
    if (plane === 'province') {
      this.province ??= new Uint8Array(this.width * this.height)
      this.province[index] = value & 255
    } else if (plane === 'mask') data[index * 4 + 3] = value & 255
    else {
      data[index * 4] = (value >>> 16) & 255
      data[index * 4 + 1] = (value >>> 8) & 255
      data[index * 4 + 2] = value & 255
    }
    this.touch()
    return true
  }
  adjustGamma(channels: GammaChannel[], additive = false): void {
    if (channels.length !== 3) throw new Error('Gamma adjustment requires three channels')
    const tables = channels.map(gammaTable)
    if (channels.every(({ gamma, floor, ceil }) => gamma === 1 && floor === 0 && ceil === 255))
      return
    const data = this.pixels.data,
      area = this.clip
    for (let y = area.y; y < area.y + area.height; y++)
      for (let x = area.x; x < area.x + area.width; x++) {
        const offset = (y * this.width + x) * 4,
          alpha = data[offset + 3]!
        if (!alpha) continue
        for (let channel = 0; channel < 3; channel++) {
          const color = data[offset + channel]!,
            table = tables[channel]!
          if (!additive || alpha === 255) data[offset + channel] = table[color]!
          else {
            const scale = alpha + (alpha >> 7)
            if (color > alpha) data[offset + channel] = ((table[255]! * scale) >> 8) + color - alpha
            else {
              const reciprocal = Math.min(0x7fff, Math.floor(65536 / alpha))
              data[offset + channel] =
                (table[Math.min(255, (reciprocal * color) >> 8)]! * scale) >> 8
            }
          }
        }
      }
    this.touch()
  }
  fill(rect: Rect, color: number, face: number, holdAlpha: boolean): boolean {
    const area = intersect(this.clip, rect),
      data = this.pixels.data
    if (!area.width || !area.height) return false
    if (face === 3 && color & 255) this.province ??= new Uint8Array(this.width * this.height)
    for (let y = area.y; y < area.y + area.height; y++)
      for (let x = area.x; x < area.x + area.width; x++) {
        const index = y * this.width + x,
          p = index * 4
        if (face === 3) {
          if (this.province) this.province[index] = color & 255
        } else if (face === 2) data[p + 3] = color & 255
        else {
          data[p] = (color >>> 16) & 255
          data[p + 1] = (color >>> 8) & 255
          data[p + 2] = color & 255
          if (face !== 1 || !holdAlpha) data[p + 3] = (color >>> 24) & 255
        }
      }
    if (
      face === 3 &&
      !(color & 255) &&
      area.x === 0 &&
      area.y === 0 &&
      area.width === this.width &&
      area.height === this.height
    )
      this.province = undefined
    this.touch()
    return true
  }
  copy(
    source: Bitmap,
    left: number,
    top: number,
    rect: Rect,
    face: number,
    holdAlpha = false,
  ): boolean {
    let target = intersect(this.clip, { x: left, y: top, width: rect.width, height: rect.height })
    target = intersect(target, {
      x: left - rect.x,
      y: top - rect.y,
      width: source.width,
      height: source.height,
    })
    // Province allocation and absent-source clearing have separate native
    // modified rules. Keep that existing path independent of main/mask copies.
    if ((!target.width || !target.height) && face !== 3) return false
    const pixels = source === this ? source.pixels.data.slice() : source.pixels.data
    const province = source === this ? source.province?.slice() : source.province
    if (face === 3) this.province ??= new Uint8Array(this.width * this.height)
    for (let y = target.y; y < target.y + target.height; y++)
      for (let x = target.x; x < target.x + target.width; x++) {
        const src = (y - top + rect.y) * source.width + x - left + rect.x,
          dst = y * this.width + x
        if (face === 3) this.province![dst] = province?.[src] ?? 0
        else if (face === 2) this.pixels.data[dst * 4 + 3] = pixels[src * 4 + 3]!
        else
          for (let c = 0; c < (face === 1 && holdAlpha ? 3 : 4); c++)
            this.pixels.data[dst * 4 + c] = pixels[src * 4 + c]!
      }
    this.touch()
    return true
  }
  copyPixels(
    source: Pixels,
    left: number,
    top: number,
    rect: Rect,
    holdAlpha = false,
    clip: Rect = this.clip,
  ): boolean {
    const target = intersect(
      intersect(intersect(clip, { x: 0, y: 0, width: this.width, height: this.height }), {
        x: left,
        y: top,
        width: rect.width,
        height: rect.height,
      }),
      { x: left - rect.x, y: top - rect.y, width: source.width, height: source.height },
    )
    if (!target.width || !target.height) return false
    const data = source.data === this.pixels.data ? source.data.slice() : source.data
    for (let y = target.y; y < target.y + target.height; y++)
      for (let x = target.x; x < target.x + target.width; x++) {
        const from = ((y - top + rect.y) * source.width + x - left + rect.x) * 4,
          to = (y * this.width + x) * 4
        for (let c = 0; c < (holdAlpha ? 3 : 4); c++) this.pixels.data[to + c] = data[from + c]!
      }
    this.touch()
    return true
  }
  color(rect: Rect, color: number, opacity: number, face: number): void {
    if (face === 2 || face === 3) {
      this.fill(rect, color, face, true)
      return
    }
    if (opacity < 0 && face !== 0) throw new Error('Negative opacity requires dfAlpha')
    const area = intersect(this.clip, rect),
      data = this.pixels.data
    const channels = [(color >>> 16) & 255, (color >>> 8) & 255, color & 255]
    for (let y = area.y; y < area.y + area.height; y++)
      for (let x = area.x; x < area.x + area.width; x++) {
        blendColor(data, (y * this.width + x) * 4, channels, opacity, face)
      }
    this.touch()
  }
  affine(
    raster: AffineRaster | undefined,
    mode: number | 'copy',
    face: number,
    opacity = 255,
    holdAlpha = false,
    clearColor?: number,
  ): boolean {
    validateBlend(mode === 'copy' ? 1 : mode, face)
    if (!raster) return false
    const amount = blendOpacity(opacity)
    if (mode !== 'copy' && !amount) return false
    let changed = false
    if (clearColor !== undefined && this.clip.width && this.clip.height) {
      this.fill(this.clip, clearColor, face, holdAlpha)
      changed = true
    }
    const { pixels, left, top, spans } = raster
    for (let row = 0; row < pixels.height; row++) {
      const y = row + top
      if (y < this.clip.y || y >= this.clip.y + this.clip.height) continue
      const start = Math.max(left + spans[row * 2]!, this.clip.x),
        end = Math.min(left + spans[row * 2 + 1]!, this.clip.x + this.clip.width)
      if (start >= end) continue
      changed = true
      if (mode === 'copy' && (face !== 1 || !holdAlpha)) {
        const from = (row * pixels.width + start - left) * 4
        this.pixels.data.set(
          pixels.data.subarray(from, from + (end - start) * 4),
          (y * this.width + start) * 4,
        )
      } else
        for (let x = start; x < end; x++) {
          const at = (y * this.width + x) * 4,
            from = (row * pixels.width + x - left) * 4
          if (mode === 'copy')
            for (let c = 0; c < 3; c++) this.pixels.data[at + c] = pixels.data[from + c]!
          else blendPixel(this.pixels.data, at, pixels.data, from, mode, face, amount, holdAlpha)
        }
    }
    if (changed) this.touch()
    return changed
  }
  operate(
    source: Pixels,
    left: number,
    top: number,
    rect: Rect,
    mode: number,
    face: number,
    opacity = 255,
    holdAlpha = false,
  ): boolean {
    validateBlend(mode, face)
    const amount = blendOpacity(opacity)
    if (!amount) return false
    const target = intersect(
      intersect(this.clip, { x: left, y: top, width: rect.width, height: rect.height }),
      { x: left - rect.x, y: top - rect.y, width: source.width, height: source.height },
    )
    if (!target.width || !target.height) return false
    // A copy is essential for overlapping self-operations; each source pixel
    // must observe the bitmap before any part of the rectangle was written.
    const data = source.data === this.pixels.data ? source.data.slice() : source.data
    for (let y = target.y; y < target.y + target.height; y++)
      for (let x = target.x; x < target.x + target.width; x++)
        blendPixel(
          this.pixels.data,
          (y * this.width + x) * 4,
          data,
          ((y - top + rect.y) * source.width + x - left + rect.x) * 4,
          mode,
          face,
          amount,
          holdAlpha,
        )
    this.touch()
    return true
  }
  /** Rasterized glyph input uses straight RGBA; an additive-alpha destination
   * stores premultiplied RGB, while an alpha destination stores straight RGB. */
  composite(
    image: Pixels,
    left: number,
    top: number,
    face: number,
    opacity = 255,
    holdAlpha = false,
  ): boolean {
    opacity = textOpacity(face, opacity)
    // Native DrawText returns before font/raster work when opacity clamps to
    // zero. In particular an opaque draw must not clear destination alpha.
    if (!opacity) return false
    const area = intersect(this.clip, { x: left, y: top, width: image.width, height: image.height })
    if (!area.width || !area.height) return false
    const data = this.pixels.data
    for (let y = area.y; y < area.y + area.height; y++)
      for (let x = area.x; x < area.x + area.width; x++) {
        const src = ((y - top) * image.width + x - left) * 4,
          dst = (y * this.width + x) * 4
        const sa = (image.data[src + 3]! * byte(Math.abs(opacity))) / 65025,
          da = data[dst + 3]! / 255
        if (face === 1 && !holdAlpha) data[dst + 3] = 0
        if (!sa) continue
        if (opacity < 0) {
          data[dst + 3] = Math.round(data[dst + 3]! * (1 - sa))
          continue
        }
        // holdAlpha selects only the opaque text kernel. Alpha and AddAlpha
        // always update destination alpha, including negative Alpha opacity.
        const alpha = face === 1 ? da : sa + da * (1 - sa)
        for (let c = 0; c < 3; c++) {
          const source = image.data[src + c]!,
            destination = data[dst + c]!
          data[dst + c] = byte(
            Math.round(
              face === 4
                ? source * sa + destination * (1 - sa)
                : face === 1
                  ? source * sa + destination * (1 - sa)
                  : alpha
                    ? (source * sa + destination * da * (1 - sa)) / alpha
                    : 0,
            ),
          )
        }
        if (face !== 1) data[dst + 3] = Math.round(alpha * 255)
      }
    this.touch()
    // Native update rectangles follow the clipped glyph box, even when its
    // coverage is entirely zero; they do not compare before/after pixels.
    return true
  }
  flip(horizontal: boolean): void {
    const area = { x: 0, y: 0, width: this.width, height: this.height },
      data = this.pixels.data
    const count = horizontal ? Math.floor(area.width / 2) : Math.floor(area.height / 2)
    const rows = horizontal ? area.height : area.width
    for (let row = 0; row < rows; row++)
      for (let i = 0; i < count; i++) {
        const first = horizontal
          ? (area.y + row) * this.width + area.x + i
          : (area.y + i) * this.width + area.x + row
        const last = horizontal
          ? (area.y + row) * this.width + area.x + area.width - 1 - i
          : (area.y + area.height - 1 - i) * this.width + area.x + row
        for (let c = 0; c < 4; c++) {
          const value = data[first * 4 + c]!
          data[first * 4 + c] = data[last * 4 + c]!
          data[last * 4 + c] = value
        }
        if (this.province) {
          const value = this.province[first]!
          this.province[first] = this.province[last]!
          this.province[last] = value
        }
      }
    this.touch()
  }
  convert(additive: boolean): void {
    convertAlpha(this.pixels, additive)
    this.touch()
  }
  grayscale(): void {
    grayscale(this.pixels, this.clip)
    if (this.clip.width && this.clip.height) this.touch()
  }
}
