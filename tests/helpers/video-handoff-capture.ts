import type { Locator, Page } from '@playwright/test'
import { readScreenshotPng } from './screenshot-png.ts'

interface Readback {
  source: string
  position: number
  width: number
  height: number
  willReadFrequently: boolean
  pixels: number[]
}
interface HandoffProbe {
  capture(video: HTMLVideoElement, canvas: HTMLCanvasElement): {
    media: { position: number; paused: boolean; seeking: boolean; width: number; height: number; pixels: number[] }
    reads: { defaultRepeated: number[]; defaultRedrawn: number[]; cpu: number[]; cpuRepeated: number[]; cpuRedrawn: number[] }
    paint: { width: number; height: number; pixels: number[] }
    production: Readback | undefined
    dropped: number
  }
}
type ProbeWindow = Window & { handoffReadbacks: HandoffProbe }

/** Observe the real host's full readback without changing its result. Test
 * readbacks are excluded so they cannot become their own production oracle. */
export async function installHandoffReadbacks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const contexts = new WeakMap<OffscreenCanvasRenderingContext2D, boolean>(),
      sources = new WeakMap<OffscreenCanvasRenderingContext2D, HTMLVideoElement>(),
      records: Readback[] = [], getContext = OffscreenCanvas.prototype.getContext,
      draw = OffscreenCanvasRenderingContext2D.prototype.drawImage,
      read = OffscreenCanvasRenderingContext2D.prototype.getImageData
    let capturing = false, dropped = 0
    OffscreenCanvas.prototype.getContext = function(this: OffscreenCanvas, ...args: unknown[]) {
      const context: unknown = Reflect.apply(getContext, this, args)
      if (args[0] === '2d' && context) {
        const drawing = context as OffscreenCanvasRenderingContext2D
        if (!contexts.has(drawing))
          contexts.set(drawing, (args[1] as { willReadFrequently?: boolean } | undefined)?.willReadFrequently === true)
      }
      return context
    } as typeof getContext
    OffscreenCanvasRenderingContext2D.prototype.drawImage = function(this: OffscreenCanvasRenderingContext2D, ...args: unknown[]) {
      const result = Reflect.apply(draw, this, args)
      if (args[0] instanceof HTMLVideoElement && args.length === 3 && args[1] === 0 && args[2] === 0)
        sources.set(this, args[0])
      else sources.delete(this)
      return result
    } as typeof draw
    OffscreenCanvasRenderingContext2D.prototype.getImageData = function(this: OffscreenCanvasRenderingContext2D, ...args: unknown[]) {
      const image: ImageData = Reflect.apply(read, this, args), video = sources.get(this)
      if (!capturing && video && args[0] === 0 && args[1] === 0 &&
          args[2] === video.videoWidth && args[3] === video.videoHeight) {
        if (image.data.length <= 256 * 256 * 4) {
          if (records.length === 64) { records.shift(); dropped++ }
          records.push({ source: video.currentSrc || video.src, position: video.currentTime,
            width: image.width, height: image.height, willReadFrequently: contexts.get(this) === true,
            pixels: [...image.data] })
        } else dropped++
      }
      return image
    } as typeof read
    ;(window as unknown as ProbeWindow).handoffReadbacks = {
      capture(video, canvas) {
        const source = video.currentSrc || video.src,
          production = [...records].reverse().find((entry) => entry.source === source)
        capturing = true
        try {
          const width = video.videoWidth, height = video.videoHeight,
            sample = (frequent: boolean) => {
              const output = new OffscreenCanvas(width, height),
                context = frequent ? output.getContext('2d', { willReadFrequently: true })! : output.getContext('2d')!
              context.drawImage(video, 0, 0)
              const pixels = [...context.getImageData(0, 0, width, height).data],
                repeated = [...context.getImageData(0, 0, width, height).data]
              context.drawImage(video, 0, 0)
              return { pixels, repeated, redrawn: [...context.getImageData(0, 0, width, height).data] }
            }, normal = sample(false), cpu = sample(true),
            output = new OffscreenCanvas(canvas.width, canvas.height),
            paint = output.getContext('2d', { willReadFrequently: true })!
          paint.drawImage(canvas, 0, 0)
          return {
            media: { position: video.currentTime, paused: video.paused, seeking: video.seeking,
              width, height, pixels: normal.pixels },
            reads: { defaultRepeated: normal.repeated, defaultRedrawn: normal.redrawn,
              cpu: cpu.pixels, cpuRepeated: cpu.repeated, cpuRedrawn: cpu.redrawn },
            paint: { width: canvas.width, height: canvas.height,
              pixels: [...paint.getImageData(0, 0, canvas.width, canvas.height).data] },
            production, dropped,
          }
        } finally { capturing = false }
      },
    }
  })
}

