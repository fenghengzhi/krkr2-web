/** Only failures for which the fixed native TextStream has a TVP message.
 * Offset, resource budgets, cancellation and host capability failures retain
 * their own error identity instead of being inferred from diagnostic text. */
export type TextStreamErrorKind = 'unsupported-cipher' | 'unsupported-mode' | 'compression-failed'

export class TextStreamError extends Error {
  constructor(readonly kind: TextStreamErrorKind, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TextStreamError'
  }
}
