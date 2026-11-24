/* Lossless ERINA frame 1/4 reconstruction, derived from ERINA-Library 1.0A
 * Copyright (C) 2000-2002 Leshade Entis, Entis-soft. See the attribution and
 * distribution terms in docs/decisions/119-eri-png-and-hosted-codecs.md.
 * This module does not implement arithmetic, Huffman or lossy image coding. */
import { ImageDecodeError } from './selection.ts'

export interface EriBitSource {
  next(): number
  take(count: number): number
  gamma(): number
}
export interface EriTruecolorShape {
  width: number
  height: number
  channels: 1 | 3 | 4
  degree: number
  enhanced: boolean
  continuous: boolean
}

function failed(): never {
  throw new ImageDecodeError('eri', 'ERIDecoder::DecodeImage failed.')
}

/** A run may span calls/blocks. Its zero/nonzero kind flips only when the
 * declared run has been consumed; an independent block resets both fields. */
class GammaRuns {
  private remaining = 0
  private nonzero = false
  constructor(private readonly bits: EriBitSource) {}
  initialize(): void {
    const flag = this.bits.next()
    if (flag < 0) failed()
    this.nonzero = flag !== 0
    this.remaining = 0
  }
  *read(output: Int32Array): Generator<void> {
    let at = 0, sinceYield = 0
    while (at < output.length) {
      if (!this.remaining) {
        this.remaining = this.bits.gamma()
        if (this.remaining < 1) failed()
      }
      const count = Math.min(this.remaining, output.length - at, 4096 - sinceYield), end = at + count
      if (this.nonzero) {
        for (; at < end; at++) {
          const sign = this.bits.next(), magnitude = this.bits.gamma()
          if (sign < 0 || magnitude < 1) failed()
          output[at] = sign ? -magnitude : magnitude
        }
      } else {
        output.fill(0, at, end)
        at = end
      }
      this.remaining -= count
      if (!this.remaining) this.nonzero = !this.nonzero
      // Accumulate across short runs: yielding per run would turn a normal
      // noisy image into hundreds of thousands of host scheduler calls.
      // A smaller complete block reaches the caller's existing block yield.
      sinceYield += count
      if (sinceYield === 4096) { sinceYield = 0; yield }
    }
  }
}

/** Original InitializeArrangeTable: parity-separated row, column, diagonal,
 * and reverse diagonal scans. Each channel uses the same spatial map. */
function* arrangements(size: number): Generator<void, readonly Uint32Array[]> {
  const area = size * size, maps = Array.from({ length: 4 }, () => new Uint32Array(area))
  let at = 0
  for (let parity = 0; parity < 2; parity++) for (let line = parity; line < size; line += 2)
    for (let pixel = 0; pixel < size; pixel++) {
      maps[0]![at] = line * size + pixel
      maps[1]![at] = pixel * size + line
      if ((++at & 4095) === 0) yield
    }
  at = 0
  for (let parity = 0; parity < 2; parity++) for (let diagonal = parity; diagonal <= 2 * size - 2; diagonal += 2)
    for (let x = Math.min(diagonal, size - 1); x >= 0 && diagonal - x < size; x--) {
      const y = diagonal - x
      maps[2]![at] = y * size + x
      maps[3]![at] = (size - x - 1) * size + y
      if ((++at & 4095) === 0) yield
    }
  return maps
}

const enhancedColors = [0, 5, 6, 7, 9, 10, 11, 13, 14, 15] as const

/** Decode into a private byte image in entropy row order. RGB(A) channels
 * remain physical B,G,R,A until the caller applies KRKR's final conversion.
 * Padded edge samples still participate in the original predictor state. */
