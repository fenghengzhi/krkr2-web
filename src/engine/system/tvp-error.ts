import { tvpMessageIds, type TvpMessageId } from './tvp-message-ids.ts'

export interface TvpMessage {
  readonly id: TvpMessageId
  readonly args: readonly string[]
}

/** Preserve the native message identity until the operation returns to TJS.
 * A readable Web diagnostic is retained for failures before a VM exists;
 * an active runtime resolves the current native holder instead. */
export class TvpError extends Error {
  readonly tvpMessage: TvpMessage
  constructor(id: TvpMessageId, args: readonly string[] = [], diagnostic?: string, options?: ErrorOptions) {
    super(diagnostic ?? id, options)
    if (!tvpMessageIds.includes(id) || !Array.isArray(args) || args.length > 2 ||
        args.some((arg) => typeof arg !== 'string'))
      throw new Error('Invalid native TVP message descriptor')
    this.name = 'TvpError'
    this.tvpMessage = Object.freeze({ id, args: Object.freeze([...args]) })
  }
}
