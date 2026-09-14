import type { DecodedImage } from '../../engine/ports/graphics.ts'
import { crc32 } from '../binary/crc32.ts'
import { paeth } from './png-filter.ts'

const magic = [137, 80, 78, 71, 13, 10, 26, 10]
const adam7 = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
]
export interface PngPlan {
  compressed: Uint8Array
  expandedLength: number
  decode(expanded: Uint8Array): Generator<void, DecodedImage>
}
interface Header {
  width: number
  height: number
  depth: number
  type: number
  channels: number
  interlace: number
}
function passes(h: Header) {
  return (h.interlace ? adam7 : [[0, 0, 1, 1]])
    .map(([x, y, dx, dy]) => ({
      x: x!,
      y: y!,
      dx: dx!,
      dy: dy!,
      width: Math.max(0, Math.ceil((h.width - x!) / dx!)),
      height: Math.max(0, Math.ceil((h.height - y!) / dy!)),
    }))
    .filter((p) => p.width && p.height)
}
function* pixels(
  h: Header,
  bytes: Uint8Array,
  palette: Uint8Array | undefined,
  transparent: Uint8Array | undefined,
  metadata: Map<string, string>,
): Generator<void, DecodedImage> {
  const { width, height, depth, type, channels } = h,
    image: DecodedImage = { width, height, data: new Uint8Array(width * height * 4) },
    bpp = Math.max(1, Math.ceil((channels * depth) / 8)),
    readSample = (row: Uint8Array, index: number): number =>
      depth < 8
        ? (row[(index * depth) >>> 3]! >>> (8 - depth - ((index * depth) & 7))) & ((1 << depth) - 1)
        : depth === 8
          ? row[index]!
          : row[index * 2]! * 256 + row[index * 2 + 1]!,
    scale = (n: number) =>
      depth === 16 ? n >>> 8 : depth === 8 ? n : (n * 255) / ((1 << depth) - 1),
    tr = transparent
      ? new DataView(transparent.buffer, transparent.byteOffset, transparent.byteLength)
      : undefined
  if (type === 3) image.indices = new Uint8Array(width * height)
  if (type === 0 && depth <= 8) image.grayscale = true
  if (metadata.size) image.metadata = metadata
  let at = 0
  for (const pass of passes(h)) {
    const stride = Math.ceil((pass.width * channels * depth) / 8)
    let previous = new Uint8Array(stride),
      row = new Uint8Array(stride)
    for (let y = 0; y < pass.height; y++) {
      const filter = bytes[at++]!
      if (filter > 4) throw new Error('Unsupported PNG scanline filter')
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp]! : 0,
          b = previous[x]!,
          c = x >= bpp ? previous[x - bpp]! : 0
        row[x] =
          bytes[at++]! +
          (filter === 1
            ? a
            : filter === 2
              ? b
              : filter === 3
                ? (a + b) >>> 1
                : filter === 4
                  ? paeth(a, b, c)
                  : 0)
      }
      for (let x = 0; x < pass.width; x++) {
        const pixel = (pass.y + y * pass.dy) * width + pass.x + x * pass.dx,
          to = pixel * 4,
          source = x * channels
        if (type === 3) {
          const index = readSample(row, x)
          if (!palette || index * 3 + 2 >= palette.length)
            throw new Error('PNG palette index out of range')
          image.indices![pixel] = index
          image.data[to] = palette[index * 3]!
          image.data[to + 1] = palette[index * 3 + 1]!
          image.data[to + 2] = palette[index * 3 + 2]!
          image.data[to + 3] = transparent?.[index] ?? 255
        } else if (type === 0 || type === 4) {
          const g = readSample(row, source)
          image.data[to] = image.data[to + 1] = image.data[to + 2] = scale(g)
          image.data[to + 3] =
            type === 4 ? scale(readSample(row, source + 1)) : tr && g === tr.getUint16(0) ? 0 : 255
        } else {
          const r = readSample(row, source),
            g = readSample(row, source + 1),
            b = readSample(row, source + 2)
          image.data[to] = scale(r)
          image.data[to + 1] = scale(g)
          image.data[to + 2] = scale(b)
          image.data[to + 3] =
            type === 6
              ? scale(readSample(row, source + 3))
              : tr && r === tr.getUint16(0) && g === tr.getUint16(2) && b === tr.getUint16(4)
                ? 0
                : 255
        }
      }
      const swap = previous
      previous = row
      row = swap
      yield
    }
  }
  if (at !== bytes.length) throw new Error('PNG expanded size mismatch')
  return image
}

