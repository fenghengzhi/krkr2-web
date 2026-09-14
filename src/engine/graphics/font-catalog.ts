import type { FontCharset, FontDescriptor } from '../ports/fonts.ts'
import type { FontSpec } from '../ports/graphics.ts'
import type { Resource } from '../ports/storage.ts'
import type { NamedFontFace } from './fonts.ts'
import { readFontMetadata, validFontName } from '../../formats/font/metadata.ts'

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
  files(): Resource[]
  resolve(name: string): Resource
  bind(fonts: Map<string, NamedFontFace[]>): void
  check(): void
  yield(): Promise<void>
  warn(message: string): void
  wait<T>(work: Promise<T>): Promise<T>
}
export class FontCatalog {
  private system: FontDescriptor[] = []
  private game: FontDescriptor[] = []
  private metadata = new WeakMap<object, FontDescriptor[]>()
  private styles = new WeakMap<object, { bold: boolean; italic: boolean }>()
  private loading?: Promise<void>
  constructor(private readonly deps: CatalogDependencies) {}
  setSystem(entries: FontDescriptor[]) {
    this.system = validateSystemFonts(entries)
  }
  async prepare(font?: FontSpec): Promise<void> {
    if (this.loading) return this.loading
    this.loading = this.discover(font)
    try {
      await this.loading
    } finally {
      this.loading = undefined
    }
  }
  private async discover(font?: FontSpec) {
    const seen = new Set<object>()
    const files = this.deps
      .files()
      .filter((file) => /\.(ttf|otf|ttc)$/i.test(file.name))
      .sort((a, b) => Number(a.name.includes('>')) - Number(b.name.includes('>')))
      .filter((file) => {
        const token = file.cacheToken ?? file
        if (seen.has(token)) return false
        seen.add(token)
        return true
      })
    if (font?.faceIsFileName) {
      const current = this.deps.resolve(font.face)
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
        try {
          if (resource.size > 16 * 1024 * 1024) throw new Error('Font file exceeds 16 MiB')
          const bytes = await this.deps.wait(resource.read())
          this.deps.check()
          if (bytes.length !== resource.size) throw new Error('Font resource length changed')
          const m = await readFontMetadata(
            {
              size: bytes.length,
              read: async (offset, length) => bytes.subarray(offset, offset + length),
            },
            () => this.deps.check(),
          )
          this.styles.set(token, { bold: m.bold, italic: m.italic })
          entries = [
            {
              name: m.family,
              source: 'game',
              fixedPitch: m.fixedPitch,
              outline: m.outline,
              charsets: m.charsets,
              vertical: false,
            },
          ]
          if (m.vertical) entries.push({ ...entries[0]!, name: '@' + m.family, vertical: true })
        } catch (error) {
          this.deps.check()
          this.deps.warn(
            `Font catalog ignored ${resource.name}: ${error instanceof Error ? error.message : String(error)}`,
          )
          entries = []
        }
        this.metadata.set(token, entries)
      }
      for (const entry of entries) {
        game.push(entry)
        const name = entry.name.toLowerCase(),
          faces = bindings.get(name) ?? [],
          style = this.styles.get(token)!
        // One face per style. Unqualified names take precedence over archived
        // aliases, so a mounted patch remains the active source.
        if (!faces.some((face) => face.bold === style.bold && face.italic === style.italic))
          faces.push({ resource, ...style })
        bindings.set(name, faces)
      }
      await this.deps.yield()
    }
    this.deps.check()
    this.game = game
    this.deps.bind(bindings)
  }
  entries() {
    return [...this.game, ...this.system, ...genericFonts]
  }
  charset(font: FontSpec): FontCharset | undefined {
    let name = font.face.toLowerCase()
    if (font.faceIsFileName) {
      const resource = this.deps.resolve(font.face),
        entries = resource && this.metadata.get(resource.cacheToken ?? resource)
      if (entries?.[0]) name = entries[0].name.toLowerCase()
    }
    return this.entries().find((entry) => entry.name.toLowerCase() === name)?.charsets?.[0]
  }
  list(flags: number, font: FontSpec) {
    return filterFonts(this.entries(), flags, this.charset(font))
  }
  clear() {
    this.game = []
    this.system = []
    this.metadata = new WeakMap()
    this.styles = new WeakMap()
  }
}
