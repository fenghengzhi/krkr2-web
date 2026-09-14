export interface VerticalSubstitutions {
  readonly feature: 'vert' | 'vrt2'
  substitute(glyph: number): number
}
interface Subtable {
  sources: Uint16Array
  targets: Uint16Array
}
class CompiledVerticalSubstitutions implements VerticalSubstitutions {
  constructor(
    readonly feature: 'vert' | 'vrt2',
    private readonly lookups: Subtable[][],
  ) {}
  substitute(glyph: number): number {
    if (!Number.isInteger(glyph) || glyph < 0 || glyph > 65535)
      throw new Error('Invalid glyph index')
    for (const tables of this.lookups) {
      for (const { sources, targets } of tables) {
        let low = 0,
          high = sources.length - 1,
          found = false
        while (low <= high) {
          const mid = (low + high) >>> 1,
            code = sources[mid]!
          if (glyph < code) high = mid - 1
          else if (glyph > code) low = mid + 1
          else {
            glyph = targets[mid]!
            found = true
            break
          }
        }
        if (found) break
      }
    }
    return glyph
  }
}

/** GDI-style feature choice: first vrt2, otherwise first vert, independent of LangSys. */
export function readVerticalSubstitutions(
  bytes: Uint8Array,
  faceIndex = 0,
): VerticalSubstitutions | undefined {
  if (bytes.length < 12) return undefined
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const fileRange = (at: number, length: number) => {
    if (!Number.isSafeInteger(at) || at < 0 || at > bytes.length || length > bytes.length - at)
      throw new Error('Vertical font directory exceeds file bounds')
  }
  let offset = 0
  if (file.getUint32(0) === 0x74746366) {
    const count = file.getUint32(8)
    if (
      ![0x10000, 0x20000].includes(file.getUint32(4)) ||
      count < 1 ||
      count > 256 ||
      !Number.isInteger(faceIndex) ||
      faceIndex < 0 ||
      faceIndex >= count
    )
      throw new Error('Invalid vertical font collection face')
    fileRange(12, count * 4)
    offset = file.getUint32(12 + faceIndex * 4)
    if (offset < 12 + count * 4) throw new Error('Vertical font face overlaps collection header')
    fileRange(offset, 12)
  }
  if (![0x10000, 0x4f54544f, 0x74727565].includes(file.getUint32(offset))) return undefined
  const tableCount = file.getUint16(offset + 4)
  if (tableCount < 1 || tableCount > 128) throw new Error('Invalid vertical font table count')
  fileRange(offset + 12, tableCount * 16)
  let gsub: DataView | undefined
  for (let i = 0; i < tableCount; i++) {
    const record = offset + 12 + i * 16
    if (file.getUint32(record) !== 0x47535542) continue
    if (gsub) throw new Error('Duplicate GSUB table')
    const at = file.getUint32(record + 8),
      length = file.getUint32(record + 12)
    fileRange(at, length)
    if (
      length < 10 ||
      length > 2 * 1024 * 1024 ||
      (at < offset + 12 + tableCount * 16 && at + length > offset)
    )
      throw new Error('Invalid GSUB table bounds')
    gsub = new DataView(bytes.buffer, bytes.byteOffset + at, length)
  }
  if (!gsub) return undefined
  const data = gsub
  const range = (at: number, length: number) => {
    if (
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at > data.byteLength ||
      length < 0 ||
      length > data.byteLength - at
    )
      throw new Error('GSUB offset exceeds table bounds')
  }
  const u16 = (at: number) => {
      range(at, 2)
      return data.getUint16(at)
    },
    u32 = (at: number) => {
      range(at, 4)
      return data.getUint32(at)
    },
    relative = (base: number, field: number, minimum: number) => {
      const delta = u16(field)
      if (delta < minimum) throw new Error('GSUB offset overlaps header')
      const at = base + delta
      range(at, 2)
      return at
    }
  if (![0x10000, 0x10001].includes(u32(0))) throw new Error('Unsupported GSUB version')
  const featureList = relative(0, 6, 10),
    lookupList = relative(0, 8, 10),
    featureCount = u16(featureList),
    lookupCount = u16(lookupList)
  if (featureCount > 4096 || lookupCount > 4096) throw new Error('GSUB record budget exceeded')
  range(featureList + 2, featureCount * 6)
  range(lookupList + 2, lookupCount * 2)
  let feature: 'vert' | 'vrt2' | undefined,
    featureOffset = 0
  for (const [name, tag] of [
    ['vrt2', 0x76727432],
    ['vert', 0x76657274],
  ] as const) {
    for (let i = 0; i < featureCount; i++) {
      const at = featureList + 2 + i * 6
      if (u32(at) === tag) {
        feature = name
        featureOffset = relative(featureList, at + 4, 2 + featureCount * 6)
        break
      }
    }
    if (feature) break
  }
  if (!feature) return undefined
  const count = u16(featureOffset + 2)
  if (count > 128) throw new Error('Too many vertical GSUB lookups')
  range(featureOffset + 4, count * 2)
  let coverageBudget = 0,
    subtableBudget = 0
  const coverage = (at: number) => {
    const format = u16(at),
      count = u16(at + 2),
      glyphs: number[] = []
    if (format === 1) {
      range(at + 4, count * 2)
      for (let i = 0; i < count; i++) {
        const glyph = u16(at + 4 + i * 2)
        if (i && glyph <= glyphs[i - 1]!) throw new Error('Unsorted GSUB coverage')
        glyphs.push(glyph)
      }
    } else if (format === 2) {
      range(at + 4, count * 6)
      for (let i = 0; i < count; i++) {
        const start = u16(at + 4 + i * 6),
          end = u16(at + 6 + i * 6),
          index = u16(at + 8 + i * 6)
        if (end < start || index !== glyphs.length || (i && start <= glyphs[glyphs.length - 1]!))
          throw new Error('Invalid GSUB coverage range')
        for (let glyph = start; glyph <= end; glyph++) glyphs.push(glyph)
      }
    } else throw new Error('Unsupported GSUB coverage format')
    coverageBudget += glyphs.length
    if (coverageBudget > 262144) throw new Error('Vertical GSUB coverage budget exceeded')
    return Uint16Array.from(glyphs)
  }
  const single = (at: number): Subtable => {
    if (++subtableBudget > 256) throw new Error('Too many vertical GSUB subtables')
    const format = u16(at),
      sources = coverage(relative(at, at + 2, 6)),
      targets = new Uint16Array(sources.length)
    if (format === 1) {
      const delta = u16(at + 4)
      for (let i = 0; i < sources.length; i++) targets[i] = (sources[i]! + delta) & 65535
    } else if (format === 2) {
      const count = u16(at + 4)
      if (count !== sources.length)
        throw new Error('GSUB substitution count does not match coverage')
      range(at + 6, count * 2)
      for (let i = 0; i < count; i++) targets[i] = u16(at + 6 + i * 2)
    } else throw new Error('Unsupported single GSUB substitution')
    return { sources, targets }
  }
  const lookups: Subtable[][] = []
  for (let i = 0; i < count; i++) {
    const index = u16(featureOffset + 4 + i * 2)
    if (index >= lookupCount) throw new Error('GSUB lookup index exceeds list')
    const at = relative(lookupList, lookupList + 2 + index * 2, 2 + lookupCount * 2),
      type = u16(at),
      flags = u16(at + 2),
      subtables = u16(at + 4)
    if (flags & ~1) throw new Error('Vertical GSUB lookup flags are not supported')
    if (subtables > 64) throw new Error('Too many GSUB lookup subtables')
    if (type !== 1 && type !== 7)
      throw new Error('Vertical GSUB requires single or extension substitutions')
    range(at + 6, subtables * 2)
    const tables: Subtable[] = []
    for (let j = 0; j < subtables; j++) {
      let sub = relative(at, at + 6 + j * 2, 6 + subtables * 2)
      if (type === 7) {
        if (u16(sub) !== 1 || u16(sub + 2) !== 1)
          throw new Error('Unsupported vertical GSUB extension')
        const delta = u32(sub + 4)
        if (delta < 8) throw new Error('GSUB extension overlaps header')
        sub += delta
        range(sub, 6)
      }
      tables.push(single(sub))
    }
    lookups.push(tables)
  }
  // The compiled object owns only copied arrays; no closure retains the source
  // font's ArrayBuffer or the parser's DataView after the native font opens.
  return new CompiledVerticalSubstitutions(feature, lookups)
}
