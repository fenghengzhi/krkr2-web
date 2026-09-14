import type { Pixels, Rect } from '../ports/graphics.ts'
import { filter } from './filters.ts'

export type AffineParameters = readonly [number, number, number, number, number, number]
export interface AffineRaster {
  pixels: Pixels
  left: number
  top: number
  /** Two local x coordinates per row: inclusive start, exclusive end. Pixels
   * outside that span are not part of the transformed image, even if alpha=0. */
  spans: Int32Array
}
type Point = { x: number; y: number }
type Weight = { index: number; weight: number }
const empty = (): AffineRaster => ({
  pixels: { width: 0, height: 0, data: new Uint8Array() },
  left: 0,
  top: 0,
  spans: new Int32Array(),
})
const nearInteger = (value: number) =>
  Math.abs(value - Math.round(value)) < 1e-10 ? Math.round(value) : value
const byte = (value: number) => Math.max(0, Math.min(255, Math.round(value)))

function weights(
  center: number,
  scale: number,
  low: number,
  high: number,
  kernel: ReturnType<typeof filter>,
): Weight[] {
  // Edge extension combines repeated samples. The finite source extent bounds
  // the footprint of extreme minification without allocating unbounded taps.
  scale = Math.max(1, Math.min(high - low + 1, scale))
  const radius = kernel.radius * scale,
    entries = new Map<number, number>()
  let sum = 0
  for (let index = Math.ceil(center - radius); index <= Math.floor(center + radius); index++) {
    const weight = kernel.weight((center - index) / scale)
    if (Math.abs(weight) < 1e-15) continue
    const clamped = Math.max(low, Math.min(high, index))
    entries.set(clamped, (entries.get(clamped) ?? 0) + weight)
    sum += weight
  }
  if (Math.abs(sum) < 1e-12)
    return [{ index: Math.max(low, Math.min(high, Math.floor(center + 0.5))), weight: 1 }]
  return [...entries].map(([index, weight]) => ({ index, weight: weight / sum }))
}

function clipPolygon(points: Point[], axis: 'x' | 'y', edge: number, greater: boolean): Point[] {
  const output: Point[] = []
  if (!points.length) return output
  let previous = points[points.length - 1]!,
    previousInside = greater ? previous[axis] >= edge : previous[axis] <= edge
  for (const point of points) {
    const inside = greater ? point[axis] >= edge : point[axis] <= edge
    if (inside !== previousInside) {
      const ratio = (edge - previous[axis]) / (point[axis] - previous[axis])
      output.push({
        x: previous.x + (point.x - previous.x) * ratio,
        y: previous.y + (point.y - previous.y) * ratio,
      })
    }
    if (inside) output.push(point)
    previous = point
    previousInside = inside
  }
  return output
}
function polygonArea(points: Point[]): number {
  if (points.length < 3) return 0
  // Translate before products to avoid subtracting two large absolute areas.
  const origin = points[0]!
  let sum = 0
  for (let i = 1; i + 1 < points.length; i++) {
    const a = points[i]!,
      b = points[i + 1]!
    sum += (a.x - origin.x) * (b.y - origin.y) - (a.y - origin.y) * (b.x - origin.x)
  }
  return Math.abs(sum / 2)
}

/** Rasterize into temporary storage before touching the destination. Yield
 * bounded batches so the host can pause/cancel expensive filtering. The pixel
 * at integer (x,y) has edges x±0.5,y±0.5; matrices address a local source rect. */
