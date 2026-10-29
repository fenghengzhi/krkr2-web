/** Selected by the native extension registry before opening the resource. */
export interface ImageDecodeSelection {
  readonly format: 'bmp' | 'jpeg' | 'png' | 'tlg' | 'eri'
  readonly mode: 'normal' | 'grayscale' | 'palettized'
}

/** Synchronous selected-decoder output. Rows are borrowed RGBA/index views;
 * consume or copy them before returning. A row is reported only after its
 * complete conversion, matching the native scanline(-1) notification. */
export interface ImageDecodeProgress {
  size(width: number, height: number): void
  /** A transformed caller row was written, before scanline completion. PNG's
   * final trailer check can still fail here. No key or tiling is implied. */
  write?(y: number, rgba: Uint8Array, indices?: Uint8Array): void
  row(y: number, rgba: Uint8Array, indices?: Uint8Array): void
}

/** Only an explicit decoder branch with a known native message reason.
 * Short reads, host failures, cancellation and Web budgets are not this type. */
export class ImageDecodeError extends Error {
  constructor(
    readonly format: Exclude<ImageDecodeSelection['format'], 'eri'>,
    readonly reason: string,
  ) {
    super(reason)
    this.name = 'ImageDecodeError'
  }
}
