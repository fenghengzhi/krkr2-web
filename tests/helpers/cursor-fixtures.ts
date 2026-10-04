import { deflateSync } from 'node:zlib'

/** Deliberately accepts on-disk rows, not decoded pixels. Tests specify the
 * bit/nibble/byte order and the expected pixels independently. */
export function cursorDib(options: {
  width: number
  height: number
  depth: 1 | 4 | 8 | 16 | 24 | 32
  xorRows: readonly (readonly number[])[]
  andRows?: readonly (readonly number[])[] | null
  palette?: readonly (readonly [number, number, number])[]
  topDown?: boolean
  masks?: readonly number[]
  core?: boolean
}): Buffer {
  const { width, height, depth, xorRows, palette = [], masks = [], core = false } = options,
    header = Buffer.alloc(core ? 12 : 40),
    stride = Math.ceil(width * depth / 32) * 4,
    maskStride = Math.ceil(width / 32) * 4
  header.writeUInt32LE(header.length)
  if (core) {
    header.writeUInt16LE(width, 4)
    header.writeUInt16LE(height * 2, 6)
    header.writeUInt16LE(1, 8)
    header.writeUInt16LE(depth, 10)
  } else {
    header.writeInt32LE(width, 4)
    header.writeInt32LE(height * 2 * (options.topDown ? -1 : 1), 8)
    header.writeUInt16LE(1, 12)
    header.writeUInt16LE(depth, 14)
    header.writeUInt32LE(masks.length === 4 ? 6 : masks.length ? 3 : 0, 16)
    header.writeUInt32LE(palette.length, 32)
  }
  function rows(values: readonly (readonly number[])[], rowBytes: number) {
    if (values.length !== height) throw new Error('Fixture row count differs from height')
    const bytes = Buffer.alloc(rowBytes * height)
    values.forEach((row, y) => {
      if (row.length > rowBytes) throw new Error('Fixture row exceeds stride')
      bytes.set(row, y * rowBytes)
    })
    return bytes
  }
  return Buffer.concat([
    header,
    words(masks),
    Buffer.from(palette.flatMap(([r, g, b]) => core ? [b, g, r] : [b, g, r, 0])),
    rows(xorRows, stride),
    options.andRows === null
      ? Buffer.alloc(0)
      : rows(options.andRows ?? Array.from({ length: height }, () => []), maskStride),
  ])
}

export interface CursorFixtureImage {
  width: number
  height: number
  payload: Uint8Array
  hotspot?: readonly [number, number]
}

export function cursorFile(images: readonly CursorFixtureImage[], type: 1 | 2 = 2): Buffer {
  const directory = Buffer.alloc(6 + images.length * 16)
  directory.writeUInt16LE(type, 2)
  directory.writeUInt16LE(images.length, 4)
  let offset = directory.length
  images.forEach((image, index) => {
    const at = 6 + index * 16
    directory[at] = image.width === 256 ? 0 : image.width
    directory[at + 1] = image.height === 256 ? 0 : image.height
    directory.writeUInt16LE(type === 1 ? 1 : image.hotspot?.[0] ?? 0, at + 4)
    directory.writeUInt16LE(type === 1 ? 32 : image.hotspot?.[1] ?? 0, at + 6)
    directory.writeUInt32LE(image.payload.length, at + 8)
    directory.writeUInt32LE(offset, at + 12)
    offset += image.payload.length
  })
  return Buffer.concat([directory, ...images.map((image) => image.payload)])
}

export function words(values: readonly number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => result.writeUInt32LE(value >>> 0, index * 4))
  return result
}

export function riffChunk(name: string, payload: Uint8Array): Buffer {
  if (name.length !== 4) throw new Error('Fixture RIFF tags contain four bytes')
  return Buffer.concat([
    Buffer.from(name, 'ascii'), words([payload.length]), payload,
    Buffer.alloc(payload.length & 1),
  ])
}

export function animatedCursor(frames: readonly Uint8Array[], options: {
  sequence?: readonly number[]
  rates?: readonly number[]
  defaultRate?: number
  steps?: number
  frameCount?: number
  flags?: number
  extraChunks?: readonly Uint8Array[]
} = {}): Buffer {
  const header = words([
      36, options.frameCount ?? frames.length,
      options.steps ?? options.sequence?.length ?? frames.length,
      0, 0, 0, 0, options.defaultRate ?? 6, options.flags ?? (options.sequence ? 3 : 1),
    ]),
    payload = Buffer.concat([
      Buffer.from('ACON'),
      riffChunk('anih', header),
      ...(options.sequence ? [riffChunk('seq ', words(options.sequence))] : []),
      ...(options.rates ? [riffChunk('rate', words(options.rates))] : []),
      ...(options.extraChunks ?? []),
      riffChunk('LIST', Buffer.concat([
        Buffer.from('fram'), ...frames.map((frame) => riffChunk('icon', frame)),
      ])),
    ])
  return Buffer.concat([Buffer.from('RIFF'), words([payload.length]), payload])
}

/** A minimal independent PNG encoder: RGBA8, filter None, zlib, real CRCs. */
export function cursorPng(width: number, height: number, rgba: readonly number[]): Buffer {
  if (rgba.length !== width * height * 4) throw new Error('Fixture PNG pixel count differs')
  const header = Buffer.alloc(13), rows = Buffer.alloc(height * (width * 4 + 1))
  header.writeUInt32BE(width)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6
  for (let y = 0; y < height; y++)
    rows.set(rgba.slice(y * width * 4, (y + 1) * width * 4), y * (width * 4 + 1) + 1)
  function chunk(name: string, data: Uint8Array) {
    const result = Buffer.alloc(data.length + 12)
    result.writeUInt32BE(data.length)
    result.write(name, 4, 'ascii')
    result.set(data, 8)
    let crc = 0xffffffff
    for (const value of result.subarray(4, result.length - 4)) {
      crc ^= value
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
    return result
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0)),
  ])
}
