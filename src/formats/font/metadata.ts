import type { ByteSource } from '../../engine/ports/storage.ts'
import type { FontCharset } from '../../engine/ports/fonts.ts'

export interface FontMetadata {
  family: string
  fixedPitch?: boolean
  outline: boolean
  charsets: FontCharset[]
  vertical: boolean
  bold: boolean
  italic: boolean
}
const codePages: [number, number][] = [
  [0, 0],
  [1, 238],
  [2, 204],
  [3, 161],
  [4, 162],
  [5, 177],
  [6, 178],
  [7, 186],
  [8, 163],
  [16, 222],
  [17, 128],
  [18, 134],
  [19, 129],
  [20, 136],
  [21, 130],
  [29, 77],
  [30, 255],
  [31, 2],
]
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const text = (bytes: Uint8Array) => String.fromCharCode(...bytes)
// Mac OS Roman byte mappings (Unicode Consortium's VENDORS/APPLE/ROMAN.TXT).
const macRoman =
  '\xc4\xc5\xc7\xc9\xd1\xd6\xdc\xe1\xe0\xe2\xe4\xe3\xe5\xe7\xe9\xe8\xea\xeb\xed\xec\xee\xef\xf1\xf3\xf2\xf4\xf6\xf5\xfa\xf9\xfb\xfc\u2020\xb0\xa2\xa3\xa7\u2022\xb6\xdf\xae\xa9\u2122\xb4\xa8\u2260\xc6\xd8\u221e\xb1\u2264\u2265\xa5\xb5\u2202\u2211\u220f\u03c0\u222b\xaa\xba\u03a9\xe6\xf8\xbf\xa1\xac\u221a\u0192\u2248\u2206\xab\xbb\u2026\xa0\xc0\xc3\xd5\u0152\u0153\u2013\u2014\u201c\u201d\u2018\u2019\xf7\u25ca\xff\u0178\u2044\u20ac\u2039\u203a\ufb01\ufb02\u2021\xb7\u201a\u201e\u2030\xc2\xca\xc1\xcb\xc8\xcd\xce\xcf\xcc\xd3\xd4\uf8ff\xd2\xda\xdb\xd9\u0131\u02c6\u02dc\xaf\u02d8\u02d9\u02da\xb8\u02dd\u02db\u02c7'
function decodeName(bytes: Uint8Array, unicode: boolean): string {
  let result = ''
  for (let i = 0; i < bytes.length; i += unicode ? 2 : 1) {
    const first = bytes[i]!
    result += unicode
      ? String.fromCharCode(first * 256 + bytes[i + 1]!)
      : first < 128
        ? String.fromCharCode(first)
        : macRoman[first - 128]!
  }
  return result
}
export function validFontName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= 256 &&
    name.trim() === name &&
    !/[\x00-\x1f\x7f]/.test(name) &&
    ![...name].some(
      (char) => char.length === 1 && char.charCodeAt(0) >= 0xd800 && char.charCodeAt(0) <= 0xdfff,
    )
  )
}

