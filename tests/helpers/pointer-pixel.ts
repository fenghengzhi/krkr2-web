import { expect, type Locator } from '@playwright/test'

/** Choose a real integer client coordinate inside a requested backing pixel.
 * MouseEvent client coordinates may be integral even when layout origins are
 * fractional. A fractional pixel centre can otherwise truncate into its neighbour. */
export async function pointerPixel(canvas: Locator, x: number, y: number): Promise<{ x: number; y: number }> {
  await canvas.scrollIntoViewIfNeeded()
  const { bounds, width, height } = await canvas.evaluate((node) => {
    const canvas = node as HTMLCanvasElement
    return { bounds: canvas.getBoundingClientRect().toJSON(), width: canvas.width, height: canvas.height }
  })
  const coordinate = (origin: number, size: number, pixels: number, target: number) => {
    const scale = size / pixels, first = Math.ceil(origin + target * scale),
      last = Math.ceil(origin + (target + 1) * scale) - 1
    expect(last, 'the requested logical pixel must contain a representable browser coordinate').toBeGreaterThanOrEqual(first)
    return Math.max(first, Math.min(last, Math.round(origin + (target + 0.5) * scale)))
  }
  return { x: coordinate(bounds.x, bounds.width, width, x), y: coordinate(bounds.y, bounds.height, height, y) }
}
