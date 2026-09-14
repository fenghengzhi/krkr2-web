import type { Pixels, Rect } from '../ports/graphics.ts'
import { filter } from './filters.ts'
interface Weight {
  index: number
  weight: number
}
function axis(
  first: number,
  count: number,
  destStart: number,
  destLength: number,
  sourceStart: number,
  sourceLength: number,
  sourceLimit: number,
  type: number,
  noClip: boolean,
  coefficient: number,
): Weight[][] {
  const low = Math.max(0, Math.min(sourceStart, sourceStart + sourceLength)),
    high = Math.min(sourceLimit, Math.max(sourceStart, sourceStart + sourceLength)) - 1
  if (low > high) return Array.from({ length: count }, () => [])
  const clamp = (value: number) =>
    Math.max(noClip ? 0 : low, Math.min(noClip ? sourceLimit - 1 : high, value))
  const scale = Math.abs(sourceLength / destLength),
    kernel = type !== 0 && type !== 14 && type !== 15 ? filter(type, coefficient) : undefined
  return Array.from({ length: count }, (_, i) => {
    const point = first + i,
      center = sourceStart + ((point + 0.5 - destStart) * sourceLength) / destLength - 0.5
    if (center < -0.5 || center > sourceLimit - 0.5) return []
    if (type === 0) return [{ index: clamp(Math.floor(center + 0.5)), weight: 1 }]
    const values = new Map<number, number>()
    const add = (index: number, weight: number) => {
      if (Math.abs(weight) < 1e-15) return
      index = clamp(index)
      values.set(index, (values.get(index) ?? 0) + weight)
    }
    if (type === 14 || type === 15) {
      const left = center + 0.5 - scale / 2,
        right = center + 0.5 + scale / 2
      for (let at = Math.floor(left); at < Math.ceil(right); at++)
        add(at, Math.max(0, Math.min(at + 1, right) - Math.max(at, left)))
    } else {
      const step = type === 1 ? 1 : Math.max(1, scale),
        radius = kernel!.radius * step
      for (let at = Math.ceil(center - radius); at <= Math.floor(center + radius); at++)
        add(at, kernel!.weight((center - at) / step))
    }
    const total = [...values.values()].reduce((sum, value) => sum + value, 0)
    if (Math.abs(total) < 1e-12) return [{ index: clamp(Math.floor(center + 0.5)), weight: 1 }]
    return [...values].map(([index, weight]) => ({ index, weight: weight / total }))
  })
}
/** A separable resampler over the clipped destination. Source pixels remain
 * unmodified until sampling finishes, including an overlapping self-copy. */
export function stretchPixels(
  source: Pixels,
  destination: Rect,
  sourceRect: Rect,
  clip: Rect,
  mode: number,
  coefficient = -1,
): { pixels: Pixels; left: number; top: number } {
  if (
    ![...Object.values(destination), ...Object.values(sourceRect), mode].every(
      Number.isSafeInteger,
    ) ||
    !Number.isFinite(coefficient)
  )
    throw new Error('Invalid stretch coordinates or filter')
  const type = mode & 0xffff
  if (type > 19 || mode & ~0x1ffff) throw new Error('Unknown stretch filter')
  if (Math.abs(sourceRect.width) > 4096 || Math.abs(sourceRect.height) > 4096)
    throw new Error('Stretch source extent exceeds bitmap limit')
  if (!destination.width || !destination.height || !sourceRect.width || !sourceRect.height)
    return {
      pixels: { width: 0, height: 0, data: new Uint8Array() },
      left: destination.x,
      top: destination.y,
    }
  let left = Math.max(clip.x, Math.min(destination.x, destination.x + destination.width)),
    top = Math.max(clip.y, Math.min(destination.y, destination.y + destination.height))
  let right = Math.min(
      clip.x + clip.width,
      Math.max(destination.x, destination.x + destination.width),
    ),
    bottom = Math.min(
      clip.y + clip.height,
      Math.max(destination.y, destination.y + destination.height),
    )
  const x0 = destination.x - (sourceRect.x * destination.width) / sourceRect.width,
    x1 = destination.x + ((source.width - sourceRect.x) * destination.width) / sourceRect.width
  const y0 = destination.y - (sourceRect.y * destination.height) / sourceRect.height,
    y1 = destination.y + ((source.height - sourceRect.y) * destination.height) / sourceRect.height
  left = Math.max(left, Math.ceil(Math.min(x0, x1) - 0.5))
  right = Math.min(right, Math.ceil(Math.max(x0, x1) - 0.5))
  top = Math.max(top, Math.ceil(Math.min(y0, y1) - 0.5))
  bottom = Math.min(bottom, Math.ceil(Math.max(y0, y1) - 0.5))
  const width = Math.max(0, right - left),
    height = Math.max(0, bottom - top)
  if (width > 4096 || height > 4096) throw new Error('Stretch output exceeds bitmap limit')
  const pixels = { width, height, data: new Uint8Array(width * height * 4) }
  if (!width || !height || !sourceRect.width || !sourceRect.height) return { pixels, left, top }
  const horizontal = axis(
    left,
    width,
    destination.x,
    destination.width,
    sourceRect.x,
    sourceRect.width,
    source.width,
    type,
    !!(mode & 0x10000),
    coefficient,
  )
  const vertical = axis(
    top,
    height,
    destination.y,
    destination.height,
    sourceRect.y,
    sourceRect.height,
    source.height,
    type,
    !!(mode & 0x10000),
    coefficient,
  )
  const rows = new Map<number, Float64Array>(),
    rowLimit = Math.max(1, Math.floor((8 * 1024 * 1024) / (width * 4 * 8)))
  for (let y = 0; y < height; y++) {
    const sum = new Float64Array(width * 4)
    for (const yw of vertical[y]!) {
      let row = rows.get(yw.index)
      if (!row) {
        row = new Float64Array(width * 4)
        for (let x = 0; x < width; x++)
          for (const xw of horizontal[x]!)
            for (let c = 0; c < 4; c++)
              row[x * 4 + c] =
                row[x * 4 + c]! +
                source.data[(yw.index * source.width + xw.index) * 4 + c]! * xw.weight
        while (rows.size >= rowLimit) rows.delete(rows.keys().next().value!)
        rows.set(yw.index, row)
      }
      for (let at = 0; at < sum.length; at++) sum[at] = sum[at]! + row[at]! * yw.weight
    }
    for (let at = 0; at < sum.length; at++)
      pixels.data[y * width * 4 + at] = Math.max(0, Math.min(255, Math.round(sum[at]!)))
  }
  return { pixels, left, top }
}
