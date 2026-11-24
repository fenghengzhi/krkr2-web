import type { DecodedImage } from '../../engine/ports/graphics.ts'
import { IMAGE_JPEG_MAX_DIMENSION, IMAGE_JPEG_MAX_INPUT, IMAGE_JPEG_MAX_SOURCE,
  type ImageJpegDecoder, type ImageJpegMode, type ImageJpegPhase } from '../../engine/ports/image-jpeg.ts'
import { ImageDecodeError, type ImageDecodeProgress } from './selection.ts'

export class JpegDecodeError extends ImageDecodeError {
  constructor(readonly code: number, readonly phase: ImageJpegPhase,
    readonly warnings: { readonly count: number; readonly lastCode?: number }) {
    super('jpeg', 'error code : ' + code)
    this.name = 'JpegDecodeError'
  }
}

/** Original selected JPEG stages, driven through bounded source suspension.
 * Source EOF belongs to the codec's synthetic EOI policy, never TJSReadError.
 * jpeg_read_scanlines owns its private row group until the whole call succeeds. */
export function* decodeSelectedJpeg(source: Uint8Array, mode: ImageJpegMode, decoder: ImageJpegDecoder,
  progress?: ImageDecodeProgress): Generator<void, DecodedImage> {
  if (source.byteLength > IMAGE_JPEG_MAX_SOURCE) throw new Error('JPEG source exceeds 64 MiB budget')
  let offset = 0, needsInput = true, image: DecodedImage | undefined, rows = 0, stalled = 0
  const empty = new Uint8Array(0)
  for (;;) {
    const input = needsInput ? source.subarray(offset, offset + IMAGE_JPEG_MAX_INPUT) : empty,
      step = decoder.step(input, offset + input.byteLength === source.byteLength)
    if (!Number.isInteger(step.inputUsed) || step.inputUsed < 0 || step.inputUsed > input.byteLength)
      throw new Error('Invalid JPEG source consumption')
    offset += step.inputUsed
    needsInput = step.needsInput
    if (step.status === 'codec-error') {
      if (!Number.isInteger(step.code) || step.code! <= 0) throw new Error('Invalid native JPEG message code')
      throw new JpegDecodeError(step.code!, step.phase, Object.freeze({ ...step.warnings }))
    }
    if (step.status === 'budget-error') throw new Error(step.budgetReason ?? 'JPEG decoder exceeded its Web budget')
    if (step.status === 'size') {
      const width = step.width!, height = step.height!
      if (image || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 ||
          width > IMAGE_JPEG_MAX_DIMENSION || height > IMAGE_JPEG_MAX_DIMENSION)
        throw new Error('Invalid JPEG output dimensions or size phase')
      image = { width, height, data: new Uint8Array(width * height * 4), ...(mode === 'grayscale' ? { grayscale: true } : {}) }
      progress?.size(width, height)
    } else if (step.status === 'rows') {
      if (!image || step.startRow !== rows || !Number.isInteger(step.rowCount) || step.rowCount! < 1 || step.rowCount! > 2 ||
          rows + step.rowCount! > image.height || !(step.data instanceof Uint8Array) ||
          step.data.byteLength !== image.width * step.rowCount! * 4)
        throw new Error('Invalid completed JPEG row group')
      for (let row = 0; row < step.rowCount!; row++) {
        const bytes = step.data.subarray(row * image.width * 4, (row + 1) * image.width * 4)
        image.data.set(bytes, rows * image.width * 4)
        progress?.row(rows, image.data.subarray(rows * image.width * 4, (rows + 1) * image.width * 4))
        rows++
        yield
      }
    } else if (step.status === 'done') {
      if (!image || rows !== image.height || step.phase !== 'complete') throw new Error('Incomplete JPEG output')
      return image
    } else if (step.status !== 'progress') throw new Error('Unknown JPEG decoder step')
    // Native steps can change phase without consuming bytes (size, buffered
    // rows, finish). A broken external kernel must not spin forever at EOF.
    stalled = step.status === 'progress' && step.inputUsed === 0 ? stalled + 1 : 0
    if (stalled > 1024) throw new Error('JPEG decoder made no bounded progress')
    yield
  }
}
