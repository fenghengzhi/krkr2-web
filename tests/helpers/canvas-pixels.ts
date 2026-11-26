import type { Locator } from '@playwright/test'

/** Read the displayed canvas at its own pixel resolution. DOM screenshots can
 * include an extra row/column when the CSS box starts at a fractional position. */
export async function canvasPixels(locator: Locator) {
  return locator.evaluate((node) => {
    const canvas = node as HTMLCanvasElement, copy = new OffscreenCanvas(canvas.width, canvas.height),
      context = copy.getContext('2d', { willReadFrequently: true })!
    context.drawImage(canvas, 0, 0)
    return { width: canvas.width, height: canvas.height,
      rgba: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
      bounds: canvas.getBoundingClientRect().toJSON(), devicePixelRatio: window.devicePixelRatio }
  })
}
