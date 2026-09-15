import {
  clipboardTextLimit,
  type ClipboardError,
  type ClipboardText,
} from '../engine/ports/clipboard.ts'

export type ClipboardCommand =
  { readonly op: 'has-text' | 'read-text' } | { readonly op: 'write-text'; readonly text: string }

export type ClipboardRequest = ClipboardCommand & {
  readonly generation: number
  readonly id: number
}

export type ClipboardResult =
  | { readonly op: 'has-text'; readonly hasText: boolean }
  | { readonly op: 'read-text'; readonly content: ClipboardText }
  | { readonly op: 'write-text' }

export type ClipboardResponse = { readonly generation: number; readonly id: number } & (
  | { readonly ok: true; readonly result: ClipboardResult }
  | { readonly ok: false; readonly error: ClipboardError }
)

export type ClipboardMessage =
  | { readonly type: 'request'; readonly request: ClipboardRequest }
  | { readonly type: 'reply'; readonly response: ClipboardResponse }
  | { readonly type: 'close'; readonly generation: number }

export function validClipboardIdentity(value: { generation?: unknown; id?: unknown }): boolean {
  return (
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    Number.isSafeInteger(value.id) &&
    (value.id as number) > 0
  )
}

export function isClipboardRequestShape(value: unknown): value is ClipboardRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ClipboardRequest>
  return (
    validClipboardIdentity(request) &&
    (request.op === 'has-text' ||
      request.op === 'read-text' ||
      (request.op === 'write-text' && typeof request.text === 'string'))
  )
}

function isClipboardResponseShape(value: unknown): value is ClipboardResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<ClipboardResponse>
  if (!validClipboardIdentity(response)) return false
  if (response.ok === false)
    return (
      !!response.error &&
      typeof response.error.name === 'string' &&
      typeof response.error.message === 'string'
    )
  if (response.ok !== true || !response.result) return false
  const result = response.result
  return (
    (result.op === 'has-text' && typeof result.hasText === 'boolean') ||
    result.op === 'write-text' ||
    (result.op === 'read-text' &&
      !!result.content &&
      typeof result.content === 'object' &&
      ((result.content.hasText === false && !('text' in result.content)) ||
        (result.content.hasText === true && typeof result.content.text === 'string')))
  )
}

const invalid = (): ClipboardError => ({ name: 'DataError', message: 'Invalid clipboard payload' })
const tooLarge = (): ClipboardError => ({
  name: 'QuotaExceededError',
  message: `Clipboard text exceeds ${clipboardTextLimit} UTF-16 code units`,
})

/** A recognizable request must receive this error, not be silently dropped. */
export function clipboardRequestError(value: unknown): ClipboardError | undefined {
  if (!isClipboardRequestShape(value)) return invalid()
  if (value.op === 'write-text' && value.text.length > clipboardTextLimit) return tooLarge()
}

export function clipboardResponseError(value: unknown): ClipboardError | undefined {
  if (!isClipboardResponseShape(value)) return invalid()
  if (!value.ok) {
    if (
      value.error.name.length > clipboardTextLimit ||
      value.error.message.length > clipboardTextLimit
    )
      return tooLarge()
  } else if (
    value.result.op === 'read-text' &&
    value.result.content.hasText &&
    value.result.content.text.length > clipboardTextLimit
  )
    return tooLarge()
}

export function isClipboardRequest(value: unknown): value is ClipboardRequest {
  return !clipboardRequestError(value)
}

export function isClipboardResponse(value: unknown): value is ClipboardResponse {
  return !clipboardResponseError(value)
}
