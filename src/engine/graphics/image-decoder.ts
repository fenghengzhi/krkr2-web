import type { DecodedImage } from '../ports/graphics.ts'
import { TvpError } from '../system/tvp-error.ts'
import { decodeSelectedBmp } from '../../formats/image/bmp.ts'
import { decodeSelectedPng, prepareSelectedPngStream } from '../../formats/image/png.ts'
import { decodeSelectedTlg } from '../../formats/image/tlg/index.ts'
import { ImageDecodeError, type ImageDecodeSelection, type ImageDecodeProgress } from '../../formats/image/selection.ts'
import type { ImageInflater } from '../ports/image-inflater.ts'

export interface SelectedImageDecoderDependencies {
  finish<T>(work: Generator<void, T>): Promise<T>
  inflate(compressed: Uint8Array, length: number): Promise<Uint8Array>
  openInflater?(source: Uint8Array, expandedLength: number): Promise<ImageInflater>
  host(bytes: Uint8Array, selection: ImageDecodeSelection): Promise<DecodedImage>
}

class ProgressFailure {
  constructor(readonly cause: unknown) {}
}

function* publish(image: DecodedImage, progress?: ImageDecodeProgress): Generator<void, DecodedImage> {
  if (progress) {
    progress.size(image.width, image.height)
    for (let y = 0; y < image.height; y++) {
      progress.row(y, image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4),
        image.indices?.subarray(y * image.width, (y + 1) * image.width))
      yield
    }
  }
  return image
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
  observer?: ImageDecodeProgress,
): Promise<DecodedImage> {
  const selected = Object.freeze({ format: selection.format, mode: selection.mode }),
    progress: ImageDecodeProgress | undefined = observer && {
      size(width, height) {
        try { observer.size(width, height) } catch (error) { throw new ProgressFailure(error) }
      },
      row(y, rgba, indices) {
        try { observer.row(y, rgba, indices) } catch (error) { throw new ProgressFailure(error) }
      },
      write(y, rgba, indices) {
        try { observer.write?.(y, rgba, indices) } catch (error) { throw new ProgressFailure(error) }
      },
    }
  try {
    switch (selected.format) {
      case 'eri':
        throw new TvpError('TVPNotImplemented', [], 'ERI image decoding is not available')
      case 'bmp': {
        const portable = decodeSelectedBmp(bytes, selected.mode, progress)
        if (portable) return portable
        let image = await dependencies.host(bytes, selected)
        if (selected.mode === 'grayscale' && !image.grayscale) image = await dependencies.finish(grayscale(image, false))
        return progress ? await dependencies.finish(publish(image, progress)) : image
      }
      case 'png': {
        if (dependencies.openInflater) {
          const plan = await dependencies.finish(prepareSelectedPngStream(bytes, selected.mode, progress)),
            inflater = await dependencies.openInflater(bytes, plan.expandedLength)
          let failed: { error: unknown } | undefined
          try { return await dependencies.finish(plan.decode(inflater)) }
          catch (error) { failed = { error }; throw error }
          finally {
            try { inflater.close() }
            catch (cleanup) {
              if (!failed) throw cleanup
              const primary = failed.error instanceof ProgressFailure ? failed.error.cause : failed.error
              throw new AggregateError([primary, cleanup], 'PNG decoding and inflater cleanup failed', { cause: primary })
            }
          }
        }
        const plan = await dependencies.finish(decodeSelectedPng(bytes, selected.mode, progress)),
          expanded = await dependencies.inflate(plan.compressed, plan.expandedLength)
        return await dependencies.finish(plan.decode(expanded))
      }
      case 'tlg':
        return await dependencies.finish(decodeSelectedTlg(bytes, selected.mode, progress))
      case 'jpeg': {
        if (selected.mode === 'palettized')
          throw new ImageDecodeError('jpeg', 'JPEG does not support palettized image')
        // A host must never accept PNG/GIF/etc. under a chosen JPEG extension.
        // Exact libjpeg numeric diagnostics remain a separate compatibility gap.
        if (bytes.length < 3) throw new Error('Truncated JPEG signature')
        if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff)
          throw new Error('Selected JPEG handler received a non-JPEG stream')
        let image = await dependencies.host(bytes, selected)
        if (selected.mode === 'grayscale') image = await dependencies.finish(grayscale(image, true))
        return progress ? await dependencies.finish(publish(image, progress)) : image
      }
      default:
        throw new Error('Unknown selected image handler')
    }
  } catch (error) {
    if (error instanceof ProgressFailure) throw error.cause
    if (!(error instanceof ImageDecodeError)) throw error
    const id = {
      bmp: 'TVPImageLoadError', jpeg: 'TVPJPEGLoadError', png: 'TVPPNGLoadError', tlg: 'TVPTLGLoadError',
    } as const
    throw new TvpError(id[error.format], [error.reason], error.message, { cause: error })
  }
}