/** Capture the whole real viewport, then copy the canvas's complete device
 * pixel extent. No element screenshot, browser PNG decode, resize or tolerance. */
export async function captureHandoff(page: Page, surface: Locator,
  onReadbacks?: (value: ReturnType<HandoffProbe['capture']>) => void) {
  const canvas = surface.locator('canvas[data-window-id]')
  const before = await canvas.evaluate((node) => {
    // Debug evaluation may have scrolled the page to its controls. Scroll the
    // real element into a reproducible viewport position without an element
    // screenshot's separate scrolling/capture protocol path.
    node.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const box = node.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height,
      viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio }
  })
  const samples = await canvas.evaluate((node) => {
    const canvas = node as HTMLCanvasElement,
      video = document.querySelector<HTMLVideoElement>(`video[data-video-id][data-window-id="${canvas.dataset.windowId}"]`)
    if (!video || video.readyState < 2 || !video.paused || video.seeking)
      throw new Error('Handoff capture requires the real paused, decoded video')
    return (window as unknown as ProbeWindow).handoffReadbacks.capture(video, canvas)
  })
  // Preserve completed raw observations even if the independent compositor
  // screenshot fails. This callback never runs inside the browser or VM.
  onReadbacks?.(samples)
  // A protocol screenshot failure must leave time for normal Stop/attachments;
  // the test's original 90-second deadline is not extended.
  const png = await page.screenshot({ fullPage: false, scale: 'device', timeout: 10000 }),
    decoded = readScreenshotPng(png),
    after = await canvas.evaluate((node) => {
      const box = node.getBoundingClientRect()
      return { x: box.x, y: box.y, width: box.width, height: box.height,
        viewportWidth: innerWidth, viewportHeight: innerHeight, dpr: devicePixelRatio }
    })
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Canvas moved during the full viewport screenshot')
  const sx = decoded.width / before.viewportWidth, sy = decoded.height / before.viewportHeight,
    left = Math.floor(before.x * sx), top = Math.floor(before.y * sy),
    right = Math.ceil((before.x + before.width) * sx), bottom = Math.ceil((before.y + before.height) * sy)
  if (!Object.values(before).every(Number.isFinite) || !Number.isFinite(sx) || !Number.isFinite(sy) || sx <= 0 || sy <= 0 ||
      decoded.width !== Math.round(before.viewportWidth * before.dpr) ||
      decoded.height !== Math.round(before.viewportHeight * before.dpr) ||
      before.width <= 0 || before.height <= 0 || left < 0 || top < 0 ||
      right > decoded.width || bottom > decoded.height || right <= left || bottom <= top)
    throw new Error('Canvas device-pixel extent is outside the full viewport screenshot')
  const pixels: number[] = []
  for (let row = top; row < bottom; row++) {
    const from = (row * decoded.width + left) * 4
    pixels.push(...decoded.rgba.subarray(from, from + (right - left) * 4))
  }
  return { ...samples, screen: { width: right - left, height: bottom - top, pixels },
    screenshot: { bounds: before, pngWidth: decoded.width, pngHeight: decoded.height,
      crop: { x: left, y: top, width: right - left, height: bottom - top } } }
}
