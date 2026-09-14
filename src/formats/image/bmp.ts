import type { DecodedImage, Pixels } from '../../engine/ports/graphics.ts'
const dither = [
  [0, 12, 2, 14],
  [8, 4, 10, 6],
  [3, 15, 1, 13],
  [11, 7, 9, 5],
]
function level(value: number, maximum: number, threshold: number): number {
  const scaled = (value / 255) * maximum,
    whole = Math.floor(scaled)
  return whole + Number(threshold / 16 < scaled - whole)
}
/** Windows BITMAPINFOHEADER, bottom-up BGR(A); bmp8 uses TVP's fixed 252-color palette. */
export function encodeBmp(image: Pixels, mode = 'bmp'): Uint8Array {
  const depth =
    mode === 'bmp' || mode === 'bmp32' ? 32 : mode === 'bmp24' ? 24 : mode === 'bmp8' ? 8 : 0
  if (!depth) throw new Error(`Image output format is not implemented: ${mode}`)
  const { width, height, data } = image
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    data.length !== width * height * 4
  )
    throw new Error('Invalid BMP image dimensions')
  const stride = Math.ceil((width * depth) / 32) * 4,
    offset = 54 + (depth === 8 ? 1024 : 0),
    size = offset + stride * height
  if (size > 64 * 1024 * 1024) throw new Error('BMP exceeds 64 MiB resource budget')
  const result = new Uint8Array(size),
    header = new DataView(result.buffer)
  header.setUint16(0, 0x4d42, true)
  header.setUint32(2, size, true)
  header.setUint32(10, offset, true)
  header.setUint32(14, 40, true)
  header.setInt32(18, width, true)
  header.setInt32(22, height, true)
  header.setUint16(26, 1, true)
  header.setUint16(28, depth, true)
  if (depth === 8)
    for (let blue = 0; blue < 6; blue++)
      for (let green = 0; green < 7; green++)
        for (let red = 0; red < 6; red++) {
          const at = 54 + (blue * 42 + green * 6 + red) * 4
          result[at] = Math.floor((blue * 255) / 5)
          result[at + 1] = Math.floor((green * 255) / 6)
          result[at + 2] = Math.floor((red * 255) / 5)
        }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4,
        to = offset + (height - 1 - y) * stride + x * (depth / 8)
      if (depth === 8) {
        const i = y & 3,
          j = x & 3
        result[to] =
          level(data[from + 2]!, 5, dither[j]![i]!) * 42 +
          level(data[from + 1]!, 6, dither[j]![(i + 1) % 2]!) * 6 +
          level(data[from]!, 5, dither[(j + 1) % 2]![(i + 1) % 2]!)
      } else {
        result[to] = data[from + 2]!
        result[to + 1] = data[from + 1]!
        result[to + 2] = data[from]!
        if (depth === 32) result[to + 3] = data[from + 3]!
      }
    }
  return result
}

/** Decode the uncompressed Windows BMP variants used by KiriKiri's image
 * writer. In 32-bit BI_RGB files the fourth byte is the TVP mask channel. */
export function decodeBmp(bytes: Uint8Array): DecodedImage | undefined {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  if (bytes.length < 54) throw new Error('Truncated BMP header')
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dib = header.getUint32(14, true),
    depth = header.getUint16(28, true),
    compression = header.getUint32(30, true)
  if (dib < 40 || compression !== 0 || ![1, 4, 8, 24, 32].includes(depth)) return undefined
  const width = header.getInt32(18, true),
    signedHeight = header.getInt32(22, true),
    height = Math.abs(signedHeight),
    offset = header.getUint32(10, true),
    stride = Math.ceil((width * depth) / 32) * 4
  if (
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    header.getUint16(26, true) !== 1
  )
    throw new Error('Invalid BMP dimensions or planes')
  const colors = depth <= 8 ? header.getUint32(46, true) || 1 << depth : 0,
    palette = 14 + dib
  if (
    colors > 1 << Math.min(depth, 8) ||
    palette + colors * 4 > offset ||
    offset + stride * height > bytes.length
  )
    throw new Error('Truncated BMP pixels or palette')
  const result: DecodedImage = {
    width,
    height,
    data: new Uint8Array(width * height * 4),
    ...(depth <= 8 ? { indices: new Uint8Array(width * height) } : {}),
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from =
          offset + (signedHeight > 0 ? height - 1 - y : y) * stride + Math.floor((x * depth) / 8),
        to = (y * width + x) * 4
      let at = from
      if (depth <= 8) {
        const index = (bytes[from]! >>> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1)
        if (index >= colors) throw new Error('BMP palette index is outside the palette')
        at = palette + index * 4
        result.indices![y * width + x] = index
      }
      result.data[to] = bytes[at + 2]!
      result.data[to + 1] = bytes[at + 1]!
      result.data[to + 2] = bytes[at]!
      result.data[to + 3] = depth === 32 ? bytes[from + 3]! : 255
    }
  return result
}
