import type { FontCharset, FontDescriptor } from '../ports/fonts.ts'
import type { FontSpec } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import type { NamedFontFace } from './fonts.ts'
import { readFontFaces, validFontName, type FontMetadata } from '../../formats/font/metadata.ts'

// Generic CSS families are virtual Unicode fonts. Their physical outline format
// is unknown, so they do not satisfy TrueType-only enumeration.
export const genericFonts: FontDescriptor[] = [
  { name: 'sans-serif', source: 'generic', charsets: ['unicode'], vertical: false },
  { name: 'serif', source: 'generic', charsets: ['unicode'], vertical: false },
  {
    name: 'monospace',
    source: 'generic',
    fixedPitch: true,
    charsets: ['unicode'],
    vertical: false,
  },
]
export function filterFonts(
  entries: readonly FontDescriptor[],
  flags: number,
  current: FontCharset | undefined,
): FontDescriptor[] {
  const result: FontDescriptor[] = [],
    seen = new Set<string>()
  for (const entry of entries) {
    if (flags & 1 && entry.fixedPitch !== true) continue
    if (flags & 4 && (entry.vertical || entry.name.startsWith('@'))) continue
    if (flags & 8 && entry.outline !== true) continue
    let charsets: (FontCharset | undefined)[] = entry.charsets?.length
      ? entry.charsets
      : [undefined]
    if (flags & 2) charsets = charsets.filter((cs) => cs !== undefined && cs === current)
    if (flags & 16) charsets = charsets.filter((cs) => cs !== undefined && cs !== 2)
    if (!charsets.length || seen.has(entry.name)) continue
    seen.add(entry.name)
    result.push({ ...entry, charsets: entry.charsets?.slice() })
  }
  return result
}
export function validateSystemFonts(input: FontDescriptor[]): FontDescriptor[] {
  if (!Array.isArray(input) || input.length > 2048)
    throw new Error('Font catalog exceeds entry budget')
  return input.map((font) => {
    if (
      !font ||
      !validFontName(font.name) ||
      font.source !== 'system' ||
      [font.fixedPitch, font.outline, font.vertical].some(
        (value) => value !== undefined && typeof value !== 'boolean',
      ) ||
      (font.charsets !== undefined &&
        (!Array.isArray(font.charsets) ||
          font.charsets.length > 32 ||
          font.charsets.some(
            (cs) => cs !== 'unicode' && (!Number.isInteger(cs) || cs < 0 || cs > 255),
          )))
    )
      throw new Error('Invalid system font descriptor')
    return {
      name: font.name,
      source: 'system',
      fixedPitch: font.fixedPitch,
      outline: font.outline,
      vertical: font.vertical ?? font.name.startsWith('@'),
      charsets: font.charsets?.slice(),
    }
  })
}
interface CatalogDependencies {
  files(): Resource[] | Promise<Resource[]>
  resolve(name: string): Resource | Promise<Resource>
  bind(fonts: Map<string, NamedFontFace[]>): void
  bindSystem?(names: string[]): void
  check(): void
  yield(): Promise<void>
  warn(message: string): void
  wait<T>(work: Promise<T>): Promise<T>
}
export class FontCatalog {
  private system: FontDescriptor[] = []
  private game: FontDescriptor[] = []
  private metadata = new WeakMap<object, FontMetadata[]>()
  private loading?: Promise<void>
  private loadingFile?: string
  private initialized = false
  private readonly fileFaces = new Map<string, object>()
  constructor(private readonly deps: CatalogDependencies) {}
  setSystem(entries: FontDescriptor[]) {
    this.system = validateSystemFonts(entries)
    this.deps.bindSystem?.(this.system.map((entry) => entry.name))
  }
  /** First ordinary family use shares discovery with getList/select. Later
   * explicit prepare calls still refresh added or replaced game resources. */
  async ensure(): Promise<void> {
    if (this.initialized) return
    try { await this.prepare() }
    catch (error) {
      this.deps.check() // Cancellation never becomes a successful fallback.
      if (this.initialized) return
      // Optional auto-discovery must not break an otherwise usable system
      // font. Do not replace any catalog published by an explicit refresh.
      this.initialized = true
      this.deps.warn(`Optional game font discovery failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async prepare(font?: FontSpec): Promise<void> {
    this.deps.check()
    if (this.loading) {
      const covered = !font?.faceIsFileName || this.loadingFile === font.face
      await this.loading
      if (covered) return
      // A normal scan need not include an explicitly requested path (e.g. an
      // unopened archive member). Join it first, then coalesce the file scan
      // with any same-path waiter that already resumed.
      return this.prepare(font)
    }
    const pending = this.discover(font)
    this.loading = pending
    this.loadingFile = font?.faceIsFileName ? font.face : undefined
    try {
      await pending
    } finally {
      if (this.loading === pending) {
        this.loading = undefined
        this.loadingFile = undefined
      }
    }
  }
  private async discover(font?: FontSpec) {
    const seen = new Set<object>()
    const files = (await this.deps.files())
      .filter((file) => /\.(ttf|otf|ttc|otc)$/i.test(file.name))
      .sort((a, b) => Number(a.name.includes('>')) - Number(b.name.includes('>')))
      .filter((file) => {
        const token = file.cacheToken ?? file
        if (seen.has(token)) return false
        seen.add(token)
        return true
      })
    if (font?.faceIsFileName) {
      const current = await this.deps.wait(Promise.resolve(this.deps.resolve(font.face)))
      this.fileFaces.delete(font.face)
      this.fileFaces.set(font.face, current.cacheToken ?? current)
      if (this.fileFaces.size > 128) this.fileFaces.delete(this.fileFaces.keys().next().value!)
      if (!files.some((file) => (file.cacheToken ?? file) === (current.cacheToken ?? current)))
        files.push(current)
    }
    if (files.length > 128) throw new Error('Game font catalog exceeds 128 files')
    const game: FontDescriptor[] = [],
      bindings = new Map<string, NamedFontFace[]>()
    for (const resource of files) {
      this.deps.check()
      const token = resource.cacheToken ?? resource
      let entries = this.metadata.get(token)
      if (!entries) {
        entries = []
        try {
          if (resource.size > 16 * 1024 * 1024) throw new Error('Font file exceeds 16 MiB')
          const source = resource.source
          if (source && source.size !== resource.size) throw new Error('Font resource length changed')
          const bytes = source ? undefined : await this.deps.wait(resource.read())
          this.deps.check()
          if (bytes && bytes.length !== resource.size) throw new Error('Font resource length changed')
          const faces = readFontFaces(
            {
              size: resource.size,
              read: async (offset, length) => {
                this.deps.check()
                if (source && source.size !== resource.size) throw new Error('Font resource length changed')
                const part = source ? await this.deps.wait(source.read(offset, length)) : bytes!.subarray(offset, offset + length)
                this.deps.check()
                if (source && source.size !== resource.size) throw new Error('Font resource length changed')
                return part
              },
            },
            () => this.deps.check(),
          )
          for await (const face of faces) entries.push(face)
        } catch (error) {
          this.deps.check()
          this.deps.warn(
            `Font catalog ignored ${entries.length ? 'remaining faces in ' : ''}${resource.name}: ${error instanceof Error ? error.message : String(error)}`,
          )
        }
        this.metadata.set(token, entries)
      }
      for (const [faceIndex, m] of entries.entries()) {
        const descriptor: FontDescriptor = {
          name: m.family, source: 'game', fixedPitch: m.fixedPitch,
          outline: m.outline, charsets: m.charsets, vertical: false,
        }
        const descriptors = [descriptor]
        if (m.vertical) descriptors.push({ ...descriptor, name: '@' + m.family, vertical: true })
        for (const entry of descriptors) {
          game.push(entry)
          const name = entry.name.toLowerCase(), faces = bindings.get(name) ?? []
          // Keep resource/patch order for ties, and retain the physical face
          // for both horizontal and vertical views of each style.
          if (!faces.some((face) => face.bold === m.bold && face.italic === m.italic))
            faces.push({ resource, faceIndex, bold: m.bold, italic: m.italic })
          bindings.set(name, faces)
        }
      }
      await this.deps.yield()
    }
    this.deps.check()
    this.game = game
    this.deps.bind(bindings)
    this.initialized = true
  }
  entries() {
    return [...this.game, ...this.system, ...genericFonts]
  }
  charset(font: FontSpec): FontCharset | undefined {
    const name = font.face.toLowerCase()
    if (font.faceIsFileName) {
      const token = this.fileFaces.get(font.face),
        entries = token && this.metadata.get(token)
      if (entries?.[0]) return entries[0].charsets[0]
    }
    return this.entries().find((entry) => entry.name.toLowerCase() === name)?.charsets?.[0]
  }
  list(flags: number, font: FontSpec) {
    return filterFonts(this.entries(), flags, this.charset(font))
  }
  clear() {
    this.game = []
    this.system = []
    this.initialized = false
    this.deps.bindSystem?.([])
    this.metadata = new WeakMap()
    this.fileFaces.clear()
  }
}
