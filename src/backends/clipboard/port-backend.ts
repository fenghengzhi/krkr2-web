import {
  clipboardError,
  assertClipboardText,
  type ClipboardPort,
  type ClipboardText,
} from '../../engine/ports/clipboard.ts'
import {
  isClipboardResponse,
  clipboardResponseError,
  type ClipboardCommand,
  type ClipboardMessage,
  type ClipboardResult,
} from '../../protocol/clipboard.ts'

/** Worker side. Only host I/O waits here; no TJS event pump or permission guesses. */
export class PortClipboardBackend implements ClipboardPort {
  private next = 1
  private closed = false
  private pending?: {
    id: number
    op: ClipboardCommand['op']
    resolve(result: ClipboardResult): void
    reject(error: unknown): void
  }

  constructor(
    private readonly port: MessagePort,
    private readonly generation: number,
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
      if (message.generation === this.generation)
        this.retire(clipboardError('AbortError', 'Clipboard host closed'), false)
      return
    }
    if (message.type !== 'reply' || !message.response || typeof message.response !== 'object')
      return
    const response = message.response,
      pending = this.pending
    if (!pending || response.generation !== this.generation || response.id !== pending.id) return
    this.pending = undefined
    const invalid = clipboardResponseError(response)
    if (invalid) pending.reject(clipboardError(invalid.name, invalid.message))
    else if (!isClipboardResponse(response) || (response.ok && response.result.op !== pending.op))
      pending.reject(clipboardError('DataError', 'Invalid clipboard response'))
    else if (response.ok) pending.resolve(response.result)
    else pending.reject(clipboardError(response.error.name, response.error.message))
  }

  private readonly messageError = () => {
    this.retire(clipboardError('DataError', 'Clipboard message could not be decoded'), true)
  }

  private send(command: ClipboardCommand): Promise<ClipboardResult> {
    if (this.closed) return Promise.reject(clipboardError('AbortError', 'Clipboard host closed'))
    if (this.pending)
      return Promise.reject(clipboardError('InvalidStateError', 'A clipboard request is pending'))
    if (!Number.isSafeInteger(this.next))
      return Promise.reject(new RangeError('Clipboard request IDs exhausted'))
    const id = this.next++
    return new Promise((resolve, reject) => {
      const pending = { id, op: command.op, resolve, reject }
      this.pending = pending
      try {
        this.port.postMessage({
          type: 'request',
          request: { ...command, id, generation: this.generation },
        } satisfies ClipboardMessage)
      } catch (error) {
        if (this.pending === pending) this.pending = undefined
        reject(error)
      }
    })
  }

  async hasText(): Promise<boolean> {
    const result = await this.send({ op: 'has-text' })
    if (result.op !== 'has-text') throw clipboardError('DataError', 'Invalid clipboard operation')
    return result.hasText
  }

  async readText(): Promise<ClipboardText> {
    const result = await this.send({ op: 'read-text' })
    if (result.op !== 'read-text') throw clipboardError('DataError', 'Invalid clipboard operation')
    return result.content
  }

  async writeText(text: string): Promise<void> {
    assertClipboardText(text)
    await this.send({ op: 'write-text', text })
  }

  close(): void {
    this.retire(clipboardError('AbortError', 'Clipboard host closed'), true)
  }

  private retire(error: Error, notify: boolean): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = undefined
    this.port.removeEventListener('message', this.message)
    this.port.removeEventListener('messageerror', this.messageError)
    pending?.reject(error)
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
