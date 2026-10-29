import type { DecodedImage, Pixels } from '../../engine/ports/graphics.ts'
import { ImageDecodeError, type ImageDecodeSelection, type ImageDecodeProgress } from './selection.ts'
import { ImageReadError } from './read-error.ts'
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
  progress?: ImageDecodeProgress,
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
    (mode === undefined && !progress && offset + stride * height > bytes.length)
  )
    throw new Error('Truncated BMP pixels or palette')
  const result: DecodedImage = {
    width,
    height,
    data: new Uint8Array(width * height * 4),
    ...(depth <= 8 && mode !== 'grayscale' ? { indices: new Uint8Array(width * height) } : {}),
    ...(mode === 'grayscale' ? { grayscale: true } : {}),
  }
  progress?.size(width, height)
  for (let sourceY = 0; sourceY < height; sourceY++) {
    // The fixed native loader reads up to eight complete file-order rows
    // before exposing any row in that batch, including bottom-up images.
    if (mode !== undefined && sourceY % 8 === 0) {
      const start = offset + sourceY * stride, requested = Math.min(8, height - sourceY) * stride,
        available = Math.max(0, bytes.length - start)
      if (requested > available)
        throw new ImageReadError('bmp', start, requested, available, 'Truncated BMP pixels or palette')
    }
    const y = mode !== undefined && signedHeight > 0 ? height - 1 - sourceY : sourceY
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
    progress?.row(y, result.data.subarray(y * width * 4, (y + 1) * width * 4),
      result.indices?.subarray(y * width, (y + 1) * width))
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
  progress?: ImageDecodeProgress,
): DecodedImage | undefined {
  const need = (offset: number, length: number) => {
    const available = Math.max(0, bytes.length - offset)
    if (length > available) throw new ImageReadError('bmp', offset, length, available, 'Truncated BMP stream')
  }
  need(0, 2)
  if (bytes[0] !== 0x42 || bytes[1] !== 0x4d)
    throw new ImageDecodeError('bmp', 'This is not a Windows BMP file or an OS/2 BMP file.')
  for (const [offset, length] of [[2, 4], [6, 2], [8, 2], [10, 4], [14, 4]]) need(offset!, length!)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    dib = view.getUint32(14, true)
  if (dib !== 12 && dib !== 40)
    throw new ImageDecodeError('bmp', 'Non-supported header version.')
  for (const [offset, length] of dib === 12 ? [[18, 2], [20, 2], [22, 2], [24, 2]]
    : [[18, 4], [22, 4], [26, 2], [28, 2], [30, 4], [34, 4], [38, 4], [42, 4], [46, 4], [50, 4]])
    need(offset!, length!)
  const depth = view.getUint16(dib === 12 ? 24 : 28, true),
    colors = depth <= 8 ? (dib === 12 ? 1 << depth : view.getUint32(46, true) || 1 << depth) : 0
  // GraphicsLoaderIntf's CORE branch memset clears biSize. Both its palette
  // allocation and its internal palette reader therefore use four bytes, not
  // the three bytes dictated by the CORE file format. Read first, then seek to
  // bfOffBits: palette data may overlap pixels, but it must be in this stream.
  if (colors > 1 << Math.min(depth, 8)) throw new Error('BMP palette exceeds the selected depth')
  need(14 + dib, colors * 4)
  const compression = dib === 12 ? 0 : view.getUint32(30, true)
  if (compression === 3) throw new ImageDecodeError('bmp', 'BITFIELDS not supported.')
  if (compression !== 0) throw new ImageDecodeError('bmp', 'Compressed BMP not supported.')
  if (depth > 8 && mode === 'palettized')
    throw new ImageDecodeError('bmp', 'Unsupported color mode for palettized image.')
  return decodeBitmap(bytes, mode, progress)
}
