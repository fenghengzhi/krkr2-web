import { deflateSync } from 'node:zlib'
import { partialBmp } from './image-partial-fixtures.ts'

export const paletteIndices = [[0, 1, 2, 3], [3, 2, 1, 0], [1, 3, 0, 2]] as const
const colors = [[10, 40, 90], [200, 20, 60], [30, 180, 70], [240, 120, 15]] as const
const alpha = [0, 64, 173, 255] as const
export const paletteRgba = [
  10, 40, 90, 0, 200, 20, 60, 64, 30, 180, 70, 173, 240, 120, 15, 255,
  240, 120, 15, 255, 30, 180, 70, 173, 200, 20, 60, 64, 10, 40, 90, 0,
  200, 20, 60, 64, 240, 120, 15, 255, 10, 40, 90, 0, 30, 180, 70, 173,
] as const
// The actual 3W BGR prefix, reinterpreted as BGRA destination pixels. Only
// the Web's explicitly zeroed tail is asserted; native tail bytes are unknown.
export const packedKeyRgba = [
  10, 40, 90, 60, 70, 200, 20, 180, 120, 15, 30, 240, 0, 0, 0, 0,
  240, 120, 15, 70, 60, 30, 180, 20, 40, 90, 200, 10, 0, 0, 0, 0,
  200, 20, 60, 15, 90, 240, 120, 40, 180, 70, 10, 30, 0, 0, 0, 0,
] as const
// Scalar triples from the independent BGR(A) rows; not computed by the codec.
export const paletteGray = [37, 47, 75, 71, 137, 106, 138, 157, 60, 40, 219, 10] as const
export const opaqueGray = [37, 60, 140, 137, 137, 140, 60, 37, 60, 137, 37, 140] as const

function chunk(name: string, data: Uint8Array, bad = false): Buffer {
  const result = Buffer.alloc(data.length + 12)
  result.writeUInt32BE(data.length); result.write(name, 4); result.set(data, 8)
  let crc = 0xffffffff
  for (const byte of result.subarray(4, result.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  result.writeUInt32BE(((crc ^ 0xffffffff) ^ Number(bad)) >>> 0, result.length - 4)
  return result
}

/** Independent filter-0 palette PNG, with an optional last-row/finish failure.
 * No product encoder, filter, CRC or image transform builds these fixtures. */
export function palettePng(options: {
  alpha?: boolean; interlace?: boolean; depth?: 2 | 4 | 8; badEnd?: boolean; badRowEnd?: boolean
} = {}): Buffer {
  const { alpha: transparent = true, interlace = false, depth = 8, badEnd = false, badRowEnd = false } = options,
    width = 4, height = 3, header = Buffer.alloc(13), rows: Buffer[] = [],
    passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4)
  header[8] = depth; header[9] = 3; header[12] = Number(interlace)
  for (const [startX, startY, stepX, stepY] of passes) {
    if (startX! >= width || startY! >= height) continue
    for (let y = startY!; y < height; y += stepY!) {
      const values: number[] = []
      for (let x = startX!; x < width; x += stepX!) values.push(paletteIndices[y]![x]!)
      const row = Buffer.alloc(1 + Math.ceil(values.length * depth / 8))
      for (let x = 0; x < values.length; x++) row[1 + Math.floor(x * depth / 8)]! |= values[x]! << (8 - depth - x * depth % 8)
      rows.push(row)
    }
  }
  const compressed = deflateSync(Buffer.concat(rows)),
    data = badRowEnd ? [chunk('IDAT', compressed.subarray(0, -4), true), chunk('IDAT', compressed.subarray(-4))]
      : [chunk('IDAT', compressed)]
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    chunk('PLTE', Buffer.from(colors.flat())), ...(transparent ? [chunk('tRNS', Buffer.from(alpha))] : []),
    ...data, chunk('IEND', Buffer.alloc(0), badEnd)])
}

export function paletteFiles(): Record<string, Buffer> {
  return {
    'alpha.png': palettePng(), 'alpha-adam7.png': palettePng({ interlace: true }),
    'opaque.png': palettePng({ alpha: false }), 'opaque-adam7.png': palettePng({ alpha: false, interlace: true }),
    'alpha-bad-row.png': palettePng({ badRowEnd: true }),
    'opaque-bad-row.png': palettePng({ alpha: false, badRowEnd: true }),
    'alpha-tail.png': palettePng({ badEnd: true }), 'alpha-adam7-tail.png': palettePng({ interlace: true, badEnd: true }),
    'masked.bmp': partialBmp({ width: 4, height: 3 }), 'masked_m.png': palettePng(),
    'masked-bad.bmp': partialBmp({ width: 4, height: 3 }), 'masked-bad_m.png': palettePng({ badRowEnd: true }),
  }
}
