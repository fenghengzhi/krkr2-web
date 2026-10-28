import type { DecodedImage } from '../ports/graphics.ts'
import { TvpError } from '../system/tvp-error.ts'
import { decodeSelectedBmp } from '../../formats/image/bmp.ts'
import { decodeSelectedPng } from '../../formats/image/png.ts'
import { decodeSelectedTlg } from '../../formats/image/tlg/index.ts'
import { ImageDecodeError, type ImageDecodeSelection } from '../../formats/image/selection.ts'

export interface SelectedImageDecoderDependencies {
  finish<T>(work: Generator<void, T>): Promise<T>
  inflate(compressed: Uint8Array, length: number): Promise<Uint8Array>
  host(bytes: Uint8Array, selection: ImageDecodeSelection): Promise<DecodedImage>
}

function* grayscale(image: DecodedImage, jpeg: boolean): Generator<void, DecodedImage> {
  // A browser JPEG yields RGB, not libjpeg's original Y plane. This is the
  // explicit Web approximation (BT.601), not a claim of native JPEG equality.
  // BMP uses the fixed TVP conversion, including indexed palette entries.
  const data = new Uint8Array(image.data.length)
  for (let at = 0; at < data.length; at += 4) {
    const r = image.data[at]!, g = image.data[at + 1]!, b = image.data[at + 2]!,
      value = jpeg ? (19595 * r + 38470 * g + 7471 * b + 32768) >>> 16
        : (54 * r + 183 * g + 19 * b) >>> 8
    data[at] = data[at + 1] = data[at + 2] = value
    data[at + 3] = 255
    if (at % 16384 === 16380) yield
  }
  const { indices: _indices, ...rest } = image
  return { ...rest, data, grayscale: true }
}

/** Dispatch exactly once by the already chosen native handler. Never try a
 * second format after a codec error or unsupported portable decoding branch. */
export async function decodeSelectedImage(
  bytes: Uint8Array,
  selection: ImageDecodeSelection,
  dependencies: SelectedImageDecoderDependencies,
): Promise<DecodedImage> {
  const selected = Object.freeze({ format: selection.format, mode: selection.mode })
  try {
    switch (selected.format) {
      case 'eri':
        throw new TvpError('TVPNotImplemented', [], 'ERI image decoding is not available')
      case 'bmp': {
        const image = decodeSelectedBmp(bytes, selected.mode) ?? await dependencies.host(bytes, selected)
        return selected.mode === 'grayscale' ? dependencies.finish(grayscale(image, false)) : image
      }
      case 'png': {
        const plan = await dependencies.finish(decodeSelectedPng(bytes, selected.mode)),
          expanded = await dependencies.inflate(plan.compressed, plan.expandedLength)
        return await dependencies.finish(plan.decode(expanded))
      }
      case 'tlg':
        return await dependencies.finish(decodeSelectedTlg(bytes, selected.mode))
      case 'jpeg': {
        if (selected.mode === 'palettized')
          throw new ImageDecodeError('jpeg', 'JPEG does not support palettized image')
        // A host must never accept PNG/GIF/etc. under a chosen JPEG extension.
        // Exact libjpeg numeric diagnostics remain a separate compatibility gap.
        if (bytes.length < 3) throw new Error('Truncated JPEG signature')
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
          throw new Error('Selected JPEG handler received a non-JPEG stream')
        const image = await dependencies.host(bytes, selected)
        return selected.mode === 'grayscale' ? dependencies.finish(grayscale(image, true)) : image
      }
      default:
        throw new Error('Unknown selected image handler')
    }
  } catch (error) {
    if (!(error instanceof ImageDecodeError)) throw error
    const id = {
      bmp: 'TVPImageLoadError', jpeg: 'TVPJPEGLoadError', png: 'TVPPNGLoadError', tlg: 'TVPTLGLoadError',
    } as const
    throw new TvpError(id[error.format], [error.reason], error.message, { cause: error })
  }
}
