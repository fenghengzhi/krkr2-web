import type { DecodedImage } from '../ports/graphics.ts'
import type { ProcessedImage } from './processed-image-cache.ts'
import { decodedImageBytes } from './image-cache.ts'

function size(image: DecodedImage, desiredWidth: number, desiredHeight: number) {
  decodedImageBytes(image)
  if (![desiredWidth, desiredHeight].every((value) => Number.isInteger(value) && value >= 0 && value <= 4096))
    throw new Error('Invalid desired graphic dimensions')
  return { width: Math.max(image.width, desiredWidth), height: Math.max(image.height, desiredHeight) }
}

/** Native size callbacks tile to at least the requested dimensions, never crop. */
export function* tileImage(image: DecodedImage, desiredWidth: number, desiredHeight: number): Generator<void, DecodedImage> {
  const { width, height } = size(image, desiredWidth, desiredHeight)
  if (width === image.width && height === image.height) return image
  const data = new Uint8Array(width * height * 4),
    indices = image.indices ? new Uint8Array(width * height) : undefined
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y % image.height) * image.width + x % image.width, target = y * width + x
      const from = source * 4, to = target * 4
      data[to] = image.data[from]!
      data[to + 1] = image.data[from + 1]!
      data[to + 2] = image.data[from + 2]!
      data[to + 3] = image.data[from + 3]!
      if (indices) indices[target] = image.indices![source]!
    }
    yield
  }
  return { ...image, width, height, data, ...(indices ? { indices } : {}) }
}

/** Convert selected grayscale/palette output into the actual native 8-bit plane.
 * Palette values survive independently of their colors. Size errors belong to
 * the Layer consumer, after this successful processed result has been cached. */
export function* planeImage(
  image: DecodedImage,
  mode: 'grayscale' | 'palettized',
  desiredWidth: number,
  desiredHeight: number,
): Generator<void, ProcessedImage> {
  const { width, height } = size(image, desiredWidth, desiredHeight)
  if (mode === 'palettized' && !image.indices && !image.grayscale)
    throw new Error('Province images require a palette or grayscale source')
  const data = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y % image.height) * image.width + x % image.width
      // Selected grayscale decoders already applied their format's conversion.
      data[y * width + x] = mode === 'palettized' && image.indices
        ? image.indices[source]! : image.data[source * 4]!
    }
    yield
  }
  return { mode, width, height, data, ...(image.metadata ? { metadata: image.metadata } : {}) }
}

/** The public rule renderer uses RGBA; keep its expansion out of cache storage. */
export function* expandRule(image: ProcessedImage): Generator<void, DecodedImage> {
  if (image.mode !== 'grayscale' || image.data.length !== image.width * image.height)
    throw new Error('Invalid processed grayscale image')
  const data = new Uint8Array(image.width * image.height * 4)
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const source = y * image.width + x, at = source * 4, gray = image.data[source]!
      data[at] = data[at + 1] = data[at + 2] = gray
      data[at + 3] = 255
    }
    yield
  }
  return { width: image.width, height: image.height, data, grayscale: true,
    ...(image.metadata ? { metadata: image.metadata } : {}) }
}
