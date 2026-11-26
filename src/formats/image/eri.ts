import type { DecodedImage } from '../../engine/ports/graphics.ts'
import { ImageDecodeError, type ImageDecodeProgress, type ImageDecodeSelection } from './selection.ts'
import { decodeEriPredictiveTruecolor, decodeEriHuffmanTruecolor } from './eri-truecolor.ts'
import { decodeEriHuffmanIndices } from './eri-huffman.ts'
import { decodeEriArithmeticIndices } from './eri-arithmetic.ts'
import { decodeEriDct } from './eri-dct.ts'

/* ERI lossless RL-MTF-G, Gamma, Huffman, arithmetic and lossy DCT decoder.
 * Written for this engine from the ERINA-Library 1.0A format/algorithm source,
 * Copyright (C) 2000-2002 Leshade Entis, Entis-soft. The original SDK is not
 * bundled here. Source, license and the older fixed KRKR headers are recorded
 * in docs/decisions/119-eri-png-and-hosted-codecs.md. The original library's
 * distribution terms/GNU GPL option still apply to its algorithm-derived code.
 * This does not claim equivalence for the other ERINA codecs or x86 routines. */

const MAX_SOURCE = 64 * 1024 * 1024
const MAX_DIMENSION = 4096
const MAX_RECORDS = 65536
const LOSSLESS = 0x03020000
const GAMMA = 0xffffffff
const HUFFMAN = 0xfffffffc
const RGB = 1, GRAY = 2, TYPE_MASK = 0x00ffffff, WITH_ALPHA = 0x04000000

/** Fixed tTVPEFileObject rejects a nonzero high size word before reading.
 * The smaller Web source budget is distinct from that native failure. */
export function checkEriSourceSize(size: number): void {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid ERI source size')
  if (size >= 2 ** 32) throw new ImageDecodeError('eri', 'Too large storage')
  if (size > MAX_SOURCE) throw new Error('ERI source exceeds 64 MiB budget')
}

/** A recognized encoding outside this portable implementation is a Web gap,
 * not a claim that the original ERIDecoder rejected the image. */
export class EriUnsupportedError extends Error {
  constructor(detail: string) {
    super('ERI image encoding is not implemented: ' + detail)
    this.name = 'EriUnsupportedError'
  }
}

function failed(phase: 'Open' | 'Initialize' | 'DecodeImage'): never {
  throw new ImageDecodeError('eri', phase === 'Open' ? 'ERIFile::Open failed.' : `ERIDecoder::${phase} failed.`)
}

interface RecordRange { start: number; end: number; id: string }
interface EriContainer { info: DataView; palette: Uint8Array; frame: RecordRange }

/** The original EFileObject bounds each record by its parent and recognizes
 * the all-ones length sentinel. Reject address wrap separately from native
 * codec errors instead of emulating unsafe 64 -> 32-bit truncation. */
function* container(bytes: Uint8Array): Generator<void, EriContainer> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes.length < 64 || ![69, 110, 116, 105, 115, 26, 0, 0].every((byte, i) => bytes[i] === byte) ||
      view.getUint32(8, true) !== 0x03000100) failed('Open')
  let records = 0
  function* children(start: number, end: number): Generator<RecordRange | void> {
    for (let at = start; end - at >= 16;) {
      if (++records > MAX_RECORDS) throw new Error('ERI container exceeds its record budget')
      const low = view.getUint32(at + 8, true), high = view.getUint32(at + 12, true), payload = at + 16
      let limit: number
      if (low === 0xffffffff && high === 0xffffffff) limit = end
      else {
        if (high !== 0 || payload + low > 0xffffffff)
          throw new Error('ERI record exceeds the bounded Web address space')
        limit = Math.min(payload + low, end)
      }
      const id = String.fromCharCode(...bytes.subarray(at, at + 8))
      yield { start: payload, end: limit, id }
      at = limit
      if ((records & 63) === 0) yield
    }
  }
  function* find(start: number, end: number, id: string): Generator<void, RecordRange> {
    for (const record of children(start, end)) {
      if (!record) { yield; continue }
      if (record.id === id) return record
    }
    return failed('Open')
  }
  const header = yield* find(64, bytes.length, 'Header  '),
    file = yield* find(header.start, header.end, 'FileHdr ')
  if (file.end - file.start < 20 || view.getUint32(file.start, true) > 0x00020100) failed('Open')
  const infoBytes = new Uint8Array(68)
  let hasImage = false, hasSound = false
  // The original starts looking for ImageInf after the first FileHdr. A later
  // short duplicate overwrites its prefix but does not clear an earlier flag.
  for (const record of children(file.end, header.end)) {
    if (!record) { yield; continue }
    if (record.id === 'ImageInf') {
      const length = Math.min(68, record.end - record.start)
      infoBytes.set(bytes.subarray(record.start, record.start + length))
      if (length === 68) hasImage = true
    } else if (record.id === 'SoundInf' && record.end - record.start >= 40) hasSound = true
  }
  if (!hasImage) {
    if (hasSound) throw new EriUnsupportedError('sound-only container without initialized image information')
    failed('Open')
  }
  const stream = yield* find(header.end, bytes.length, 'Stream  '), palette = new Uint8Array(1024)
  for (const record of children(stream.start, stream.end)) {
    if (!record) { yield; continue }
    if (record.id === 'Palette ') {
      palette.fill(0)
      palette.set(bytes.subarray(record.start, Math.min(record.end, record.start + 1024)))
    } else if (record.id === 'ImageFrm') {
      return { info: new DataView(infoBytes.buffer), palette, frame: record }
    }
  }
  return failed('Open')
}