export function* decodeEriGammaTruecolor(bits: EriBitSource, shape: EriTruecolorShape): Generator<void, Uint8Array> {
  const { width, height, channels, degree, enhanced, continuous } = shape
  if (!Number.isInteger(degree) || degree < 1 || degree > 8)
    throw new Error('ERI truecolor block degree exceeds the safe Web range')
  const size = 2 ** degree, area = size * size, samples = area * channels,
    across = Math.ceil(width / size), down = Math.ceil(height / size), blocks = across * down,
    pixelBytes = width * height * 4,
    workBytes = pixelBytes + samples * 8 + (enhanced && channels >= 3 ? area * 16 : 0)
      + (across + 1) * size * channels * 4 + (continuous && channels >= 3 ? blocks : 0)
  if (!Number.isSafeInteger(workBytes) || workBytes > 96 * 1024 * 1024)
    throw new Error('ERI truecolor exceeds the 96 MiB owned work budget')
  const image = new Uint8Array(pixelBytes), encoded = new Int32Array(samples), block = new Int32Array(samples),
    columns = new Int32Array(size * channels), previousLine = new Int32Array(across * size * channels),
    maps = enhanced && channels >= 3 ? yield* arrangements(size) : [],
    operationBits = enhanced ? 6 : 4,
    operations = continuous && channels >= 3 ? new Uint8Array(blocks) : undefined,
    runs = new GammaRuns(bits)
  if (operations) for (let i = 0; i < operations.length; i++) {
    operations[i] = bits.take(operationBits)
    if ((i & 4095) === 4095) yield
  }
  // This delimiter precedes either the shared run context or the first block.
  if (bits.next() !== 0) failed()
  if (continuous) runs.initialize()
  for (let by = 0; by < down; by++) {
    columns.fill(0)
    for (let bx = 0; bx < across; bx++) {
      const operation = channels < 3 ? 0 : operations ? operations[by * across + bx]! : bits.take(operationBits)
      if (!continuous) runs.initialize()
      yield* runs.read(encoded)
      // The original 64-entry static table defines 50 initializers; the last
      // 14 entries are zero-initialized rather than invalid opcodes.
      const color = enhanced && channels >= 3 ? operation < 50 ? enhancedColors[operation % 10]! : 0 : operation,
        arrange = enhanced && channels >= 3 && operation < 50 ? Math.floor(operation / 10) : 0,
        map = arrange ? maps[arrange - 1]! : undefined
      for (let channel = 0; channel < channels; channel++) {
        const base = channel * area
        for (let i = 0; i < area; i++) {
          block[base + (map ? map[i]! : i)] = encoded[base + i]!
          if ((i & 4095) === 4095) yield
        }
      }
      if (channels >= 3 && color && ![1, 2, 3, 4, 8, 12].includes(color)) {
        // ColorOperation 5/6/7 adds B to G/R; 9/10/11 adds G to B/R;
        // 13/14/15 adds R to B/G. The alpha plane is never color transformed.
        const source = (color >>> 2) - 1, target = color & 3,
          first = source === 0 ? 1 : 0, second = source === 2 ? 1 : 2
        for (let i = 0; i < area; i++) {
          const value = block[source * area + i]!
          if (target & 1) block[first * area + i] = (block[first * area + i]! + value) | 0
          if (target & 2) block[second * area + i] = (block[second * area + i]! + value) | 0
          if ((i & 4095) === 4095) yield
        }
      }
      // Horizontal integration carries the last value of each block row to
      // the next block in x. This state is saved before vertical integration.
      for (let line = 0; line < size * channels; line++) {
        const start = line * size
        let last = columns[line]!
        for (let x = 0; x < size; x++) {
          last = (last + block[start + x]!) | 0
          block[start + x] = last
        }
        columns[line] = last
        if (((start + size) & 4095) === 0) yield
      }
      // Vertical state is separate for each x block/channel. Keep all padded
      // bottom/right samples exactly as the original, even outside the crop.
      for (let channel = 0; channel < channels; channel++) {
        const base = channel * area, saved = (bx * channels + channel) * size
        for (let y = 0; y < size; y++) {
          const row = base + y * size
          for (let x = 0; x < size; x++)
            block[row + x] = (block[row + x]! + (y ? block[row - size + x]! : previousLine[saved + x]!)) | 0
          if ((((y + 1) * size) & 4095) === 0) yield
        }
        previousLine.set(block.subarray(base + area - size, base + area), saved)
      }
      const croppedWidth = Math.min(size, width - bx * size), croppedHeight = Math.min(size, height - by * size)
      for (let y = 0; y < croppedHeight; y++) {
        for (let x = 0; x < croppedWidth; x++) {
          const from = y * size + x, to = ((by * size + y) * width + bx * size + x) * 4
          image[to] = block[from]!
          image[to + 1] = channels === 1 ? block[from]! : block[area + from]!
          image[to + 2] = channels === 1 ? block[from]! : block[area * 2 + from]!
          image[to + 3] = channels === 4 ? block[area * 3 + from]! : 255
        }
        if (((y + 1) * croppedWidth & 4095) === 0) yield
      }
      yield
    }
  }
  return image
}
