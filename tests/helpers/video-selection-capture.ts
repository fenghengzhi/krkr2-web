import type { Locator, Page, TestInfo } from '@playwright/test'
import type { HandoffProbe, ProbeWindow } from './video-handoff-capture.ts'
import { readScreenshotPng } from './screenshot-png.ts'

/** Independent reads of the unchanged paused elements plus a receive-only
 * copy of the production readback recorded by installHandoffReadbacks. Keep
 * the default GPU route even though layer production uses frequent CPU reads. */
export async function selectionReadbacks(canvas: Locator) {
  return canvas.evaluate((node) => {
    const surface = node as HTMLCanvasElement
    let paint: ReturnType<HandoffProbe['capture']>['paint'] | undefined
    const videos = [...document.querySelectorAll<HTMLVideoElement>('video[data-video-id]')].map((video) => {
      const state = () => ({ id: video.dataset.videoId, source: video.currentSrc || video.src,
        position: video.currentTime, duration: video.duration, paused: video.paused, seeking: video.seeking, readyState: video.readyState,
        presentedTime: video.dataset.presentedTime, presentedFrames: video.dataset.presentedFrames })
      const before = state()
      try {
        const { paint: canvasPixels, ...capture } = (window as unknown as ProbeWindow).handoffReadbacks.capture(video, surface)
        paint ??= canvasPixels
        return { before, after: state(), capture }
      } catch (error) { return { before, after: state(), error: String(error) } }
    })
    return { videos, paint }
  })
}

export function selectionRegion(pixels: readonly number[], width: number, x: number, y: number) {
  const result: number[] = []
  for (let row = y; row < y + 60; row++) result.push(...pixels.slice((row * width + x) * 4, (row * width + x + 80) * 4))
  return result
}

/** The reference is the complete separate stream-copy decoder output, placed
 * at native size on the authored opaque black 80x60 panel. No scaling/filter
 * or product renderer is used to derive these bytes. */
export function referencePanel(width: number, height: number, pixels: readonly number[]) {
  if (width > 80 || height > 60 || pixels.length !== width * height * 4)
    throw new Error('Unexpected independent video reference dimensions')
  const result = Array<number>(80 * 60 * 4).fill(0)
  for (let at = 3; at < result.length; at += 4) result[at] = 255
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) for (let c = 0; c < 4; c++)
    result[(y * 80 + x) * 4 + c] = pixels[(y * width + x) * 4 + c]!
  return result
}

/** Capture real compositor pixels. The three full video panels have equal
 * black gutters and identical device-pixel phase; the edge of the HTML canvas
 * is not used as a substitute for the other panels' black neighbours. */
export async function selectionScreen(page: Page, canvas: Locator, info: TestInfo, label: string) {
  const bounds = () => canvas.evaluate((node) => {
    const surface = node as HTMLCanvasElement, box = surface.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      backingWidth: surface.width, backingHeight: surface.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio }
  })
  await canvas.evaluate((node) => node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }))
  const before = await bounds(), png = await page.screenshot({ fullPage: false, scale: 'device', timeout: 10000 })
  // Preserve the actual screenshot before any coordinate or equality failure.
  await info.attach(label, { body: png, contentType: 'image/png' })
  const decoded = readScreenshotPng(png), after = await bounds()
  await info.attach(label + '-coordinates', { contentType: 'application/json',
    body: JSON.stringify({ before, after, screenshot: { width: decoded.width, height: decoded.height } }) })
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Video canvas moved during compositor capture')
  const sx = decoded.width / before.viewportWidth, sy = decoded.height / before.viewportHeight,
    pixelX = before.width / before.backingWidth * sx, pixelY = before.height / before.backingHeight * sy
  if (!Object.values(before).every(Number.isFinite) || before.backingWidth !== 256 || before.backingHeight !== 64 ||
      pixelX <= 0 || pixelY <= 0 || decoded.width !== Math.round(before.viewportWidth * before.dpr) ||
      decoded.height !== Math.round(before.viewportHeight * before.dpr) || !Number.isInteger(84 * pixelX))
    throw new Error('Video panels do not share the same measured device-pixel phase')
  const rectangles = [2, 86, 170].map((x) => {
    const left = Math.floor(before.x * sx + x * pixelX), right = Math.ceil(before.x * sx + (x + 80) * pixelX),
      top = Math.floor(before.y * sy + 2 * pixelY), bottom = Math.ceil(before.y * sy + 62 * pixelY)
    if (left < 0 || top < 0 || right > decoded.width || bottom > decoded.height || right <= left || bottom <= top)
      throw new Error('Complete video panel is outside the viewport screenshot')
    return { left, top, width: right - left, height: bottom - top }
  })
  const panels = rectangles.map(({ left, top, width, height }) => {
    const pixels: number[] = []
    for (let row = top; row < top + height; row++) {
      const start = (row * decoded.width + left) * 4
      pixels.push(...decoded.rgba.subarray(start, start + width * 4))
    }
    return pixels
  })
  return { bounds: before, screenshot: { width: decoded.width, height: decoded.height }, rectangles, panels }
}
