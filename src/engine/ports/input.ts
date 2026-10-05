export interface MouseKeyObservation {
  /** Keyboard receiver, which can differ from the focused source Window. */
  windowId: number
  x: number
  y: number
  /** Window client pixels per CSS pixel at observation time. */
  scaleX: number
  scaleY: number
  /** Zero means that the page has not observed a real pointer yet. */
  pointerSequence: number
}
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
  /** Legacy mouse integer coordinates relative to the PaintBox at event
   * capture/admission time. Raw x/y remain Window client observation values.
   * Window callbacks must not reinterpret this point after a queued zoom or
   * layer-origin change. Touch events never use this field. */
  paintBoxPoint?: { x: number; y: number }
  /** Browser geometry/physical sampling only. Conversion happens after native
   * keyboard routing and trap-key admission in the engine. */
  mouseKeyObservation?: MouseKeyObservation
  /** TickBeat observes held keys before polling the next Gamepad sample.
   * This snapshot only drives emulation; it never replaces physical state. */
  mouseKeyKeys?: number[]
} & (
  | {
      type: 'move' | 'down' | 'up' | 'click'
      x: number
      y: number
      shift: number
      button: number
      clicks: number
    }
  | { type: 'leave' | 'cancel' | 'activate' | 'deactivate' | 'mouseKeyTick' }
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
  /** Session settings interpreted by TJS; joypad enablement is fixed at the
   * first Window, while repeat timing follows later argument changes. */
  gamepad?: { enabled: boolean; delay: number; interval: number }
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
