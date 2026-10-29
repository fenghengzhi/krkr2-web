import type { DecodedImage } from '../../engine/ports/graphics.ts'
import { crc32 } from '../binary/crc32.ts'
import { paeth } from './png-filter.ts'
import { ImageDecodeError, type ImageDecodeSelection, type ImageDecodeProgress } from './selection.ts'
import { PngPull, PngStreamReadError } from './png-pull.ts'
import { ImageReadError } from './read-error.ts'
import type { ImageInflater } from '../../engine/ports/image-inflater.ts'

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
export interface PngStreamPlan {
  expandedLength: number
  readonly phase: 'read_row' | 'read_image' | 'read_end' | 'complete'
  decode(inflater: ImageInflater): Generator<void, DecodedImage>
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
  bytes: Uint8Array | undefined,
  palette: Uint8Array | undefined,
  transparent: Uint8Array | undefined,
  metadata: Map<string, string>,
  mode?: ImageDecodeSelection['mode'],
  progress?: ImageDecodeProgress,
  rowSource?: (length: number) => Generator<void, Uint8Array>,
  finishRow?: (last: boolean) => Generator<void, void>,
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
  if (type === 3 && mode !== 'grayscale') image.indices = new Uint8Array(width * height)
  if (type === 0 && depth <= 8) image.grayscale = true
  if (mode === 'grayscale') image.grayscale = true
  if (metadata.size) image.metadata = metadata
  let at = 0
  const imagePasses = passes(h)
  for (const pass of imagePasses) {
    const stride = Math.ceil((pass.width * channels * depth) / 8)
    let previous = new Uint8Array(stride),
      row = new Uint8Array(stride)
    for (let y = 0; y < pass.height; y++) {
      const packet = rowSource ? (yield* rowSource(stride + 1)) : bytes!.subarray(at, at + stride + 1),
        filter = packet[0]!
      if (filter > 4 && !rowSource) throw new Error('Unsupported PNG scanline filter')
      at += stride + 1
      for (let x = 0; x < stride; x++) {
        const a = x >= bpp ? row[x - bpp]! : 0,
          b = previous[x]!,
          c = x >= bpp ? previous[x - bpp]! : 0
        row[x] =
          packet[x + 1]! +
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
      // libpng 1.0.6 warns for an unknown filter and sets the first sample
      // byte to zero; it does not reject the completed filtered row.
      if (filter > 4) row[0] = 0
      for (let x = 0; x < pass.width; x++) {
        const pixel = (pass.y + y * pass.dy) * width + pass.x + x * pass.dx,
          to = pixel * 4,
          source = x * channels
        if (type === 3) {
          const index = readSample(row, x)
          if (!palette || index * 3 + 2 >= palette.length)
            throw new Error('PNG palette index out of range')
          if (image.indices) image.indices[pixel] = index
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
              // The selected native RGB handler enables BGR/filler, but not
              // libpng's EXPAND flag. Only the generic PNG API expands RGB
              // tRNS; gray's separate native branch still enables EXPAND.
              : mode === undefined && tr && r === tr.getUint16(0) && g === tr.getUint16(2) && b === tr.getUint16(4)
                ? 0
                : 255
        }
        if (mode === 'grayscale') {
          // Fixed GraphicsLoaderIntf passes (red=0, green=0) to libpng
          // 1.0.6 for RGB(A), selecting B. Palette PNG uses TVP's manual
          // BGR conversion instead. Gray/gray-alpha already contains gray.
          const value = type === 3
            ? (54 * image.data[to]! + 183 * image.data[to + 1]! + 19 * image.data[to + 2]!) >>> 8
            : type === 2 || type === 6 ? image.data[to + 2]! : image.data[to]!
          image.data[to] = image.data[to + 1] = image.data[to + 2] = value
          image.data[to + 3] = 255
        } else if (mode === 'palettized') image.data[to + 3] = 255
      }
      const swap = previous
      previous = row
      row = swap
      if (rowSource && !h.interlace && !(mode === 'grayscale' && h.type === 3))
        progress?.write?.(y, image.data.subarray(y * width * 4, (y + 1) * width * 4),
          image.indices?.subarray(y * width, (y + 1) * width))
      if (finishRow) yield* finishRow(pass === imagePasses.at(-1) && y === pass.height - 1)
      if (!h.interlace) progress?.row(y, image.data.subarray(y * width * 4, (y + 1) * width * 4),
        image.indices?.subarray(y * width, (y + 1) * width))
      yield
    }
  }
  if (bytes && at !== bytes.length) throw new Error('PNG expanded size mismatch')
  return image
}

function streamPlan(bytes: Uint8Array, start: number, h: Header, palette: Uint8Array | undefined,
  transparent: Uint8Array | undefined, metadata: Map<string, string>, mode: ImageDecodeSelection['mode'],
  progress: ImageDecodeProgress | undefined): PngStreamPlan {
  let phase: PngStreamPlan['phase'] = h.interlace ? 'read_image' : 'read_row', started = false
  return {
    expandedLength: passes(h).reduce((sum, pass) => sum +
      (1 + Math.ceil(pass.width * h.channels * h.depth / 8)) * pass.height, 0),
    get phase() { return phase },
    *decode(inflater) {
      if (started) throw new Error('PNG stream plan was already consumed')
      started = true
      const source = new PngPull(bytes, start, inflater),
        image = yield* pixels(h, undefined, palette, transparent, metadata, mode, progress,
          (length) => source.row(length), (last) => source.finishRow(last))
      phase = 'read_end'
      yield* source.endImageData()
      while (true) {
        const length = source.u32(), name = source.take(4), type = String.fromCharCode(...name),
          ancillary = !!(name[0]! & 32), vpag = type.toLowerCase() === 'vpag'
        if (type === 'IDAT') throw new ImageDecodeError('png', "Too many IDAT's found")
        if (type === 'IHDR') throw new ImageDecodeError('png', 'Out of place IHDR')
        const data = source.take(length)
        if (vpag && length >= 9) {
          // The original unknown-chunk callback precedes its CRC check.
          const view = new DataView(data.buffer, data.byteOffset, data.byteLength), unit = data[8]!
          metadata.set('vpag_w', String(view.getInt32(0)))
          metadata.set('vpag_h', String(view.getInt32(4)))
          metadata.set('vpag_unit', unit === 0 ? 'pixel' : unit === 1 ? 'micrometer' : 'unknown')
        } else if (!ancillary && type !== 'IEND' && type !== 'PLTE') {
          throw new ImageDecodeError('png', `${type}: unknown critical chunk`)
        }
        const nameChecksum = yield* crc32(name), checksum = yield* crc32(data, nameChecksum),
          valid = source.u32() === checksum
        if (!valid && !ancillary) throw new ImageDecodeError('png', `${type}: CRC error`)
        // Known ancillary tail metadata and PLTE only warn/consume. IEND may
        // have extra payload in the old reader; bytes after IEND are not read.
        if (type === 'IEND') break
        yield
      }
      if (h.interlace && progress) for (let y = 0; y < h.height; y++) {
        const rgba = image.data.subarray(y * h.width * 4, (y + 1) * h.width * 4),
          indices = image.indices?.subarray(y * h.width, (y + 1) * h.width)
        progress.write?.(y, rgba, indices)
        progress.row(y, rgba, indices)
        yield
      }
      if (metadata.size) image.metadata = metadata
      phase = 'complete'
      return image
    },
  }
}

function parse(bytes: Uint8Array, mode: ImageDecodeSelection['mode'], progress: ImageDecodeProgress | undefined,
  streaming: true): Generator<void, PngStreamPlan>
function parse(bytes: Uint8Array, mode?: ImageDecodeSelection['mode'], progress?: ImageDecodeProgress,
  streaming?: false): Generator<void, PngPlan>
function* parse(bytes: Uint8Array, mode?: ImageDecodeSelection['mode'], progress?: ImageDecodeProgress,
  streaming = false): Generator<void, PngPlan | PngStreamPlan> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    metadata = new Map<string, string>()
  const need = (offset: number, requested: number, diagnostic: string, audited = true) => {
    const actual = Math.max(0, bytes.length - offset)
    if (requested > actual) {
      if (!audited) throw new Error(diagnostic)
      throw streaming ? new PngStreamReadError(offset, requested, actual)
        : new ImageReadError('png', offset, requested, actual, diagnostic)
    }
  }
  let at = 8,
    header: Header | undefined,
    palette: Uint8Array | undefined,
    transparent: Uint8Array | undefined,
    total = 0,
    dataStart = 0,
    dataStop = 0,
    ended = false,
    dataStarted = false,
    dataEnded = false,
    tailFailed = false,
    tailError: unknown
  while (at < bytes.length || (mode !== undefined && !ended)) {
    // Eight remaining bytes identify a non-IDAT tail even when its CRC or
    // declared payload is truncated. That read occurs in native png_read_end.
    let afterData = !!progress && dataStarted &&
      ((mode !== undefined && bytes.length - at < 8) || (bytes.length - at >= 8 &&
        String.fromCharCode(...bytes.subarray(at + 4, at + 8)) !== 'IDAT'))
    try {
    if (mode !== undefined) {
      // These are separate source reads in png_read_info. Do not require a
      // payload/CRC before dispatching a handler that can reject its header.
      need(at, 4, 'Truncated PNG chunk')
      need(at + 4, 4, 'Truncated PNG chunk')
      const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8)), length = view.getUint32(at)
      if (type === 'IHDR') {
        if (header) throw new ImageDecodeError('png', 'Out of place IHDR')
        if (length !== 13) throw new ImageDecodeError('png', 'Invalid IHDR chunk')
      } else if (type === 'IEND' && (!header || !dataStarted)) {
        throw new ImageDecodeError('png', 'No image in file')
      } else if (type === 'PLTE') {
        if (!header) throw new ImageDecodeError('png', 'Missing IHDR before PLTE')
        if (!dataStarted && palette) throw new ImageDecodeError('png', 'Duplicate PLTE chunk')
        if (!dataStarted && header.type === 3 && length % 3)
          throw new ImageDecodeError('png', 'Invalid palette chunk')
        // Preserve the Web palette bound before a potentially enormous triple
        // loop; this is not presented as a native ReadBuffer diagnosis.
        if (length > 768) throw new Error('Invalid PNG palette')
      } else if (type === 'IDAT') {
        if (!header || (header.type === 3 && !palette))
          throw new ImageDecodeError('png', header ? 'Missing PLTE before IDAT' : 'Missing IHDR before IDAT')
        if (streaming) {
          progress?.size(header.width, header.height)
          return streamPlan(bytes, at, header, palette, transparent, metadata, mode, progress)
        }
      } else if (!header && ['tRNS', 'oFFs', 'pHYs'].includes(type)) {
        throw new ImageDecodeError('png', `Missing IHDR before ${type === 'pHYs' ? 'pHYS' : type}`)
      }
    } else if (bytes.length - at < 12) throw new Error('Truncated PNG chunk')
    if (progress && !dataStarted && header && bytes.length - at >= 8 &&
        String.fromCharCode(...bytes.subarray(at + 4, at + 8)) === 'IDAT' &&
        (header.type !== 3 || palette)) {
      // A complete first IDAT header reaches native size before reading the
      // actual compressed bytes. The legacy bulk path retains that boundary.
      progress.size(header.width, header.height)
    }
    const length = view.getUint32(at),
      start = at + 4,
      end = start + 4 + length
    const type = String.fromCharCode(...bytes.subarray(start, start + 4))
    if (mode !== undefined) {
      // Do not claim the read granularity of unimplemented ancillary handlers.
      // Their existing plain validation failure remains an explicit gap. The
      // original unknown-chunk callback, in contrast, reads one payload buffer.
      const otherKnown = ['gAMA', 'cHRM', 'sBIT', 'sRGB', 'bKGD', 'hIST', 'iCCP', 'sPLT',
        'tIME', 'sCAL', 'pCAL', 'tEXt', 'zTXt', 'iTXt'].includes(type),
        paletteTriples = type === 'PLTE' && !dataStarted && header?.type === 3 && length % 3 === 0,
        transparencySkip = type === 'tRNS' && (dataStarted || !!transparent ||
          (header?.type === 3 ? !length || (!!palette && length > palette.length / 3)
            : header?.type === 0 ? length !== 2 : header?.type === 2 ? length !== 6 : true)),
        skipped = type === 'IDAT' || type === 'IEND' || transparencySkip ||
          ((type === 'oFFs' || type === 'pHYs') && (length !== 9 || dataStarted ||
            metadata.has(type === 'oFFs' ? 'offs_x' : 'reso_x'))),
        audited = /^[A-Za-z]{4}$/.test(type) && !otherKnown && (type !== 'PLTE' || paletteTriples || dataStarted),
        batch = paletteTriples ? 3 : skipped || (type === 'PLTE' && dataStarted) ? 8192 : length
      for (let offset = start + 4; offset < end;) {
        const requested = Math.min(batch, end - offset)
        need(offset, requested, bytes.length - at < 12 ? 'Truncated PNG chunk' : 'Truncated PNG chunk data', audited)
        offset += requested
        yield
      }
      // The configured native unknown-chunk callback receives payload bytes
      // before CRC. An unrecognized critical chunk therefore rejects here.
      if (!(bytes[start]! & 32) && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type) &&
          !(type.toLowerCase() === 'vpag' && length >= 9))
        throw new ImageDecodeError('png', `${type}: unknown critical chunk`)
      need(end, 4, 'Truncated PNG chunk', audited)
    } else if (length > bytes.length - at - 12) throw new Error('Truncated PNG chunk data')
    const chunk = bytes.subarray(start + 4, end)
    afterData = dataStarted && type !== 'IDAT'
    const nativePosition = mode !== undefined &&
      (type === 'oFFs' || type === 'pHYs' || type.toLowerCase() === 'vpag'),
      ancillaryPosition = nativePosition && !!(bytes[start]! & 32),
      validCrc = (yield* crc32(bytes.subarray(start, end))) === view.getUint32(end)
    // A short vpAg is unrecognized by the callback. A critical variant then
    // fails before its CRC is consumed; ancillary variants are ignored.
    if (nativePosition && type.toLowerCase() === 'vpag' && length < 9 && !ancillaryPosition)
      throw new ImageDecodeError('png', `${type}: unknown critical chunk`)
    if (!validCrc && !ancillaryPosition && !(streaming && (bytes[start]! & 32))) {
      if (streaming) throw new ImageDecodeError('png', `${type}: CRC error`)
      throw new Error('PNG chunk CRC mismatch')
    }
    at = end + 4
    if (streaming && !validCrc && (bytes[start]! & 32) && type.toLowerCase() !== 'vpag') {
      yield
      continue
    }
    if (!header && type !== 'IHDR') throw new Error('PNG must start with IHDR')
    if (type === 'IHDR') {
      if (header || length !== 13) throw new Error('Invalid PNG header')
      const info = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
        width = info.getUint32(0),
        height = info.getUint32(4),
        depth = chunk[8]!,
        color = chunk[9]!,
        channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[color]
      if (
        !channels ||
        !(color === 0 ? [1, 2, 4, 8, 16] : color === 3 ? [1, 2, 4, 8] : [8, 16]).includes(depth) ||
        chunk[10] ||
        chunk[11] ||
        chunk[12]! > 1
      )
        throw new Error('Unsupported PNG image type')
      if (mode === 'palettized' && depth > 8)
        throw new ImageDecodeError('png', 'Unsupported color type for palattized image')
      if (mode !== undefined && (width >= 65536 || height >= 65536))
        throw new ImageDecodeError('png', 'Too large image')
      if (!width || !height || width > 4096 || height > 4096)
        throw new Error('PNG dimensions must be between 1 and 4096')
      if (mode === 'palettized' && color !== 0 && color !== 3)
        // The historical libpng caller does not reject this branch before
        // writing RGB(A) rows to an 8-bit destination. Do not invent a native
        // error or reproduce that unsafe write; retain an explicit Web gap.
        throw new Error('Palettized PNG decoding requires a palette or grayscale source')
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
        const vpag = type.toLowerCase() === 'vpag',
          prefix = type === 'oFFs' ? 'offs' : type === 'pHYs' ? 'reso' : 'vpag'
        if (mode !== undefined) {
          // libpng's known handlers warn and ignore invalid/duplicate/tail
          // oFFs/pHYs. The custom vpAg callback accepts >=9 bytes and runs
          // before CRC checking, so an ancillary CRC warning keeps its data.
          if (vpag ? length < 9 :
            dataStarted || length !== 9 || !validCrc || metadata.has(prefix + '_x')) {
            yield
            continue
          }
        } else if (length !== 9) throw new Error('Invalid PNG position metadata')
        const values = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength),
          unit = chunk[8]!
        metadata.set(
          prefix + (prefix === 'vpag' ? '_w' : '_x'),
          String(type === 'oFFs' || mode !== undefined ? values.getInt32(0) : values.getUint32(0)),
        )
        metadata.set(
          prefix + (prefix === 'vpag' ? '_h' : '_y'),
          String(type === 'oFFs' || mode !== undefined ? values.getInt32(4) : values.getUint32(4)),
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
    } catch (error) {
      // png_read_end runs after noninterlaced row notifications, but before
      // interlaced rows are copied. Retain the actual error object, not a new
      // diagnosis; IDAT/inflate failure timing remains a separate boundary.
      if (!progress || !afterData) throw error
      tailFailed = true; tailError = error
      break
    }
    yield
  }
  if (!header) throw new Error('Truncated or extra PNG data')
  if (!ended || at !== bytes.length || !total) {
    if (!progress || !dataStarted || !total) throw new Error('Truncated or extra PNG data')
    if (!tailFailed) { tailFailed = true; tailError = new Error('Truncated or extra PNG data') }
  }
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
      return (function* (): Generator<void, DecodedImage> {
        const image = yield* pixels(h, expanded, palette, transparent, metadata, mode, progress)
        if (tailFailed) throw tailError
        if (progress && h.interlace) for (let y = 0; y < h.height; y++) {
          progress.row(y, image.data.subarray(y * h.width * 4, (y + 1) * h.width * 4),
            image.indices?.subarray(y * h.width, (y + 1) * h.width))
          yield
        }
        return image
      })()
    },
  }
}
/** PNG filtering/Adam7 remain portable; the host supplies bounded zlib inflation. */
export function decodePng(bytes: Uint8Array): Generator<void, PngPlan> | undefined {
  if (bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) return undefined
  if (magic.some((byte, index) => bytes[index] !== byte)) throw new Error('Invalid PNG signature')
  return parse(bytes)
}

