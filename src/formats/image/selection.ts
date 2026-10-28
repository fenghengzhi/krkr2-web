/** Selected by the native extension registry before opening the resource. */
export interface ImageDecodeSelection {
  readonly format: 'bmp' | 'jpeg' | 'png' | 'tlg' | 'eri'
  readonly mode: 'normal' | 'grayscale' | 'palettized'
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
