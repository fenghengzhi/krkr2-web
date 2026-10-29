/** Only native ReadBuffer short reads have been audited for this boundary. */
export type TjsMessageId = 'TJSReadError'
export interface TjsMessage { readonly id: TjsMessageId }

/** Resolve the existing TJS holder when the native reply is consumed. This is
 * separate from TVP's catalog and has no placeholder/argument expansion. */
export class TjsError extends Error {
  readonly tjsMessage: TjsMessage
  constructor(id: TjsMessageId, diagnostic?: string, options?: ErrorOptions) {
    super(diagnostic ?? id, options)
    if (id !== 'TJSReadError') throw new Error('Invalid native TJS message descriptor')
    this.name = 'TjsError'
    this.tjsMessage = Object.freeze({ id })
  }
}