/** No sniff/fallthrough: libpng reads all eight signature bytes first. */
export function decodeSelectedPng(
  bytes: Uint8Array,
  mode: ImageDecodeSelection['mode'],
  progress?: ImageDecodeProgress,
): Generator<void, PngPlan> {
  if (bytes.length < 8) throw new ImageReadError('png', 0, 8, bytes.length, 'Truncated PNG signature')
  if (magic.some((byte, index) => bytes[index] !== byte)) {
    const firstFourMatch = magic.slice(0, 4).every((byte, index) => bytes[index] === byte)
    throw new ImageDecodeError('png', firstFourMatch
      ? 'PNG file corrupted by ASCII conversion' : 'Not a PNG file')
  }
  return parse(bytes, mode, progress)
}

/** Stops at the first IDAT header. No compressed payload or IDAT CRC is read
 * until the caller has acquired its owned pull inflater. */
export function prepareSelectedPngStream(bytes: Uint8Array, mode: ImageDecodeSelection['mode'],
  progress?: ImageDecodeProgress): Generator<void, PngStreamPlan> {
  if (bytes.length < 8) throw new PngStreamReadError(0, 8, bytes.length)
  if (bytes.length > 64 * 1024 * 1024) throw new Error('PNG source exceeds 64 MiB budget')
  if (magic.some((value, index) => bytes[index] !== value)) {
    const firstFour = magic.slice(0, 4).every((value, index) => bytes[index] === value)
    throw new ImageDecodeError('png', firstFour ? 'PNG file corrupted by ASCII conversion' : 'Not a PNG file')
  }
  return parse(bytes, mode, progress, true)
}