/** Reads only metadata tables; glyph data and outlines remain in the font backend. */
export async function readFontMetadata(
  source: ByteSource,
  check: () => void = () => {},
): Promise<FontMetadata> {
  let readBytes = 0
  const read = async (offset: number, length: number) => {
    check()
    if (
      !Number.isSafeInteger(source.size) ||
      source.size < 12 ||
      source.size > 64 * 1024 * 1024 ||
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset > source.size ||
      length > source.size - offset ||
      (readBytes += length) > 1024 * 1024
    )
      throw new Error('Font metadata exceeds bounds or budget')
    const bytes = await source.read(offset, length)
    check()
    if (bytes.length !== length) throw new Error('Truncated font metadata')
    return bytes
  }
  let offset = 0,
    header = await read(0, 12)
  if (text(header.subarray(0, 4)) === 'ttcf') {
    const h = view(header),
      version = h.getUint32(4),
      count = h.getUint32(8)
    if (
      ![0x10000, 0x20000].includes(version) ||
      count < 1 ||
      count > 256 ||
      12 + count * 4 > source.size
    )
      throw new Error('Invalid font collection header')
    offset = view(await read(12, 4)).getUint32(0)
    if (offset < 12 + count * 4) throw new Error('Font collection face overlaps header')
    header = await read(offset, 12)
  }
  const h = view(header),
    signature = h.getUint32(0),
    count = h.getUint16(4)
  if (![0x10000, 0x4f54544f, 0x74727565].includes(signature) || count < 1 || count > 128)
    throw new Error('Unsupported font metadata container')
  const directory = await read(offset + 12, count * 16),
    d = view(directory),
    tables = new Map<string, { offset: number; length: number }>()
  for (let i = 0; i < count; i++) {
    const name = text(directory.subarray(i * 16, i * 16 + 4)),
      at = d.getUint32(i * 16 + 8),
      length = d.getUint32(i * 16 + 12)
    if (
      tables.has(name) ||
      at > source.size ||
      length > source.size - at ||
      (length && at < offset + 12 + count * 16 && at + length > offset)
    )
      throw new Error('Invalid font table directory')
    tables.set(name, { offset: at, length })
  }
  const table = async (name: string, minimum = 0, maximum = 1024 * 1024) => {
    const item = tables.get(name)
    if (!item) return undefined
    if (item.length < minimum || item.length > maximum)
      throw new Error('Invalid ' + name + ' table length')
    return read(item.offset, item.length)
  }
  const names = await table('name', 6, 256 * 1024)
  if (!names) throw new Error('Font has no naming table')
  const n = view(names),
    version = n.getUint16(0),
    entries = n.getUint16(2),
    storage = n.getUint16(4)
  if (
    version > 1 ||
    entries > 4096 ||
    6 + entries * 12 > names.length ||
    storage < 6 + entries * 12 ||
    storage > names.length
  )
    throw new Error('Invalid font name records')
  if (version === 1) {
    const at = 6 + entries * 12
    if (at + 2 > names.length || at + 2 + n.getUint16(at) * 4 > storage)
      throw new Error('Invalid font language records')
  }
  const families: { value: string; score: number }[] = []
  for (let i = 0; i < entries; i++) {
    const at = 6 + i * 12,
      platform = n.getUint16(at),
      encoding = n.getUint16(at + 2),
      language = n.getUint16(at + 4),
      id = n.getUint16(at + 6),
      length = n.getUint16(at + 8),
      start = storage + n.getUint16(at + 10)
    if (start > names.length || length > names.length - start)
      throw new Error('Font name exceeds string storage')
    if (id !== 1 || !length || length > 512) continue
    const unicode = platform === 0 || (platform === 3 && [0, 1, 10].includes(encoding))
    if (!unicode && !(platform === 1 && encoding === 0)) continue
    if (unicode && length % 2) throw new Error('Odd UTF-16 font name length')
    const value = decodeName(names.subarray(start, start + length), unicode).trim()
    if (validFontName(value))
      families.push({
        value,
        score: (unicode ? 20 : 0) + (language === 0x409 ? 10 : 0) + (platform === 3 ? 2 : 0),
      })
  }
  const family = families.sort((a, b) => b.score - a.score)[0]?.value
  if (!family) throw new Error('Font has no supported family name')
  const prefix = async (name: string, minimum: number, length: number) => {
    const item = tables.get(name)
    if (!item) return undefined
    if (item.length < minimum) throw new Error('Truncated ' + name + ' table')
    return read(item.offset, Math.min(length, item.length))
  }
  const post = await prefix('post', 32, 32),
    os2 = await prefix('OS/2', 68, 86),
    head = await prefix('head', 54, 54),
    cmapHeader = await prefix('cmap', 4, 4)
  let cmap: Uint8Array | undefined
  if (cmapHeader) {
    const count = view(cmapHeader).getUint16(2)
    if (count > 256) throw new Error('Too many cmap records')
    cmap = await prefix('cmap', 4 + count * 8, 4 + count * 8)
  }
  const charsets = new Set<FontCharset>()
  if (os2 && view(os2).getUint16(0) >= 1) {
    if (os2.length < 86) throw new Error('Truncated OS/2 code-page ranges')
    const ranges = view(os2).getUint32(78)
    for (const [bit, charset] of codePages) if (ranges & (1 << bit)) charsets.add(charset)
  }
  let unicode = false
  if (cmap) {
    const c = view(cmap),
      count = c.getUint16(2)
    if (c.getUint16(0) !== 0 || count > 256 || 4 + count * 8 > cmap.length)
      throw new Error('Invalid cmap records')
    for (let i = 0; i < count; i++) {
      const at = 4 + i * 8,
        platform = c.getUint16(at),
        encoding = c.getUint16(at + 2),
        subtable = c.getUint32(at + 4)
      if (subtable < 4 + count * 8 || subtable + 2 > tables.get('cmap')!.length)
        throw new Error('Invalid cmap subtable offset')
      if (platform === 0 || (platform === 3 && [1, 10].includes(encoding))) unicode = true
      if (platform === 3) {
        const charset = new Map([
          [0, 2],
          [2, 128],
          [3, 134],
          [4, 136],
          [5, 129],
          [6, 130],
        ]).get(encoding)
        if (charset !== undefined) charsets.add(charset)
      }
    }
  }
  if (unicode && !(charsets.size === 1 && charsets.has(2))) charsets.add('unicode')
  return {
    family,
    fixedPitch: post ? view(post).getUint32(12) !== 0 : undefined,
    outline: ['glyf', 'CFF ', 'CFF2'].some((name) => (tables.get(name)?.length ?? 0) > 0),
    charsets: [...charsets],
    vertical: (tables.get('vhea')?.length ?? 0) >= 36 && (tables.get('vmtx')?.length ?? 0) >= 4,
    bold: !!((os2 && view(os2).getUint16(62) & 32) || (head && view(head).getUint16(44) & 1)),
    italic: !!((os2 && view(os2).getUint16(62) & 1) || (head && view(head).getUint16(44) & 2)),
  }
}
