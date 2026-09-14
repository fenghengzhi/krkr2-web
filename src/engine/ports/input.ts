export type InputPacket =
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
  | { type: 'keyDown' | 'keyUp'; key: number; shift: number }
  | { type: 'text'; text: string }
  | {
      type: 'touchDown' | 'touchMove' | 'touchUp'
      x: number
      y: number
      width: number
      height: number
      id: number
    }
export interface InputView {
  cursor: number
  hint: string
  focused: number
  attentionX: number
  attentionY: number
  imeMode: number
}
export const shiftButtons = 8 | 16 | 32 | 256 | 512
