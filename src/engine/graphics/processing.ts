import type { Pixels, Rect } from '../ports/graphics.ts'

/** TVP scalar conversions preserve alpha. Additive RGB in excess of coverage
 * cannot be represented after conversion back to straight alpha. */
export function convertAlpha(image: Pixels, additive: boolean): void {
  const data = image.data
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3]!
    for (let c = 0; c < 3; c++)
      data[at + c] = additive
        ? (data[at + c]! * alpha) >> 8
        : alpha
          ? Math.min(255, Math.floor((data[at + c]! * 255) / alpha))
          : 0
  }
}

export function grayscale(image: Pixels, clip: Rect): void {
  const data = image.data
  for (let y = clip.y; y < clip.y + clip.height; y++)
    for (let x = clip.x; x < clip.x + clip.width; x++) {
      const at = (y * image.width + x) * 4
      const gray = (data[at]! * 54 + data[at + 1]! * 183 + data[at + 2]! * 19) >> 8
      data[at] = data[at + 1] = data[at + 2] = gray
    }
}

/** Sliding sums implement the original TVP CPU box filter in linear image
 * time, regardless of radius. clip controls writes; the surrounding bitmap
 * supplies samples, with smaller neighborhoods at the bitmap edges. */
export function* boxBlur(
  source: Pixels,
  clip: Rect,
  horizontal: number,
  vertical: number,
  alpha: boolean,
): Generator<void, Pixels | undefined> {
  if (![horizontal, vertical].every(Number.isSafeInteger))
    throw new Error('Invalid box blur radius')
  const rx = Math.abs(horizontal),
    ry = Math.abs(vertical),
    nominalArea = (rx * 2 + 1) * (ry * 2 + 1)
  if (!clip.width || !clip.height || (!rx && !ry)) return undefined
  if (nominalArea >= 1 << 24)
    throw new Error('Box blur area must contain fewer than 16 million pixels')
  const { width, height, data } = source
  const firstColumn = Math.max(0, clip.x - rx),
    lastColumn = Math.min(width - 1, clip.x + clip.width - 1 + rx)
  const columns = new Uint32Array((lastColumn - firstColumn + 1) * 4),
    sum = new Float64Array(4)
  const output: Pixels = {
    width: clip.width,
    height: clip.height,
    data: new Uint8Array(clip.width * clip.height * 4),
  }
  let work = 0
  const update = (x: number, y: number, sign: number) => {
    const at = (y * width + x) * 4,
      to = (x - firstColumn) * 4,
      a = data[at + 3]!,
      factor = a + (a >> 7)
    for (let c = 0; c < 3; c++)
      columns[to + c] =
        columns[to + c]! + sign * (alpha ? (data[at + c]! * factor) >> 8 : data[at + c]!)
    columns[to + 3] = columns[to + 3]! + sign * a
  }
  let rowCount = Math.min(height - 1, clip.y + ry) - Math.max(0, clip.y - ry) + 1
  for (let y = Math.max(0, clip.y - ry); y <= Math.min(height - 1, clip.y + ry); y++)
    for (let x = firstColumn; x <= lastColumn; x++) {
      update(x, y, 1)
      if (++work === 4096) {
        work = 0
        yield
      }
    }
  for (let y = clip.y; y < clip.y + clip.height; y++) {
    sum.fill(0)
    const start = Math.max(0, clip.x - rx),
      end = Math.min(width - 1, clip.x + rx)
    let columnCount = end - start + 1
    for (let x = start; x <= end; x++) {
      for (let c = 0; c < 4; c++) sum[c] = sum[c]! + columns[(x - firstColumn) * 4 + c]!
      if (++work === 4096) {
        work = 0
        yield
      }
    }
    for (let x = clip.x; x < clip.x + clip.width; x++) {
      const count = columnCount * rowCount,
        half = Math.floor(count / 2),
        reciprocal = Math.floor(65536 / count),
        average = (value: number) =>
          nominalArea < 256
            ? Math.floor(((value + half) * reciprocal) / 65536)
            : Math.floor((value + half) / count),
        a = average(sum[3]!),
        at = ((y - clip.y) * clip.width + x - clip.x) * 4
      output.data[at + 3] = a
      for (let c = 0; c < 3; c++) {
        const color = average(sum[c]!)
        output.data[at + c] = alpha ? (a ? Math.min(255, Math.floor((color * 255) / a)) : 0) : color
      }
      if (x + 1 < clip.x + clip.width && x - rx >= 0) {
        for (let c = 0; c < 4; c++) sum[c] = sum[c]! - columns[(x - rx - firstColumn) * 4 + c]!
        columnCount--
      }
      if (x + 1 < clip.x + clip.width && x + rx + 1 < width) {
        for (let c = 0; c < 4; c++) sum[c] = sum[c]! + columns[(x + rx + 1 - firstColumn) * 4 + c]!
        columnCount++
      }
      if (++work === 4096) {
        work = 0
        yield
      }
    }
    if (y - ry >= 0) {
      for (let x = firstColumn; x <= lastColumn; x++) {
        update(x, y - ry, -1)
        if (++work === 4096) {
          work = 0
          yield
        }
      }
      rowCount--
    }
    if (y + ry + 1 < height) {
      for (let x = firstColumn; x <= lastColumn; x++) {
        update(x, y + ry + 1, 1)
        if (++work === 4096) {
          work = 0
          yield
        }
      }
      rowCount++
    }
  }
  return output
}
