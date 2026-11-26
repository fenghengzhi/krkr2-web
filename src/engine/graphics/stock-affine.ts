import type { Pixels, Rect } from '../ports/graphics.ts'
import type { AffineRaster } from './affine.ts'

type Point = { x: number; y: number }
export type StockSampling = 'point' | 'bilinear'

/** The 2.32 renderer dispatches by the resolved blit method as well as the
 * requested filter. Extended Web filters keep their independent kernels. */
export function stockSampling(filter: number, mode: number | 'copy', face: number, hold: boolean): StockSampling | undefined {
  if (!Number.isSafeInteger(filter) || filter < 0 || filter > 0x10003 || (filter & 0xffff) > 3) return
  if (mode !== 'copy' && mode !== 1 && mode !== 2 && mode !== 12) return
  if (mode === 12 && face === 0) return // Web's explicit additive-to-straight extension.
  const interpolated = mode === 'copy' ? face !== 1 || !hold : face === 1 && !hold && (mode === 1 || mode === 12)
  return (filter & 0xffff) !== 0 && interpolated ? 'bilinear' : 'point'
}

const unit = 65536, half = unit / 2
type Vertex = { x: number; y: number; sx: number; sy: number }
const fixedProduct = (a: number, b: number) => Math.trunc(a * b / unit)
const intersectEdge = (a: Vertex, b: Vertex, t: number) => ({
  x: a.x + fixedProduct(b.x - a.x, t),
  sx: a.sx + fixedProduct(b.sx - a.sx, t),
  sy: a.sy + fixedProduct(b.sy - a.sy, t),
})
function scanline(vertices: Vertex[], y: number) {
  const hits: ReturnType<typeof intersectEdge>[] = []
  for (let i = 0; i < 4; i++) {
    const a = vertices[i]!, b = vertices[(i + 1) % 4]!
    if (a.y === y && b.y === y)
      return [intersectEdge(a, b, 0), intersectEdge(a, b, unit - 1)]
    if (y < Math.min(a.y, b.y) || y >= Math.max(a.y, b.y)) continue
    hits.push(intersectEdge(a, b, Math.trunc((y - a.y) * unit / (b.y - a.y))))
  }
  return hits
}
const mix = (a: number, b: number, weight: number) => a + (((b - a) * weight) >> 8)

/** Sample all four channels with the two successive byte blends from TVP's
 * scalar inner loops. The clipped border and arbitrary-angle loop adjust both
 * weights. The horizontal interior loop adjusts only its vertical weight. */
function bilinear(source: Pixels, sx: number, sy: number, bounds: Rect, horizontal: boolean, dest: Uint8Array, at: number) {
  const x = Math.floor(sx / unit), y = Math.floor(sy / unit),
    right = bounds.x + bounds.width - 1, bottom = bounds.y + bounds.height - 1,
    x0 = Math.max(bounds.x, Math.min(right, x)), x1 = Math.max(bounds.x, Math.min(right, x + 1)),
    y0 = Math.max(bounds.y, Math.min(bottom, y)), y1 = Math.max(bounds.y, Math.min(bottom, y + 1)),
    p00 = (y0 * source.width + x0) * 4, p01 = (y0 * source.width + x1) * 4,
    p10 = (y1 * source.width + x0) * 4, p11 = (y1 * source.width + x1) * 4
  const interior = x >= bounds.x && x + 1 <= right && y >= bounds.y && y + 1 <= bottom
  let wx = (sx & 65535) >>> 8, wy = (sy & 65535) >>> 8
  if (!horizontal || !interior) wx += wx >>> 7
  wy += wy >>> 7
  for (let c = 0; c < 4; c++) {
    const top = mix(source.data[p00 + c]!, source.data[p01 + c]!, wx),
      below = mix(source.data[p10 + c]!, source.data[p11 + c]!, wx)
    dest[at + c] = mix(top, below, wy)
  }
  return interior
}

/** InternalAffineBlt quantizes the three given corners before constructing
 * the fourth. Each row starts at a 16.16 edge intersection and then advances
 * by a truncated source step. Clipping must preserve that accumulated phase.
 * Undefined requests the portable geometry path outside signed native range. */
