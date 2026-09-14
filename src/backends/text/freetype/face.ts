import type { FontModule } from './module.ts'
import type { FontSpec, GlyphMetrics, RasterGlyph } from '../../../engine/ports/graphics.ts'
import { fontGeometry } from '../../../engine/graphics/font.ts'
import {
  isVerticalFace,
  verticalOrientation,
  verticalPresentationForm,
} from '../../../engine/graphics/vertical.ts'
import {
  readVerticalSubstitutions,
  type VerticalSubstitutions,
} from '../../../formats/font/vertical-substitutions.ts'
const flags = (font: FontSpec) =>
  Number(font.bold) |
  (Number(font.italic) << 1) |
  (Number(font.underline) << 2) |
  (Number(font.strikeout) << 3)

export class FontKernel {
  private disposed = false
  private readonly faces = new Set<NativeFileFont>()
  constructor(readonly module: FontModule) {
    if (module._krfont_abi!() !== 2) throw new Error('Font module ABI mismatch')
  }
  open(bytes: Uint8Array, faceIndex = 0): NativeFileFont {
    if (this.disposed) throw new Error('Font module is disposed')
    if (!bytes.length || bytes.length > 16 * 1024 * 1024)
      throw new Error('Font file exceeds byte budget')
    const input = this.module._malloc!(bytes.length)
    if (!input) throw new Error('Font module allocation failed')
    let id: number
    try {
      this.module.HEAPU8.set(bytes, input)
      id = this.module._krfont_open!(input, bytes.length, faceIndex)
    } finally {
      this.module._free!(input)
    }
    if (!id) throw new Error(`FreeType font open failed (${this.module._krfont_error!()})`)
    let layout: VerticalSubstitutions | Error | undefined
    try {
      layout = readVerticalSubstitutions(bytes, faceIndex)
    } catch (error) {
      layout = error instanceof Error ? error : new Error(String(error))
    }
    const face = new NativeFileFont(this, id, layout)
    this.faces.add(face)
    return face
  }
  release(face: NativeFileFont, id: number) {
    if (this.faces.delete(face) && !this.disposed) this.module._krfont_close!(id)
  }
  dispose() {
    if (this.disposed) return
    for (const face of [...this.faces]) face.dispose()
    this.module._krfont_done!()
    this.disposed = true
  }
}
export class NativeFileFont {
  private disposed = false
  constructor(
    private readonly kernel: FontKernel,
    private readonly id: number,
    private readonly layout?: VerticalSubstitutions | Error,
  ) {}
  private call(name: string, ...args: number[]): number {
    if (this.disposed) throw new Error('Font face is disposed')
    const result = this.kernel.module[`_${name}`]!(this.id, ...args)
    const error = this.kernel.module._krfont_error!()
    if (error) throw new Error(`FreeType ${name} failed (${error})`)
    return result
  }
  ascent(height: number) {
    return this.call('krfont_ascent', height)
  }
  has(character: string, font?: FontSpec) {
    const code = character.charCodeAt(0)
    if (this.call('krfont_has', code)) return true
    const alternate = font && isVerticalFace(font) ? verticalPresentationForm(code) : undefined
    return alternate !== undefined && !!this.call('krfont_has', alternate)
  }
  advance(character: string, font: FontSpec) {
    if (isVerticalFace(font)) {
      if (!this.has(character, font)) return Math.abs(font.height)
      return this.verticalShape(character, font).advance
    }
    return this.call('krfont_advance', Math.abs(font.height), flags(font), character.charCodeAt(0))
  }
  private details(character: string, font: FontSpec): number[] {
    const pointer = this.call(
      'krfont_metrics',
      Math.abs(font.height),
      flags(font),
      character.charCodeAt(0),
    )
    if (!pointer) throw new Error('Font metrics unavailable')
    return [...this.kernel.module.HEAP32.subarray(pointer / 4, pointer / 4 + 9)]
  }
  metrics(character: string, font: FontSpec): GlyphMetrics {
    if (isVerticalFace(font)) {
      const shape = this.verticalShape(character, font)
      return this.transform(shape, { ...font, angle: 0 }, (pointer) => {
        const bounds = this.call(
          'krfont_bounds_index',
          Math.abs(font.height),
          flags(font),
          shape.index,
          pointer,
        )
        if (!bounds) throw new Error('Vertical font bounds unavailable')
        const values = [...this.kernel.module.HEAP32.subarray(bounds / 4, bounds / 4 + 4)]
        return {
          left: values[0]!,
          top: values[1]!,
          right: values[2]!,
          bottom: values[3]!,
          advance: shape.advance,
        }
      })
    }
    const [left, top, right, bottom, advance] = this.details(character, font)
    return { left: left!, top: top!, right: right!, bottom: bottom!, advance: advance! }
  }
  glyph(character: string, font: FontSpec, antialiased: boolean): RasterGlyph {
    if (isVerticalFace(font)) {
      const shape = this.verticalShape(character, font)
      return this.transform(shape, font, (pointer) => {
        const glyph = this.call(
          'krfont_glyph_index',
          Math.abs(font.height),
          flags(font) | (antialiased ? 0 : 16),
          shape.index,
          pointer,
        )
        if (!glyph) throw new Error('Vertical font glyph unavailable')
        return { ...this.readGlyph(glyph), advance: shape.advance }
      })
    }
    const pointer = this.call(
      'krfont_glyph',
      Math.abs(font.height),
      flags(font) | (antialiased ? 0 : 16),
      character.charCodeAt(0),
    )
    if (!pointer) throw new Error('Font glyph unavailable')
    const info = [...this.kernel.module.HEAP32.subarray(pointer / 4, pointer / 4 + 8)]
    let result = this.readGlyph(pointer)
    if (font.underline || font.strikeout) {
      const details = this.details(character, font)
      if (font.underline) result = horizontalLine(result, details[6]!, details[7]!)
      if (font.strikeout) result = horizontalLine(result, details[8]!, details[7]!)
    }
    // Match the reference FreeType rasterizer: glyphs remain upright; angle
    // changes the advance vector and horizontal ascent offset.
    result.left += fontGeometry(font.angle, info[5]!).ascentX
    return result
  }
  private readGlyph(pointer: number): RasterGlyph {
    const info = [...this.kernel.module.HEAP32.subarray(pointer / 4, pointer / 4 + 8)]
    return {
      width: info[0]!,
      height: info[1]!,
      left: info[2]!,
      top: info[3]!,
      advance: info[4]!,
      coverage: this.kernel.module.HEAPU8.slice(info[6]!, info[6]! + info[7]!),
    }
  }
  private verticalShape(character: string, font: FontSpec) {
    if (this.layout instanceof Error) throw this.layout
    const code = character.charCodeAt(0),
      original =
        this.call('krfont_index', character.charCodeAt(0)) || this.call('krfont_index', 32),
      substituted = this.layout?.substitute(original) ?? original,
      alternate = substituted === original ? verticalPresentationForm(code) : undefined,
      index =
        alternate === undefined ? substituted : this.call('krfont_index', alternate) || substituted,
      orientation = verticalOrientation(code),
      upright = index !== original || orientation === 'U' || orientation === 'Tu',
      pointer = this.call('krfont_metrics_index', Math.abs(font.height), flags(font), index)
    if (!pointer) throw new Error('Vertical font metrics unavailable')
    const metrics = [...this.kernel.module.HEAP32.subarray(pointer / 4, pointer / 4 + 12)],
      advance = Math.floor((metrics[upright ? 5 : 4]! + 32) / 64)
    return { index, upright, metrics, advance }
  }
  private transform<T>(
    shape: { index: number; upright: boolean; metrics: number[]; advance: number },
    font: FontSpec,
    work: (pointer: number) => T,
  ): T {
    const m = shape.metrics,
      size = Math.abs(font.height),
      radians = ((shape.upright ? font.angle - 2700 : font.angle) * Math.PI) / 1800,
      cos = Math.round(Math.cos(radians) * 65536),
      sin = Math.round(Math.sin(radians) * 65536),
      ox = shape.upright ? m[2]! - m[0]! - size * 32 : 0,
      oy = shape.upright ? -m[3]! - m[1]! : -m[6]! * 64,
      command = [cos, -sin, sin, cos, ox, oy, 0]
    for (const [enabled, position] of [
      [font.underline, m[7]!],
      [font.strikeout, m[9]!],
    ] as const) {
      if (!enabled || position < 0 || shape.advance <= 0) continue
      const thickness = m[8]!,
        top = Math.max(0, position - Math.trunc(thickness / 2)),
        bottom = top + thickness
      if (shape.upright)
        command.push(-bottom * 64 - ox, -shape.advance * 64 - oy, -top * 64 - ox, -oy)
      else command.push(0, (m[6]! - bottom) * 64, shape.advance * 64, (m[6]! - top) * 64)
      command[6]++
    }
    if (command.some((value) => !Number.isSafeInteger(value) || Math.abs(value) > 0x7fffffff))
      throw new Error('Vertical font transform exceeds integer budget')
    const pointer = this.kernel.module._malloc!(command.length * 4)
    if (!pointer) throw new Error('Font transform allocation failed')
    try {
      this.kernel.module.HEAP32.set(command, pointer / 4)
      return work(pointer)
    } finally {
      this.kernel.module._free!(pointer)
    }
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    this.kernel.release(this, this.id)
  }
}
function horizontalLine(glyph: RasterGlyph, position: number, thickness: number): RasterGlyph {
  if (position < 0 || thickness <= 0) return glyph
  const lineTop = Math.max(0, position - Math.trunc(thickness / 2)),
    lineBottom = lineTop + thickness
  const width = glyph.advance + Math.max(0, -glyph.left)
  let top = glyph.top,
    bottom = top + glyph.height
  if (lineTop < top) top = lineTop
  else if (lineBottom > bottom) bottom = lineBottom
  const height = bottom - top
  if (width < 0 || width > 4096 || height < 0 || height > 4096)
    throw new Error('Font decoration exceeds glyph budget')
  if (width === glyph.width && height === glyph.height) {
    const coverage = glyph.coverage.slice()
    for (
      let y = Math.max(0, lineTop - glyph.top);
      y < Math.min(height, lineBottom - glyph.top);
      y++
    )
      coverage.fill(255, y * width, (y + 1) * width)
    return { ...glyph, coverage }
  }
  const coverage = new Uint8Array(width * height),
    offsetX = Math.max(0, glyph.left),
    offsetY = glyph.top - top
  for (let y = 0; y < glyph.height; y++) {
    const targetY = y + offsetY
    if (targetY < 0 || targetY >= height) continue
    const length = Math.min(glyph.width, width - offsetX)
    if (length > 0)
      coverage.set(
        glyph.coverage.subarray(y * glyph.width, y * glyph.width + length),
        targetY * width + offsetX,
      )
  }
  for (let y = Math.max(0, lineTop - top); y < Math.min(height, lineBottom - top); y++)
    coverage.fill(255, y * width, (y + 1) * width)
  return { ...glyph, width, height, left: Math.min(0, glyph.left), top, coverage }
}
