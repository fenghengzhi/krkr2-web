import type { EngineEvent, SessionSnapshot } from '../engine/session.ts'
import type { SaveFile } from '../engine/ports/saves.ts'
import type { InputPacket } from '../engine/ports/input.ts'
import type { ActivityState } from '../engine/ports/activity.ts'
import type { FontDescriptor, FontPreview } from '../engine/ports/fonts.ts'
import type { DebugPanel } from '../engine/diagnostics/panels.ts'
import type { MenuPopupIdentity } from '../engine/scene/menus.ts'
export const PROTOCOL_VERSION = 13
export interface LocalGameFile {
  path: string
  blob: Blob
}
export interface RemoteGameFile {
  path: string
  url: string
}
export type GameFile = LocalGameFile | RemoteGameFile
export type GameInput = GameFile[] | { libraryId: string }
export type BackendPreference = 'auto' | 'asyncify' | 'jspi'
export interface InitializeRequest {
  systemFonts: FontDescriptor[]
  version: number
  generation: number
  surfaces: MessagePort
  events: MessagePort
  manifestUrl: string
  backend: BackendPreference
  debugMode?: boolean
  gameId: string
  audio: MessagePort
  video: MessagePort
  activity: ActivityState
}
export type SessionEvent = EngineEvent & { generation: number; sequence: number }
/** Admission acknowledges validation/queueing, not completion of TJS callbacks.
 * Callback failures are reported by the owning Session's failure/state events. */
export interface InputAdmissionAck {
  status: 'accepted' | 'ignored'
}
export interface SessionApi {
  prepare(files: GameInput): Promise<string>
  initialize(request: InitializeRequest): Promise<SessionSnapshot>
  mount(): Promise<SessionSnapshot>
  start(entry: string): Promise<SessionSnapshot>
  evaluate(source: string): Promise<string>
  pause(): Promise<SessionSnapshot>
  resume(): Promise<SessionSnapshot>
  retryGraphics(): Promise<SessionSnapshot>
  setActivity(activity: ActivityState): Promise<SessionSnapshot>
  /** Legacy programmatic helpers retain callback-completion semantics. */
  click(x: number, y: number): Promise<void>
  pointerMove(x: number, y: number): Promise<void>
  pointerState(x: number, y: number, windowId?: number): Promise<void>
  /** Resolve immediately after admission so browser input can continue queueing. */
  input(packet: InputPacket): Promise<InputAdmissionAck>
  keyState(keys: number[]): Promise<void>
  exitFullScreen(windowId?: number): Promise<void>
  activateWindow(windowId: number): Promise<InputAdmissionAck>
  closeWindow(windowId: number): Promise<InputAdmissionAck>
  moveWindow(windowId: number, left: number, top: number): Promise<void>
  resizeWindow(windowId: number, width: number, height: number): Promise<void>
  menuClick(id: number, popup?: MenuPopupIdentity): Promise<InputAdmissionAck>
  menuDismiss(popup?: MenuPopupIdentity): Promise<void>
  setSystemFonts(fonts: FontDescriptor[]): Promise<void>
  setDebugVisibility(panel: DebugPanel, visible: boolean): Promise<SessionSnapshot>
  selectFont(id: number, face: string | null): Promise<void>
  selectSystemDialog(id: number, value: string | null): Promise<boolean>
  previewFont(id: number, face: string, kind?: 'sample' | 'label'): Promise<FontPreview | null>
  inspect(): Promise<SessionSnapshot>
  stop(): Promise<void>
  exportSaves(): Promise<SaveFile[]>
  importSaves(files: SaveFile[]): Promise<void>
}
