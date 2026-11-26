import type { Pixels, Rect } from '../ports/graphics.ts'

interface Tap { index: number; weight: number }
const f32 = Math.fround

// Resampler.cpp uses a triangle for stLinear and a quadratic bell for
// stCubic. Both are centered on destinationIndex / scale.
function weights(i: number, from: number, to: number, cubic: boolean, vertical: boolean): Tap[] {
  const scale = f32(to / from), shrink = to < from
  const center = shrink && vertical ? f32(i * f32(1 / scale)) : f32(i / scale)
  const radius = f32((cubic ? 1.5 : 1) / (shrink ? scale : 1))
  const first = Math.ceil(center - radius), last = Math.floor(center + radius)
  const taps: Tap[] = []
  let sum = 0
  for (let j = first; j <= last; j++) {
    const t = Math.abs(f32(f32(center - j) * (shrink ? scale : 1)))
    const weight = !cubic ? Math.max(0, 1 - t)
      : t < 0.5 ? 0.75 - t * t : t < 1.5 ? 0.5 * (t - 1.5) ** 2 : 0
    const index = j < 0 ? -j : j >= from ? 2 * from - j - 1 : j
    taps.push({ index: Math.max(0, Math.min(from - 1, index)), weight: f32(weight) })
    sum = f32(sum + f32(weight))
  }
  if (shrink) {
    const reciprocal = f32(1 / sum)
    for (const tap of taps) tap.weight = f32(tap.weight * reciprocal)
  }
  return taps
}

function channel(sum: number, first: number, changes: number, shift: number): number {
  return ((changes >>> shift) & 255) ? Math.min(255, Math.max(0, Math.round(sum))) : (first >>> shift) & 255
}

function sample(taps: Tap[], pixel: (index: number) => number): number {
  const first = pixel(taps[0]!.index)
  let r = 0, g = 0, b = 0, a = 0, changes = 0
  for (let i = taps.length - 1; i >= 0; i--) {
    const tap = taps[i]!, value = pixel(tap.index)
    changes |= value ^ first
    r = f32(r + (value & 255) * tap.weight)
    g = f32(g + ((value >>> 8) & 255) * tap.weight)
    b = f32(b + ((value >>> 16) & 255) * tap.weight)
    a = f32(a + (value >>> 24) * tap.weight)
  }
  return channel(r, first, changes, 0) | (channel(g, first, changes, 8) << 8) |
    (channel(b, first, changes, 16) << 16) | (channel(a, first, changes, 24) << 24)
}

/** Stock StretchBlt dispatches an unclipped, forward bmCopy at full opacity
 * to a separable, byte-intermediate filter. Other operations retain their
 * own clipping, blend, hold-alpha and extended kernel behavior. */
export function filteredCopy(source: Pixels, rect: Rect, dest: Rect, clip: Rect,
  mode: number, coefficient: number, inPlace: boolean): Generator<void, Pixels> | undefined {
  const type = mode & 0xffff
  if ((type !== 2 && type !== 3) || (mode & ~0x1ffff) || (type === 3 && coefficient !== -1) ||
      dest.width <= 0 || dest.height <= 0 || rect.width <= 0 || rect.height <= 0 ||
      (dest.width === rect.width && dest.height === rect.height) ||
      dest.x < clip.x || dest.y < clip.y || dest.x + dest.width > clip.x + clip.width ||
      dest.y + dest.height > clip.y + clip.height || rect.x < 0 || rect.y < 0 ||
      rect.x + rect.width > source.width || rect.y + rect.height > source.height) return
  return resample(source, rect, dest, type === 3, inPlace)
}

function* resample(source: Pixels, rect: Rect, dest: Rect, cubic: boolean, inPlace: boolean): Generator<void, Pixels> {
  const result = { width: dest.width, height: dest.height, data: new Uint8Array(dest.width * dest.height * 4) }
  const input = new DataView(source.data.buffer, source.data.byteOffset, source.data.byteLength)
  const output = new DataView(result.data.buffer), column = new Uint32Array(rect.height)
  const vertical = Array.from({ length: dest.height }, (_, i) => weights(i, rect.height, dest.height, cubic, true))
  const readColumn = (index: number) => column[index]!
  let work = 0
  for (let x = 0; x < dest.width; x++) {
    const horizontal = weights(x, rect.width, dest.width, cubic, false)
    let sourceY = rect.y
    const readRow = (index: number) => {
      const sourceX = rect.x + index
      // When the same bitmap is both arguments, previously written columns
      // are visible to later columns. Keep the live Layer atomic until commit.
      if (inPlace && sourceX >= dest.x && sourceX < dest.x + x && sourceY >= dest.y && sourceY < dest.y + dest.height)
        return output.getUint32(((sourceY - dest.y) * dest.width + sourceX - dest.x) * 4, true)
      return input.getUint32((sourceY * source.width + sourceX) * 4, true)
    }
    for (let y = 0; y < rect.height; y++, sourceY++) {
      column[y] = sample(horizontal, readRow)
      work += horizontal.length
      if (work >= 4096) { work = 0; yield }
    }
    for (let y = 0; y < dest.height; y++) {
      const taps = vertical[y]!
      output.setUint32((y * dest.width + x) * 4, sample(taps, readColumn), true)
      work += taps.length
      if (work >= 4096) { work = 0; yield }
    }
  }
  return result
}
