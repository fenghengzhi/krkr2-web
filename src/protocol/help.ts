import { isHelpDocument, type HelpDocument } from '../engine/ports/help.ts'

export interface HelpRequest {
  readonly generation: number
  readonly id: number
  readonly document: HelpDocument
}

export interface HelpError {
  readonly name: string
  readonly message: string
}

export type HelpResponse = { readonly generation: number; readonly id: number } & (
  | { readonly ok: true; readonly presented: boolean }
  | { readonly ok: false; readonly error: HelpError }
)

export type HelpMessage =
  | { readonly type: 'request'; readonly request: HelpRequest }
  | { readonly type: 'reply'; readonly response: HelpResponse }
  | { readonly type: 'close'; readonly generation: number }

export function validHelpIdentity(value: { generation?: unknown; id?: unknown }): boolean {
  return (
    Number.isSafeInteger(value.generation) &&
    (value.generation as number) > 0 &&
    Number.isSafeInteger(value.id) &&
    (value.id as number) > 0
  )
}

export function isHelpRequest(value: unknown): value is HelpRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<HelpRequest>
  return validHelpIdentity(request) && isHelpDocument(request.document)
}

export function isHelpResponse(value: unknown): value is HelpResponse {
  if (!value || typeof value !== 'object') return false
  const response = value as Partial<HelpResponse>
  if (!validHelpIdentity(response)) return false
  if (response.ok === true) return typeof response.presented === 'boolean'
  return (
    response.ok === false &&
    !!response.error &&
    typeof response.error.name === 'string' &&
    response.error.name.length <= 4096 &&
    typeof response.error.message === 'string' &&
    response.error.message.length <= 4096
  )
}

export function helpError(name: string, message: string): Error {
  const error = new Error(message)
  error.name = name
  return error
}

/** Keep callback failures bounded too; a failed presentation cannot bypass the wire budget. */
export function helpErrorDetails(error: unknown): HelpError {
  try {
    const name = error instanceof Error ? error.name : 'Error',
      message = error instanceof Error ? error.message : String(error)
    if (name.length <= 4096 && message.length <= 4096) return { name, message }
    return { name: 'QuotaExceededError', message: 'Help error description exceeds its budget' }
  } catch {
    return { name: 'Error', message: 'Help presentation failed with an unreadable error' }
  }
}
