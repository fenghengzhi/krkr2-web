import type { EngineEvent, SessionSnapshot } from '../engine/session.ts'
import type { SaveFile } from '../engine/ports/saves.ts'
import type { InputPacket } from '../engine/ports/input.ts'
import type { ActivityState } from '../engine/ports/activity.ts'
import type { FontDescriptor, FontPreview } from '../engine/ports/fonts.ts'
import type { DebugPanel } from '../engine/diagnostics/panels.ts'
export const PROTOCOL_VERSION = 9
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
  canvas: OffscreenCanvas
  events: MessagePort
  manifestUrl: string
  backend: BackendPreference
  gameId: string
  audio: MessagePort
  video: MessagePort
  activity: ActivityState
}
export type SessionEvent = EngineEvent & { generation: number; sequence: number }
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
  click(x: number, y: number): Promise<void>
  pointerMove(x: number, y: number): Promise<void>
  pointerState(x: number, y: number): Promise<void>
  input(packet: InputPacket): Promise<void>
  keyState(keys: number[]): Promise<void>
  exitFullScreen(): Promise<void>
  menuClick(id: number): Promise<void>
  menuDismiss(): Promise<void>
  setSystemFonts(fonts: FontDescriptor[]): Promise<void>
  setDebugVisibility(panel: DebugPanel, visible: boolean): Promise<SessionSnapshot>
  selectFont(id: number, face: string | null): Promise<void>
  previewFont(id: number, face: string, kind?: 'sample' | 'label'): Promise<FontPreview | null>
  inspect(): Promise<SessionSnapshot>
  stop(): Promise<void>
  exportSaves(): Promise<SaveFile[]>
  importSaves(files: SaveFile[]): Promise<void>
}
