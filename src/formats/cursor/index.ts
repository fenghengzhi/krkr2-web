import type { Pixels } from '../../engine/ports/graphics.ts'

/** Keep the two raster operations. A transparent RGBA conversion cannot
 * represent (destination AND 1) XOR 1, or a color XOR on the destination. */
export interface CursorImage extends Pixels {
  hotspot: { x: number; y: number }
  depth: number
  encoding: 'dib' | 'png'
  mode: 'alpha' | 'and-xor'
  /** One byte per pixel, either 0 or 255; retained even for alpha images. */
  andMask: Uint8Array
}
export interface CursorFrame { images: CursorImage[] }
export interface CursorAsset {
  kind: 'cur' | 'ani'
  frames: CursorFrame[]
  /** Indices into frames; durations are per step, not per distinct frame.
   * Native zero rates are preserved but require a calibrated playback policy. */
  sequence: number[]
  rates: number[]
  durationJiffies: number
  sourceBytes: number
  decodedBytes: number
  imageCount: number
  animation?: { width: number; height: number; depth: number; planes: number; flags: number }
}
export interface CursorLimits {
  sourceBytes: number
  frames: number
  imagesPerFrame: number
  images: number
  pixels: number
  steps: number
  durationJiffies: number
}
export const cursorLimits: Readonly<CursorLimits> = Object.freeze({
  sourceBytes: 32 * 1024 * 1024,
  frames: 256,
  imagesPerFrame: 64,
  images: 1024,
  pixels: 4 * 1024 * 1024,
  steps: 4096,
  durationJiffies: 60 * 60 * 60,
})
export interface CursorDecodeOptions {
  /** The host supplies the existing bounded PNG decoder. Only PNG payloads
   * with matching, preflighted cursor dimensions reach this function. */
  png(bytes: Uint8Array): Promise<Pixels>
  checkpoint?(): void | Promise<void>
  /** Callers can reduce, but cannot increase, the format's resource budgets. */
  limits?: Partial<CursorLimits>
}
interface Budget { pixels: number; images: number; limits: Readonly<CursorLimits> }
function fail(message: string): never { throw new Error(`Cursor: ${message}`) }
function view(bytes: Uint8Array) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
function tag(bytes: Uint8Array, offset: number) {
  return String.fromCharCode(...bytes.subarray(offset, offset + 4))
}
function range(bytes: Uint8Array, offset: number, length: number): Uint8Array {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 ||
      offset > bytes.length || length > bytes.length - offset) fail('truncated resource')
  return bytes.subarray(offset, offset + length)
}
function dimensions(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
      width > 256 || height > 256) fail('image dimensions must be between 1 and 256')
}
function charge(budget: Budget, width: number, height: number) {
  dimensions(width, height)
  if (++budget.images > budget.limits.images ||
      width * height > budget.limits.pixels - budget.pixels) fail('decoded image budget exceeded')
  budget.pixels += width * height
}
function channel(mask: number, depth: number): { mask: number; shift: number; maximum: number } {
  mask >>>= 0
  if (!mask) return { mask: 0, shift: 0, maximum: 0 }
  if (depth === 16 && mask > 0xffff) fail('bit field exceeds pixel depth')
  let shift = 0, bits = mask
  while (!(bits & 1)) { shift++; bits >>>= 1 }
  if ((bits & (bits + 1)) !== 0) fail('noncontiguous color bit field')
  return { mask, shift, maximum: bits }
}
function component(pixel: number, field: ReturnType<typeof channel>) {
  if (!field.maximum) return 0
  const value = (pixel & field.mask) >>> field.shift
  // LoadCursorFromFile/DrawIconEx on the fixed Windows 2022/2025 matrix
  // expands RGB555/565 by repeating high bits, not by rounding a ratio.
  if (field.maximum === 31) return (value << 3) | (value >>> 2)
  if (field.maximum === 63) return (value << 2) | (value >>> 4)
  return Math.round(value * 255 / field.maximum)
}

