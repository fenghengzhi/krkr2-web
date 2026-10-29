/** PNG-only pull inflation. ZIP/text decompression uses its separate API. */
export type ImageInflateStatus = 'ok' | 'end' | 'data-error' | 'need-dictionary' |
  'memory-error' | 'buffer-error'

export interface ImageInflateStep {
  inputUsed: number
  outputUsed: number
  status: ImageInflateStatus
  nativeReason?: string
}

export interface ImageInflater {
  /** Synchronous, with fixed Z_PARTIAL_FLUSH. Only output[0..outputUsed) is
   * written; retain input[inputUsed..] for the next call. No host callbacks. */
  step(input: Uint8Array, output: Uint8Array): ImageInflateStep
  close(): void
}

export interface ImageInflaterKernel {
  open(): ImageInflater
  dispose(): void
  inspect(): { active: number; allocatedBytes: number; peakAllocatedBytes: number }
}

/** Session-owned lazy loading/cancellation boundary. source identifies the
 * encoded request for observation; the native kernel never retains it. */
export interface ImageInflaterProvider {
  open(source: Uint8Array, expectedLength: number): Promise<ImageInflater>
  dispose(): void
}

export const IMAGE_INFLATE_MAX_STREAMS = 64
export const IMAGE_INFLATE_MAX_INPUT = 8192
/** Current maximum PNG source row: 4096 RGBA16 pixels and one filter byte. */
export const IMAGE_INFLATE_MAX_OUTPUT = 4096 * 8 + 1
