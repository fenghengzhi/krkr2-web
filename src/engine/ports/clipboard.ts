/** Presence and content are separate: an empty text representation is not absent. */
export type ClipboardText = { hasText: false } | { hasText: true; text: string }

/** Bounds are UTF-16 code units, matching TJS and JavaScript string lengths. */
export const clipboardTextLimit = 1_048_576
/** Reject a text Blob before decoding or materializing its string. */
export const clipboardBlobLimit = 4 * 1024 * 1024

export function assertClipboardText(value: unknown): asserts value is string {
  if (typeof value !== 'string')
    throw clipboardError('DataError', 'Clipboard text must be a string')
  if (value.length > clipboardTextLimit)
    throw clipboardError(
      'QuotaExceededError',
      `Clipboard text exceeds ${clipboardTextLimit} UTF-16 code units`,
    )
}

/** A host clipboard. Calls may await a user action; they never pump script events. */
export interface ClipboardPort {
  hasText(): Promise<boolean>
  readText(): Promise<ClipboardText>
  writeText(text: string): Promise<void>
  /** Retire waiting requests. An already issued platform write cannot be retracted. */
  close(): void
}

export interface ClipboardError {
  readonly name: string
  readonly message: string
}

export function clipboardError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

export const unavailableClipboard = (): ClipboardPort => {
  const unavailable = () =>
    Promise.reject(clipboardError('NotSupportedError', 'A clipboard host is not available'))
  return {
    hasText: unavailable,
    readText: unavailable,
    writeText: unavailable,
    close() {},
  }
}
