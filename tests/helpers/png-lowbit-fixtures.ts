import { deflateSync } from 'node:zlib'

/** Independent PNG framing/CRC and filter-zero source rows. No product codec
 * or pixel transform authors the input or the literal expected sample maps. */
export function lowbitChunk(type: string, payload: Uint8Array, badCrc = false): Buffer {
  const bytes = Buffer.alloc(payload.length + 12)
  bytes.writeUInt32BE(payload.length); bytes.write(type, 4); bytes.set(payload, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, bytes.length - 4)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE(((crc ^ 0xffffffff) ^ Number(badCrc)) >>> 0, bytes.length - 4)
  return bytes
}

export function grayTransparency(value: number, badCrc = false): Buffer {
  const data = Buffer.alloc(2); data.writeUInt16BE(value)
  return lowbitChunk('tRNS', data, badCrc)
}

export function lowbitPng(options: {
  samples: readonly (readonly number[])[]
  width: number
  depth?: 1 | 2 | 4 | 8 | 16
  color?: 0 | 2 | 3 | 4 | 6
  interlace?: boolean
  palette?: readonly number[]
  beforePalette?: readonly Uint8Array[]
  before?: readonly Uint8Array[]
  after?: readonly Uint8Array[]
  badIdat?: boolean
  badEnd?: boolean
}): Buffer {
  const { width, samples, depth = 8, color = 0, interlace = false } = options,
    height = samples.length, channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as const)[color],
    header = Buffer.alloc(13), expanded: Buffer[] = [],
    passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
      [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  if (samples.some((row) => row.length !== width * channels)) throw new Error('Invalid authored low-bit sample row')
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4)
  header[8] = depth; header[9] = color; header[12] = Number(interlace)
  for (const [startX, startY, stepX, stepY] of passes) {
    if (startX! >= width || startY! >= height) continue
    for (let y = startY!; y < height; y += stepY!) {
      const values: number[] = []
      for (let x = startX!; x < width; x += stepX!)
        for (let channel = 0; channel < channels; channel++) values.push(samples[y]![x * channels + channel]!)
      const row = Buffer.alloc(1 + Math.ceil(values.length * depth / 8))
      for (let i = 0; i < values.length; i++) {
        if (depth === 16) row.writeUInt16BE(values[i]!, 1 + i * 2)
        else if (depth === 8) row[1 + i] = values[i]!
        else row[1 + Math.floor(i * depth / 8)]! |= values[i]! << (8 - depth - i * depth % 8)
      }
      expanded.push(row)
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), lowbitChunk('IHDR', header),
    ...(options.beforePalette ?? []),
    ...(options.palette ? [lowbitChunk('PLTE', Uint8Array.from(options.palette))] : []),
    ...(options.before ?? []), lowbitChunk('IDAT', deflateSync(Buffer.concat(expanded)), options.badIdat),
    ...(options.after ?? []), lowbitChunk('IEND', Buffer.alloc(0), options.badEnd)])
}

export const lowbitSamples = {
  1: [[0, 1, 0, 1, 1, 0, 1], [1, 0, 1, 0, 0, 1, 0], [0, 0, 1, 1, 0, 1, 1]],
  2: [[0, 1, 2, 3, 2, 1, 0], [3, 2, 1, 0, 1, 2, 3], [1, 0, 3, 2, 0, 2, 1]],
  4: [[0, 1, 7, 8, 15, 2, 14], [15, 14, 8, 7, 1, 0, 2], [2, 0, 15, 8, 1, 7, 14]],
} as const
export const lowbitValues = {
  1: [0, 255], 2: [0, 85, 170, 255],
  4: [0, 17, 34, 51, 68, 85, 102, 119, 136, 153, 170, 187, 204, 221, 238, 255],
} as const
