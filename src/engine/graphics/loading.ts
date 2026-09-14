import type { DecodedImage, Pixels } from '../ports/graphics.ts'

export const noColorKey = 0x1fffffff
export function validateColorKey(key: number): void {
  if (
    !Number.isInteger(key) ||
    key < 0 ||
    key > 0xffffffff ||
    !(
      key === noColorKey ||
      key === 0x01ffffff ||
      key <= 0xffffff ||
      key >>> 24 === 3 ||
      key >>> 24 === 4
    )
  )
    throw new Error('Invalid image color key')
}

/** Keying precedes companion masks; matting follows them. */
export function* applyImageKey(image: DecodedImage, key: number): Generator<void, void> {
  validateColorKey(key)
  const { data, width } = image
  if (key === noColorKey || key >>> 24 === 4 || (key >>> 24 === 3 && !image.indices)) return
  if (key === 0x01ffffff) {
    const counts = new Map<number, number>()
    let maximum = 0,
      selected = 0xffffff
    for (let x = 0; x < width; x++) {
      const at = x * 4,
        color = (data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!,
        count = (counts.get(color) ?? 0) + 1
      counts.set(color, count)
      if (count > maximum || (count === maximum && color < selected)) {
        maximum = count
        selected = color
      }
    }
    key = selected
  }
  for (let pixel = 0; pixel < data.length / 4; pixel++) {
    const at = pixel * 4,
      matched =
        key >>> 24 === 3
          ? image.indices![pixel] === (key & 255)
          : ((data[at]! << 16) | (data[at + 1]! << 8) | data[at + 2]!) === key
    data[at + 3] = matched ? 0 : 255
    if (pixel % 4096 === 4095) yield
  }
}
export function* applyImageMask(image: Pixels, mask: Pixels): Generator<void, void> {
  if (image.width !== mask.width || image.height !== mask.height)
    throw new Error('Companion mask size mismatch')
  for (let at = 0; at < image.data.length; at += 4) {
    image.data[at + 3] =
      (54 * mask.data[at]! + 183 * mask.data[at + 1]! + 19 * mask.data[at + 2]!) >>> 8
    if (at % 16384 === 16380) yield
  }
}
export function* matteImage(image: Pixels, key: number): Generator<void, void> {
  if (key >>> 24 !== 4) return
  const background = [(key >>> 16) & 255, (key >>> 8) & 255, key & 255],
    data = image.data
  for (let at = 0; at < data.length; at += 4) {
    const alpha = data[at + 3]!
    for (let c = 0; c < 3; c++)
      data[at + c] = background[c]! + (((data[at + c]! - background[c]!) * alpha) >> 8)
    data[at + 3] = 255
    if (at % 16384 === 16380) yield
  }
}
export function* provincePixels(
  image: DecodedImage,
  width: number,
  height: number,
): Generator<void, Uint8Array> {
  if (!image.indices && !image.grayscale)
    throw new Error('Province images require a palette or grayscale source')
  // Native province loads request the main image's size and tile smaller sources.
  if (image.width > width || image.height > height) throw new Error('Province image size mismatch')
  const result = new Uint8Array(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y % image.height) * image.width + (x % image.width)
      result[y * width + x] = image.indices ? image.indices[source]! : image.data[source * 4]!
    }
    yield
  }
  return result
}