/** Original 64-KiB prefetch pads only its final nonempty DWORD with zero.
 * Bits are MSB first. Exhaustion is a codec result, not ReadBuffer/TJSReadError. */
class EriBits {
  private bit = 0
  private readonly length: number
  constructor(private readonly bytes: Uint8Array) {
    this.length = Math.ceil(bytes.length / 4) * 32
  }
  next(): number {
    if (this.bit >= this.length) return -1
    const at = this.bit++
    return ((this.bytes[at >>> 3] ?? 0) >>> (7 - (at & 7))) & 1
  }
  take(count: number): number {
    let value = 0
    for (let i = 0; i < count; i++) {
      const bit = this.next()
      if (bit < 0) break
      value = value * 2 + bit
    }
    return value
  }
  gamma(): number {
    let base = 1, value = 0
    for (;;) {
      const continuation = this.next()
      if (continuation < 0) return -1
      if (!continuation) return base + value
      // The source's signed int overflow has no portable, safe result.
      if (base >= 0x40000000) throw new Error('ERI gamma code exceeds safe signed 32-bit arithmetic')
      const bit = this.next()
      if (bit < 0) return -1
      base *= 2
      value = value * 2 + bit
    }
  }
}

function* indices(bits: EriBits, width: number, height: number): Generator<void, Uint8Array> {
  const tables = new Uint8Array(257 * 256), plane = new Uint8Array(width * height)
  for (let i = 0; i < tables.length; i++) tables[i] = i & 255
  // Tables persist across rows, but the row-start context and previous symbol
  // reset. This matches both the scalar routine and the original x86 assembly.
  for (let y = 0; y < height; y++) {
    let table = 256 * 256, previous = -1, x = 0, work = 0
    while (x < width) {
      const index = bits.gamma() - 1
      if (index < 0 || index > 255) failed('DecodeImage')
      const value = tables[table + index]!
      tables.copyWithin(table + 1, table, table + index)
      tables[table] = value
      plane[y * width + x++] = value
      if (value === previous) {
        const repeat = bits.gamma() - 1
        // Native can return the completed row even if the run suffix is
        // missing after its final literal. Do not tighten that acceptance.
        if (repeat < 0) {
          if (x !== width) failed('DecodeImage')
          break
        }
        const count = Math.min(repeat, width - x)
        plane.fill(value, y * width + x, y * width + x + count)
        x += count
      } else {
        previous = value
        table = value * 256
      }
      if (++work === 128) { work = 0; yield }
    }
    yield
  }
  return plane
}

/** The original copies bottom-up physical rows only after DecodeImage returns.
 * Reorder the private image in place to avoid retaining a second whole image.
 * Its alpha conversion is TVPDivTable, not an assumed straight-alpha copy. */
