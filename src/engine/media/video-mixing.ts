import type { VideoMixingBitmap, VideoSettings } from '../ports/video.ts'
import type { LayerState } from '../scene/layers.ts'
import type { WindowView } from '../scene/window.ts'

/** WindowForm applies Win32 MulDiv independently to each video rectangle edge. */
function zoomEdge(value: number, numer: number, denom: number): number {
  const result = Math.sign(value) * Math.floor((Math.abs(value) * numer + denom / 2) / denom)
  return result < -2147483648 || result > 2147483647 ? -1 : result
}

/** Shared by capture and presentation so fractional zoom uses the same rectangle. */
export function videoOutputRectangle(
  settings: Pick<VideoSettings, 'left' | 'top' | 'width' | 'height'>,
  window: Pick<WindowView, 'zoomNumer' | 'zoomDenom'>,
): { left: number; top: number; width: number; height: number } {
  const { zoomNumer, zoomDenom } = window,
    left = zoomEdge(settings.left, zoomNumer, zoomDenom),
    top = zoomEdge(settings.top, zoomNumer, zoomDenom)
  return {
    left,
    top,
    width: zoomEdge(settings.left + settings.width, zoomNumer, zoomDenom) - left,
    height: zoomEdge(settings.top + settings.height, zoomNumer, zoomDenom) - top,
  }
}

/** No completion/onPaint/children traversal: this API reads the current MainImage. */
export function captureVideoMixingBitmap(
  layer: LayerState,
  settings: VideoSettings,
  window: Pick<WindowView, 'zoomNumer' | 'zoomDenom'>,
): VideoMixingBitmap | null {
  if (!layer.visible) return null
  const bitmap = layer.bitmap
  if (!bitmap) throw new Error('This layer has no drawable image')
  // Native overlay/layer backends ignore the bitmap after the MainImage checks.
  if (settings.mode !== 2) return null
  const output = videoOutputRectangle(settings, window),
    width = Math.max(1, output.width),
    height = Math.max(1, output.height),
    left = layer.left + layer.imageLeft,
    top = layer.top + layer.imageTop,
    normalize = (edge: number, size: number) =>
      Math.fround(Math.fround(Math.fround(edge) + 0.5) / Math.fround(size)),
    data = Uint8Array.from(bitmap.pixels.data)
  // VMR9's HDC path ignores the DIB's mask; opacity is a separate scalar.
  for (let index = 3; index < data.length; index += 4) data[index] = 255
  return {
    pixels: { width: bitmap.width, height: bitmap.height, data },
    destination: {
      left: normalize(left, width),
      top: normalize(top, height),
      right: normalize(left + bitmap.width, width),
      bottom: normalize(top + bitmap.height, height),
    },
    opacity: Math.fround(layer.opacity / 255),
  }
}