async function dib(bytes: Uint8Array, width: number, height: number, options: CursorDecodeOptions) {
  range(bytes, 0, 12)
  const h = view(bytes), size = h.getUint32(0, true), core = size === 12
  if (![12, 40, 52, 56, 108, 124].includes(size)) fail('unsupported DIB header')
  range(bytes, 0, size)
  const w = core ? h.getUint16(4, true) : h.getInt32(4, true),
    doubled = core ? h.getUint16(6, true) : h.getInt32(8, true),
    planes = h.getUint16(core ? 8 : 12, true), depth = h.getUint16(core ? 10 : 14, true),
    compression = core ? 0 : h.getUint32(16, true)
  if (w !== width || Math.abs(doubled) !== height * 2 || planes !== 1)
    fail('DIB dimensions or planes differ from directory')
  if (![1, 4, 8, 16, 24, 32].includes(depth) ||
      (core && ![1, 4, 8, 24].includes(depth)) ||
      ![0, 3, 6].includes(compression) || (compression !== 0 && depth !== 16 && depth !== 32))
    fail('unsupported DIB pixel format')
  // Embedded color profiles need a separate color-management contract; never
  // interpret profile bytes as pixels or silently claim their colors match.
  if (size === 124 && (h.getUint32(112, true) || h.getUint32(116, true)))
    fail('embedded DIB color profiles are not supported')
  let offset = size, masks = depth === 16 ? [0x7c00, 0x03e0, 0x001f, 0] : [0xff0000, 0xff00, 0xff, depth === 32 ? 0xff000000 : 0]
  if (compression !== 0) {
    const count = compression === 6 ? 4 : 3,
      at = size === 40 ? size : 40
    if (size !== 40 && size < 40 + count * 4) fail('missing embedded DIB bit fields')
    range(bytes, at, count * 4)
    masks = [h.getUint32(at, true), h.getUint32(at + 4, true), h.getUint32(at + 8, true),
      count === 4 || size >= 56 ? h.getUint32(at + 12, true) : 0]
    if (size === 40) offset += count * 4
    if (masks.slice(0, 3).some((mask) => !mask)) fail('empty RGB bit field')
    for (let i = 0; i < masks.length; i++)
      for (let j = 0; j < i; j++) if ((masks[i]! & masks[j]!) !== 0) fail('overlapping color bit fields')
  }
  const fields = masks.map((mask) => channel(mask, depth)),
    used = core ? 0 : h.getUint32(32, true),
    colors = depth <= 8 ? used || 2 ** depth : used,
    paletteStride = core ? 3 : 4
  if (colors > (depth <= 8 ? 2 ** depth : 256)) fail('DIB palette exceeds pixel format')
  const palette = range(bytes, offset, colors * paletteStride)
  offset += palette.length
  const stride = Math.ceil(width * depth / 32) * 4,
    maskStride = Math.ceil(width / 32) * 4,
    xor = range(bytes, offset, stride * height)
  offset += xor.length
  const maskLength = maskStride * height,
    hasMask = bytes.length - offset >= maskLength,
    mask = hasMask ? range(bytes, offset, maskLength) : undefined,
    data = new Uint8Array(width * height * 4), andMask = new Uint8Array(width * height),
    xview = view(xor)
  let alpha = false
  for (let y = 0; y < height; y++) {
    const row = doubled > 0 ? height - 1 - y : y
    for (let x = 0; x < width; x++) {
      const pixel = y * width + x, to = pixel * 4, from = row * stride + Math.floor(x * depth / 8)
      if (depth <= 8) {
        const index = (xor[from]! >>> (8 - depth - (x * depth & 7))) & (2 ** depth - 1)
        if (index >= colors) fail('palette index outside table')
        const p = index * paletteStride
        data[to] = palette[p + 2]!
        data[to + 1] = palette[p + 1]!
        data[to + 2] = palette[p]!
        data[to + 3] = 255
      } else if (depth === 24) {
        data[to] = xor[from + 2]!
        data[to + 1] = xor[from + 1]!
        data[to + 2] = xor[from]!
        data[to + 3] = 255
      } else {
        const value = depth === 16 ? xview.getUint16(from, true) : xview.getUint32(from, true)
        for (let c = 0; c < 4; c++) data[to + c] = component(value, fields[c]!)
        if (fields[3]!.mask && data[to + 3]) alpha = true
      }
      andMask[pixel] = mask && (mask[row * maskStride + (x >>> 3)]! & (0x80 >>> (x & 7))) ? 255 : 0
    }
    if ((y & 7) === 7) await options.checkpoint?.()
  }
  // Alpha-only 32-bit payloads occur in modern cursor resources. Truncated
  // partial masks are not the same thing as an entirely absent mask.
  if (!hasMask && !(depth === 32 && alpha && bytes.length === offset)) fail('truncated AND mask')
  if (hasMask && bytes.length !== offset + maskLength) fail('extra DIB pixel data')
  if (!alpha) for (let at = 3; at < data.length; at += 4) data[at] = 255
  return { width, height, data, andMask, depth, encoding: 'dib' as const,
    mode: alpha ? 'alpha' as const : 'and-xor' as const }
}