function* parse(bytes: Uint8Array): Generator<void, PngPlan> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    metadata = new Map<string, string>()
  let at = 8,
    header: Header | undefined,
    palette: Uint8Array | undefined,
    transparent: Uint8Array | undefined,
    total = 0,
    dataStart = 0,
    dataStop = 0,
    ended = false,
    dataStarted = false,
    dataEnded = false
  while (at < bytes.length) {
    if (bytes.length - at < 12) throw new Error('Truncated PNG chunk')
    const length = view.getUint32(at),
      start = at + 4,
      end = start + 4 + length
    if (length > bytes.length - at - 12) throw new Error('Truncated PNG chunk data')
    const type = String.fromCharCode(...bytes.subarray(start, start + 4)),
      chunk = bytes.subarray(start + 4, end)
    if ((yield* crc32(bytes.subarray(start, end))) !== view.getUint32(end))
      throw new Error('PNG chunk CRC mismatch')
    at = end + 4
    if (!header && type !== 'IHDR') throw new Error('PNG must start with IHDR')
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('Invalid PNG header')
      const info = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        width = info.getUint32(0),
        height = info.getUint32(4),
        depth = chunk[8]!,
        color = chunk[9]!,
        channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]
      if (!width || !height || width > 4096 || height > 4096)
        throw new Error('PNG dimensions must be between 1 and 4096')
      if (
        !channels ||
        !(color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16]).includes(depth) ||
        chunk[10] ||
        chunk[11] ||
        chunk[12]! > 1
      )
        throw new Error('Unsupported PNG image type')
      header = { width, height, depth, type: color, channels, interlace: chunk[12]! }
    } else if (type === 'PLTE') {
      if (
        palette ||
        dataStarted ||
        !length ||
        length % 3 ||
        length > 768 ||
        (header!.type === 3 && length / 3 > 1 << header!.depth)
      )
        throw new Error('Invalid PNG palette')
      palette = chunk
    } else if (type === 'tRNS') {
      const color = header!.type
      if (
        transparent ||
        dataStarted ||
        (color === 3
          ? !palette || length > palette.length / 3
          : color === 0
            ? length !== 2
            : color === 2
              ? length !== 6
              : true)
      )
        throw new Error('Invalid PNG transparency')
      transparent = chunk
    } else if (type === 'IDAT') {
      if (dataEnded || (header!.type === 3 && !palette))
        throw new Error('Invalid PNG image data order')
      if (!dataStarted) dataStart = start - 4
      dataStarted = true
      dataStop = at
      total += length
    } else {
      if (dataStarted) dataEnded = true
      if (type === 'IEND') {
        if (length || !dataStarted) throw new Error('Invalid PNG end chunk')
        ended = true
        break
      }
      if (type === 'oFFs' || type === 'pHYs' || type.toLowerCase() === 'vpag') {
        if (length !== 9) throw new Error('Invalid PNG position metadata')
        const values = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          prefix = type === 'oFFs' ? 'offs' : type === 'pHYs' ? 'reso' : 'vpag',
          unit = chunk[8]!
        metadata.set(
          prefix + (prefix === 'vpag' ? '_w' : '_x'),
          String(type === 'oFFs' ? values.getInt32(0) : values.getUint32(0)),
        )
        metadata.set(
          prefix + (prefix === 'vpag' ? '_h' : '_y'),
          String(type === 'oFFs' ? values.getInt32(4) : values.getUint32(4)),
        )
        metadata.set(
          prefix + '_unit',
          type === 'pHYs'
            ? unit === 1
              ? 'meter'
              : 'unknown'
            : unit === 0
              ? 'pixel'
              : unit === 1
                ? 'micrometer'
                : 'unknown',
        )
      } else if (!(bytes[start]! & 32)) throw new Error(`Unsupported PNG critical chunk: ${type}`)
    }
    yield
  }
  if (!header || !ended || at !== bytes.length || !total)
    throw new Error('Truncated or extra PNG data')
  const h = header,
    expandedLength = passes(h).reduce(
      (sum, p) => sum + (1 + Math.ceil((p.width * h.channels * h.depth) / 8)) * p.height,
      0,
    ),
    compressed = new Uint8Array(total)
  let offset = 0
  // IDATs are consecutive. Revisit their bounds without retaining chunk objects.
  for (let position = dataStart; position < dataStop;) {
    const length = view.getUint32(position)
    compressed.set(bytes.subarray(position + 8, position + 8 + length), offset)
    offset += length
    position += length + 12
    yield
  }
  return {
    compressed,
    expandedLength,
    decode: (expanded) => {
      if (expanded.length !== expandedLength) throw new Error('PNG expanded size mismatch')
      return pixels(h, expanded, palette, transparent, metadata)
    },
  }
}
/** PNG filtering/Adam7 remain portable; the host supplies bounded zlib inflation. */
export function decodePng(bytes: Uint8Array): Generator<void, PngPlan> | undefined {
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return undefined
  if (magic.some((byte, index) => bytes[index] !== byte)) throw new Error('Invalid PNG signature')
  return parse(bytes)
}
