import { BinaryReader } from '../binary/reader.ts'
import type { DecodedImage } from '../../engine/ports/graphics.ts'

function* subblocks(input: BinaryReader, keep = true): Generator<void, Uint8Array> {
  const start = input.position
  let size = 0,
    blocks = 0
  while (true) {
    const length = input.u8()
    if (!length) break
    input.slice(length)
    size += length
    if (++blocks % 512 === 0) yield
  }
  if (!keep) return new Uint8Array()
  const bytes = new Uint8Array(size)
  let at = 0,
    source = start
  // Revisit validated lengths instead of retaining one object per sub-block.
  while (source < input.position - 1) {
    const length = input.bytes[source++]!
    bytes.set(input.bytes.subarray(source, source + length), at)
    source += length
    at += length
    if (++blocks % 512 === 0) yield
  }
  return bytes
}
function* lzw(bytes: Uint8Array, minimum: number, size: number): Generator<void, Uint8Array> {
  if (minimum < 2 || minimum > 8) throw new Error('Invalid GIF LZW minimum code size')
  const output = new Uint8Array(size),
    prefix = new Uint16Array(4096),
    suffix = new Uint8Array(4096),
    stack = new Uint8Array(4096),
    clear = 1 << minimum,
    end = clear + 1
  for (let i = 0; i < clear; i++) suffix[i] = i
  let bit = 0,
    width = minimum + 1,
    next = end + 1,
    previous = -1,
    first = 0,
    at = 0,
    work = 0,
    cleared = false
  while (true) {
    if (bit + width > bytes.length * 8) throw new Error('Truncated GIF LZW data')
    let code = 0
    for (let i = 0; i < width; i++, bit++) code |= ((bytes[bit >>> 3]! >>> (bit & 7)) & 1) << i
    if (++work >= 1024) {
      work = 0
      yield
    }
    if (code === clear) {
      width = minimum + 1
      next = end + 1
      previous = -1
      cleared = true
      continue
    }
    if (!cleared) throw new Error('GIF LZW must start with a clear code')
    if (code === end) {
      if (at !== size) throw new Error('GIF LZW output size mismatch')
      return output
    }
    const original = code
    let count = 0
    if (code === next && previous >= 0) {
      stack[count++] = first
      code = previous
    } else if (code >= next) throw new Error('Invalid GIF LZW dictionary code')
    while (code >= clear) {
      if (count >= 4095) throw new Error('Cyclic GIF LZW dictionary')
      stack[count++] = suffix[code]!
      code = prefix[code]!
    }
    first = code
    stack[count++] = first
    if (count > size - at) throw new Error('GIF LZW output exceeds image')
    work += count
    while (count) output[at++] = stack[--count]!
    if (previous >= 0 && next < 4096) {
      prefix[next] = previous
      suffix[next] = first
      next++
      if (next === 1 << width && width < 12) width++
    }
    previous = original
  }
}
function* read(bytes: Uint8Array): Generator<void, DecodedImage> {
  const input = new BinaryReader(bytes),
    signature = String.fromCharCode(...input.slice(6))
  if (signature !== 'GIF87a' && signature !== 'GIF89a') throw new Error('Unsupported GIF signature')
  const width = input.u16(),
    height = input.u16(),
    flags = input.u8(),
    background = input.u8()
  input.u8()
  if (!width || !height || width > 4096 || height > 4096) throw new Error('Invalid GIF dimensions')
  const global = flags & 128 ? input.slice(3 * (1 << ((flags & 7) + 1))) : undefined
  let transparent = -1,
    image: DecodedImage | undefined
  while (input.remaining) {
    const marker = input.u8()
    if (marker === 0x3b) {
      if (!image) throw new Error('GIF contains no image')
      return image
    }
    if (marker === 0x21) {
      const label = input.u8()
      if (label === 0xf9) {
        if (input.u8() !== 4) throw new Error('Invalid GIF graphics control')
        const flags = input.u8()
        input.u16()
        const index = input.u8()
        if (input.u8() !== 0) throw new Error('Invalid GIF graphics control terminator')
        transparent = flags & 1 ? index : -1
      } else {
        yield* subblocks(input, false)
        if (label === 1) transparent = -1
      }
    } else if (marker === 0x2c) {
      const left = input.u16(),
        top = input.u16(),
        w = input.u16(),
        h = input.u16(),
        flags = input.u8(),
        palette = flags & 128 ? input.slice(3 * (1 << ((flags & 7) + 1))) : global,
        minimum = input.u8(),
        compressed = yield* subblocks(input, !image)
      if (!w || !h || left + w > width || top + h > height || !palette)
        throw new Error('Invalid GIF image rectangle or palette')
      if (image) continue // Layer images use the first frame, not an animation timeline.
      const decoded = yield* lzw(compressed, minimum, w * h),
        data = new Uint8Array(width * height * 4),
        indices = new Uint8Array(width * height)
      indices.fill(background)
      for (let i = 0; i < width * height; i++) {
        if (global && background * 3 + 2 < global.length) {
          data[i * 4] = global[background * 3]!
          data[i * 4 + 1] = global[background * 3 + 1]!
          data[i * 4 + 2] = global[background * 3 + 2]!
        }
        data[i * 4 + 3] = background === transparent ? 0 : 255
        if (i % 4096 === 4095) yield
      }
      let source = 0
      for (const [start, step] of flags & 64
        ? [
            [0, 8],
            [4, 8],
            [2, 4],
            [1, 2],
          ]
        : [[0, 1]])
        for (let y = start!; y < h; y += step!) {
          for (let x = 0; x < w; x++) {
            const index = decoded[source++]!,
              pixel = (top + y) * width + left + x,
              at = pixel * 4
            if (index * 3 + 2 >= palette.length) throw new Error('GIF palette index out of range')
            indices[pixel] = index
            data[at] = palette[index * 3]!
            data[at + 1] = palette[index * 3 + 1]!
            data[at + 2] = palette[index * 3 + 2]!
            data[at + 3] = index === transparent ? 0 : 255
          }
          yield
        }
      image = { width, height, data, indices }
      transparent = -1
    } else throw new Error('Invalid GIF block marker')
    yield
  }
  throw new Error('Truncated GIF trailer')
}
export function decodeGif(bytes: Uint8Array): Generator<void, DecodedImage> | undefined {
  if (bytes[0] !== 71 || bytes[1] !== 73 || bytes[2] !== 70) return undefined
  return read(bytes)
}