export function* affinePixels(
  source: Pixels,
  rect: Rect,
  matrix: boolean,
  parameters: AffineParameters,
  clip: Rect,
  mode = 0,
): Generator<void, AffineRaster | undefined> {
  if (
    !Object.values(rect).every(Number.isSafeInteger) ||
    !Object.values(clip).every(Number.isSafeInteger) ||
    !parameters.every(Number.isFinite)
  )
    throw new Error('Invalid affine coordinates')
  const type = mode & 0xffff
  if (!Number.isSafeInteger(mode) || mode < 0 || mode & ~0x1ffff || type > 19)
    throw new Error('Unknown affine filter')
  if (rect.width <= 0 || rect.height <= 0) return undefined
  if (
    rect.x < 0 ||
    rect.y < 0 ||
    rect.x + rect.width > source.width ||
    rect.y + rect.height > source.height
  )
    throw new Error('Affine source rectangle is outside the image')
  if (
    source.width > 4096 ||
    source.height > 4096 ||
    clip.width > 4096 ||
    clip.height > 4096 ||
    clip.width < 0 ||
    clip.height < 0
  )
    throw new Error('Affine bitmap dimensions exceed the 4096 pixel limit')
  let [a, b, c, d, tx, ty] = parameters
  if (!matrix) {
    const [x0, y0, x1, y1, x2, y2] = parameters
    a = (x1 - x0) / rect.width
    b = (y1 - y0) / rect.width
    c = (x2 - x0) / rect.height
    d = (y2 - y0) / rect.height
    tx = x0 + (a + c) / 2
    ty = y0 + (b + d) / 2
  }
  const determinant = a * d - b * c
  if (![a, b, c, d, tx, ty, determinant].every(Number.isFinite))
    throw new Error('Affine transform exceeds numeric range')
  if (!determinant || !clip.width || !clip.height) return empty()
  const inverse = [d / determinant, -b / determinant, -c / determinant, a / determinant] as const
  if (!inverse.every(Number.isFinite)) throw new Error('Affine inverse exceeds numeric range')
  const transform = (x: number, y: number): Point => ({
    x: a * x + c * y + tx,
    y: b * x + d * y + ty,
  })
  const corners = [
    transform(-0.5, -0.5),
    transform(rect.width - 0.5, -0.5),
    transform(rect.width - 0.5, rect.height - 0.5),
    transform(-0.5, rect.height - 0.5),
  ]
  if (corners.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y)))
    throw new Error('Affine bounds exceed numeric range')
  const left = Math.max(clip.x, Math.ceil(nearInteger(Math.min(...corners.map((p) => p.x))))),
    top = Math.max(clip.y, Math.ceil(nearInteger(Math.min(...corners.map((p) => p.y))))),
    right = Math.min(
      clip.x + clip.width,
      Math.ceil(nearInteger(Math.max(...corners.map((p) => p.x)))),
    ),
    bottom = Math.min(
      clip.y + clip.height,
      Math.ceil(nearInteger(Math.max(...corners.map((p) => p.y)))),
    )
  if (left >= right || top >= bottom) return empty()
  const width = right - left,
    height = bottom - top
  const result: AffineRaster = {
    left,
    top,
    pixels: { width, height, data: new Uint8Array(width * height * 4) },
    spans: new Int32Array(height * 2),
  }
  const noClip = !!(mode & 0x10000),
    lowX = noClip ? 0 : rect.x,
    highX = noClip ? source.width - 1 : rect.x + rect.width - 1,
    lowY = noClip ? 0 : rect.y,
    highY = noClip ? source.height - 1 : rect.y + rect.height - 1,
    scaleX = type === 1 ? 1 : Math.hypot(inverse[0], inverse[2]),
    scaleY = type === 1 ? 1 : Math.hypot(inverse[1], inverse[3]),
    kernel = type !== 0 && type !== 14 && type !== 15 ? filter(type, -1) : undefined
  const sum = new Float64Array(4)
  let batch = 0
  for (let y = top; y < bottom; y++) {
    let spanLeft = Infinity,
      spanRight = -Infinity
    for (let edge = 0; edge < 4; edge++) {
      const first = corners[edge]!,
        last = corners[(edge + 1) % 4]!
      if (y < Math.min(first.y, last.y) || y >= Math.max(first.y, last.y) || first.y === last.y)
        continue
      const x = first.x + ((y - first.y) * (last.x - first.x)) / (last.y - first.y)
      spanLeft = Math.min(spanLeft, x)
      spanRight = Math.max(spanRight, x)
    }
    let firstWritten = -1,
      lastWritten = -1
    for (
      let x = Math.max(left, Math.ceil(nearInteger(spanLeft)));
      x < Math.min(right, Math.ceil(nearInteger(spanRight)));
      x++
    ) {
      const localX = inverse[0] * (x - tx) + inverse[2] * (y - ty),
        localY = inverse[1] * (x - tx) + inverse[3] * (y - ty),
        roundedX = Math.floor(nearInteger(localX + 0.5)),
        roundedY = Math.floor(nearInteger(localY + 0.5))
      if (!Number.isFinite(localX) || !Number.isFinite(localY))
        throw new Error('Affine sample exceeds numeric range')
      // Source bounds are independent of stRefNoClip: that flag only changes
      // neighboring samples used by a filter, never the transformed coverage.
      if (roundedX < 0 || roundedX >= rect.width || roundedY < 0 || roundedY >= rect.height)
        continue
      const at = ((y - top) * width + x - left) * 4,
        sx = rect.x + localX,
        sy = rect.y + localY
      if (type === 0) {
        const from = ((rect.y + roundedY) * source.width + rect.x + roundedX) * 4
        result.pixels.data.set(source.data.subarray(from, from + 4), at)
      } else {
        sum.fill(0)
        if (type === 14 || type === 15) {
          // Area filtering integrates the inverse image of the destination
          // pixel, a parallelogram, rather than its larger bounding rectangle.
          // Normalize the polygon so large inverse footprints do not overflow
          // the area calculation. All cell boundaries use the same scale.
          const norm = Math.max(1, ...inverse.map(Math.abs))
          const footprint = [
            [-0.5, -0.5],
            [0.5, -0.5],
            [0.5, 0.5],
            [-0.5, 0.5],
          ].map(([dx, dy]) => ({
            x: (inverse[0] / norm) * dx! + (inverse[2] / norm) * dy!,
            y: (inverse[1] / norm) * dx! + (inverse[3] / norm) * dy!,
          }))
          const minX = Math.min(...footprint.map((p) => p.x)),
            maxX = Math.max(...footprint.map((p) => p.x)),
            minY = Math.min(...footprint.map((p) => p.y)),
            maxY = Math.max(...footprint.map((p) => p.y))
          let total = 0
          const beginX = Math.max(lowX, Math.min(highX, Math.floor(sx + minX * norm + 0.5))),
            endX = Math.max(lowX, Math.min(highX, Math.floor(sx + maxX * norm + 0.5))),
            beginY = Math.max(lowY, Math.min(highY, Math.floor(sy + minY * norm + 0.5))),
            endY = Math.max(lowY, Math.min(highY, Math.floor(sy + maxY * norm + 0.5)))
          for (let yy = beginY; yy <= endY; yy++) {
            const row = clipPolygon(
              clipPolygon(footprint, 'y', yy === lowY ? minY : (yy - 0.5 - sy) / norm, true),
              'y',
              yy === highY ? maxY : (yy + 0.5 - sy) / norm,
              false,
            )
            for (let xx = beginX; xx <= endX; xx++) {
              const cell = clipPolygon(
                  clipPolygon(row, 'x', xx === lowX ? minX : (xx - 0.5 - sx) / norm, true),
                  'x',
                  xx === highX ? maxX : (xx + 0.5 - sx) / norm,
                  false,
                ),
                weight = polygonArea(cell)
              total += weight
              for (let channel = 0; channel < 4; channel++)
                sum[channel] =
                  sum[channel]! + source.data[(yy * source.width + xx) * 4 + channel]! * weight
              if (++batch >= 1024) {
                batch = 0
                yield
              }
            }
          }
          if (total > 0)
            for (let channel = 0; channel < 4; channel++) sum[channel] = sum[channel]! / total
          else
            for (let channel = 0; channel < 4; channel++)
              sum[channel] =
                source.data[((rect.y + roundedY) * source.width + rect.x + roundedX) * 4 + channel]!
        } else {
          const horizontal = weights(sx, scaleX, lowX, highX, kernel!),
            vertical = weights(sy, scaleY, lowY, highY, kernel!)
          for (const wy of vertical)
            for (const wx of horizontal) {
              const from = (wy.index * source.width + wx.index) * 4,
                weight = wx.weight * wy.weight
              for (let channel = 0; channel < 4; channel++)
                sum[channel] = sum[channel]! + source.data[from + channel]! * weight
              if (++batch >= 1024) {
                batch = 0
                yield
              }
            }
        }
        for (let channel = 0; channel < 4; channel++)
          result.pixels.data[at + channel] = byte(sum[channel]!)
      }
      if (firstWritten < 0) firstWritten = x - left
      lastWritten = x - left + 1
      if (++batch >= 1024) {
        batch = 0
        yield
      }
    }
    if (firstWritten >= 0) result.spans.set([firstWritten, lastWritten], (y - top) * 2)
  }
  return result
}
