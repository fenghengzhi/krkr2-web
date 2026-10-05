import { cursorLimits, decodeCursorSelection, type CursorAsset, type CursorImage,
  type CursorDecodeOptions, type CursorDirectoryEntry } from './index.ts'

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
function imageDimensions(image: Pick<CursorImage, 'width' | 'height' | 'depth'>): void {
  if (!image || !Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.width > 256 || image.height < 1 || image.height > 256 ||
      !Number.isSafeInteger(image.depth) || image.depth < 0 || image.depth > 65535)
    fail('invalid image dimensions or depth')
}
function select<T extends Pick<CursorImage, 'width' | 'height' | 'depth'>>(images: readonly T[], profile: CursorLoadProfile): T {
  if (!images.length || images.length > cursorLimits.imagesPerFrame) fail('invalid image directory')
  let selected: T | undefined, best: number[] | undefined
  for (const image of images) {
    imageDimensions(image)
    // File loading is not the resource-directory API's documented preference
    // for smaller images: both directory orders select 48 over 16. The crossed
    // rectangle fixtures select 48x40/40x48 before closer 32x16/16x32 entries.
    // Prefer the group that covers both target dimensions before distance;
    // equal geometry/depth ranks preserve the original directory order.
    const distance = Math.abs(image.width - profile.width) + Math.abs(image.height - profile.height),
      below = image.width < profile.width || image.height < profile.height,
      rank = [Number(below), distance, -image.width * image.height,
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
  if (image.depth < 1 || image.depth > 32 ||
      !(image.data instanceof Uint8Array) || !(image.andMask instanceof Uint8Array) ||
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
/** Deleted monochrome pixels accumulate into the next centered sample. The
 * complete 085 256-to-32 axis observations give [0,4], [5,12], ... [245,252].
 * Repeated samples while enlarging have a single source pixel. 086's 3770
 * native mask comparisons cover this ratio and seven further square/mixed
 * geometries. Other sizes remain subject to the strict native probes. */
function maskRange(at: number, source: number, target: number): [number, number] {
  const last = nearest(at, source, target)
  return [at ? Math.min(last, nearest(at - 1, source, target) + 1) : 0, last]
}
/** File loading narrows the directory hotspot to signed SHORT, rounds the
 * scaled value by truncating after +0.5 (also for negatives), and stores a
 * signed SHORT result in ICONINFO's DWORD fields. Preserve that unsigned API
 * value; presentation interprets it as signed when positioning the raster. */
export function loadedCursorHotspot(
  image: Pick<CursorImage, 'width' | 'height' | 'hotspot' | 'icon'>,
  profile: CursorLoadProfile = windowsDesktopCursorProfile,
): { x: number; y: number } {
  const target = profileValue(profile)
  if (!Number.isSafeInteger(image.width) || !Number.isSafeInteger(image.height) ||
      image.width < 1 || image.width > 256 || image.height < 1 || image.height > 256 ||
      !image.hotspot || !Number.isSafeInteger(image.hotspot.x) || !Number.isSafeInteger(image.hotspot.y) ||
      image.hotspot.x < 0 || image.hotspot.x > 65535 || image.hotspot.y < 0 || image.hotspot.y > 65535)
    fail('invalid source hotspot')
  if (image.icon) return { x: target.width >>> 1, y: target.height >>> 1 }
  const scale = (value: number, source: number, destination: number) => {
    const signed = value << 16 >> 16, rounded = Math.trunc(signed * destination / source + 0.5)
    return (rounded << 16 >> 16) >>> 0
  }
  return { x: scale(image.hotspot.x, image.width, target.width),
    y: scale(image.hotspot.y, image.height, target.height) }
}
async function resize(image: CursorImage, profile: CursorLoadProfile, options: CursorLoadOptions): Promise<CursorImage> {
  const width = profile.width, height = profile.height,
    hotspot = loadedCursorHotspot(image, profile),
    monochrome = image.encoding === 'dib' && image.depth === 1 && image.mode === 'and-xor'
  if (image.width === width && image.height === height) return { ...image, hotspot }
  const data = new Uint8Array(width * height * 4), andMask = new Uint8Array(width * height),
    // 082's alpha planes and 097's independent zero-alpha asymmetric plane
    // both establish a centered 2x2 average for 64x64 -> 32x32. The color
    // reduction does not depend on whether alpha or AND/XOR draws the result;
    // the Boolean mask retains its separate native support below.
    halfSizeColor = image.depth === 32 &&
      image.width === width * 2 && image.height === height * 2,
    // 100's paired native desktops preserve smoothing through 65, then use
    // centered point samples at every size 66..80 on either axis, even when
    // the other axis enlarges from 13. This boundary is for the fixed 32x32
    // profile; it is not a claim about other target sizes or DPI settings.
    // Keep the separately observed integer reductions and half-size average.
    pointSample = image.depth < 32 ||
      image.width >= 66 || image.height >= 66 ||
      (image.width >= width && image.height >= height &&
        image.width % width === 0 && image.height % height === 0)
  // 089's two native desktops distinguish a 16-bit fractional step from the
  // earlier binary32 candidate: it matches all 41 complete smooth planes,
  // including independent axes, asymmetric/checker fields and integral-Y
  // rows. Quantize each endpoint ratio once, then accumulate exactly in
  // binary64. The separate point/half-alpha paths do not use these steps.
  const stepX = Math.floor((image.width - 1) * 65536 / (width - 1)) / 65536,
    stepY = Math.floor((image.height - 1) * 65536 / (height - 1)) / 65536
  let positionY = 0
  for (let row = 0; row < height; row++, positionY += stepY) {
    // Native planes originate from bottom-up DIB memory. Keep its traversal
    // and incremental coordinates even though our public plane is top-down.
    const y = height - 1 - row, nearY = nearest(y, image.height, height),
      sy = Math.min(image.height - 1, positionY), baseY = Math.floor(sy),
      y0 = image.height - 1 - baseY, y1 = Math.max(0, y0 - 1), fy = sy - baseY,
      maskY = maskRange(y, image.height, height),
      xorY = monochrome ? maskRange(y + height, image.height * 2, height * 2) : undefined
    let positionX = 0
    for (let x = 0; x < width; x++, positionX += stepX) {
      const target = y * width + x, nearX = nearest(x, image.width, width),
        source = nearY * image.width + nearX, maskX = maskRange(x, image.width, width)
      // Keep Boolean mask operations distinct from color interpolation;
      // inversion must not become alpha transparency or a fractional mask.
      let and = 255
      for (let my = maskY[0]; my <= maskY[1]; my++) for (let mx = maskX[0]; mx <= maskX[1]; mx++)
        and &= image.andMask[my * image.width + mx]!
      andMask[target] = and
      if (xorY) {
        // Native monochrome ICONINFO has one double-height bitmap. 085's raw
        // XOR first row includes the AND plane's final three source rows at
        // 256-to-32; independently resizing each half loses that boundary.
        for (let channel = 0; channel < 3; channel++) {
          let xor = 255
          for (let my = xorY[0]; my <= xorY[1]; my++) for (let mx = maskX[0]; mx <= maskX[1]; mx++)
            xor &= my < image.height ? image.andMask[my * image.width + mx]!
              : image.data[((my - image.height) * image.width + mx) * 4 + channel]!
          data[target * 4 + channel] = xor
        }
        data[target * 4 + 3] = 255
      } else if (halfSizeColor) {
        const from = (y * 2 * image.width + x * 2) * 4, nextRow = from + image.width * 4
        for (let channel = 0; channel < 4; channel++)
          data[target * 4 + channel] = Math.floor((image.data[from + channel]! +
            image.data[from + 4 + channel]! + image.data[nextRow + channel]! +
            image.data[nextRow + 4 + channel]!) / 4)
      } else if (pointSample) {
        data.set(image.data.subarray(source * 4, source * 4 + 4), target * 4)
      } else {
        // 081's raw color planes distinguish the axis order and byte stages:
        // an exact source row sums its horizontal terms before truncating;
        // other rows truncate each horizontal term before the vertical sum.
        // Retain strict full-plane/native drawing comparisons for the whole
        // profile: unobserved source geometries remain evidence boundaries.
        const sx = Math.min(image.width - 1, positionX),
          x0 = Math.floor(sx), x1 = Math.min(image.width - 1, x0 + 1), fx = sx - x0
        for (let channel = 0; channel < 4; channel++) {
          const a = image.data[(y0 * image.width + x0) * 4 + channel]! * (1 - fx),
            b = image.data[(y0 * image.width + x1) * 4 + channel]! * fx,
            c = image.data[(y1 * image.width + x0) * 4 + channel]! * (1 - fx),
            d = image.data[(y1 * image.width + x1) * 4 + channel]! * fx
          data[target * 4 + channel] = fy === 0 ? Math.floor(a + b)
            : Math.floor((Math.floor(a) + Math.floor(b)) * (1 - fy) +
                (Math.floor(c) + Math.floor(d)) * fy)
        }
        if (image.mode === 'and-xor') data[target * 4 + 3] = 255
      }
    }
    if ((row & 7) === 7) await options.checkpoint?.()
  }
  return { ...image, width, height, hotspot, data, andMask }
}

/** Apply the fixed desktop file-loading policy to a complete decoded asset.
 * Use loadCursorBytes when acceptance must match selection before decoding.
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
  // 081's ani-single reference loads one encoded frame/step (default rate 9)
  // as a static cursor with native rate 0. Do not extend that observation to
  // multiple encoded frames or multiple steps; the raw decoder keeps its rate.
  const staticAni = source.kind === 'ani' && source.frames.length === 1 && source.sequence.length === 1
  let pixels = 0
  const selected = source.frames.map((frame) => {
    if (!Array.isArray(frame.images)) fail('invalid frame directory')
    const image = select(frame.images, target)
    pixels += image.width * image.height
    if (pixels > cursorLimits.pixels) fail('selected image budget exceeded')
    return snapshot(image)
  }), metadata = {
    kind: source.kind, sourceBytes: source.sourceBytes,
    sequence: [...source.sequence], rates: staticAni ? [0] : [...source.rates],
    durationJiffies: staticAni ? 0 : source.durationJiffies,
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

/** Load complete CUR/ANI bytes, choosing one entry per frame before pixel
 * decoding. An invalid selected entry fails; no lower-ranked fallback occurs.
 * decodeCursor remains the separate full-directory inspection API. */
export async function loadCursorBytes(
  input: Uint8Array,
  options: CursorDecodeOptions,
  profile: CursorLoadProfile = windowsDesktopCursorProfile,
): Promise<CursorAsset> {
  const target = profileValue(profile), source = await decodeCursorSelection(input, options,
    (entries: readonly CursorDirectoryEntry[]) => select(entries, target).index)
  return loadCursorAsset(source, target, { checkpoint: options.checkpoint })
}
