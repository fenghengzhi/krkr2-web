import type { TextPixels } from '../ports/graphics.ts'
export interface GlyphMask {
  width: number
  height: number
  left: number
  top: number
  coverage: Uint8Array
}
export function* colorGlyph(mask: GlyphMask, color: number): Generator<void, TextPixels> {
  const data = new Uint8Array(mask.coverage.length * 4)
  for (let i = 0; i < mask.coverage.length; i++) {
    data[i * 4] = (color >>> 16) & 255
    data[i * 4 + 1] = (color >>> 8) & 255
    data[i * 4 + 2] = color & 255
    data[i * 4 + 3] = mask.coverage[i]!
    if ((i & 4095) === 0) yield
  }
  return { width: mask.width, height: mask.height, left: mask.left, top: mask.top, data }
}
/** Native character blur: integer radial weights and saturating additions. */
export function* shadowGlyph(
  mask: GlyphMask,
  level: number,
  signedWidth: number,
): Generator<void, GlyphMask> {
  if (level === 255 && signedWidth === 0) return mask
  const radius = Math.abs(signedWidth)
  if (!radius) {
    const coverage = Uint8Array.from(mask.coverage, (value) => (value * level) >> 8)
    return { ...mask, coverage }
  }
  const width = mask.width + radius * 2,
    height = mask.height + radius * 2,
    coverage = new Uint8Array(width * height),
    weights: { x: number; y: number; weight: number }[] = []
  let sum = 0
  for (let y = -radius; y <= radius; y++)
    for (let x = -radius; x <= radius; x++) {
      const a = Math.max(Math.abs(x), Math.abs(y)),
        b = Math.min(Math.abs(x), Math.abs(y)),
        t = b + (b >> 1),
        distance = a - (a >> 5) - (a >> 7) + (t >> 2) + (t >> 6)
      if (distance <= radius) {
        const weight = radius - distance + 1
        weights.push({ x, y, weight })
        sum += weight
      }
    }
  if (weights.length * mask.coverage.length > 64 * 1024 * 1024)
    throw new Error('Glyph shadow work exceeds 64 million samples')
  const scale = Math.floor(262144 / (sum || 1))
  for (const { x, y, weight } of weights) {
    const amount = (weight * scale * level) >> 8
    for (let sy = 0; sy < mask.height; sy++) {
      const src = sy * mask.width,
        dest = (y + sy + radius) * width + x + radius
      for (let sx = 0; sx < mask.width; sx++)
        coverage[dest + sx] = Math.min(
          255,
          coverage[dest + sx]! + ((mask.coverage[src + sx]! * amount) >> 18),
        )
      yield
    }
  }
  return { width, height, left: mask.left - signedWidth, top: mask.top - signedWidth, coverage }
}