export function* stockAffinePixels(source: Pixels, rect: Rect, corners: readonly Point[], clip: Rect,
  sampling: StockSampling, noClip: boolean): Generator<void, AffineRaster | undefined> {
  const vertex = (p: Point, x: number, y: number): Vertex => ({
    x: Math.trunc(p.x * unit), y: Math.trunc(p.y * unit), sx: x * unit - half, sy: y * unit - half,
  })
  const a = vertex(corners[0]!, rect.x, rect.y), b = vertex(corners[1]!, rect.x + rect.width, rect.y),
    d = vertex(corners[2]!, rect.x, rect.y + rect.height),
    vertices = [a, b, { x: b.x - a.x + d.x, y: b.y - a.y + d.y, sx: b.sx, sy: d.sy }, d]
  if (vertices.some((p) => Math.abs(p.x) > 0x7fffffff || Math.abs(p.y) > 0x7fffffff)) return
  const ux = (b.x - a.x) / unit, uy = (b.y - a.y) / unit,
    vx = (d.x - a.x) / unit, vy = (d.y - a.y) / unit
  let dx: number, dy: number
  if (!uy) { dx = (b.sx - a.sx) / ux; dy = 0 }
  else if (!vy) { dx = 0; dy = (d.sy - a.sy) / vx }
  else {
    const length = ux / uy - vx / vy
    dx = ((b.sx - a.sx) / uy) / length
    dy = ((a.sy - d.sy) / vy) / length
  }
  dx = Math.trunc(dx); dy = Math.trunc(dy)
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.abs(dx) > 0x7fffffff || Math.abs(dy) > 0x7fffffff) return
  const left = Math.max(clip.x, Math.ceil(Math.min(...vertices.map((p) => p.x)) / unit)),
    top = Math.max(clip.y, Math.ceil(Math.min(...vertices.map((p) => p.y)) / unit)),
    right = Math.min(clip.x + clip.width, Math.ceil(Math.max(...vertices.map((p) => p.x)) / unit)),
    bottom = Math.min(clip.y + clip.height, Math.ceil(Math.max(...vertices.map((p) => p.y)) / unit)),
    width = Math.max(0, right - left), height = Math.max(0, bottom - top),
    pixels = { width, height, data: new Uint8Array(width * height * 4) }, spans = new Int32Array(height * 2),
    stockBilinear = sampling === 'bilinear' ? { horizontal: dy === 0, interior: new Int32Array(height * 2) } : undefined,
    bounds = noClip ? { x: 0, y: 0, width: source.width, height: source.height } : rect
  let work = 0
  for (let y = top; y < bottom; y++) {
    const hits = scanline(vertices, y * unit)
    if (hits.length !== 2) continue
    const [start, end] = hits[0]!.x <= hits[1]!.x ? [hits[0]!, hits[1]!] : [hits[1]!, hits[0]!]
    const edge = Math.ceil(start.x / unit), first = Math.max(left, edge), last = Math.min(right, Math.ceil(end.x / unit)),
      phase = edge * unit - start.x
    let sx = start.sx + fixedProduct(phase, dx) + (first - edge) * dx,
      sy = start.sy + fixedProduct(phase, dy) + (first - edge) * dy, firstWritten = -1, lastWritten = 0,
      firstInterior = -1, lastInterior = 0
    for (let x = first; x < last; x++, sx += dx, sy += dy) {
      if (++work >= 4096) { work = 0; yield }
      const ix = Math.floor((sx + half) / unit), iy = Math.floor((sy + half) / unit)
      if (ix < rect.x || ix >= rect.x + rect.width || iy < rect.y || iy >= rect.y + rect.height) continue
      const at = ((y - top) * width + x - left) * 4
      if (sampling === 'point') {
        const from = (iy * source.width + ix) * 4
        for (let c = 0; c < 4; c++) pixels.data[at + c] = source.data[from + c]!
      } else if (bilinear(source, sx, sy, bounds, dy === 0, pixels.data, at)) {
        if (firstInterior < 0) firstInterior = x - left
        lastInterior = x - left + 1
      }
      if (firstWritten < 0) firstWritten = x - left
      lastWritten = x - left + 1
    }
    if (firstWritten >= 0) { spans[(y - top) * 2] = firstWritten; spans[(y - top) * 2 + 1] = lastWritten }
    if (stockBilinear && firstInterior >= 0) {
      stockBilinear.interior[(y - top) * 2] = firstInterior
      stockBilinear.interior[(y - top) * 2 + 1] = lastInterior
    }
  }
  return { pixels, left, top, spans, stockBilinear }
}