function* publishTruecolor(data: Uint8Array, width: number, height: number, signedHeight: number,
  gray: boolean, hasAlpha: boolean, progress?: ImageDecodeProgress): Generator<void, DecodedImage> {
  const stride = width * 4
  if (signedHeight > 0) {
    const temporary = new Uint8Array(stride)
    for (let y = 0; y < Math.floor(height / 2); y++) {
      const first = y * stride, last = (height - y - 1) * stride
      temporary.set(data.subarray(first, first + stride))
      data.copyWithin(first, last, last + stride)
      data.set(temporary, last)
      yield
    }
  }
  for (let y = 0; y < height; y++) {
    const start = y * stride
    for (let at = start; at < start + stride; at += 4) {
      const blue = data[at]!, green = data[at + 1]!, red = data[at + 2]!, alpha = data[at + 3]!
      if (gray) {
        // The grayscale branch sees the original physical colors and ignores
        // alpha. It does not unpremultiply before applying the integer weights.
        data[at] = data[at + 1] = data[at + 2] = (red * 54 + green * 183 + blue * 19) >>> 8
        data[at + 3] = 255
      } else if (hasAlpha) {
        data[at] = alpha ? Math.min(255, Math.floor(red * 255 / alpha)) : 0
        data[at + 1] = alpha ? Math.min(255, Math.floor(green * 255 / alpha)) : 0
        data[at + 2] = alpha ? Math.min(255, Math.floor(blue * 255 / alpha)) : 0
      } else {
        data[at] = red; data[at + 2] = blue; data[at + 3] = 255
      }
    }
    progress?.row(y, data.subarray(start, start + stride))
    yield
  }
  return { width, height, data, ...(gray ? { grayscale: true } : {}) }
}

/** Native selection accepts palettized source data for normal/gray output,
 * but rejects the caller's palettized mode before any source/header read.
 * Size is observable before Initialize/DecodeImage; all decoded source pixels
 * remain private until the complete entropy decode has succeeded. */
