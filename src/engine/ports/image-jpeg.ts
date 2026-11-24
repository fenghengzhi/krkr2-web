/** Original JPEG handler settings; command-line "normal" means IFAST/fancy. */
export type ImageJpegPrecision = 'low' | 'normal' | 'high'
export type ImageJpegMode = 'normal' | 'grayscale'
export type ImageJpegPhase = 'header' | 'start' | 'rows' | 'finish' | 'complete'
export interface ImageJpegStep {
  /** Accepted encoded source bytes, including pending marker skips. */
  inputUsed: number
  needsInput: boolean
  phase: ImageJpegPhase
  status: 'progress' | 'size' | 'rows' | 'done' | 'codec-error' | 'budget-error'
  width?: number
  height?: number
  startRow?: number
  rowCount?: number
  /** Owned canonical RGBA bytes for a fully completed native row group. */
  data?: Uint8Array
  /** The original IJG6b message code, only for codec-error. */
  code?: number
  /** Explicit Web budget diagnosis, never formatted as a native JPEG code. */
  budgetReason?: string
  /** Passive observations; the original loader ignores JPEG warnings. */
  warnings: { count: number; lastCode?: number }
}
export interface ImageJpegDecoder {
  /** At most one bounded source window per step, no host callback or nested
   * VM entry. eof states that no bytes follow this offered input. */
  step(input: Uint8Array, eof: boolean): ImageJpegStep
  close(): void
}
export interface ImageJpegKernel {
  open(mode: ImageJpegMode, precision: ImageJpegPrecision): ImageJpegDecoder
  dispose(): void
  inspect(): { active: number; allocatedBytes: number; peakAllocatedBytes: number }
}
export interface ImageJpegProvider {
  open(source: Uint8Array, mode: ImageJpegMode, precision: ImageJpegPrecision): Promise<ImageJpegDecoder>
  dispose(): void
}
export const IMAGE_JPEG_MAX_STREAMS = 64
export const IMAGE_JPEG_MAX_INPUT = 8192
export const IMAGE_JPEG_MAX_OUTPUT = 4096 * 4 * 2
export const IMAGE_JPEG_MAX_SOURCE = 64 * 1024 * 1024
export const IMAGE_JPEG_MAX_DIMENSION = 4096
