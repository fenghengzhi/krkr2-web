import { isHelpDocument, type HelpDocument, type HelpPort } from '../../engine/ports/help.ts'
import { helpError, isHelpResponse, type HelpMessage } from '../../protocol/help.ts'

/** Only presentation acknowledgement waits here; dismissal never owns a script continuation. */
export class PortHelpBackend implements HelpPort {
  private next = 1
  private closed = false
  private pending?: {
    id: number
    resolve(presented: boolean): void
    reject(error: unknown): void
  }

  constructor(
    private readonly port: MessagePort,
    private readonly generation: number,
  ) {
    if (!Number.isSafeInteger(generation) || generation <= 0)
      throw new RangeError('Invalid help generation')
    port.addEventListener('message', this.message)
    port.addEventListener('messageerror', this.messageError)
    port.start()
  }

  private readonly message = (event: MessageEvent<unknown>) => {
    if (this.closed || !event.data || typeof event.data !== 'object') return
    const message = event.data as Partial<HelpMessage>
    if (message.type === 'close') {
      if (message.generation === this.generation)
        this.retire(helpError('AbortError', 'Help host closed'), false)
      return
    }
    if (message.type !== 'reply' || !message.response || typeof message.response !== 'object')
      return
    const response = message.response,
      pending = this.pending
    if (!pending || response.generation !== this.generation || response.id !== pending.id) return
    this.pending = undefined
    if (!isHelpResponse(response)) pending.reject(helpError('DataError', 'Invalid help response'))
    else if (response.ok) pending.resolve(response.presented)
    else pending.reject(helpError(response.error.name, response.error.message))
  }

  private readonly messageError = () => {
    this.retire(helpError('DataError', 'Help message could not be decoded'), true)
  }

  show(document: HelpDocument): Promise<boolean> {
    if (this.closed) return Promise.reject(helpError('AbortError', 'Help host closed'))
    if (!isHelpDocument(document))
      return Promise.reject(helpError('DataError', 'Invalid help document'))
    if (this.pending)
      return Promise.reject(helpError('InvalidStateError', 'A help presentation is pending'))
    if (!Number.isSafeInteger(this.next))
      return Promise.reject(new RangeError('Help request IDs exhausted'))
    const id = this.next++
    return new Promise((resolve, reject) => {
      const pending = { id, resolve, reject }
      this.pending = pending
      try {
        this.port.postMessage({
          type: 'request',
          request: {
            generation: this.generation,
            id,
            document: { path: document.path, title: document.title, text: document.text },
          },
        } satisfies HelpMessage)
      } catch (error) {
        // A synchronously completed older send must not retire a replacement.
        if (this.pending !== pending) return
        this.pending = undefined
        try {
          this.retire(helpError('AbortError', 'Help transport failed'), true)
        } catch (cleanupError) {
          reject(new AggregateError([error, cleanupError], 'Help send and cleanup failed'))
          return
        }
        reject(error)
      }
    })
  }

  close(): void {
    this.retire(helpError('AbortError', 'Help host closed'), true)
  }

  private retire(error: Error, notify: boolean): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    this.port.removeEventListener('message', this.message)
    this.port.removeEventListener('messageerror', this.messageError)
    pending?.reject(error)
    const errors: unknown[] = []
    for (const action of [
      () => {
        if (notify)
          this.port.postMessage({ type: 'close', generation: this.generation } satisfies HelpMessage)
      },
      () => this.port.close(),
    ]) {
      try {
        action()
      } catch (cleanupError) {
        errors.push(cleanupError)
      }
    }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Help backend cleanup failed')
  }
}