export function* decodeSelectedEri(bytes: Uint8Array, mode: ImageDecodeSelection['mode'],
  progress?: ImageDecodeProgress, paletteKey?: number): Generator<void, DecodedImage> {
  if (mode === 'palettized')
    throw new ImageDecodeError('eri', 'currently Kirikiri does not support loading palettized ERI image.')
  if (mode !== 'normal' && mode !== 'grayscale') throw new Error('Invalid ERI output mode')
  checkEriSourceSize(bytes.length)
  const parsed = yield* container(bytes), info = parsed.info,
    width = info.getInt32(16, true), signedHeight = info.getInt32(20, true), height = Math.abs(signedHeight)
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION)
    throw new Error('ERI dimensions exceed the supported Web image bounds')
  progress?.size(width, height)
  yield
  const version = info.getUint32(0, true), transformation = info.getUint32(4, true),
    architecture = info.getUint32(8, true), type = info.getUint32(12, true),
    depth = info.getUint32(24, true), blockingDegree = info.getUint32(52, true), kind = type & TYPE_MASK
  // Initialize errors come from the ERINA source or the fixed SDK observations
  // below; other potentially valid codecs must not acquire invented errors.
  if (transformation === 1) {
    if ((architecture !== GAMMA && architecture !== HUFFMAN) || kind !== RGB || depth < 24) failed('Initialize')
    // The pinned 2.32r2 SDK rejects this header combination before decoding.
    // The newer ERINA mirror accepts it; do not infer that its acceptance
    // describes the bundled library, or extend this result to other versions.
    if (version === 0x00020100 && architecture === GAMMA) failed('Initialize')
    const alpha = (type & WITH_ALPHA) !== 0
    const image = yield* decodeEriDct(new EriBits(bytes.subarray(parsed.frame.start, parsed.frame.end)), {
      width, height, degree: blockingDegree, sampling: info.getUint32(32, true), alpha, huffman: architecture === HUFFMAN,
    })
    return yield* publishTruecolor(image, width, height, signedHeight, mode === 'grayscale', alpha, progress)
  }
  if (transformation === LOSSLESS) {
    if (![GAMMA, HUFFMAN, 32].includes(architecture) || (kind !== RGB && kind !== GRAY) ||
        (version !== 0x00020100 && version !== 0x00020200)) failed('Initialize')
  } else throw new EriUnsupportedError('transformation 0x' + transformation.toString(16))
  if (blockingDegree > 8) throw new Error('ERI blocking degree exceeds the Web work budget')
  const outputDepth = depth === 8 && !(type & WITH_ALPHA) ? 8 : depth >= 24 ? 32 : mode === 'grayscale' ? 8 : 32,
    channels = kind === GRAY || depth <= 8 ? 1 : type & WITH_ALPHA ? 4 : 3,
    enhanced = version === 0x00020100 ? 0 : architecture === HUFFMAN ? 2 : 1,
    // GetRestoreFunc checks the exact source format, including flags.
    restorable = type === RGB ? outputDepth === 32 : type === (RGB | WITH_ALPHA) ? outputDepth === 32
      : type === GRAY && outputDepth === 8,
    bits = new EriBits(bytes.subarray(parsed.frame.start, parsed.frame.end)), frameVersion = bits.take(8)
  if (frameVersion !== 2) {
    if (frameVersion === 1 || frameVersion === 4) {
      if ((frameVersion === 4 && enhanced !== 1) || !restorable) failed('DecodeImage')
      const operations = bits.take(8), encoding = bits.take(8), reserved = bits.take(8)
      if (architecture === 32 ? operations !== 0 || reserved !== 0
        : architecture === GAMMA ? operations !== 0 || (encoding & 0xfe) !== 0 || reserved !== 0 : true)
        failed('DecodeImage')
      if (depth !== 24 && depth !== 32 && !(type === GRAY && depth === 8))
        throw new EriUnsupportedError('truecolor source depth ' + depth)
      const image = yield* decodeEriPredictiveTruecolor(bits, {
        width, height, channels, degree: blockingDegree, enhanced: enhanced !== 0, continuous: (encoding & 1) !== 0,
      }, architecture === 32 ? encoding : undefined)
      return yield* publishTruecolor(image, width, height, signedHeight, mode === 'grayscale',
        (type & WITH_ALPHA) !== 0, progress)
    }
    if (frameVersion === 8) {
      if (channels < 3 || enhanced !== 2 || architecture !== HUFFMAN || !restorable) failed('DecodeImage')
      const operations = bits.take(8), encoding = bits.take(8), bitCount = bits.take(8)
      if (operations !== 0 || (encoding & 0xfe) !== 0 || bitCount !== 8) failed('DecodeImage')
      if (depth !== 24 && depth !== 32) throw new EriUnsupportedError('truecolor source depth ' + depth)
      const image = yield* decodeEriHuffmanTruecolor(bits, {
        width, height, channels, degree: blockingDegree, continuous: (encoding & 1) !== 0,
      })
      return yield* publishTruecolor(image, width, height, signedHeight, mode === 'grayscale',
        (type & WITH_ALPHA) !== 0, progress)
    }
    failed('DecodeImage')
  }
  if (outputDepth !== 8) failed('DecodeImage')
  if (bits.take(24) !== 0) failed('DecodeImage')
  if (depth !== 8 || (type & WITH_ALPHA)) throw new EriUnsupportedError('only 8-bit sources without alpha are supported')
  const plane = architecture === HUFFMAN ? yield* decodeEriHuffmanIndices(bits, width, height)
    : architecture === 32 ? yield* decodeEriArithmeticIndices(bits, width, height) : yield* indices(bits, width, height),
    data = new Uint8Array(width * height * 4),
    gray = mode === 'grayscale', key = paletteKey === undefined || paletteKey === -1 ? -1 : paletteKey & 255
  // Missing palette memory in the original is uninitialized; the Web's owned
  // zero palette is an explicit safe boundary. A present short Palette record
  // is zero padded by the original library itself.
  for (let y = 0; y < height; y++) {
    const sourceY = signedHeight > 0 ? height - 1 - y : y
    for (let x = 0; x < width; x++) {
      const index = plane[sourceY * width + x]!, at = (y * width + x) * 4
      if (kind === GRAY) {
        data[at] = data[at + 1] = data[at + 2] = index
        data[at + 3] = 255
      } else {
        const palette = index * 4, blue = parsed.palette[palette]!, green = parsed.palette[palette + 1]!,
          red = parsed.palette[palette + 2]!
        if (gray) data[at] = data[at + 1] = data[at + 2] = (red * 54 + green * 183 + blue * 19) >>> 8
        else { data[at] = red; data[at + 1] = green; data[at + 2] = blue }
        data[at + 3] = !gray && index === key ? 0 : 255
      }
    }
    progress?.row(y, data.subarray(y * width * 4, (y + 1) * width * 4))
    yield
  }
  return { width, height, data, ...(gray ? { grayscale: true } : {}) }
}
