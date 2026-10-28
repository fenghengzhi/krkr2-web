import type { DecodedImage, Pixels } from '../../engine/ports/graphics.ts'
import { ImageDecodeError, type ImageDecodeSelection } from './selection.ts'
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

/** Decode BI_RGB pixels without invoking a platform codec. A selected CORE
 * handler uses the fixed loader's four-byte palette behavior; direct embedding
 * reads the standard three-byte CORE palette. */
function decodeBitmap(
  bytes: Uint8Array,
  mode?: ImageDecodeSelection['mode'],
): DecodedImage | undefined {
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d) return undefined
  if (bytes.length < 18) throw new Error('Truncated BMP header')
  const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dib = header.getUint32(14, true)
  // Retain the old direct Windows-header short-read boundary. CORE is the
  // newly supported shorter header and must be allowed to end at byte 26.
  if (dib !== 12 && bytes.length < 54) throw new Error('Truncated BMP header')
  if (dib !== 12 && dib < 40) return undefined
  if (bytes.length < 26) throw new Error('Truncated BMP header')
  const core = dib === 12,
    depth = header.getUint16(core ? 24 : 28, true),
    compression = core ? 0 : header.getUint32(30, true)
  if (compression !== 0 || ![1, 4, 8, 15, 16, 24, 32].includes(depth)) return undefined
  const width = core ? header.getUint16(18, true) : header.getInt32(18, true),
    signedHeight = core ? header.getUint16(20, true) : header.getInt32(22, true),
    height = Math.abs(signedHeight),
    offset = header.getUint32(10, true),
    stride = Math.ceil((width * depth) / 32) * 4
  if (
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    header.getUint16(core ? 22 : 26, true) !== 1
  )
    throw new Error('Invalid BMP dimensions or planes')
  // The original pitches a depth=15 row using 15*width but reads width whole
  // 16-bit words. Do not normalize its pitch or emulate reads past that row.
  if (depth === 15 && stride < width * 2)
    throw new Error('BMP 15-bit row cannot contain its declared pixel words')
  const colors = depth <= 8 ? (core ? 1 << depth : header.getUint32(46, true) || 1 << depth) : 0,
    palette = 14 + dib,
    paletteBytes = core && mode === undefined ? 3 : 4
  if (
    colors > 1 << Math.min(depth, 8) ||
    palette + colors * paletteBytes > bytes.length ||
    (mode === undefined && palette + colors * paletteBytes > offset) ||
    offset + stride * height > bytes.length
  )
    throw new Error('Truncated BMP pixels or palette')
  const result: DecodedImage = {
    width,
    height,
    data: new Uint8Array(width * height * 4),
    ...(depth <= 8 && mode !== 'grayscale' ? { indices: new Uint8Array(width * height) } : {}),
    ...(mode === 'grayscale' ? { grayscale: true } : {}),
  }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const from =
          offset + (signedHeight > 0 ? height - 1 - y : y) * stride +
          (depth === 15 || depth === 16 ? x * 2 : Math.floor((x * depth) / 8)),
        to = (y * width + x) * 4
      let at = from
      if (depth <= 8) {
        const index = (bytes[from]! >>> (8 - depth - ((x * depth) & 7))) & ((1 << depth) - 1)
        if (result.indices) result.indices[y * width + x] = index
        if (mode === 'palettized') {
          // Native's palettized destination contains the index, not a palette
          // lookup. Keep that byte even if a short declared palette lacks it.
          result.data[to] = result.data[to + 1] = result.data[to + 2] = index
          result.data[to + 3] = 255
          continue
        }
        if (index >= colors) throw new Error('BMP palette index is outside the palette')
        at = palette + index * paletteBytes
      }
      if (depth === 15 || depth === 16) {
        const word = header.getUint16(from, true),
          r = (word >>> 10) & 31, g = (word >>> 5) & 31, b = word & 31
        if (mode === 'grayscale') {
          // TVPBLConvert15BitTo8Bit is a distinct fixed-point conversion,
          // not TVP's 8-bit grayscale applied to expanded RGB555.
          const gray = (r * 56 + g * 187 + b * 21) >>> 5
          result.data[to] = result.data[to + 1] = result.data[to + 2] = gray
        } else {
          result.data[to] = (r << 3) | (r >>> 2)
          result.data[to + 1] = (g << 3) | (g >>> 2)
          result.data[to + 2] = (b << 3) | (b >>> 2)
        }
        result.data[to + 3] = 255
      } else if (mode === 'grayscale') {
        const gray = (54 * bytes[at + 2]! + 183 * bytes[at + 1]! + 19 * bytes[at]!) >>> 8
        result.data[to] = result.data[to + 1] = result.data[to + 2] = gray
        result.data[to + 3] = 255
      } else {
        result.data[to] = bytes[at + 2]!
        result.data[to + 1] = bytes[at + 1]!
        result.data[to + 2] = bytes[at]!
        result.data[to + 3] = depth === 32 ? bytes[from + 3]! : 255
      }
    }
  return result
}

/** Direct uncompressed BMP decoding. Existing 32-bit BI_RGB alpha remains the
 * TVP mask channel. CORE uses its standard BGR triples on this direct API. */
export function decodeBmp(bytes: Uint8Array): DecodedImage | undefined {
  return decodeBitmap(bytes)
}

/** Native BMP handler checks precede portable/host decoding. The direct BMP
 * reader above deliberately retains its wider embedding/CUR contract. */
export function decodeSelectedBmp(
  bytes: Uint8Array,
  mode: ImageDecodeSelection['mode'],
): DecodedImage | undefined {
  const need = (length: number) => {
    if (bytes.length < length) throw new Error('Truncated BMP stream')
  }
  need(2)
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d)
    throw new ImageDecodeError('bmp', 'This is not a Windows BMP file or an OS/2 BMP file.')
  need(18)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dib = view.getUint32(14, true)
  if (dib !== 12 && dib !== 40)
    throw new ImageDecodeError('bmp', 'Non-supported header version.')
  need(14 + dib)
  const depth = view.getUint16(dib === 12 ? 24 : 28, true),
    colors = depth <= 8 ? (dib === 12 ? 1 << depth : view.getUint32(46, true) || 1 << depth) : 0
  // GraphicsLoaderIntf's CORE branch memset clears biSize. Both its palette
  // allocation and its internal palette reader therefore use four bytes, not
  // the three bytes dictated by the CORE file format. Read first, then seek to
  // bfOffBits: palette data may overlap pixels, but it must be in this stream.
  need(14 + dib + colors * 4)
  const compression = dib === 12 ? 0 : view.getUint32(30, true)
  if (compression === 3) throw new ImageDecodeError('bmp', 'BITFIELDS not supported.')
  if (compression !== 0) throw new ImageDecodeError('bmp', 'Compressed BMP not supported.')
  if (depth > 8 && mode === 'palettized')
    throw new ImageDecodeError('bmp', 'Unsupported color mode for palettized image.')
  return decodeBitmap(bytes, mode)
}
