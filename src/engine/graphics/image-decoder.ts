import type { DecodedImage } from '../ports/graphics.ts'
import { TvpError } from '../system/tvp-error.ts'
import { TjsError } from '../system/tjs-error.ts'
import { decodeSelectedBmp } from '../../formats/image/bmp.ts'
import { decodeSelectedPng, prepareSelectedPngStream } from '../../formats/image/png.ts'
import { decodeSelectedTlg } from '../../formats/image/tlg/index.ts'
import { ImageDecodeError, type ImageDecodeSelection, type ImageDecodeProgress } from '../../formats/image/selection.ts'
import type { ImageInflater } from '../ports/image-inflater.ts'
import { ImageReadError } from '../../formats/image/read-error.ts'

export interface SelectedImageDecoderDependencies {
  finish<T>(work: Generator<void, T>): Promise<T>
  inflate(compressed: Uint8Array, length: number): Promise<Uint8Array>
  openInflater?(source: Uint8Array, expandedLength: number): Promise<ImageInflater>
  host(bytes: Uint8Array, selection: ImageDecodeSelection): Promise<DecodedImage>
}

class ProgressFailure {
  constructor(readonly cause: unknown) {}
}
class InflaterFailure {
  constructor(readonly cause: unknown) {}
}
function original(error: unknown): unknown {
  return error instanceof ProgressFailure || error instanceof InflaterFailure ? error.cause : error
}
function codecError(error: unknown): unknown {
  if (error instanceof ImageReadError)
    return new TjsError('TJSReadError', error.message, { cause: error })
  if (error instanceof ImageDecodeError) {
    const id = {
      bmp: 'TVPImageLoadError', jpeg: 'TVPJPEGLoadError', png: 'TVPPNGLoadError', tlg: 'TVPTLGLoadError',
    } as const
    return new TvpError(id[error.format], [error.reason], error.message, { cause: error })
  }
  return error
}
function codec<T>(read: () => T): T {
  try { return read() }
  catch (error) { throw codecError(error) }
}
function* codecWork<T>(create: () => Generator<void, T>): Generator<void, T> {
  // Only the codec's own reads/validation are translated. The scheduler and
  // asynchronous host dependencies remain outside this boundary, including
  // errors a scheduler injects at the yield. Close the delegated work on Stop.
  const work = codec(create)
  try {
    for (;;) {
      const next = codec(() => work.next())
      if (next.done) return next.value
      yield
    }
  } finally { work.return(undefined as T) }
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
  const { format, mode, paletteKey } = selection
  if (paletteKey !== undefined && (mode !== 'normal' || !Number.isInteger(paletteKey) || paletteKey < 0 || paletteKey > 255))
    throw new Error('Invalid selected image palette key')
  const selected = Object.freeze({ format, mode, ...(paletteKey === undefined ? {} : { paletteKey }) }),
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
        const portable = codec(() => decodeSelectedBmp(bytes, selected.mode, progress))
        if (portable) return portable
        let image = await dependencies.host(bytes, selected)
        if (selected.mode === 'grayscale' && !image.grayscale) image = await dependencies.finish(grayscale(image, false))
        return progress ? await dependencies.finish(publish(image, progress)) : image
      }
      case 'png': {
        if (dependencies.openInflater) {
          const plan = await dependencies.finish(codecWork(() => prepareSelectedPngStream(bytes, selected.mode, progress, selected.paletteKey))),
            inflater = await dependencies.openInflater(bytes, plan.expandedLength)
          const guarded: ImageInflater = {
            step(input, output) {
              try { return inflater.step(input, output) }
              catch (error) { throw new InflaterFailure(error) }
            },
            close() { inflater.close() },
          }
          let failed: { error: unknown } | undefined
          try { return await dependencies.finish(codecWork(() => plan.decode(guarded))) }
          catch (error) { failed = { error }; throw error }
          finally {
            try { inflater.close() }
            catch (cleanup) {
              if (!failed) throw cleanup
              const primary = original(failed.error)
              throw new AggregateError([primary, cleanup], 'PNG decoding and inflater cleanup failed', { cause: primary })
            }
          }
        }
        const plan = await dependencies.finish(codecWork(() => decodeSelectedPng(bytes, selected.mode, progress, selected.paletteKey))),
          expanded = await dependencies.inflate(plan.compressed, plan.expandedLength)
        return await dependencies.finish(codecWork(() => plan.decode(expanded)))
      }
      case 'tlg':
        return await dependencies.finish(codecWork(() => decodeSelectedTlg(bytes, selected.mode, progress)))
      case 'jpeg': {
        if (selected.mode === 'palettized')
          throw codecError(new ImageDecodeError('jpeg', 'JPEG does not support palettized image'))
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
    throw original(error)
  }
}
