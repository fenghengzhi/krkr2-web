import type { VideoMixingBitmap } from '../../../engine/ports/video.ts'

export const videoMixingBudget = 64 * 1024 * 1024

export interface VideoMixingSurface {
  readonly canvas: HTMLCanvasElement
  readonly bytes: number
}

/** Construct detached storage before the caller replaces its current bitmap. */
export function createVideoMixingSurface(
  bitmap: VideoMixingBitmap,
  remainingBytes: number,
): VideoMixingSurface {
  const { width, height, data } = bitmap.pixels,
    { left, top, right, bottom } = bitmap.destination,
    bytes = width * height * 4,
    positions = [left * 100, top * 100, (right - left) * 100, (bottom - top) * 100]
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width > 4096 ||
    height > 4096 ||
    !(data instanceof Uint8Array) ||
    data.byteLength !== bytes
  )
    throw new Error('Invalid video mixing bitmap dimensions or pixels')
  if (
    ![left, top, right, bottom, ...positions].every(Number.isFinite) ||
    right <= left ||
    bottom <= top ||
    !Number.isFinite(bitmap.opacity) ||
    bitmap.opacity < 0 ||
    bitmap.opacity > 1
  )
    throw new Error('Invalid video mixing bitmap geometry or opacity')
  if (bytes > remainingBytes) throw new Error('Video mixing bitmap resource budget exceeded')

  const canvas = document.createElement('canvas')
  try {
    canvas.className = 'video-mixing-bitmap'
    canvas.setAttribute('aria-hidden', 'true')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) throw new Error('Video mixing bitmap canvas is unavailable')
    // ImageData owns a copy even for direct host callers. The native HDC path
    // ignores the MainImage mask; only the bitmap's global opacity participates.
    const copy = new Uint8ClampedArray(data)
    for (let offset = 3; offset < copy.length; offset += 4) copy[offset] = 255
    context.putImageData(new ImageData(copy, width, height), 0, 0)
    Object.assign(canvas.style, {
      display: 'block',
      position: 'absolute',
      left: `${positions[0]}%`,
      top: `${positions[1]}%`,
      width: `${positions[2]}%`,
      height: `${positions[3]}%`,
      maxWidth: 'none',
      maxHeight: 'none',
      aspectRatio: 'auto',
      objectFit: 'fill',
      opacity: String(bitmap.opacity),
      pointerEvents: 'none',
      imageRendering: 'pixelated',
    })
    return { canvas, bytes }
  } catch (error) {
    try {
      releaseVideoMixingSurface({ canvas, bytes })
    } catch {}
    throw error
  }
}

export function releaseVideoMixingSurface(surface: VideoMixingSurface): void {
  let primary: unknown,
    failed = false
  for (const release of [
    () => surface.canvas.remove(),
    () => {
      surface.canvas.width = 0
    },
    () => {
      surface.canvas.height = 0
    },
  ])
    try {
      release()
    } catch (error) {
      if (!failed) primary = error
      failed = true
    }
  if (failed) throw primary
}
