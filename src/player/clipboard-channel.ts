import {
  isClipboardRequest,
  isClipboardResponse,
  validClipboardIdentity,
  clipboardRequestError,
  clipboardResponseError,
  type ClipboardMessage,
  type ClipboardRequest,
  type ClipboardResponse,
} from '../protocol/clipboard.ts'

/** Window-side transport. The presentation invokes the real API from its click handler. */
export class ClipboardChannel {
  private closed = false
  private lastId = 0
  private pending?: ClipboardRequest

  constructor(
    private readonly port: MessagePort,
    private readonly generation: number,
    private readonly onRequest: (request: ClipboardRequest | null) => void,
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new RangeError('Invalid clipboard generation')
    port.addEventListener('message', this.message)
    port.addEventListener('messageerror', this.messageError)
    port.start()
  }

  private readonly message = (event: MessageEvent<unknown>) => {
    if (this.closed || !event.data || typeof event.data !== 'object') return
    const message = event.data as Partial<ClipboardMessage>
    if (message.type === 'close') {
      if (message.generation === this.generation) this.retire(false)
      return
    }
    if (
      message.type !== 'request' ||
      !message.request ||
      typeof message.request !== 'object' ||
      !validClipboardIdentity(message.request) ||
      message.request.generation !== this.generation ||
      message.request.id <= this.lastId
    )
      return
    const error = clipboardRequestError(message.request)
    if (error || !isClipboardRequest(message.request)) {
      this.sendReply({
        type: 'reply',
        response: {
          generation: this.generation,
          id: message.request.id,
          ok: false,
          error: error ?? { name: 'DataError', message: 'Invalid clipboard request' },
        },
      })
      return
    }
    // Forward only the bounded protocol fields, not extra sender-owned data.
    const request: ClipboardRequest = Object.freeze(
      message.request.op === 'write-text'
        ? {
            generation: this.generation,
            id: message.request.id,
            op: 'write-text',
            text: message.request.text,
          }
        : { generation: this.generation, id: message.request.id, op: message.request.op },
    )
    if (this.pending) {
      this.sendReply({
        type: 'reply',
        response: {
          id: request.id,
          generation: this.generation,
          ok: false,
          error: { name: 'InvalidStateError', message: 'A clipboard request is pending' },
        },
      } satisfies ClipboardMessage)
      return
    }
    this.lastId = request.id
    this.pending = request
    try {
      this.onRequest(request)
    } catch (error) {
      if (this.pending !== request || this.closed) return
      // A failed presentation cannot leave a Worker waiting for an inaccessible button.
      this.pending = undefined
      const response: ClipboardResponse = {
        id: request.id,
        generation: this.generation,
        ok: false,
        error: {
          name: error instanceof Error ? error.name : 'Error',
          message: error instanceof Error ? error.message : String(error),
        },
      }
      try {
        this.onRequest(null)
      } finally {
        if (!this.closed) this.sendReply({ type: 'reply', response })
      }
    }
  }

  private readonly messageError = () => this.close()

  respond(response: ClipboardResponse): boolean {
    const request = this.pending
    if (
      this.closed ||
      !request ||
      !response ||
      typeof response !== 'object' ||
      response.generation !== this.generation ||
      response.id !== request.id
    )
      return false
    const operation = response.ok && response.result?.op
    if (
      operation &&
      ['has-text', 'read-text', 'write-text'].includes(operation) &&
      operation !== request.op
    )
      return false
    const error = clipboardResponseError(response)
    if (error || !isClipboardResponse(response))
      response = {
        generation: this.generation,
        id: request.id,
        ok: false,
        error: error ?? { name: 'DataError', message: 'Invalid clipboard response' },
      }
    else if (!response.ok)
      response = {
        generation: this.generation,
        id: request.id,
        ok: false,
        error: { name: response.error.name, message: response.error.message },
      }
    else {
      const result = response.result
      response = {
        generation: this.generation,
        id: request.id,
        ok: true,
        result:
          result.op === 'read-text'
            ? {
                op: result.op,
                content: result.content.hasText
                  ? { hasText: true, text: result.content.text }
                  : { hasText: false },
              }
            : result.op === 'has-text'
              ? { op: result.op, hasText: result.hasText }
              : { op: result.op },
      }
    }
    this.pending = undefined
    try {
      this.onRequest(null)
    } finally {
      if (!this.closed) this.sendReply({ type: 'reply', response })
    }
    return !this.closed
  }

  close(): void {
    this.retire(true)
  }

  private sendReply(message: Extract<ClipboardMessage, { type: 'reply' }>): void {
    const error = clipboardResponseError(message.response)
    if (error)
      message = {
        type: 'reply',
        response: {
          generation: this.generation,
          id: message.response.id,
          ok: false,
          error,
        },
      }
    try {
      this.port.postMessage(message)
    } catch (error) {
      try {
        // A failed result send must not leave an active UI or an open local
        // channel. A separate close notification may still reach the Worker.
        this.retire(true)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Clipboard send and cleanup failed')
      }
      throw error
    }
  }

  private retire(notify: boolean): void {
    if (this.closed) return
    this.closed = true
    const hadPending = !!this.pending
    this.pending = undefined
    this.port.removeEventListener('message', this.message)
    this.port.removeEventListener('messageerror', this.messageError)
    try {
      if (hadPending) this.onRequest(null)
    } finally {
      try {
        if (notify)
          this.port.postMessage({
            type: 'close',
            generation: this.generation,
          } satisfies ClipboardMessage)
      } finally {
        this.port.close()
      }
    }
  }
}
