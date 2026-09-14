import type {
  GraphicsDecoder,
  Pixels,
  FontSpec,
  TextOptions,
  TextPixels,
} from '../../../engine/ports/graphics.ts'
import { decodeBmp } from '../../../formats/image/bmp.ts'
import type { FontKernel, NativeFileFont } from '../freetype/face.ts'
import { fontGeometry } from '../../../engine/graphics/font.ts'
import { cssFontFamily } from './families.ts'
import { browserVerticalGlyph, isVerticalFace } from '../../../engine/graphics/vertical.ts'

export class BrowserGraphics implements GraphicsDecoder {
  private fontSequence = 0
  private readonly measurement = new OffscreenCanvas(1, 1).getContext('2d')!
  private readonly raster = new OffscreenCanvas(1, 1)
  private readonly nativeFaces = new Map<string, NativeFileFont>()
  private readonly browserFaces = new Set<() => void>()
  private nativePromise?: Promise<FontKernel>
  private disposed = false
  constructor(private readonly nativeLoader?: () => Promise<FontKernel>) {}
  async loadFont(bytes: Uint8Array) {
    if (this.disposed) throw new Error('Font backend is disposed')
    if (this.nativeLoader) {
      const pending = (this.nativePromise ??= this.nativeLoader())
      let kernel: FontKernel
      try {
        kernel = await pending
      } catch (error) {
        if (this.nativePromise === pending) this.nativePromise = undefined
        throw error
      }
      if (this.disposed) throw new Error('Font backend is disposed')
      const face = kernel.open(bytes),
        family = `krkr-file-font-${++this.fontSequence}`
      this.nativeFaces.set(family, face)
      return {
        face: family,
        dispose: () => {
          face.dispose()
          this.nativeFaces.delete(family)
        },
      }
    }
    const fonts = (globalThis as unknown as { fonts?: FontFaceSet }).fonts
    if (!fonts || typeof FontFace === 'undefined')
      throw new Error('This browser cannot load fonts in the game Worker')
    const family = `krkr-file-font-${++this.fontSequence}`,
      face = new FontFace(family, Uint8Array.from(bytes).buffer)
    await face.load()
    if (this.disposed) throw new Error('Font backend is disposed')
    fonts.add(face)
    const dispose = () => {
      if (this.browserFaces.delete(dispose)) fonts.delete(face)
    }
    this.browserFaces.add(dispose)
    return {
      face: family,
      dispose,
    }
  }
  async decode(bytes: Uint8Array): Promise<Pixels> {
    const bmp = decodeBmp(bytes)
    if (bmp) return bmp
    const image = await createImageBitmap(new Blob([Uint8Array.from(bytes).buffer]))
    try {
      if (image.width > 4096 || image.height > 4096)
        throw new Error('Image exceeds 4096px dimension limit')
      const canvas = new OffscreenCanvas(image.width, image.height)
      const ctx = canvas.getContext('2d')!
      ctx.drawImage(image, 0, 0)
      return {
        width: image.width,
        height: image.height,
        data: new Uint8Array(ctx.getImageData(0, 0, image.width, image.height).data.buffer),
      }
    } finally {
      image.close()
    }
  }
  private font(spec: FontSpec): string {
    const faces = spec.face.replace(/^@/, '').split(',').map(cssFontFamily).join(',')
    return `${spec.italic ? 'italic ' : ''}${spec.bold ? 'bold ' : ''}${Math.abs(spec.height)}px ${faces},sans-serif`
  }
  measure(text: string, font: FontSpec): { width: number; height: number; ascent: number } {
    if (text.length > 8192) throw new Error('Text exceeds measurement budget')
    const native = this.nativeFaces.get(font.face)
    if (native) {
      let width = 0
      for (let i = 0; i < text.length && text.charCodeAt(i); i++)
        width += native.advance(text[i]!, font)
      return { width, height: Math.abs(font.height), ascent: native.ascent(Math.abs(font.height)) }
    }
    if (isVerticalFace(font)) {
      const horizontal = { ...font, face: font.face.replace(/^@/, ''), verticalFace: false },
        base = this.measure('', horizontal)
      let width = 0
      for (let i = 0; i < text.length && text.charCodeAt(i); i++)
        width += browserVerticalGlyph(text[i]!).upright
          ? Math.abs(font.height)
          : this.measure(text[i]!, horizontal).width
      return { ...base, width }
    }
    const context = this.measurement
    context.font = this.font(font)
    const metrics = context.measureText(text)
    return {
      width: metrics.width,
      height: Math.abs(font.height),
      ascent: metrics.fontBoundingBoxAscent ?? Math.abs(font.height) * 0.8,
    }
  }
  measureGlyph(character: string, font: FontSpec) {
    const native = this.nativeFaces.get(font.face)
    if (native) return native.metrics(character, font)
    const context = this.measurement
    context.font = this.font(font)
    const m = context.measureText(character),
      size = Math.abs(font.height),
      baseline = m.fontBoundingBoxAscent ?? size * 0.8
    // TextMetrics ink bounds differ between browsers even for the same loaded
    // font. Scan the unrotated glyph that this backend actually rasterizes.
    const raster = this.text(
      character,
      size,
      0xffffff,
      {
        ...font,
        angle: 0,
        underline: false,
        strikeout: false,
      },
      { antialiased: true, shadowLevel: 0, shadowWidth: 0, shadowX: 0, shadowY: 0, shadowColor: 0 },
    )
    let x0 = raster.width,
      y0 = raster.height,
      x1 = 0,
      y1 = 0
    for (let y = 0; y < raster.height; y++)
      for (let x = 0; x < raster.width; x++)
        if (raster.data[(y * raster.width + x) * 4 + 3]) {
          x0 = Math.min(x0, x)
          y0 = Math.min(y0, y)
          x1 = Math.max(x1, x + 1)
          y1 = Math.max(y1, y + 1)
        }
    const empty = x0 === raster.width
    let left = empty ? 0 : x0 + (raster.left ?? 0),
      top = empty ? Math.trunc(baseline) : y0 + (raster.top ?? 0),
      right = empty ? 0 : x1 + (raster.left ?? 0),
      bottom = empty ? Math.trunc(baseline) : y1 + (raster.top ?? 0)
    const line = (y: number) => {
      left = Math.min(left, 0)
      right = Math.max(right, Math.ceil(m.width))
      top = Math.min(top, Math.floor(y))
      bottom = Math.max(bottom, Math.ceil(y + Math.max(1, size / 16)))
    }
    if (font.underline) line(baseline + Math.max(1, size / 16))
    if (font.strikeout) line(baseline - size * 0.3)
    return {
      left,
      top,
      right,
      bottom,
      advance: Math.round(isVerticalFace(font) ? this.measure(character, font).width : m.width),
      rasterSamples: raster.width * raster.height,
    }
  }
  glyph(character: string, font: FontSpec, antialiased: boolean) {
    const native = this.nativeFaces.get(font.face)
    if (!native) return undefined
    const code = character.charCodeAt(0),
      space =
        (code >= 9 && code <= 13) ||
        [32, 0x85, 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000].includes(code) ||
        (code >= 0x2000 && code <= 0x200a)
    if (
      !native.has(character, font) &&
      !space &&
      !(code >= 0xd800 && code <= 0xdfff) &&
      !(code >= 0xfdd0 && code <= 0xfdef) &&
      code < 0xfffe
    ) {
      if (isVerticalFace(font)) {
        const fallback = { ...font, face: 'sans-serif', faceIsFileName: false, verticalFace: true },
          raster = this.text(character, Math.abs(font.height), 0xffffff, fallback, {
            antialiased,
            shadowLevel: 0,
            shadowWidth: 0,
            shadowX: 0,
            shadowY: 0,
            shadowColor: 0,
          }),
          coverage = new Uint8Array(raster.width * raster.height)
        for (let i = 0; i < coverage.length; i++) coverage[i] = raster.data[i * 4 + 3]!
        return {
          width: raster.width,
          height: raster.height,
          left: raster.left ?? 0,
          top: raster.top ?? 0,
          coverage,
          advance: Math.round(this.measure(character, fallback).width),
        }
      }
      const fallback = { ...font, face: 'sans-serif', faceIsFileName: false, angle: 0 },
        raster = this.text(character, Math.abs(font.height), 0xffffff, fallback, {
          antialiased,
          shadowLevel: 0,
          shadowWidth: 0,
          shadowX: 0,
          shadowY: 0,
          shadowColor: 0,
        }),
        coverage = new Uint8Array(raster.width * raster.height)
      for (let i = 0; i < coverage.length; i++) coverage[i] = raster.data[i * 4 + 3]!
      return {
        width: raster.width,
        height: raster.height,
        left:
          (raster.left ?? 0) +
          fontGeometry(font.angle, native.ascent(Math.abs(font.height))).ascentX,
        top: raster.top ?? 0,
        coverage,
        advance: Math.round(this.measure(character, fallback).width),
      }
    }
    return native.glyph(character, font, antialiased)
  }
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const face of this.nativeFaces.values()) face.dispose()
    this.nativeFaces.clear()
    for (const dispose of this.browserFaces) dispose()
    void this.nativePromise?.then((kernel) => kernel.dispose()).catch(() => {})
  }
  text(
    text: string,
    size: number,
    color: number,
    spec?: FontSpec,
    options?: TextOptions,
  ): TextPixels {
    if (!spec || !isVerticalFace(spec) || !text.length)
      return this.canvasText(text, size, color, spec, options)
    if (text.length > 8192 || !Number.isFinite(size) || size < 1 || size > 256)
      throw new Error('Text exceeds drawing budget')
    const pieces: { image: TextPixels; x: number; y: number }[] = [],
      geometry = fontGeometry(spec.angle, 0),
      horizontal = { ...spec, face: spec.face.replace(/^@/, ''), verticalFace: false }
    let x = 0,
      y = 0,
      left = Infinity,
      top = Infinity,
      right = -Infinity,
      bottom = -Infinity,
      bytes = 0
    for (let i = 0; i < text.length && text.charCodeAt(i); i++) {
      const shape = browserVerticalGlyph(text[i]!),
        image = this.canvasText(
          shape.character,
          size,
          color,
          { ...horizontal, angle: shape.upright ? (spec.angle + 900) % 3600 : spec.angle },
          options,
          shape.upright ? -size : 0,
        ),
        px = x + (image.left ?? 0),
        py = y + (image.top ?? 0)
      pieces.push({ image, x: px, y: py })
      left = Math.min(left, px)
      top = Math.min(top, py)
      right = Math.max(right, px + image.width)
      bottom = Math.max(bottom, py + image.height)
      bytes += image.data.length
      if (right - left > 4096 || bottom - top > 4096 || bytes > 64 * 1024 * 1024)
        throw new Error('Vertical text exceeds raster budget')
      const advance = geometry.advance(
        Math.round(shape.upright ? size : this.measure(text[i]!, horizontal).width),
      )
      x += advance.x
      y += advance.y
    }
    if (!pieces.length) return { width: 1, height: 1, data: new Uint8Array(4), left: 0, top: 0 }
    if (pieces.length === 1) return pieces[0]!.image
    const canvas = this.raster,
      stamp = new OffscreenCanvas(1, 1),
      context = canvas.getContext('2d')!,
      source = stamp.getContext('2d')!
    canvas.width = right - left
    canvas.height = bottom - top
    for (const piece of pieces) {
      stamp.width = piece.image.width
      stamp.height = piece.image.height
      source.putImageData(
        new ImageData(new Uint8ClampedArray(piece.image.data), stamp.width, stamp.height),
        0,
        0,
      )
      context.drawImage(stamp, piece.x - left, piece.y - top)
    }
    return {
      width: canvas.width,
      height: canvas.height,
      left,
      top,
      data: new Uint8Array(context.getImageData(0, 0, canvas.width, canvas.height).data.buffer),
    }
  }
  private canvasText(
    text: string,
    size: number,
    color: number,
    spec?: FontSpec,
    options?: TextOptions,
    originX = 0,
  ): TextPixels {
    if (text.length > 8192 || !Number.isFinite(size) || size < 1 || size > 256)
      throw new Error('Text exceeds drawing budget')
    const fontSpec = spec ?? {
      height: size,
      face: 'sans-serif',
      bold: false,
      italic: false,
      underline: false,
      strikeout: false,
      angle: 0,
    }
    const canvas = this.raster
    const ctx = canvas.getContext('2d')!
    const font = this.font(fontSpec)
    ctx.font = font
    const metrics = ctx.measureText(text),
      baseline = metrics.fontBoundingBoxAscent ?? size * 0.8
    const angle = (-fontSpec.angle * Math.PI) / 1800,
      c = Math.cos(angle),
      s = Math.sin(angle)
    const minX = originX + Math.min(0, -metrics.actualBoundingBoxLeft),
      maxX = originX + Math.max(metrics.width, metrics.actualBoundingBoxRight)
    const minY = Math.min(0, baseline - metrics.actualBoundingBoxAscent),
      maxY = Math.max(size, baseline + metrics.actualBoundingBoxDescent)
    const corners = [
      [minX, minY],
      [maxX, minY],
      [minX, maxY],
      [maxX, maxY],
    ].map(([x, y]) => ({ x: x! * c - y! * s, y: x! * s + y! * c }))
    const blur = options?.shadowWidth ?? 0,
      shadowX = options?.shadowX ?? 0,
      shadowY = options?.shadowY ?? 0
    if (blur < 0 || blur > 64 || Math.abs(shadowX) > 4096 || Math.abs(shadowY) > 4096)
      throw new Error('Text shadow exceeds drawing budget')
    const padding = options?.shadowLevel ? Math.ceil(blur * 3 + 2) : 1
    const left = Math.floor(Math.min(...corners.map((p) => p.x)) + Math.min(0, shadowX) - padding)
    const top = Math.floor(Math.min(...corners.map((p) => p.y)) + Math.min(0, shadowY) - padding)
    const width = Math.max(
      1,
      Math.ceil(Math.max(...corners.map((p) => p.x)) + Math.max(0, shadowX) + padding - left),
    )
    const height = Math.max(
      1,
      Math.ceil(Math.max(...corners.map((p) => p.y)) + Math.max(0, shadowY) + padding - top),
    )
    if (width > 4096 || height > 4096) throw new Error('Text raster exceeds dimension budget')
    canvas.width = width
    canvas.height = height
    ctx.font = font
    ctx.translate(-left, -top)
    ctx.textBaseline = 'alphabetic'
    if (options?.shadowLevel) {
      ctx.shadowColor = `rgba(${(options.shadowColor >>> 16) & 255},${(options.shadowColor >>> 8) & 255},${options.shadowColor & 255},${Math.min(255, options.shadowLevel) / 255})`
      ctx.shadowBlur = blur
      ctx.shadowOffsetX = shadowX
      ctx.shadowOffsetY = shadowY
    }
    ctx.rotate(angle)
    ctx.fillStyle = `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
    ctx.fillText(text, originX, baseline)
    if (fontSpec.underline)
      ctx.fillRect(
        originX,
        baseline + Math.max(1, size / 16),
        metrics.width,
        Math.max(1, size / 16),
      )
    if (fontSpec.strikeout)
      ctx.fillRect(originX, baseline - size * 0.3, metrics.width, Math.max(1, size / 16))
    const data = new Uint8Array(ctx.getImageData(0, 0, width, height).data.buffer)
    if (options && !options.antialiased)
      for (let i = 3; i < data.length; i += 4) data[i] = data[i]! >= 128 ? 255 : 0
    return {
      width,
      height,
      data,
      left,
      top,
    }
  }
}
