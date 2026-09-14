/** KRKR pre-rendered font versions 0/1; UTF-16 indices and 65-level coverage. */
export interface PrerenderedGlyph {
  code: number
  width: number
  height: number
  originX: number
  originY: number
  incX: number
  incY: number
  advance: number
  coverage: Uint8Array
}
export class PrerenderedFont {
  constructor(
    readonly glyphs: ReadonlyMap<number, PrerenderedGlyph>,
    readonly bytes: number,
  ) {}
  find(code: number): PrerenderedGlyph | undefined {
    return this.glyphs.get(code)
  }
}
const signature = Array.from('TVP pre-rendered font\x1a', (c) => c.charCodeAt(0))
const maxFile = 32 * 1024 * 1024,
  maxDecoded = 64 * 1024 * 1024
export function* readPrerenderedFont(bytes: Uint8Array): Generator<void, PrerenderedFont> {
  if (bytes.length < 36 || bytes.length > maxFile)
    throw new Error('Pre-rendered font file size is invalid or exceeds 32 MiB')
  if (signature.some((value, i) => bytes[i] !== value) || bytes[23] !== 2 || bytes[22]! > 1)
    throw new Error('Unsupported pre-rendered font header')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    version = bytes[22],
    count = view.getUint32(24, true),
    chars = view.getUint32(28, true),
    records = view.getUint32(32, true)
  const fits = (start: number, length: number) => start >= 36 && start + length <= bytes.length
  if (count > 65536 || !fits(chars, count * 2) || !fits(records, count * 20))
    throw new Error('Pre-rendered font index is outside the file')
  if (count && chars < records + count * 20 && records < chars + count * 2)
    throw new Error('Pre-rendered font index tables overlap')
  const reserved = [
      [0, 36],
      [chars, chars + count * 2],
      [records, records + count * 20],
    ],
    entries: (Omit<PrerenderedGlyph, 'coverage'> & { offset: number })[] = []
  // Reserve metadata as well as coverage, including empty glyph records.
  let total = count * 128,
    previousCode = -1
  for (let i = 0; i < count; i++) {
    const at = records + i * 20,
      code = view.getUint16(chars + i * 2, true),
      width = view.getUint16(at + 4, true),
      height = view.getUint16(at + 6, true),
      offset = view.getUint32(at, true)
    if (code <= previousCode)
      throw new Error('Pre-rendered font characters must be unique and sorted')
    previousCode = code
    total += width * height
    if (width > 2048 || height > 2048 || total > maxDecoded)
      throw new Error('Pre-rendered font decoded glyphs exceed the 64 MiB budget')
    if (
      width &&
      height &&
      (offset >= bytes.length || reserved.some(([a, b]) => offset >= a! && offset < b!))
    )
      throw new Error('Pre-rendered glyph offset overlaps metadata or is outside the file')
    entries.push({
      code,
      offset,
      width,
      height,
      originX: view.getInt16(at + 8, true),
      originY: view.getInt16(at + 10, true),
      incX: view.getInt16(at + 12, true),
      incY: view.getInt16(at + 14, true),
      advance: view.getInt16(at + 16, true),
    })
    if ((i & 255) === 0) yield
  }
  const boundaries = [
      ...new Set([
        ...entries.filter((e) => e.width && e.height).map((e) => e.offset),
        ...reserved.map((r) => r[0]!),
        bytes.length,
      ]),
    ].sort((a, b) => a - b),
    limits = new Map(
      boundaries.map((value, index) => [value, boundaries[index + 1] ?? bytes.length]),
    ),
    glyphs = new Map<number, PrerenderedGlyph>()
  for (const entry of entries) {
    const coverage = new Uint8Array(entry.width * entry.height),
      limit = limits.get(entry.offset) ?? bytes.length
    let cursor = entry.offset,
      position = 0,
      work = 0
    while (position < coverage.length) {
      if (cursor >= limit) throw new Error('Truncated pre-rendered glyph data')
      const value = bytes[cursor++]!
      if (value === 0x41 || (version === 1 && value > 0x41)) {
        if (!position) throw new Error('Pre-rendered glyph run has no preceding pixel')
        if (version === 0 && cursor >= limit) throw new Error('Truncated pre-rendered glyph run')
        const length = version === 0 ? bytes[cursor++]! : value - 0x40
        if (position + length > coverage.length)
          throw new Error('Pre-rendered glyph run exceeds its bitmap')
        coverage.fill(coverage[position - 1]!, position, position + length)
        position += length
      } else {
        if (value > 64) throw new Error('Pre-rendered glyph coverage exceeds 65 levels')
        coverage[position++] = Math.min(255, value * 4)
      }
      if ((++work & 1023) === 0) yield
    }
    const { offset: _offset, ...metrics } = entry
    glyphs.set(entry.code, { ...metrics, coverage })
    yield
  }
  return new PrerenderedFont(glyphs, total)
}
