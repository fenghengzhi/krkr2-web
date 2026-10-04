export type InputPacket = {
  windowId?: number
  /** Exact editing ownership, including the focused Layer; used by IME commits. */
  keyboardRouteRevision?: number
  /** Ordinary input follows Layer focus within the same live Window route. */
  keyboardInputRevision?: number
  /** One physical mouse observation, shared with pointerState. Positive and
   * increasing within a Window across surface replacement; absent for legacy
   * embedding input and script-posted events. */
  pointerSequence?: number
} & (
  | {
      type: 'move' | 'down' | 'up'
      x: number
      y: number
      shift: number
      button: number
      clicks: number
    }
  | { type: 'leave' | 'cancel' | 'activate' | 'deactivate' }
  | { type: 'wheel'; x: number; y: number; shift: number; delta: number }
  | { type: 'keyDown' | 'keyUp'; key: number; shift: number; systemKey?: boolean }
  | { type: 'text'; text: string }
  | {
      type: 'touchDown' | 'touchMove' | 'touchUp'
      x: number
      y: number
      width: number
      height: number
      id: number
    }
)
/** A copied CSS font description, never a Layer/Font script ownership edge. */
export interface InputAttentionFont {
  face: string
  height: number
  bold: boolean
  italic: boolean
  underline: boolean
  strikeout: boolean
}
export interface InputAttention {
  /** Window client coordinates after its drawing transform, before CSS scaling. */
  x: number
  y: number
  focusLayerId: number
  pointLayerId: number
  font: InputAttentionFont | null
}
export interface VirtualCursor {
  /** Window client coordinates after the drawing transform, before CSS scaling. */
  x: number
  y: number
  /** Session-monotonic write identity; never reused after retirement. */
  revision: number
  /** Latest physical sample observed by this Window when the script moved it. */
  basePhysicalSequence: number
}
export interface InputView {
  cursor: number
  hint: string
  focused: number
  attention: InputAttention | null
  attentionX: number
  attentionY: number
  imeMode: number
  /** A Web cursor overlay, never an assertion that the OS pointer moved. */
  virtualCursor?: VirtualCursor | null
  keyboardRoute?: {
    windowId: number
    revision: number
    inputRevision?: number
    focused: number
    imeMode: number
  }
}
export const shiftButtons = 8 | 16 | 32 | 256 | 512
