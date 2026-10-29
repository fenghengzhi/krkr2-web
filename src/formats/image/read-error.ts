/** A selected image handler could not satisfy a real source ReadBuffer.
 * Validation, decompression and bounded in-memory tag parsing are different
 * errors. The engine resolves the native TJS holder only at its VM boundary. */
export class ImageReadError extends Error {
  constructor(readonly format: 'bmp' | 'png' | 'tlg', readonly offset: number,
    readonly requested: number, readonly actual: number, diagnostic: string) {
    super(diagnostic)
    this.name = 'ImageReadError'
  }
}
