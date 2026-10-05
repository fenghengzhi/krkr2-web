/** A synchronous script call owns one host move interaction until completion. */
export interface WindowMoveRequest {
  readonly requestId: number
  readonly windowId: number
  readonly left: number
  readonly top: number
}
export type WindowMoveMessage = {
  requestId: number
  windowId: number
  sequence: number
} & (
  | { type: 'update' | 'commit'; left: number; top: number }
  | { type: 'cancel' }
  | { type: 'error'; message: string }
)
