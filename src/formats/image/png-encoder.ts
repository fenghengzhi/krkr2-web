import type { Pixels } from '../../engine/ports/graphics.ts'
import { BinaryWriter } from '../binary/writer.ts'
import { crc32 } from '../binary/crc32.ts'
import { paeth } from './png-filter.ts'

export interface PngEncoding {
  filtered: Uint8Array
  finish(compressed: Uint8Array): Generator<void, Uint8Array>
}
function* chunk(output: BinaryWriter, type: string, bytes: Uint8Array): Generator<void, void> {
  const body = new BinaryWriter(bytes.length + 4)
  body.ascii(type)
  body.append(bytes)
  const content = body.finish()
  output.be32(bytes.length)
  output.append(content)
  output.be32(yield* crc32(content))
}
function metadataInteger(
  metadata: ReadonlyMap<string, string>,
  key: string,
  signed = false,
): number {
  const source = metadata.get(key) ?? '0',
    number = Number(source)
  if (
    !/^-?\d+$/.test(source) ||
    !Number.isInteger(number) ||
    number < (signed ? -0x80000000 : 0) ||
    number > (signed ? 0x7fffffff : 0xffffffff)
  )
    throw new Error(`Invalid PNG metadata: ${key}`)
  return number
}
function* assemble(
  image: Pixels,
  alpha: boolean,
  compressed: Uint8Array,
  metadata: ReadonlyMap<string, string>,
): Generator<void, Uint8Array> {
  const output = new BinaryWriter(),
    header = new BinaryWriter(13)
  output.append(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]))
  header.be32(image.width)
  header.be32(image.height)
  header.u8(8)
  header.u8(alpha ? 6 : 2)
  header.u8(0)
  header.u8(0)
  header.u8(0)
  yield* chunk(output, 'IHDR', header.finish())
  yield* chunk(output, 'sBIT', new Uint8Array(alpha ? [8, 8, 8, 8] : [8, 8, 8]))
  for (const [prefix, type, x, y] of [
    ['offs', 'oFFs', 'offs_x', 'offs_y'],
    ['reso', 'pHYs', 'reso_x', 'reso_y'],
    ['vpag', 'vpAg', 'vpag_w', 'vpag_h'],
  ] as const) {
    if (!metadata.has(x) && !metadata.has(y)) continue
    const value = new BinaryWriter(9),
      unit = metadata.get(prefix + '_unit') ?? 'pixel'
    value.be32(metadataInteger(metadata, x, prefix === 'offs'))
    value.be32(metadataInteger(metadata, y, prefix === 'offs'))
    value.u8(prefix === 'reso' ? (unit === 'meter' ? 1 : 0) : unit === 'micrometer' ? 1 : 0)
    yield* chunk(output, type, value.finish())
  }
  for (let at = 0; at < compressed.length; at += 65536)
    yield* chunk(output, 'IDAT', compressed.subarray(at, at + 65536))
  yield* chunk(output, 'IEND', new Uint8Array())
  return output.finish()
}
export function* encodePng(
  image: Pixels,
  alpha = true,
  metadata: ReadonlyMap<string, string> = new Map(),
): Generator<void, PngEncoding> {
  const { width, height, data } = image,
    channels = alpha ? 4 : 3,
    stride = width * channels
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > 4096 ||
    height > 4096 ||
    data.length !== width * height * 4
  )
    throw new Error('Invalid PNG source image')
  const filtered = new Uint8Array((stride + 1) * height),
    candidates = Array.from({ length: 5 }, () => new Uint8Array(stride))
  let previous = new Uint8Array(stride),
    current = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++)
      for (let c = 0; c < channels; c++) current[x * channels + c] = data[(y * width + x) * 4 + c]!
    let best = 0,
      bestScore = Infinity
    for (let kind = 0; kind < 5; kind++) {
      const row = candidates[kind]!
      let score = 0
      for (let x = 0; x < stride; x++) {
        const a = x >= channels ? current[x - channels]! : 0,
          b = previous[x]!,
          c = x >= channels ? previous[x - channels]! : 0,
          predicted =
            kind === 0
              ? 0
              : kind === 1
                ? a
                : kind === 2
                  ? b
                  : kind === 3
                    ? (a + b) >>> 1
                    : paeth(a, b, c),
          value = (current[x]! - predicted) & 255
        row[x] = value
        score += Math.min(value, 256 - value)
      }
      if (score < bestScore) {
        bestScore = score
        best = kind
      }
      yield
    }
    filtered[y * (stride + 1)] = best
    filtered.set(candidates[best]!, y * (stride + 1) + 1)
    const swap = previous
    previous = current
    current = swap
  }
  return { filtered, finish: (compressed) => assemble(image, alpha, compressed, metadata) }
}