async function frame(bytes: Uint8Array, budget: Budget, options: CursorDecodeOptions, embedded: boolean): Promise<CursorFrame> {
  range(bytes, 0, 6)
  const h = view(bytes), type = h.getUint16(2, true), count = h.getUint16(4, true)
  if (h.getUint16(0, true) || (type !== 2 && !(embedded && type === 1))) fail('invalid CUR directory')
  if (!count || count > budget.limits.imagesPerFrame) fail('image directory budget exceeded')
  range(bytes, 6, count * 16)
  const images: CursorImage[] = []
  for (let i = 0; i < count; i++) {
    await options.checkpoint?.()
    const at = 6 + i * 16, width = bytes[at] || 256, height = bytes[at + 1] || 256,
      length = h.getUint32(at + 8, true), offset = h.getUint32(at + 12, true)
    if (bytes[at + 3] || offset < 6 + count * 16 || !length) fail('invalid image directory entry')
    const payload = range(bytes, offset, length),
      hotspot = type === 2
        ? { x: h.getUint16(at + 4, true), y: h.getUint16(at + 6, true) }
        : { x: width >>> 1, y: height >>> 1 }
    // CUR hotspots are unsigned 16-bit coordinates, not bounded by the image.
    // The hosted Win32 reference preserves an outside hotspot verbatim.
    charge(budget, width, height)
    if (payload[0] === 137 && tag(payload, 1) === 'PNG\r') {
      range(payload, 0, 33)
      const p = view(payload)
      if (tag(payload, 12) !== 'IHDR' || p.getUint32(16) !== width || p.getUint32(20) !== height)
        fail('PNG dimensions differ from directory')
      const decoded = await options.png(payload)
      await options.checkpoint?.()
      if (decoded.width !== width || decoded.height !== height || decoded.data.length !== width * height * 4)
        fail('PNG decoder returned inconsistent pixels')
      images.push({ width, height, data: new Uint8Array(decoded.data), andMask: new Uint8Array(width * height),
        depth: 32, encoding: 'png', mode: 'alpha', hotspot })
    } else images.push({ ...await dib(payload, width, height, options), hotspot })
  }
  return { images }
}

interface Chunk { name: string; bytes: Uint8Array }
function chunks(bytes: Uint8Array): Chunk[] {
  const result: Chunk[] = [], h = view(bytes)
  for (let at = 0; at < bytes.length;) {
    range(bytes, at, 8)
    const name = tag(bytes, at), length = h.getUint32(at + 4, true), body = range(bytes, at + 8, length)
    range(bytes, at + 8, length + (length & 1))
    result.push({ name, bytes: body })
    if (result.length > 8192) fail('RIFF chunk budget exceeded')
    at += 8 + length + (length & 1)
  }
  return result
}
async function animated(bytes: Uint8Array, budget: Budget, options: CursorDecodeOptions): Promise<Omit<CursorAsset, 'sourceBytes' | 'decodedBytes' | 'imageCount'>> {
  range(bytes, 0, 12)
  if (tag(bytes, 8) !== 'ACON' || view(bytes).getUint32(4, true) !== bytes.length - 8) fail('invalid ANI RIFF container')
  const top = chunks(bytes.subarray(12)), unique = (name: string) => {
    const matches = top.filter((chunk) => chunk.name === name)
    if (matches.length > 1) fail(`duplicate ANI ${name} chunk`)
    return matches[0]?.bytes
  }, header = unique('anih'), sequenceBytes = unique('seq '), rateBytes = unique('rate')
  if (!header || header.length !== 36) fail('missing or invalid ANI header')
  const h = view(header), count = h.getUint32(4, true), steps = h.getUint32(8, true),
    rate = h.getUint32(28, true), flags = h.getUint32(32, true)
  if (h.getUint32(0, true) !== 36 || !(flags & 1) || (flags & ~3)) fail('unsupported ANI frame representation')
  if (!count || count > budget.limits.frames || !steps || steps > budget.limits.steps) fail('ANI frame or step budget exceeded')
  if (sequenceBytes && sequenceBytes.length !== steps * 4) fail('ANI sequence length differs from step count')
  if (rateBytes && rateBytes.length !== steps * 4) fail('ANI rate length differs from step count')
  // AF_SEQUENCE alone does not require a seq chunk: the observed native
  // loader uses directory order when steps and frames have equal counts.
  if (!sequenceBytes && steps !== count) fail('ANI is missing its frame sequence')
  const sequence = Array.from({ length: steps }, (_, i) => sequenceBytes ? view(sequenceBytes).getUint32(i * 4, true) : i),
    rates = Array.from({ length: steps }, (_, i) => rateBytes ? view(rateBytes).getUint32(i * 4, true) : rate),
    durationJiffies = rates.reduce((sum, value) => sum + value, 0)
  if (sequence.some((index) => index >= count)) fail('ANI sequence references a missing frame')
  // Native frame metadata preserves zero rates and explicit indexed drawing
  // still works. Keep those bytes; wall-clock playback needs a separate policy.
  if (durationJiffies > budget.limits.durationJiffies) fail('ANI duration budget exceeded')
  const lists = top.filter((chunk) => chunk.name === 'LIST' && tag(chunk.bytes, 0) === 'fram')
  if (lists.length !== 1) fail('ANI must contain one frame list')
  const encoded = chunks(lists[0]!.bytes.subarray(4)).filter((chunk) => chunk.name === 'icon')
  if (encoded.length !== count) fail('ANI frame count differs from frame list')
  const frames: CursorFrame[] = []
  for (const encodedFrame of encoded) frames.push(await frame(encodedFrame.bytes, budget, options, true))
  return { kind: 'ani', frames, sequence, rates, durationJiffies,
    animation: { width: h.getUint32(12, true), height: h.getUint32(16, true),
      depth: h.getUint32(20, true), planes: h.getUint32(24, true), flags } }
}

