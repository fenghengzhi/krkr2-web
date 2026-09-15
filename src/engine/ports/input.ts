export type InputPacket = { windowId?: number; keyboardRouteRevision?: number } & (
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
export interface InputView {
  cursor: number
  hint: string
  focused: number
  attention: InputAttention | null
  attentionX: number
  attentionY: number
  imeMode: number
  keyboardRoute?: {
    windowId: number
    revision: number
    focused: number
    imeMode: number
  }
}
export const shiftButtons = 8 | 16 | 32 | 256 | 512
