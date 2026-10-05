/** A codec data/processing failure, distinct from IO, allocation, host
 * capability and cooperative checkpoint failures around that codec. */
export class CompressionError extends Error {
  constructor(readonly operation: 'inflate' | 'deflate', message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'CompressionError'
  }
}
