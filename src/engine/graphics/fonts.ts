import type {
  FontSpec,
  GraphicsDecoder,
  TextOptions,
  TextPixels,
  LoadedFont,
} from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import { ExecutionCancelled, SerialQueue } from '../scheduler/control.ts'
import { readPrerenderedFont, type PrerenderedFont } from '../../formats/font/prerendered.ts'
import { colorGlyph, shadowGlyph, type GlyphMask } from './glyph.ts'
import { fontGeometry } from './font.ts'
import { isVerticalFace } from './vertical.ts'

type Finish = <T>(work: Generator<void, T>) => Promise<T>
interface MappedFont {
  token: object
  font: PrerenderedFont
  refs: number
}
interface FileFont {
  loaded: LoadedFont
  bytes: number
}
export interface NamedFontFace {
  resource: Resource
  bold: boolean
  italic: boolean
}
export interface TextDraw {
  pixels: TextPixels
  x: number
  y: number
}
export const fontKey = (font: FontSpec): string =>
  JSON.stringify([
    Math.abs(font.height),
    font.angle,
    font.face,
    !!font.bold,
    !!font.italic,
    !!font.underline,
    !!font.strikeout,
    !!font.faceIsFileName,
  ])

/** Session-wide font mappings; rasterizer faces remain behind GraphicsDecoder. */
export class FontService {
  private mappings = new Map<string, MappedFont>()
  private sources = new Map<object, MappedFont>()
  private files = new Map<object, FileFont>()
  private namedFiles = new Map<string, NamedFontFace[]>()
  // A dialog preview may still be finishing when its suspended script resumes.
  // Keep raster operations together so another operation cannot evict its face.
  private readonly raster = new SerialQueue()
  private disposed = false
  private waiters = new Set<() => void>()
  constructor(
    private readonly resolve: (name: string) => Resource,
    private readonly graphics: GraphicsDecoder,
    private readonly finish: Finish,
  ) {}
  private check(): void {
    if (this.disposed) throw new ExecutionCancelled()
  }
  registerNamed(fonts: Map<string, NamedFontFace[]>): void {
    this.check()
    this.namedFiles = new Map(
      [...fonts]
        .filter(([, faces]) => faces.length)
        .map(([name, faces]) => [name, faces.map((face) => ({ ...face }))]),
    )
  }
  private wait<T>(value: Promise<T>): Promise<T> {
    // A shared never-settling cancellation Promise would retain settled race
    // results, including evicted font faces, until the entire session stops.
    return new Promise<T>((resolve, reject) => {
      let pending = true
      const take = () => {
        if (!pending) return false
        pending = false
        this.waiters.delete(cancel)
        return true
      }
      const cancel = () => {
        if (take()) reject(new ExecutionCancelled())
      }
      this.waiters.add(cancel)
      void value.then(
        (result) => {
          if (take()) resolve(result)
        },
        (error) => {
          if (take()) reject(error)
        },
      )
      if (this.disposed) cancel()
    })
  }
  private mappedBytes(): number {
    return [...this.sources.values()].reduce((sum, item) => sum + item.font.bytes, 0)
  }
  async map(spec: FontSpec, name: string): Promise<void> {
    this.check()
    const key = fontKey(spec),
      resource = this.resolve(name),
      token = resource.cacheToken ?? resource,
      old = this.mappings.get(key)
    let source = this.sources.get(token)
    if (source === old && source) return
    if (!source) {
      if (resource.size > 32 * 1024 * 1024) throw new Error('Pre-rendered font exceeds 32 MiB')
      const font = await this.finish(readPrerenderedFont(await this.wait(resource.read())))
      this.check()
      if (
        this.mappedBytes() + font.bytes - (old?.refs === 1 ? old.font.bytes : 0) >
        64 * 1024 * 1024
      )
        throw new Error('Mapped font coverage exceeds 64 MiB')
      source = { token, font, refs: 0 }
    }
    if (!old && this.mappings.size >= 4096) throw new Error('Font mapping limit exceeded')
    this.unmap(spec)
    source.refs++
    this.sources.set(token, source)
    this.mappings.set(key, source)
  }
  unmap(spec: FontSpec): void {
    this.check()
    const key = fontKey(spec),
      entry = this.mappings.get(key)
    if (!entry) return
    this.mappings.delete(key)
    if (--entry.refs === 0) this.sources.delete(entry.token)
  }
  private async prepare(spec: FontSpec): Promise<FontSpec> {
    this.check()
    const family = spec.face.toLowerCase(),
      variants =
        this.namedFiles.get(family) ??
        (family.startsWith('@') ? this.namedFiles.get(family.slice(1)) : undefined),
      cost = (face: NamedFontFace) =>
        Number(face.italic !== spec.italic) * 2 + Number(face.bold !== spec.bold),
      named = !spec.faceIsFileName
        ? variants?.reduce((best, face) => (cost(face) < cost(best) ? face : best))
        : undefined
    const resource = spec.faceIsFileName ? this.resolve(spec.face) : named?.resource
    if (!resource) return spec
    if (!this.graphics.loadFont) throw new Error('Font file loading requires a font backend')
    const token = resource.cacheToken ?? resource
    let entry = this.files.get(token)
    if (!entry) {
      if (resource.size > 16 * 1024 * 1024) throw new Error('Font file exceeds 16 MiB')
      const bytes = await this.wait(resource.read())
      this.check()
      if (bytes.length > 16 * 1024 * 1024) throw new Error('Font file exceeds 16 MiB')
      let owned: LoadedFont | undefined,
        released = false
      const release = () => {
        if (owned && !released) {
          released = true
          owned.dispose()
        }
      }
      const pending = this.graphics.loadFont(bytes).then((loaded) => {
        owned = loaded
        if (this.disposed) release()
        return { face: loaded.face, dispose: release }
      })
      let loaded: LoadedFont
      try {
        loaded = await this.wait(pending)
      } catch (error) {
        release()
        throw error
      }
      if (this.disposed) loaded.dispose()
      this.check()
      let total = [...this.files.values()].reduce((sum, item) => sum + item.bytes, 0)
      while (this.files.size >= 32 || total + bytes.length > 32 * 1024 * 1024) {
        const oldest = this.files.entries().next().value!
        total -= oldest[1].bytes
        oldest[1].loaded.dispose()
        this.files.delete(oldest[0])
      }
      entry = { loaded, bytes: bytes.length }
    }
    this.files.delete(token)
    this.files.set(token, entry)
    return {
      ...spec,
      face: entry.loaded.face,
      faceIsFileName: false,
      verticalFace: isVerticalFace(spec),
      bold: spec.bold && !named?.bold,
      italic: spec.italic && !named?.italic,
    }
  }
  measure(text: string, spec: FontSpec): Promise<{ width: number; height: number }> {
    const font = { ...spec }
    return this.raster.enqueue(() => this.measureText(text, font))
  }
  private async measureText(
    text: string,
    spec: FontSpec,
  ): Promise<{ width: number; height: number }> {
    if (text.length > 8192) throw new Error('Text exceeds measurement budget')
    const prepared = await this.prepare(spec),
      mapped = this.mappings.get(fontKey(spec))?.font
    const work = function* (
      graphics: GraphicsDecoder,
    ): Generator<void, { width: number; height: number }> {
      let width = 0
      const advances = new Map<number, number>()
      for (let i = 0; i < text.length && text.charCodeAt(i) !== 0; i++) {
        const code = text.charCodeAt(i),
          glyph = mapped?.find(code)
        if (glyph) width += glyph.advance
        else {
          if (!graphics.measure) throw new Error('Font metrics require a graphics backend')
          let advance = advances.get(code)
          if (advance === undefined) {
            advance = Math.round(graphics.measure(text[i]!, prepared).width)
            advances.set(code, advance)
          }
          width += advance
        }
        if ((i & 63) === 0) yield
      }
      return { width, height: Math.abs(spec.height) }
    }
    return this.finish(work(this.graphics))
  }
  draw(text: string, spec: FontSpec, color: number, options: TextOptions): Promise<TextDraw[]> {
    const font = { ...spec },
      settings = { ...options }
    return this.raster.enqueue(() => this.drawText(text, font, color, settings))
  }
  private async drawText(
    text: string,
    spec: FontSpec,
    color: number,
    options: TextOptions,
  ): Promise<TextDraw[]> {
    if (text.length > 8192) throw new Error('Text exceeds drawing budget')
    if (
      !Number.isInteger(options.shadowLevel) ||
      options.shadowLevel < 0 ||
      options.shadowLevel > 255 ||
      Math.abs(options.shadowWidth) > 64 ||
      Math.abs(options.shadowX) > 4096 ||
      Math.abs(options.shadowY) > 4096
    )
      throw new Error('Text shadow exceeds drawing budget')
    const prepared = await this.prepare(spec),
      mapped = this.mappings.get(fontKey(spec))?.font,
      graphics = this.graphics,
      ascent = Math.trunc(graphics.measure?.('', prepared).ascent ?? Math.abs(spec.height) * 0.8),
      geometry = fontGeometry(spec.angle, ascent)
    const work = function* (): Generator<void, TextDraw[]> {
      const fronts: TextDraw[] = [],
        shadows: TextDraw[] = [],
        cache = new Map<
          number,
          { front: TextPixels; shadow?: TextPixels; dx: number; dy: number }
        >()
      let x = 0,
        y = 0,
        bytes = 0,
        samples = 0
      for (let i = 0; i < text.length && text.charCodeAt(i) !== 0; i++) {
        const code = text.charCodeAt(i)
        let cached = cache.get(code)
        if (!cached) {
          const glyph = mapped?.find(code)
          let mask: GlyphMask, dx: number, dy: number
          if (glyph) {
            mask = {
              width: glyph.width,
              height: glyph.height,
              left: glyph.originX + geometry.ascentX,
              top: -glyph.originY + geometry.ascentY,
              coverage: glyph.coverage,
            }
            dx = glyph.incX
            dy = spec.angle < 1800 ? -Math.abs(glyph.incY) : Math.abs(glyph.incY)
          } else {
            const native = graphics.glyph?.(text[i]!, prepared, options.antialiased)
            if (native) {
              if (
                !Number.isInteger(native.width) ||
                !Number.isInteger(native.height) ||
                native.width < 0 ||
                native.height < 0 ||
                native.width > 4096 ||
                native.height > 4096 ||
                [native.left, native.top, native.advance].some(
                  (value) => !Number.isSafeInteger(value) || Math.abs(value) > 16777216,
                ) ||
                !(native.coverage instanceof Uint8Array) ||
                native.coverage.length !== native.width * native.height
              )
                throw new Error('Invalid font glyph')
              mask = native
              const advance = geometry.advance(native.advance)
              dx = advance.x
              dy = advance.y
            } else {
              if (!graphics.measure) throw new Error('Font metrics require a graphics backend')
              const width = Math.round(graphics.measure(text[i]!, prepared).width),
                raster = graphics.text(text[i]!, Math.abs(spec.height), 0xffffff, prepared, {
                  ...options,
                  shadowLevel: 0,
                  shadowWidth: 0,
                  shadowX: 0,
                  shadowY: 0,
                })
              mask = {
                width: raster.width,
                height: raster.height,
                left: raster.left ?? 0,
                top: raster.top ?? 0,
                coverage: new Uint8Array(raster.width * raster.height),
              }
              for (let p = 0; p < mask.coverage.length; p++) {
                mask.coverage[p] = raster.data[p * 4 + 3]!
                if ((p & 4095) === 0) yield
              }
              const advance = geometry.advance(width)
              dx = advance.x
              dy = advance.y
            }
          }
          const front = yield* colorGlyph(mask, color),
            shadow =
              options.shadowLevel && mask.width && mask.height
                ? yield* colorGlyph(
                    yield* shadowGlyph(mask, options.shadowLevel, options.shadowWidth),
                    options.shadowColor,
                  )
                : undefined
          bytes += front.data.length + (shadow?.data.length ?? 0)
          if (bytes > 64 * 1024 * 1024) throw new Error('Text raster exceeds 64 MiB')
          cached = { front, shadow, dx, dy }
          cache.set(code, cached)
        }
        if (cached.front.width && cached.front.height) {
          samples += cached.front.data.length / 4 + (cached.shadow?.data.length ?? 0) / 4
          if (samples > 64 * 1024 * 1024)
            throw new Error('Text composition exceeds 64 million samples')
          fronts.push({ pixels: cached.front, x, y })
          if (cached.shadow)
            shadows.push({ pixels: cached.shadow, x: x + options.shadowX, y: y + options.shadowY })
        }
        x += cached.dx
        y += cached.dy
        if (Math.abs(x) > 16777216 || Math.abs(y) > 16777216)
          throw new Error('Text advance exceeds coordinate budget')
        yield
      }
      return [...shadows, ...fronts]
    }
    return this.finish(work())
  }
  bounds(text: string, spec: FontSpec) {
    const font = { ...spec }
    return this.raster.enqueue(() => this.glyphBounds(text, font))
  }
  private async glyphBounds(text: string, spec: FontSpec) {
    if (text.length > 8192) throw new Error('Text exceeds glyph bounds budget')
    const prepared = await this.prepare(spec),
      graphics = this.graphics
    if (!graphics.measureGlyph) throw new Error('Glyph bounds require a font backend')
    // The reference query asks the rasterizer directly, independently of the
    // pre-rendered mapping. Its horizontal advance is not the drawing vector.
    const font = { ...prepared, angle: 0 }
    return this.finish(
      (function* () {
        let left = 0,
          top = 0,
          right = 0,
          bottom = 0,
          offset = 0,
          samples = 0
        const cache = new Map<string, ReturnType<NonNullable<typeof graphics.measureGlyph>>>()
        for (let i = 0; i < text.length; i++) {
          const character = text[i]!
          let glyph = cache.get(character)
          if (!glyph) {
            glyph = graphics.measureGlyph!(character, font)
            if (
              [glyph.left, glyph.top, glyph.right, glyph.bottom, glyph.advance].some(
                (value) => !Number.isSafeInteger(value) || Math.abs(value) > 16777216,
              ) ||
              (glyph.rasterSamples !== undefined &&
                (!Number.isSafeInteger(glyph.rasterSamples) || glyph.rasterSamples < 0))
            )
              throw new Error('Invalid glyph metrics')
            cache.set(character, glyph)
            samples += glyph.rasterSamples ?? 0
            if (samples < 0 || samples > 64 * 1024 * 1024)
              throw new Error('Glyph bounds exceed raster budget')
          }
          const l = glyph.left + offset,
            r = glyph.right + offset
          if (i === 0) {
            left = l
            top = glyph.top
            right = r
            bottom = glyph.bottom
          } else if (l < r && glyph.top < glyph.bottom) {
            left = Math.min(left, l)
            top = Math.min(top, glyph.top)
            right = Math.max(right, r)
            bottom = Math.max(bottom, glyph.bottom)
          }
          offset += glyph.advance
          if (Math.abs(offset) > 16777216 || Math.abs(l) > 16777216 || Math.abs(r) > 16777216)
            throw new Error('Glyph bounds exceed coordinate budget')
          yield
        }
        return { left, top, right, bottom }
      })(),
    )
  }
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const cancel of this.waiters) cancel()
    this.waiters.clear()
    this.mappings.clear()
    this.sources.clear()
    for (const entry of this.files.values()) entry.loaded.dispose()
    this.files.clear()
    this.namedFiles.clear()
  }
}