/** Parse the complete asset before publishing it. The source is snapshotted
 * before any asynchronous decoder/checkpoint can let the caller mutate it. */
export async function decodeCursor(input: Uint8Array, options: CursorDecodeOptions): Promise<CursorAsset> {
  const limits = { ...cursorLimits, ...options.limits }
  for (const key of Object.keys(cursorLimits) as (keyof typeof cursorLimits)[])
    if (!Number.isSafeInteger(limits[key]) || limits[key] <= 0 || limits[key] > cursorLimits[key])
      fail('invalid decoder budget')
  if (!input.length || input.length > limits.sourceBytes) fail('source byte budget exceeded')
  const bytes = new Uint8Array(input), budget: Budget = { pixels: 0, images: 0, limits }
  await options.checkpoint?.()
  const asset = tag(bytes, 0) === 'RIFF'
    ? await animated(bytes, budget, options)
    : { kind: 'cur' as const, frames: [await frame(bytes, budget, options, false)],
      sequence: [0], rates: [1], durationJiffies: 1 }
  return { ...asset, sourceBytes: bytes.length, decodedBytes: budget.pixels * 5, imageCount: budget.images }
}

/** A clock value never drops or duplicates an ANI step; rates remain exact
 * integer sixtieths of a second until this final presentation calculation. */
export function cursorStep(asset: CursorAsset, elapsedMilliseconds: number): number {
  if (!Number.isFinite(elapsedMilliseconds) || elapsedMilliseconds < 0) fail('invalid animation time')
  if (asset.kind === 'cur') return 0
  if (asset.rates.some((rate) => rate === 0)) fail('ANI zero-rate playback timing is not calibrated')
  // Keep integer ratios. Modulo by a fractional millisecond cycle first can
  // put an exact 50 ms boundary below 1 jiffy for a two-jiffy animation.
  const period = asset.durationJiffies * 1000
  let time = ((elapsedMilliseconds % period) * 60) % period
  for (let step = 0; step < asset.rates.length; step++) {
    if (time < asset.rates[step]! * 1000) return step
    time -= asset.rates[step]! * 1000
  }
  return 0
}

/** Compose onto an opaque RGB destination, including arbitrary colored XOR.
 * The cursor's hotspot is applied by the caller when computing left/top. */
export function compositeCursor(image: CursorImage, destination: Pixels, left: number, top: number): void {
  dimensions(image.width, image.height)
  if (!Number.isInteger(left) || !Number.isInteger(top) ||
      !Number.isSafeInteger(destination.width) || !Number.isSafeInteger(destination.height) ||
      destination.width <= 0 || destination.height <= 0 ||
      image.data.length !== image.width * image.height * 4 || image.andMask.length !== image.width * image.height ||
      destination.data.length !== destination.width * destination.height * 4)
    fail('invalid cursor composition destination')
  for (let y = Math.max(0, -top); y < Math.min(image.height, destination.height - top); y++)
    for (let x = Math.max(0, -left); x < Math.min(image.width, destination.width - left); x++) {
      const pixel = y * image.width + x, from = pixel * 4, to = ((top + y) * destination.width + left + x) * 4,
        a = image.data[from + 3]!
      for (let c = 0; c < 3; c++) destination.data[to + c] = image.mode === 'and-xor'
        ? (destination.data[to + c]! & image.andMask[pixel]!) ^ image.data[from + c]!
        // Native loading quantizes the source's premultiplication first. A
        // single rounded source-over expression loses that byte boundary.
        // The destination term remains a candidate outside the observed
        // alpha/background matrix; the hosted reference gate compares exactly.
        : Math.floor(image.data[from + c]! * a / 255) + Math.round(destination.data[to + c]! * (255 - a) / 255)
      destination.data[to + 3] = 255
    }
}
