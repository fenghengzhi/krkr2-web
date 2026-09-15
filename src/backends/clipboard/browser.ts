import type { ClipboardPort, ClipboardText } from '../../engine/ports/clipboard.ts'
import {
  assertClipboardText,
  clipboardBlobLimit,
  clipboardError,
} from '../../engine/ports/clipboard.ts'

/** Window-only clipboard access. Invoke these methods directly from a user action. */
export class BrowserClipboard implements ClipboardPort {
  private closed = false
  private readonly pending = new Set<(error: unknown) => void>()

  private access(): Clipboard {
    if (
      typeof window === 'undefined' ||
      !window.isSecureContext ||
      typeof navigator === 'undefined' ||
      !navigator.clipboard
    )
      throw new DOMException('This context does not provide the Clipboard API', 'NotSupportedError')
    return navigator.clipboard
  }

  private read(): Promise<ClipboardItems> {
    const clipboard = this.access()
    if (typeof clipboard.read !== 'function')
      throw new DOMException(
        'This browser cannot inspect clipboard text formats',
        'NotSupportedError',
      )
    return clipboard.read()
  }

  private run<T>(start: () => Promise<T>): Promise<T> {
    if (this.closed)
      return Promise.reject(new DOMException('Clipboard host is closed', 'AbortError'))
    // Run before creating any asynchronous continuation: the browser must see
    // the user activation of the button handler that called this method.
    let work: Promise<T>
    try {
      work = start()
    } catch (error) {
      return Promise.reject(error)
    }
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const take = () => {
        if (settled) return false
        settled = true
        this.pending.delete(cancel)
        return true
      }
      const cancel = (error: unknown) => {
        if (take()) reject(error)
      }
      this.pending.add(cancel)
      // Always consume both outcomes, including after close. Clipboard API
      // operations have no AbortSignal; closing only retires our own wait.
      void work.then(
        (value) => {
          if (take()) resolve(value)
        },
        (error) => {
          if (take()) reject(error)
        },
      )
      if (this.closed) cancel(new DOMException('Clipboard host is closed', 'AbortError'))
    })
  }

  hasText(): Promise<boolean> {
    return this.run(() =>
      this.read().then((items) => items.some((item) => item.types.includes('text/plain'))),
    )
  }

  readText(): Promise<ClipboardText> {
    return this.run(() =>
      this.read().then(async (items): Promise<ClipboardText> => {
        const item = items.find((entry) => entry.types.includes('text/plain'))
        if (!item) return { hasText: false }
        const blob = await item.getType('text/plain')
        if (blob.size > clipboardBlobLimit)
          throw clipboardError(
            'QuotaExceededError',
            `Clipboard text representation exceeds ${clipboardBlobLimit} bytes`,
          )
        const text = await blob.text()
        assertClipboardText(text)
        return { hasText: true, text }
      }),
    )
  }

  writeText(text: string): Promise<void> {
    return this.run(() => {
      assertClipboardText(text)
      const clipboard = this.access()
      if (typeof clipboard.writeText !== 'function')
        throw new DOMException('This browser cannot write clipboard text', 'NotSupportedError')
      return clipboard.writeText(text)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const error = new DOMException('Clipboard host is closed', 'AbortError')
    for (const cancel of this.pending) cancel(error)
  }
}
