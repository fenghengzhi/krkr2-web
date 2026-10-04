import type { HelpDocument } from '../engine/ports/help.ts'
import {
  helpError,
  helpErrorDetails,
  isHelpRequest,
  validHelpIdentity,
  type HelpMessage,
  type HelpResponse,
} from '../protocol/help.ts'

/** Synchronous host installation is acknowledged before the script continues. */
export class HelpChannel {
  private closed = false
  private suspended = false
  private lastId = 0
  private presentedId?: number

  constructor(
    private readonly port: MessagePort,
    private readonly generation: number,
    private readonly onDocument?: (document: HelpDocument | null) => void,
    private readonly onError: (error: unknown) => void = (error) => {
      throw error
    },
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new RangeError('Invalid help generation')
    port.addEventListener('message', this.message)
    port.addEventListener('messageerror', this.messageError)
    port.start()
  }

  private readonly message = (event: MessageEvent<unknown>) => {
    try {
      this.receive(event.data)
    } catch (error) {
      this.onError(error)
    }
  }

  private receive(data: unknown): void {
    if (this.closed || !data || typeof data !== 'object') return
    const message = data as Partial<HelpMessage>
    if (message.type === 'close') {
      if (message.generation === this.generation) this.retire(false)
      return
    }
    // During Stop the cancel RPC owns settlement. Do not resume a waiting TJS
    // catch on this separate port before control has actually been cancelled.
    if (this.suspended) return
    if (
      message.type !== 'request' ||
      !message.request ||
      typeof message.request !== 'object' ||
      !validHelpIdentity(message.request) ||
      message.request.generation !== this.generation ||
      message.request.id <= this.lastId
    )
      return
    const id = message.request.id
    this.lastId = id
    if (!isHelpRequest(message.request)) {
      this.send({
        generation: this.generation,
        id,
        ok: false,
        error: { name: 'DataError', message: 'Invalid help document' },
      })
      return
    }
    if (!this.onDocument) {
      this.send({ generation: this.generation, id, ok: true, presented: false })
      return
    }
    const source = message.request.document,
      document = Object.freeze({ path: source.path, title: source.title, text: source.text })
    this.presentedId = id
    try {
      this.publish(document)
    } catch (error) {
      const errors = [error]
      if (this.presentedId === id) {
        this.presentedId = undefined
        try {
          this.publish(null)
        } catch (cleanupError) {
          errors.push(cleanupError)
        }
      }
      if (!this.closed && !this.suspended)
        this.send({
          generation: this.generation,
          id,
          ok: false,
          error: helpErrorDetails(
            errors.length === 1
              ? error
              : new Error(errors.map((value) => helpErrorDetails(value).message).join('; ')),
          ),
        })
      return
    }
    if (!this.closed && !this.suspended)
      this.send({
        generation: this.generation,
        id,
        ok: true,
        presented: this.presentedId === id,
      })
  }

  private readonly messageError = () => {
    try {
      this.retire(true)
    } catch (error) {
      this.onError(error)
    }
  }

  /** Retire visible UI immediately; the following Stop RPC cancels script work. */
  suspend(): void {
    if (this.closed || this.suspended) return
    this.suspended = true
    this.clear()
  }

  close(): void {
    this.retire(true)
  }

  private clear(): void {
    if (this.presentedId === undefined) return
    this.presentedId = undefined
    this.publish(null)
  }

  private publish(document: HelpDocument | null): void {
    // TypeScript permits async functions in a void callback position. They do
    // not satisfy this API's installation contract and must never earn an ACK.
    const result: unknown = this.onDocument?.(document)
    if (
      result &&
      (typeof result === 'object' || typeof result === 'function') &&
      'then' in result &&
      typeof result.then === 'function'
    ) {
      // Observe rejection from the rejected callback contract. The explicit
      // synchronous TypeError below is the operation's authoritative failure.
      void Promise.resolve(result).catch(() => {})
      throw helpError('TypeError', 'Help presentation callback must complete synchronously')
    }
  }

  private send(response: HelpResponse): void {
    try {
      this.port.postMessage({ type: 'reply', response } satisfies HelpMessage)
    } catch (error) {
      try {
        this.retire(true)
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Help reply and cleanup failed')
      }
      throw error
    }
  }

  private retire(notify: boolean): void {
    if (this.closed) return
    this.closed = true
    this.port.removeEventListener('message', this.message)
    this.port.removeEventListener('messageerror', this.messageError)
    const errors: unknown[] = []
    for (const action of [
      () => this.clear(),
      () => {
        if (notify)
          this.port.postMessage({ type: 'close', generation: this.generation } satisfies HelpMessage)
      },
      () => this.port.close(),
    ]) {
      try {
        action()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Help channel cleanup failed')
  }
}
