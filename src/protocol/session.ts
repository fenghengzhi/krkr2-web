import type { EngineEvent, SessionSnapshot } from '../engine/session.ts'
import type { SaveCopyResult, SaveFile, SaveScope, SaveTransferSource } from '../engine/ports/saves.ts'
import type { InputPacket } from '../engine/ports/input.ts'
import type { ActivityState } from '../engine/ports/activity.ts'
import type { ApplicationActivation } from '../engine/ports/application.ts'
import type { FontDescriptor, FontPreview } from '../engine/ports/fonts.ts'
import type { DebugPanel } from '../engine/diagnostics/panels.ts'
import type { MenuPopupIdentity } from '../engine/scene/menus.ts'
import type { PadAck, PadMessage, PadFontData } from './pad.ts'
import type { SystemDisplayMetrics, SystemDisplayUpdate } from '../engine/system/display.ts'
import type { WindowMoveMessage } from '../engine/ports/window-move.ts'
import type { WindowPopupMessage } from '../engine/ports/window-popup.ts'
import type { DroppedTree } from '../engine/ports/storage-drop.ts'
import type { WindowFileDropIdentity } from '../engine/ports/window-file-drop.ts'
import type { ImageJpegPrecision } from '../engine/ports/image-jpeg.ts'
import type { CddaDisc } from '../engine/ports/cdda.ts'
export const PROTOCOL_VERSION = 63
export interface WindowFileDropRequest extends WindowFileDropIdentity {
  readonly generation: number
  readonly tree: DroppedTree<Blob>
}
export interface LocalGameFile {
  path: string
  blob: Blob
}
export interface RemoteGameFile {
  path: string
  url: string
}
export type GameFile = LocalGameFile | RemoteGameFile
/** manifestUrl here identifies a published game directory listing. */
export type GameInput = GameFile[] | { libraryId: string } | { manifestUrl: string }
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
  /** Raw relative -datapath configuration, normalized once by the engine. */
  dataPath?: string
  /** Optional startup-only -jpegdec setting; omitted differs from explicit normal. */
  jpegPrecision?: ImageJpegPrecision
  /** Explicit imported-disc bindings; omitted discovers one project CUE. */
  cddaDiscs?: readonly CddaDisc[]
  /** Immutable page/embedding palette, validated again before Worker resources are created. */
  systemColors?: readonly number[]
  /** Player-local CSS geometry, sampled before its Worker is initialized. */
  systemDisplay?: SystemDisplayMetrics
  gameId: string
  audio: MessagePort
  video: MessagePort
  /** A distinct channel keeps clipboard requests independent of a suspended script RPC. */
  clipboard?: MessagePort
  /** Help presentation ACKs are independent of a suspended script RPC. */
  help?: MessagePort
  /** Independent of suspended script RPC; only acknowledged geometry commits. */
  geometry?: MessagePort
  /** A host capable of completing the synchronous Window movement interaction. */
  windowMoveSupported?: boolean
  activity: ActivityState
  application?: ApplicationActivation
}
export type SessionEvent = EngineEvent & { generation: number; sequence: number }
/** Admission acknowledges validation/queueing, not completion of TJS callbacks.
 * Callback failures are reported by the owning Session's failure/state events. */
export interface InputAdmissionAck {
  status: 'accepted' | 'ignored'
}
export interface SessionApi {
  prepare(files: GameInput, project?: import('../engine/storage/project.ts').ProjectSelection, entry?: string, discs?: readonly CddaDisc[]): Promise<string | { gameId: string; files: RemoteGameFile[] }>
  initialize(request: InitializeRequest): Promise<SessionSnapshot>
  mount(): Promise<SessionSnapshot>
  start(entry: string): Promise<SessionSnapshot>
  evaluate(source: string): Promise<string>
  pause(): Promise<SessionSnapshot>
  resume(): Promise<SessionSnapshot>
  retryGraphics(): Promise<SessionSnapshot>
  setActivity(activity: ActivityState): Promise<SessionSnapshot>
  applicationActivation(generation: number, value: ApplicationActivation): Promise<InputAdmissionAck>
  /** Legacy programmatic helpers retain callback-completion semantics. */
  click(x: number, y: number): Promise<void>
  pointerMove(x: number, y: number): Promise<void>
  pointerState(x: number, y: number, windowId?: number, pointerSequence?: number,
    physicalScreen?: import('../engine/ports/input.ts').PhysicalPointerScreen): Promise<void>
  screenPointerState(screen: import('../engine/ports/input.ts').PhysicalPointerScreen): Promise<void>
  /** Resolve immediately after admission so browser input can continue queueing. */
  input(packet: InputPacket): Promise<InputAdmissionAck>
  dropFiles(request: WindowFileDropRequest): Promise<InputAdmissionAck>
  cancelFileDrop(request: Omit<WindowFileDropRequest, 'tree'>): Promise<void>
  keyState(keys: number[]): Promise<void>
  exitFullScreen(windowId?: number): Promise<void>
  activateWindow(windowId: number): Promise<InputAdmissionAck>
  closeWindow(windowId: number): Promise<InputAdmissionAck>
  moveWindow(windowId: number, left: number, top: number): Promise<void>
  windowMove(message: WindowMoveMessage): Promise<boolean>
  windowPopup(message: WindowPopupMessage): Promise<InputAdmissionAck>
  resizeWindow(windowId: number, width: number, height: number): Promise<void>
  refreshWindowGeometry(windowId: number): Promise<void>
  menuClick(id: number, popup?: MenuPopupIdentity): Promise<InputAdmissionAck>
  menuDismiss(popup?: MenuPopupIdentity): Promise<void>
  setSystemFonts(fonts: FontDescriptor[]): Promise<void>
  setSystemDisplay(generation: number, update: SystemDisplayUpdate): Promise<void>
  setDebugVisibility(panel: DebugPanel, visible: boolean): Promise<SessionSnapshot>
  selectFont(id: number, face: string | null): Promise<void>
  selectSystemDialog(id: number, value: string | null): Promise<boolean>
  browseStorageSelector(id: number, directory: string): Promise<import('../engine/ports/storage-selector.ts').StorageSelectorDirectory | null>
  pad(message: PadMessage): Promise<PadAck>
  padFont(generation: number, id: number, epoch: number): Promise<PadFontData | null>
  previewFont(id: number, face: string, kind?: 'sample' | 'label'): Promise<FontPreview | null>
  inspect(): Promise<SessionSnapshot>
  stop(): Promise<void>
  exportSaves(scope?: SaveScope): Promise<SaveFile[]>
  importSaves(files: SaveFile[], scope?: SaveScope): Promise<void>
  listSaveVersions(): Promise<SaveTransferSource[]>
  saveVersionPaths(id: string): Promise<{ paths: string[]; destination: string }>
  copyVersionSaves(id: string, directory: string, replace: boolean): Promise<SaveCopyResult>
}
