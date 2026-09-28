/** Pure-value auxiliary editor protocol. No TJS handles cross this boundary. */
export interface PadView {
  id: number
  epoch: number
  textEpoch: number
  revision: number
  acceptedEditSeq: number
  text: string
  fileName: string
  color: number
  visible: boolean
  title: string
  /** Actual rendering color; the public fontColor getter intentionally returns color. */
  inkColor: number
  fontHeight: number
  fontSize: number
  fontBold: boolean
  fontItalic: boolean
  fontUnderline: boolean
  fontStrikeOut: boolean
  fontFace: string
  readOnly: boolean
  wordWrap: boolean
  opacity: number
  showStatusBar: boolean
  showScrollBars: number
  statusText: string
  borderStyle: number
  width: number
  height: number
  top: number
  left: number
  blocked: boolean
}
export interface PadIdentity {
  generation: number
  id: number
  epoch: number
  seq: number
  baseTextEpoch: number
}
export type PadMessage = PadIdentity &
  (
    | { kind: 'edit'; text: string }
    | { kind: 'selection'; start: number; end: number }
    | {
        kind: 'geometry'
        mode: 'move' | 'resize' | 'restore'
        left: number
        top: number
        width: number
        height: number
      }
    | { kind: 'close' }
    | { kind: 'save-open' }
    | { kind: 'save-confirm'; requestId: number; fileName: string }
    | { kind: 'save-cancel'; requestId: number }
    | { kind: 'save-outcome'; requestId: number; receipt: number; ok: boolean; error?: string }
  )
export interface PadAck {
  status: 'accepted' | 'ignored'
  view?: PadView
}
export interface PadSaveRequest {
  id: number
  padId: number
  epoch: number
  revision: number
  fileName: string
  /** Snapshot taken after the last acknowledged edit, never the live editor. */
  text: string
  error?: string
  /** Present only after confirmation. Consumed once by the browser host. */
  receipt?: number
}
export interface PadPresentation {
  pendingSaveId: number | null
  pads: readonly PadView[]
  save: PadSaveRequest | null
}

export interface PadFontData {
  family: string
  bold: boolean
  italic: boolean
  bytes: Uint8Array
}
