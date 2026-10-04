import { cursorLimits, type CursorAsset, type CursorImage } from './index.ts'

export interface CursorLoadProfile {
  width: number
  height: number
  depth: number
  dpi: number
}
/** The two hosted reference desktops have this explicit environment. This
 * policy does not track browser DPR or claim another desktop's defaults. */
export const windowsDesktopCursorProfile: Readonly<CursorLoadProfile> = Object.freeze({
  width: 32, height: 32, depth: 32, dpi: 96,
})
export interface CursorLoadOptions { checkpoint?: () => void | Promise<void> }

function fail(message: string): never { throw new Error('Cursor load: ' + message) }
function profileValue(profile: CursorLoadProfile): CursorLoadProfile {
  const copy = { ...profile }
  if (copy.width !== 32 || copy.height !== 32 || copy.depth !== 32 || copy.dpi !== 96)
    fail('only the 32x32, 32-bit, 96-DPI desktop profile is supported')
  return copy
}
function imageDimensions(image: CursorImage): void {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.width > 256 || image.height < 1 || image.height > 256 ||
      !Number.isSafeInteger(image.depth) || image.depth < 1 || image.depth > 32)
    fail('invalid image dimensions or depth')
}
function select(images: readonly CursorImage[], profile: CursorLoadProfile): CursorImage {
  if (!images.length || images.length > cursorLimits.imagesPerFrame) fail('invalid image directory')
  let selected: CursorImage | undefined, best: number[] | undefined
  for (const image of images) {
    imageDimensions(image)
    // File loading is not the resource-directory API's documented preference
    // for smaller images: both observed directory orders select 48 over 16
    // for a 32-pixel request. Equal geometry/depth keeps the first directory
    // entry. Crossed rectangular dimensions remain under the strict native
    // comparison gate rather than being inferred from just the square cases.
    const distance = Math.abs(image.width - profile.width) + Math.abs(image.height - profile.height),
      below = image.width < profile.width || image.height < profile.height,
      rank = [distance, Number(below), -image.width * image.height,
        image.depth > profile.depth ? 1 : 0,
        image.depth > profile.depth ? image.depth : -image.depth]
    if (!best || rank.some((value, index) => value < best![index]! &&
        rank.slice(0, index).every((earlier, at) => earlier === best![at]))) {
      selected = image
      best = rank
    }
  }
  return selected!
}
function snapshot(image: CursorImage): CursorImage {
  const pixels = image.width * image.height
  if (!(image.data instanceof Uint8Array) || !(image.andMask instanceof Uint8Array) ||
      image.data.length !== pixels * 4 || image.andMask.length !== pixels ||
      (image.mode !== 'alpha' && image.mode !== 'and-xor') ||
      (image.encoding !== 'dib' && image.encoding !== 'png') ||
      !image.hotspot || !Number.isSafeInteger(image.hotspot.x) || !Number.isSafeInteger(image.hotspot.y) ||
      image.hotspot.x < 0 || image.hotspot.y < 0 || image.hotspot.x > 65535 || image.hotspot.y > 65535)
    fail('invalid image planes or hotspot')
  if (image.encoding === 'dib' && (image.topDown ||
      (image.dibHeaderSize !== 12 && image.dibHeaderSize !== 40)))
    fail('DIB representation is not supported by the native file-loading policy')
  return { ...image, hotspot: { ...image.hotspot }, data: new Uint8Array(image.data),
    andMask: new Uint8Array(image.andMask) }
}
function nearest(at: number, source: number, target: number): number {
  return Math.min(source - 1, Math.floor((at + 0.5) * source / target))
}
async function resize(image: CursorImage, profile: CursorLoadProfile, options: CursorLoadOptions): Promise<CursorImage> {
  const width = profile.width, height = profile.height,
    hotspot = image.icon ? { x: width >>> 1, y: height >>> 1 } : {
      x: Math.round(image.hotspot.x * width / image.width),
      y: Math.round(image.hotspot.y * height / image.height),
    }
  if (image.width === width && image.height === height) return { ...image, hotspot }
  const data = new Uint8Array(width * height * 4), andMask = new Uint8Array(width * height),
    pointSample = image.depth < 32 ||
      (image.encoding === 'png' && image.width >= width && image.height >= height)
  for (let y = 0; y < height; y++) {
    const nearY = nearest(y, image.height, height),
      sy = height === 1 ? 0 : y * (image.height - 1) / (height - 1),
      y0 = Math.floor(sy), y1 = Math.min(image.height - 1, y0 + 1), fy = sy - y0
    for (let x = 0; x < width; x++) {
      const target = y * width + x, nearX = nearest(x, image.width, width),
        source = nearY * image.width + nearX
      // Boolean AND remains a separate plane. Color interpolation must never
      // turn inversion into alpha transparency or interpolate the mask values.
      andMask[target] = image.andMask[source]!
      if (pointSample) {
        data.set(image.data.subarray(source * 4, source * 4 + 4), target * 4)
      } else {
        // General 32-bit smooth-scaling candidate. Hosted 13x9 and 48x48
        // observations establish smoothing and endpoint behavior, but expose
        // additional byte quantization not yet reproduced here. Keep every
        // frame and compare every output pixel in the native loading gate;
        // neither a claimed match nor a first-frame fallback is justified.
        const sx = width === 1 ? 0 : x * (image.width - 1) / (width - 1),
          x0 = Math.floor(sx), x1 = Math.min(image.width - 1, x0 + 1), fx = sx - x0
        for (let channel = 0; channel < 4; channel++) {
          const top = image.data[(y0 * image.width + x0) * 4 + channel]! * (1 - fx) +
              image.data[(y0 * image.width + x1) * 4 + channel]! * fx,
            bottom = image.data[(y1 * image.width + x0) * 4 + channel]! * (1 - fx) +
              image.data[(y1 * image.width + x1) * 4 + channel]! * fx
          data[target * 4 + channel] = Math.floor(top * (1 - fy) + bottom * fy)
        }
        if (image.mode === 'and-xor') data[target * 4 + 3] = 255
      }
    }
    if ((y & 7) === 7) await options.checkpoint?.()
  }
  return { ...image, width, height, hotspot, data, andMask }
}

