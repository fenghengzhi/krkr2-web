import type { ImageJpegPrecision } from '../engine/ports/image-jpeg.ts'

/** Validate before allocating Player or Worker resources. Omission must remain
 * absent from System.getArgument, even though decoding defaults to normal. */
export function copyJpegPrecision(value: unknown): ImageJpegPrecision | undefined {
  if (value === undefined || value === 'low' || value === 'normal' || value === 'high') return value
  throw new Error('JPEG precision must be low, normal or high')
}
