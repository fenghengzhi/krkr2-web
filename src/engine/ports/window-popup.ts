/** Host Window messages, not a script method or a command to hide DOM. */
export type WindowPopupMessage =
  | { type: 'window'; windowId: number }
  | { type: 'application'; active: boolean }