/** Apply the fixed desktop file-loading policy to a complete decoded asset.
 * The raw decoder deliberately retains every image; currently it therefore
 * rejects a corrupt unselected image before this policy runs. Matching native
 * select-before-decode acceptance still requires a directory-level loader.
 * Smooth scaling and unobserved ranking ties remain explicit candidates whose
 * native comparison failures must not be dropped or relabeled as passes. */
export async function loadCursorAsset(
  source: CursorAsset,
  profile: CursorLoadProfile = windowsDesktopCursorProfile,
  options: CursorLoadOptions = {},
): Promise<CursorAsset> {
  const target = profileValue(profile)
  if (!source || (source.kind !== 'cur' && source.kind !== 'ani') ||
      !Array.isArray(source.frames) || !source.frames.length || source.frames.length > cursorLimits.frames ||
      !Array.isArray(source.sequence) || !source.sequence.length || source.sequence.length > cursorLimits.steps ||
      !Array.isArray(source.rates) || source.rates.length !== source.sequence.length ||
      source.sequence.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= source.frames.length) ||
      source.rates.some((rate) => !Number.isSafeInteger(rate) || rate < 0) ||
      source.rates.reduce((sum, rate) => sum + rate, 0) !== source.durationJiffies ||
      source.durationJiffies > cursorLimits.durationJiffies ||
      !Number.isSafeInteger(source.sourceBytes) || source.sourceBytes < 1 || source.sourceBytes > cursorLimits.sourceBytes)
    fail('invalid decoded asset')
  let pixels = 0
  const selected = source.frames.map((frame) => {
    if (!Array.isArray(frame.images)) fail('invalid frame directory')
    const image = select(frame.images, target)
    pixels += image.width * image.height
    if (pixels > cursorLimits.pixels) fail('selected image budget exceeded')
    return snapshot(image)
  }), metadata = {
    kind: source.kind, sourceBytes: source.sourceBytes,
    sequence: [...source.sequence], rates: [...source.rates], durationJiffies: source.durationJiffies,
    ...(source.animation ? { animation: { ...source.animation } } : {}),
  }, frames: CursorAsset['frames'] = []
  // Selection, source planes and metadata are snapshotted before suspension.
  await options.checkpoint?.()
  for (const image of selected) {
    frames.push({ images: [await resize(image, target, options)] })
    await options.checkpoint?.()
  }
  return { ...metadata, frames, imageCount: frames.length,
    decodedBytes: frames.length * target.width * target.height * 5 }
}
