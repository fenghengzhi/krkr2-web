import { PadService } from './scene/pads.ts'
import { padClass } from './tvp/pad.ts'
import type { PadAck, PadMessage, PadPresentation, PadFontData } from '../protocol/pad.ts'
import { bootstrap } from './tvp/bootstrap.ts'
import { clipboardClass } from './tvp/clipboard.ts'
import { assertClipboardText, unavailableClipboard, type ClipboardPort } from './ports/clipboard.ts'
import { unavailableHelp, type HelpPort } from './ports/help.ts'
import { getWebLocalName, openHelpDocument } from './system/help.ts'
import { SystemMaintenance } from './system/maintenance.ts'
import { TvpError } from './system/tvp-error.ts'
import { mapTextStreamError } from './system/text-stream-error.ts'
import type { TvpMessageId } from './system/tvp-message-ids.ts'
import { ScriptTextEncoding } from './script/text-encoding.ts'
import { debugBridge } from './tvp/debug.ts'
import { DebugLog } from './diagnostics/log.ts'
import { DebugPanels, type DebugPanel, type DebugVisibility } from './diagnostics/panels.ts'
import { DebugService } from './diagnostics/service.ts'
import { ExecutionCancelled, ExecutionControl, SerialQueue } from './scheduler/control.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type HostHandler,
  type HostReply,
  type ScriptObject,
  type ScriptRuntime,
  type ScriptValue,
} from './script/runtime.ts'
import { StorageResolver } from './storage/resolver.ts'
import { DropStorage } from './storage/drop.ts'
import { copyGameProject, type GameProject } from './storage/project.ts'
import {
  chopStorageExt,
  extractStorageExt,
  extractStorageName,
  extractStoragePath,
  getFullStoragePath,
  storageWritePath,
  toPublicStoragePath,
} from './storage/public-path.ts'
import { ImageLoader, ProvinceImageLoadError } from './storage/images.ts'
import { CursorStorage } from './storage/cursors.ts'
import type { CursorAsset } from '../formats/cursor/index.ts'
import { loadCursorBytes, windowsDesktopCursorProfile } from '../formats/cursor/load.ts'
import { ImageWriter, layerImageMetadata } from './storage/image-writer.ts'
import { LayerTree, type LayerState } from './scene/layers.ts'
import { WindowUpdates } from './scene/window-updates.ts'
import { createWindowRegion, copyWindowRegion, WindowRegions, type WindowRegion } from './scene/window-region.ts'
import { deviceInt, deviceMulDiv, drawDeviceGeometry, fromPrimary, paintBoxPoint, toPrimary } from './scene/draw-device.ts'
import { LayerService } from './scene/layer-objects.ts'
import { captureVideoMixingBitmap } from './media/video-mixing.ts'
import type { DecodedImage, GraphicsDecoder, Renderer, RendererStatus } from './ports/graphics.ts'
import type { ArchiveReader, Inflater, Resource } from './ports/storage.ts'
import { MemorySaveStore, type SaveStore, type SaveFile } from './ports/saves.ts'
import { SaveOverlay } from './storage/save-overlay.ts'
import { StorageSelector, normalizeSelectorPath } from './storage/selector.ts'
import type { DropResourceTree } from './ports/storage-drop.ts'
import type { WindowFileDropIdentity } from './ports/window-file-drop.ts'
import { modeOffset } from '../formats/text/stream.ts'
import { parseStreamMode, parseTextWriterMode, type StreamMode } from '../formats/text/mode.ts'
import { ScriptEvents } from './scheduler/events.ts'
import { SystemEvents, type EventOptions, type EventOutcome } from './scheduler/system-events.ts'
import { systemEventsBridge } from './tvp/system.ts'
import { systemClassValue, systemReadonlyProperties } from './tvp/system-class.ts'
import { SystemEnvironment } from './system/environment.ts'
import {
  systemDisplayProperties,
  type SystemDisplayMetrics,
  type SystemDisplayUpdate,
} from './system/display.ts'
import { checkpointBridge } from './tvp/checkpoints.ts'
import { ModalLoop } from './scheduler/modal-loop.ts'
import { WindowModals } from './scene/window-modal.ts'
import { WindowMoves } from './scene/window-move.ts'
import type { WindowGeometry, WindowGeometryPort, WindowGeometryRequest, WindowGeometryScroll } from './ports/window-geometry.ts'
import { HeadlessWindowGeometry, scrollWindowGeometry, validateWindowGeometry } from './scene/window-geometry.ts'
import type { WindowMoveMessage, WindowMoveRequest } from './ports/window-move.ts'
import type { WindowPopupMessage } from './ports/window-popup.ts'
import { initialApplicationActivation, validateApplicationActivation, type ApplicationActivation } from './ports/application.ts'
import { MenuModals } from './scene/menu-modal.ts'
import { SystemDialogs, type SystemDialogSnapshot } from './scene/system-dialogs.ts'
import { modalBridge } from './tvp/modal.ts'
import type {
  CheckpointCallbacks,
  SessionCheckpoint,
  SessionEventReceipt,
} from './scheduler/session-checkpoints.ts'
import { eventClasses } from './tvp/events.ts'
import { tvpConstants } from './tvp/constants.ts'
import { MemoryAppLocks, type AppLocks } from './ports/system.ts'
import { KagService } from './kag/service.ts'
import { kagClass } from './tvp/kag.ts'
import { menuClass } from './tvp/menus.ts'
import {
  MenuTree,
  type MenuPopupIdentity,
  type MenuSnapshot,
  type WindowMenus,
} from './scene/menus.ts'
import { MenuService } from './scene/menu-items.ts'
import { WindowState, type WindowView, type WindowPresentation } from './scene/window.ts'
import { WindowService, type WindowRecord } from './scene/windows.ts'
import { windowClass } from './tvp/window.ts'
import { layerClass } from './tvp/layer.ts'
import { fontClass } from './tvp/font.ts'
import { transitionBridge } from './tvp/transitions.ts'
import { rectClass } from './tvp/rect.ts'
import { fontSpec } from './graphics/font.ts'
import { FontService, type NamedFontFace } from './graphics/fonts.ts'
import { FontCatalog } from './graphics/font-catalog.ts'
import { FontSelection } from './graphics/font-selection.ts'
import { cancelable } from './scheduler/cancelable.ts'
import { Bitmap, intersect } from './graphics/bitmap.ts'
import { SystemColors } from './graphics/system-colors.ts'
import type { FontDescriptor, FontPreview, FontSelectionRequest } from './ports/fonts.ts'
import { fontPreviewSize } from './ports/fonts.ts'
import type { AudioBackend } from './ports/audio.ts'
import { SoundService } from './media/sounds.ts'
import { soundClasses } from './tvp/sound.ts'
import type { VideoBackend } from './ports/video.ts'
import { VideoService } from './media/videos.ts'
import { videoClass } from './tvp/video.ts'
import { InputControllers } from './input/controllers.ts'
import { InputService } from './input/service.ts'
import { ObservedKeyState } from './input/key-state.ts'
import { MouseKeyState, type MouseKeyAction } from './input/mouse-key.ts'
import { inputBridge } from './tvp/input.ts'
import type { InputPacket, InputView, VirtualCursor, PhysicalPointerScreen } from './ports/input.ts'
import { SceneComposer } from './scene/composer.ts'
import { SceneTransitions } from './scene/transitions.ts'
import { decodeBmp } from '../formats/image/bmp.ts'
import { decodePng } from '../formats/image/png.ts'
import { decodeGif } from '../formats/image/gif.ts'
import { decodeTlg } from '../formats/image/tlg/index.ts'
import { stretchPixels } from './graphics/resample.ts'
import { validateBlend } from './graphics/blend.ts'
import { affinePixels } from './graphics/affine.ts'
import { boxBlur } from './graphics/processing.ts'
import type { InputOperation } from './input/controller.ts'
import {
  activityPaused,
  initialActivity,
  validateActivity,
  type ActivityState,
} from './ports/activity.ts'

export type SessionState =
  'initializing' | 'ready' | 'running' | 'paused' | 'stopping' | 'stopped' | 'failed'
/** Acceptance is synchronous; completion remains owned by the submitted operation. */
export interface SessionAdmission {
  readonly status: 'accepted' | 'ignored'
  readonly completion: Promise<void>
}
const ignoredAdmission = (): SessionAdmission => ({
  status: 'ignored',
  completion: Promise.resolve(),
})
export interface SessionSnapshot {
  project?: GameProject
  windows?: WindowPresentation[]
  activeWindow?: number
  mainWindow?: number
  debug: DebugVisibility
  eventDisabled: boolean
  revision: number
  state: SessionState
  userPaused: boolean
  graphics: RendererStatus
  activity: ActivityState
  resources: number
  layers: number
  bitmapBytes: number
  memoryBytes: number
  handles: number
  backend: string
  width: number
  height: number
  title: string
  saveFiles: number
  pendingSaves: number
  imageCacheBytes: number
  imageCacheEntries: number
  imageCachePending: number
  imageCacheHits: number
  imageCacheMisses: number
  imageCacheLimit: number
  cursorCacheEntries: number
  cursorCacheBytes: number
  cursorCachePending: number
}
export type EngineEvent =
  | { type: 'state'; snapshot: SessionSnapshot }
  | { type: 'menus'; menus: MenuSnapshot }
  | { type: 'window-menus'; windows: WindowMenus[] }
  | { type: 'window'; window: WindowView }
  | { type: 'windows'; windows: WindowPresentation[] }
  | { type: 'window-closed'; windowId: number }
  | { type: 'window-region'; windowId: number; revision: number; region: WindowRegion | null }
  | { type: 'window-regions-clear' }
  | { type: 'window-move'; request: WindowMoveRequest | null }
  | { type: 'window-activate'; windowId: number }
  | { type: 'window-input'; windowId: number; input: InputView }
  | { type: 'cursor-asset'; id: number; asset: CursorAsset }
  | { type: 'cursor-assets-clear' }
  | { type: 'input'; input: InputView }
  | ({ type: 'pads' } & PadPresentation)
  | { type: 'font-selection'; request: FontSelectionRequest | null }
  | ({ type: 'system-dialog' } & SystemDialogSnapshot)
  | { type: 'log'; level: 'info' | 'error'; text: string }
function copyPhysicalScreen(screen: PhysicalPointerScreen): PhysicalPointerScreen {
  if (!screen || !Number.isSafeInteger(screen.sequence) || screen.sequence < 1 ||
      [screen.x, screen.y].some((n) => !Number.isFinite(n) || n < -0x80000000 || n > 0x7fffffff) ||
      (screen.restoreWindowId !== undefined && (!Number.isSafeInteger(screen.restoreWindowId) || screen.restoreWindowId < 1)))
    throw new Error('Invalid physical screen observation')
  return { ...screen, x: Math.trunc(screen.x), y: Math.trunc(screen.y) }
}
interface VirtualCursorState {
  view: VirtualCursor
  /** Keyboard emulation owns a Window cursor, including a Window without a
   * primary Layer. Script Layer writes retain their stricter Layer lifetime. */
  layer?: LayerState
  window: WindowRecord
  controllerEpoch: number
  inputGeneration: number
}
interface WindowMouseKeys {
  state: MouseKeyState
  scaleX: number
  scaleY: number
  down: { x: number; y: number; paintBoxPoint: { x: number; y: number } }
  move: { x: number; y: number; paintBoxPoint: { x: number; y: number } }
}
export interface SessionDependencies {
  project?: GameProject
  archives?: ArchiveReader
  /** The page implements the matching request/reply presentation protocol. */
  windowMoveSupported?: boolean
  windowGeometry?: WindowGeometryPort
  systemDisplay?: SystemDisplayMetrics
  systemFonts?: FontDescriptor[]
  systemColors?: readonly number[]
  activity?: ActivityState
  application?: ApplicationActivation
  createRuntime: (
    handler: HostHandler,
    control: ExecutionControl,
    options: { debugMode: boolean },
  ) => Promise<ScriptRuntime>
  graphics: GraphicsDecoder
  inflateImage: Inflater
  deflateImage: (bytes: Uint8Array) => Promise<Uint8Array>
  renderer: Renderer
  decodeScript: (
    bytes: Uint8Array,
    mode?: string,
    encoding?: string,
  ) => string | Uint8Array | Promise<string | Uint8Array>
  readText: (bytes: Uint8Array, mode?: string, encoding?: string) => Promise<string>
  writeText: (text: string, mode?: string) => Promise<Uint8Array>
  saveStore?: SaveStore
  appLocks?: AppLocks
  audio?: AudioBackend
  video?: VideoBackend
  clipboard?: ClipboardPort
  help?: HelpPort
  arguments?: ReadonlyMap<string, string>
  fillRandomBytes?: (bytes: Uint8Array<ArrayBuffer>) => void
  now: () => number
  wallNow?: () => number
  yieldToHost: () => Promise<void>
  schedule: (callback: () => void, delay: number) => () => void
  event: (event: EngineEvent) => void
}

export class EngineSession {
  private readonly windowGeometry: WindowGeometryPort
  private nextGeometryRequest = 1
  private readonly geometryRequests = new Map<number, number>()
  private readonly geometrySignatures = new Map<number, string>()
  private readonly geometryPrimaryIds = new Map<number, number>()
  private readonly geometryScrollSequences = new Map<number, number>()
  private readonly geometryPending = new Map<number, Promise<void>>()
  private readonly geometryTransactions = new Map<number, Promise<void>>()
  private detachGeometry?: () => void
  private readonly systemEnvironment: SystemEnvironment
  private readonly systemColors: SystemColors
  private readonly clipboard: ClipboardPort
  private clipboardClosed = false
  private readonly help: HelpPort
  private helpClosed = false
  private readonly textEncoding = new ScriptTextEncoding()
  private readonly fontCatalog: FontCatalog
  private padFonts = new Map<string, NamedFontFace[]>()
  private readonly fontSelection: FontSelection
  private fontPreviewBusy = false
  readonly control = new ExecutionControl()
  private readonly queue = new SerialQueue()
  private readonly storage: StorageResolver
  private readonly dropped: DropStorage
  private readonly project?: GameProject
  private readonly images = new ImageLoader(
    (name) => this.findResource(name),
    (bytes) => this.decodeImage(bytes),
    (work) => this.finishGraphics(work),
    {
      now: () => this.deps.now(),
      check: () => this.control.check(),
      yield: () => this.yieldGraphics(),
    },
  )
  private readonly cursors = new CursorStorage(
    (name) => this.findResource(name),
    (bytes) => this.decodeCursorAsset(bytes),
    () => this.control.check(),
    (id, asset) => this.deps.event({ type: 'cursor-asset', id, asset }),
  )
  private readonly cursorLoads = new WeakMap<LayerState, number>()
  private cursorDefinitionsCleared = false
  private readonly imageWriter = new ImageWriter(
    (bytes) => this.deps.deflateImage(bytes),
    (work) => this.finishGraphics(work),
  )
  private readonly saves: SaveOverlay
  private readonly diagnostics: DebugLog
  private debug?: DebugService
  private readonly appLocks: AppLocks
  private readonly kag: KagService
  private readonly menus = new MenuTree()
  private menuRevision = -1
  private menuWindowsView = ''
  private readonly layers: LayerTree
  private readonly inputControllers: InputControllers
  private get inputController() {
    return this.inputControllers.active
  }
  private inputs?: InputService
  private inputView = ''
  private gamepadSettings?: NonNullable<InputView['gamepad']>
  private readonly windowInputViews = new Map<number, string>()
  private readonly keyboardRoutes = new Map<
    number,
    { signature: string; inputSignature: string; route: NonNullable<InputView['keyboardRoute']> }
  >()
  private nextKeyboardRouteRevision = 1
  private windowsView = ''
  private transitions?: SceneTransitions
  private readonly composer: SceneComposer
  private preparingFrame = false
  private readonly windowUpdates = new WindowUpdates()
  private paintedLayers = new Set<number>()
  private readonly redrawRequests = new Set<number>()
  private readonly deferredPaint = new Map<number, { generation: number; deadline?: number }>()
  private readonly modalReadyRedraw = new Map<number, number>()
  private cancelRedraw?: () => void
  private redrawWakeAt?: number
  private redrawQueued = false
  private redrawGeneration = 0
  private layerObjects?: LayerService
  private runtime?: ScriptRuntime
  private systemEvents?: SystemEvents
  private modalLoop?: ModalLoop
  private windowModals?: WindowModals
  private windowMoves?: WindowMoves
  private menuModals?: MenuModals
  private systemDialogs?: SystemDialogs
  private pads?: PadService
  private clipboardBusy = 0
  private windowInputGeneration = 0
  private readonly fileDropSequences = new Map<number, number>()
  private readonly pendingFileDrops = new Map<string, { windowId: number; cancelled: boolean; cancelWait(): void }>()
  private readonly fileDropReceiptReservations = new Set<object>()
  private modalWakeup?: () => void
  private detachPendingEvents?: () => void
  private checkpointCallbacks?: CheckpointCallbacks
  private nextReceipt = 1
  private nextCheckpoint = 1
  private readonly eventReceipts = new Map<number, SessionEventReceipt>()
  private readonly settledRounds = new Map<number, Set<number>>()
  private readonly outsideReceipts = new Set<number>()
  private readonly outerRecoveryReceipts = new Set<number>()
  private readonly abortedReceiptRounds = new Map<number, Error>()
  private readonly checkpoints = new Map<number, SessionCheckpoint>()
  private readonly windowPresentationsCompleted = new Map<number, number>()
  private readonly windowPresentedVersions = new Map<number, number>()
  private readonly videoFrameChanges = new Map<number, number>()
  private videoFrameChange = 0
  private executing = false
  private checkpointQueued = false
  private frameRequested = false
  private readonly frameWaiters = new Set<{ resolve(): void; reject(error: unknown): void }>()
  private frameWorkVersion = 1
  private attemptedFrameVersion = 0
  private eventYieldAt = 0
  private readonly systemArguments: Map<string, string>
  private events?: ScriptEvents
  private sounds?: SoundService
  private videos?: VideoService
  private state: SessionState = 'initializing'
  private userPaused = false
  private snapshotRevision = 0
  private activity = initialActivity()
  private applicationActive = true
  private applicationActivation = initialApplicationActivation()
  private readonly applicationEventSource = {}
  private graphicsStatus: RendererStatus = { state: 'ready', generation: 0 }
  private detachRenderer?: () => void
  private window = new WindowState()
  private windows?: WindowService
  private menuItems?: MenuService
  private windowId = 0
  private get width(): number {
    return this.window.width
  }
  private get height(): number {
    return this.window.height
  }
  private get title(): string {
    return this.window.caption
  }
  private windowRevision = -1
  private postedInputPending = 0
  private readonly windowPointers = new Map<number, { x: number; y: number }>()
  private physicalScreen?: PhysicalPointerScreen
  private readonly hiddenCursorPositions = new Map<number, { kind: 'screen' | 'viewport'; x: number; y: number }>()
  private readonly physicalPointerSequences = new Map<number, number>()
  private readonly virtualCursors = new Map<number, VirtualCursorState>()
  private readonly mouseKeys = new Map<number, WindowMouseKeys>()
  private readonly windowRegions = new WindowRegions()
  private readonly windowRegionRequests = new Map<number, number>()
  private nextWindowRegionRequest = 1
  private nextWindowRegionRevision = 1
  private nextVirtualCursorRevision = 1
  private readonly keyStates = new ObservedKeyState()
  private get physicalKeys(): ReadonlySet<number> { return this.keyStates.current }
  private readonly fonts: FontService
  private sceneDirty = true
  private get dirty(): boolean {
    return this.sceneDirty
  }
  private set dirty(value: boolean) {
    this.sceneDirty = value
    if (value) {
      this.frameWorkVersion++
      this.modalWakeup?.()
    }
  }
  private stopPromise?: Promise<void>
  private disposalPromise?: Promise<void>
  private exitRequested = false
  private exitOnWindowClose = true
  private exitOnNoWindowStartup = true
  private exitAfterOperation = false
  private terminateRequested = false
  private maintenance?: SystemMaintenance
  private compactCallback?: ScriptObject
  private pendingCompact = 0
  private compactQueued = false
  private readonly cancellationErrors: unknown[] = []
  private readonly cancellationWork = new Set<Promise<void>>()
  constructor(private readonly deps: SessionDependencies) {
    if (deps.application) {
      validateApplicationActivation(deps.application)
      this.applicationActivation = { ...deps.application }
    }
    this.project = copyGameProject(deps.project)
    // Reject invalid configuration before clocks or subscribed host resources
    // are consulted. A failed constructor has no disposal owner yet.
    this.systemColors = new SystemColors(deps.systemColors)
    this.systemArguments = new Map(deps.arguments)
    this.systemEnvironment = new SystemEnvironment(
      this.systemArguments,
      deps.fillRandomBytes,
      deps.systemDisplay,
      this.project,
    )
    let archiveYieldAt = deps.now() + 8, archiveSteps = 0
    this.storage = new StorageResolver(this.project?.directory ?? '', !this.project, deps.archives,
      async () => {
        await this.control.wait(); this.control.check()
        if (++archiveSteps >= 64 || deps.now() >= archiveYieldAt) {
          await deps.yieldToHost(); this.control.check()
          archiveSteps = 0; archiveYieldAt = deps.now() + 8
        }
      })
    this.windowGeometry = deps.windowGeometry ?? new HeadlessWindowGeometry()
    this.detachGeometry = this.windowGeometry.subscribe((observation) => this.observeWindowScroll(observation))
    this.layers = new LayerTree(this.systemColors)
    this.inputControllers = new InputControllers(this.layers, () => this.windowId)
    this.composer = new SceneComposer(this.layers, (id) => this.transitions?.frame(id))
    this.clipboard = deps.clipboard ?? unavailableClipboard()
    this.help = deps.help ?? unavailableHelp()
    this.fonts = new FontService(
      (name) => this.resolveResource(name),
      deps.graphics,
      (work) => this.finishGraphics(work),
      (error) => deps.event({ type: 'log', level: 'error', text: `Compact Event (Font faces): ${String(error)}` }),
    )
    this.fontCatalog = new FontCatalog({
      // Never enumerate unopened packages just to discover optional fonts.
      files: () => this.storage.knownResources().map((file) => this.saves.resource(file.name) ?? file),
      resolve: (name) => this.resolveResource(name),
      bind: (fonts) => {
        this.fonts.registerNamed(fonts)
        this.padFonts = fonts
      },
      check: () => this.control.check(),
      // Catalog discovery is pure host work shared with Pad. A paused VM must
      // not prevent an auxiliary editor from obtaining its font bytes.
      yield: async () => {
        await this.deps.yieldToHost()
        this.control.check()
      },
      wait: (work) => cancelable(work, this.control),
      warn: (text) => this.log(text),
    })
    this.fontCatalog.setSystem(deps.systemFonts ?? [])
    this.fontSelection = new FontSelection(this.fontCatalog, (request) => {
      if (request) this.clearVirtualCursors()
      if (request) this.deps.event({ type: 'font-selection', request })
      this.pads?.present()
      if (!request) this.deps.event({ type: 'font-selection', request })
    })
    if (deps.activity) {
      validateActivity(deps.activity)
      this.activity = { ...deps.activity }
    }
    this.pauseMediaRequestTimeouts()
    this.saves = new SaveOverlay(deps.saveStore ?? new MemorySaveStore(), (path) => {
      this.images.invalidate(path)
      this.storage.invalidateSearch()
    }, (path) => this.storage.assertWritable(path))
    this.dropped = new DropStorage(this.storage, () => this.saves.list().map((file) => file.name),
      async () => { this.control.check(); await deps.yieldToHost(); this.control.check() })
    this.diagnostics = new DebugLog(this.saves, deps.wallNow ?? Date.now, (entry) =>
      deps.event({ type: 'log', level: entry.level, text: entry.text }),
    )
    this.appLocks = deps.appLocks ?? new MemoryAppLocks()
    this.kag = new KagService(
      async (name) =>
        this.withTextError(name, async () => this.deps.readText(await this.readResource(name), '', this.textEncoding.codec)),
      (text) => this.log(text),
    )
    this.control.onCancel(() => {
      this.terminateRequested = false
      this.pendingCompact = 0
      this.maintenance?.close()
      for (const drop of this.pendingFileDrops.values()) { drop.cancelled = true; drop.cancelWait() }
      this.pendingFileDrops.clear()
      this.fileDropReceiptReservations.clear()
      this.fileDropSequences.clear()
      // Revoke tickets and wake modal waits before any device/user cleanup
      // can throw. Preserve those failures for the terminal stop result.
      this.cancelEventReceipts(new ExecutionCancelled())
      for (const cleanup of [
        () => this.windowGeometry.dispose(),
        () => { this.detachGeometry?.(); this.detachGeometry = undefined },
        () => this.pads?.dispose(),
        () => this.closeClipboard(),
        () => this.closeHelp(),
        () => this.modalLoop?.dispose(),
        () => this.menus.dismiss(undefined, undefined, 'unavailable'),
        () => this.fontSelection.cancel(),
        () => {
          this.fontCatalog.clear()
          this.padFonts.clear()
        },
        () => this.cancelRedraw?.(),
        () => this.detachRenderer?.(),
        () => this.transitions?.dispose(),
        () => this.composer.clear(),
        () => this.windowUpdates.finish(),
        () => { this.physicalScreen = undefined; this.hiddenCursorPositions.clear() },
        () => this.images.dispose(),
        () => this.dropped.dispose(),
        () => this.storage.dispose(),
        () => this.closeCursors(),
        () => this.closeWindowRegions(),
        () => this.fonts.dispose(),
        () => deps.graphics.dispose?.(),
      ]) {
        try {
          cleanup()
        } catch (error) {
          this.cancellationErrors.push(error)
        }
      }
      this.cancelRedraw = undefined
      this.redrawWakeAt = undefined
      this.redrawRequests.clear()
      this.deferredPaint.clear()
      this.modalReadyRedraw.clear()
      for (const cancel of [() => this.sounds?.cancel(), () => this.videos?.cancel()]) {
        try {
          const work = cancel()
          if (work) {
            const tracked = work
              .catch((error) => {
                this.cancellationErrors.push(error)
              })
              .finally(() => this.cancellationWork.delete(tracked))
            this.cancellationWork.add(tracked)
          }
        } catch (error) {
          this.cancellationErrors.push(error)
        }
      }
    })
    this.detachRenderer = deps.renderer.subscribe?.((status) => {
      if (this.control.cancelled) return
      this.graphicsStatus = { ...status }
      this.dirty = true
      this.applyPause()
      this.notify()
      this.modalWakeup?.()
      if (status.state === 'failed')
        this.deps.event({
          type: 'log',
          level: 'error',
          text: `画面恢复失败：${status.message ?? '未知错误'}；可重试显示或导出存档。`,
        })
    })
  }

  initialize(): Promise<void> {
    return this.queue.enqueue(async () => {
      await this.saves.initialize()
      this.runtime = await this.deps.createRuntime((...args) => this.host(...args), this.control, {
        debugMode: this.systemArguments.get('-debug') === 'yes',
      })
      this.control.check()
      this.debug = new DebugService(this.diagnostics, this.runtime, this.systemArguments)
      this.runtime.setConsoleOutput((text) =>
        this.debug!.dispatch(
          this.diagnostics.begin(
            text.length <= 256 * 1024 ? text : text.slice(0, 256 * 1024 - 10) + '…[日志截断]',
          ),
        ),
      )
      this.diagnostics.setLocation(this.systemEnvironment.dataPath, this.systemArguments)
      this.eventYieldAt = this.deps.now() + 8
      this.systemEvents = new SystemEvents(
        this.runtime,
        { now: this.deps.now, schedule: this.deps.schedule },
        (operation) =>
          this.execute(async () => {
            const reply = operation()
            return reply.kind === 'invoke'
              ? this.runtime!.invoke(reply.callback, reply.args)
              : undefined
          }).then(() => undefined),
        () => this.notify(),
        (message, handled) => {
          if (!this.control.cancelled && !handled) {
            try {
              this.log(message, 'error')
              this.diagnostics.error()
            } catch (error) {
              this.reportFlushFailure(error)
            }
          }
        },
      )
      this.modalLoop = new ModalLoop(this.runtime, this.control, {
        hasWork: () => this.hasModalWork(),
        dispatch: () => this.beginModalDispatch(),
        beforeWait: (token) => {
          this.windowModals?.beforeWait(token)
          this.menuModals?.beforeWait(token)
          this.systemDialogs?.beforeWait(token)
          this.windowMoves?.beforeWait(token)
        },
        changed: (phase) => {
          this.windowMoves?.present()
          // Opening the native dialog captures the old DOM focus before the
          // Window roster applies inert. Unwinding restores eligibility first.
          if (phase === 'open') {
            this.systemDialogs?.present()
            this.pads?.present()
          }
          this.present()
          if (phase === 'release') {
            this.pads?.present()
            this.systemDialogs?.present()
          }
          this.notify()
        },
      })
      this.setModalWakeup(() => this.modalLoop?.notify())
      this.detachPendingEvents = this.systemEvents.subscribePending(() => this.modalWakeup?.())
      this.inputs = new InputService(
        this.inputControllers,
        this.runtime,
        (id) => this.layerObjects?.owner(id),
        (id) => {
          if (!id) return undefined
          try {
            return this.windows?.get(id).owner
          } catch {
            return undefined
          }
        },
        (id) => this.layerObjects?.eventOwner(id),
      )
      this.transitions = new SceneTransitions(
        this.layers,
        (id) => this.inputControllers.forLayer(id),
        this.runtime,
        (operation) => this.inputs!.start(operation),
        this.deps.now,
        this.deps.schedule,
        () => {
          for (const id of this.transitions?.windowIds() ?? []) this.invalidateWindow(id)
          return this.requestFrameCheckpoint()
        },
        (id, invalidation = true) => {
          this.systemEvents?.setExternalContinuous(this.transitions?.continuousActive ?? false)
          if (invalidation) this.invalidateLayer(id)
          else this.dirty = true
        },
        (name) => this.images.rule(name),
        (error) => {
          if (!this.control.cancelled) this.fail(error)
        },
        (id) => this.layerObjects?.owner(id),
        (id) => this.layerObjects?.isClosing(id) ?? true,
      )
      this.sounds = new SoundService(
        this.runtime,
        this.deps.audio,
        (name) => this.readResource(name),
        (name) => this.resourceExists(name),
        this.deps.readText,
        (callback, member, args, valid, source) =>
          this.systemEvents!.post(() => ({ kind: 'invoke', callback, member, args }), {
            valid,
            source,
          }),
        (error) => {
          if (!this.control.cancelled) this.fail(error)
        },
        (source) => this.systemEvents!.cancelSource(source),
        {
          resolve: (name) => this.resolveResource(name),
          checkpoint: async () => {
            await this.control.wait()
            this.control.check()
          },
        },
      )
      this.events = new ScriptEvents(
        { now: this.deps.now, schedule: this.deps.schedule },
        this.runtime,
        (event) =>
          this.systemEvents!.post(
            () => ({ kind: 'invoke', callback: event.callback, member: event.member, args: [] }),
            {
              ...event,
              priority: event.priority === 0 ? 0 : event.priority === 2 ? 3 : 2,
            },
          ),
        (error) => {
          if (!this.control.cancelled) this.fail(error)
        },
        (source) => this.systemEvents!.cancelSource(source),
      )
      this.videos = new VideoService(
        this.runtime,
        this.deps.video,
        (name) => this.readResource(name),
        (id, pixels) => {
          if (!this.layers.has(id)) return
          const previousWindow = this.layerWindow(id)
          this.layers.image(id, pixels)
          this.layers.resize(id, pixels.width, pixels.height)
          this.videoFrameChanges.set(this.layers.get(id).windowId, ++this.videoFrameChange)
          if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
          this.invalidateLayer(id)
        },
        (callback, member, args, valid, before, immediate, source, release) => {
          return this.acceptEvent(
            () =>
              member
                ? { kind: 'invoke', callback, member, args }
                : { kind: 'value', value: undefined },
            {
              valid: () => valid() && (!immediate || !this.systemEvents!.disabled),
              discardable: immediate,
              source,
            },
            {
              release,
              before: () => {
                const beforeFrame = this.videoFrameChange
                if (valid()) before()
                return [...this.videoFrameChanges]
                  .filter(([, revision]) => revision > beforeFrame)
                  .map(([id]) => id)
              },
            },
          ).completion
        },
        (error) => {
          if (!this.control.cancelled) this.fail(error)
        },
        (source) => this.systemEvents!.cancelSource(source),
        undefined,
        (source, settings, windowId, opened) => {
          // Native argument validation precedes the unopened-video no-op.
          const layer = source === null ? null : this.layerObjects!.cast(source)
          if (!opened || !layer) return null
          return captureVideoMixingBitmap(
            this.layers.get(layer.id),
            settings,
            this.windows!.get(windowId).state,
          )
        },
      )
      this.windows = new WindowService(
        this.runtime,
        (window) => {
          this.inputControllers.create(window.id, () => window.state).keys = new Set(
            this.physicalKeys,
          )
          this.refreshKeyboardRoutes()
          try {
            this.deps.renderer.openWindow?.(window.id)
            this.inputControllers.releaseCaptures()
            this.syncActiveWindow()
            this.dirty = true
          } catch (error) {
            this.inputControllers.remove(window.id)
            this.deps.renderer.closeWindow?.(window.id)
            throw error
          }
        },
        async (window) => {
          this.fileDropSequences.delete(window.id)
          for (const drop of this.pendingFileDrops.values()) if (drop.windowId === window.id) {
            drop.cancelled = true; drop.cancelWait()
          }
          this.hiddenCursorPositions.delete(window.id)
          this.windowUpdates.remove(window.id)
          this.geometryRequests.delete(window.id)
          this.geometrySignatures.delete(window.id)
          this.geometryPrimaryIds.delete(window.id)
          this.geometryScrollSequences.delete(window.id)
          this.windowGeometry.retire(window.id)
          this.windowMoves?.invalidate(window.id)
          this.clearVirtualCursors(window.id)
          this.windowRegionRequests.delete(window.id)
          this.windowRegions.replace(window.id, null)
          this.windowModals?.invalidate(window.id)
          this.menus.dismiss(window.id, undefined, 'unavailable')
          this.systemEvents!.cancelSource(window)
          window.resizePending = false
          window.inputActive = false
          // This notification also covers a Window created and invalidated in
          // one script entry, before it ever appears in a rendered roster.
          this.deps.event({ type: 'window-closed', windowId: window.id })
          this.syncActiveWindow()
          if (this.windows?.active)
            void this.activateWindow(this.windows.active.id).catch((error) => {
              if (!this.control.cancelled) this.fail(error)
            })
          this.videos?.disconnectWindow(window.id)
          await this.videos?.flushCloses()
        },
        (window) => {
          this.fileDropSequences.delete(window.id)
          this.windowUpdates.remove(window.id)
          this.geometryRequests.delete(window.id)
          this.geometrySignatures.delete(window.id)
          this.geometryPrimaryIds.delete(window.id)
          this.geometryScrollSequences.delete(window.id)
          this.windowGeometry.retire(window.id)
          this.windowModals?.invalidate(window.id)
          this.systemEvents?.cancelSource(window)
          this.videos?.disconnectWindow(window.id)
          this.menuItems?.disconnectWindow(window)
          this.inputControllers.remove(window.id)
          this.windowPointers.delete(window.id)
          this.hiddenCursorPositions.delete(window.id)
          this.physicalPointerSequences.delete(window.id)
          this.virtualCursors.delete(window.id)
          this.mouseKeys.delete(window.id)
          this.windowRegionRequests.delete(window.id)
          this.windowRegions.replace(window.id, null)
          this.windowInputViews.delete(window.id)
          this.keyboardRoutes.delete(window.id)
          this.refreshKeyboardRoutes()
          this.windowPresentationsCompleted.delete(window.id)
          this.windowPresentedVersions.delete(window.id)
          this.videoFrameChanges.delete(window.id)
          this.deps.renderer.closeWindow?.(window.id)
          this.syncActiveWindow()
          this.dirty = true
        },
      )
      this.windowModals = new WindowModals(this.windows, this.modalLoop, {
        enter: (window) => {
          // Clear queued input without invalidating the currently executing
          // input generator or its suspended caller's continuation.
          this.windowInputGeneration++
          this.clearVirtualCursors()
          for (const existing of this.windows!.registered()) {
            this.systemEvents!.cancelSource(existing)
            if (existing !== window) this.menus.dismiss(existing.id, undefined, 'unavailable')
          }
          this.inputControllers.releaseCaptures()
          window.state.set('visible', 1)
          this.invalidateWindow(window.id)
          // Publish blocking before the browser receives a new focus command.
          this.present()
          this.observeAdmission(this.acceptActivateWindow(window.id))
        },
        leave: (window, previousId) => {
          this.clearVirtualCursors(window.id)
          if (this.registeredWindow(window.id) === window) {
            window.state.set('visible', 0)
            window.inputActive = false
            this.inputControllers.get(window.id)?.resetTransient()
            this.menus.dismiss(window.id, undefined, 'unavailable')
          }
          if (this.windowId === window.id) this.windows!.activate(0)
          this.syncActiveWindow()
          this.dirty = true
          this.present()
          if (this.control.cancelled) return
          const eligible = (candidate: WindowRecord | undefined) =>
            candidate &&
            candidate.state.visible &&
            candidate.state.focusable &&
            !this.windowModals!.blocked(candidate.id)
          const previous = this.registeredWindow(previousId)
          const restore = eligible(previous)
            ? previous
            : this.windows!.registered().reverse().find(eligible)
          if (restore) this.observeAdmission(this.acceptActivateWindow(restore.id))
        },
        query: (window, onNotEntered) =>
          this.observeAdmission(this.enqueueCloseWindow(window.id, onNotEntered)),
      })
      this.windowMoves = new WindowMoves(this.modalLoop, {
        window: (id) => this.registeredWindow(id),
        position: (window, left, top) => {
          if (this.registeredWindow(window.id) !== window) return
          window.state.set('left', left)
          window.state.set('top', top)
          this.present()
        },
        changed: (request) => this.deps.event({ type: 'window-move', request }),
      }, this.deps.windowMoveSupported === true)
      this.menuItems = new MenuService(this.runtime, this.menus, this.windows, (item) => {
        this.systemEvents?.cancelSource(item)
      })
      this.menuModals = new MenuModals(this.menus, this.modalLoop, (view) =>
        this.queueMenuNotification(view),
      )
      this.systemDialogs = new SystemDialogs(this.modalLoop, {
        changed: (snapshot) => this.deps.event({ type: 'system-dialog', ...snapshot }),
        enter: (_id, kind) => {
          this.clearVirtualCursors()
          // The original file picker does not clear the game's Window event
          // queue. Block input through the shared modal scope without silently
          // applying System.inform's separate event cleanup policy.
          if (kind !== 'storage-selector') {
            this.windowInputGeneration++
            for (const window of this.windows!.registered()) this.systemEvents!.cancelSource(window)
          }
          this.inputControllers.releaseCaptures()
          this.keyStates.release()
          this.menus.dismiss(undefined, undefined, 'unavailable')
          this.present()
        },
      })
      this.pads = new PadService(this.runtime, this.systemColors, this.modalLoop, {
        changed: (presentation) => this.deps.event({ type: 'pads', ...presentation }),
        blocked: () =>
          !['running', 'paused'].includes(this.state) ||
          this.activity.state !== 'visible' ||
          !!this.modalLoop?.depth ||
          this.fontSelection.active ||
          this.clipboardBusy > 0,
        covered: () => this.fontSelection.active || this.clipboardBusy > 0,
        enter: () => {
          this.windowInputGeneration++
          this.clearVirtualCursors()
          for (const window of this.windows!.registered()) this.systemEvents!.cancelSource(window)
          this.inputControllers.releaseCaptures()
          this.keyStates.release()
          this.menus.dismiss(undefined, undefined, 'unavailable')
          this.present()
        },
      })
      this.layerObjects = new LayerService(
        this.runtime,
        this.layers,
        this.windows,
        (layer) => {
          this.redrawRequests.delete(layer.id)
          this.deferredPaint.delete(layer.id)
          this.systemEvents?.cancelSource(layer)
          this.invalidateWindow(layer.window.id)
        },
        (layer) => {
          this.redrawRequests.delete(layer.id)
          this.deferredPaint.delete(layer.id)
          this.systemEvents?.cancelSource(layer)
          this.transitions?.drop(layer.id)
          this.invalidateWindow(layer.window.id)
        },
      )
      this.discard(await this.runtime.execute(tvpConstants, 'krkr2-web/constants.tjs'))
      this.discard(await this.runtime.execute(debugBridge, 'krkr2-web/debug.tjs'))
      this.discard(await this.runtime.execute(bootstrap, 'krkr2-web/bootstrap.tjs'))
      this.discard(await this.runtime.execute(clipboardClass, 'krkr2-web/clipboard.tjs'))
      this.discard(await this.runtime.execute(systemEventsBridge, 'krkr2-web/system-events.tjs'))
      this.discard(await this.runtime.execute(eventClasses, 'krkr2-web/events.tjs'))
      this.discard(await this.runtime.execute(kagClass, 'krkr2-web/kag.tjs'))
      this.discard(await this.runtime.execute(menuClass, 'krkr2-web/menus.tjs'))
      this.discard(await this.runtime.execute(windowClass, 'krkr2-web/window.tjs'))
      this.discard(await this.runtime.execute(inputBridge, 'krkr2-web/input.tjs'))
      this.discard(await this.runtime.execute(checkpointBridge, 'krkr2-web/checkpoints.tjs'))
      this.discard(await this.runtime.execute(modalBridge, 'krkr2-web/modal.tjs'))
      this.discard(await this.runtime.execute(padClass, 'krkr2-web/pad.tjs'))
      this.discard(await this.runtime.execute(transitionBridge, 'krkr2-web/transitions.tjs'))
      this.discard(await this.runtime.execute(fontClass, 'krkr2-web/font.tjs'))
      this.discard(await this.runtime.execute(layerClass, 'krkr2-web/layer.tjs'))
      this.discard(await this.runtime.execute(rectClass, 'krkr2-web/rect.tjs'))
      this.discard(await this.runtime.execute(soundClasses, 'krkr2-web/sound.tjs'))
      this.discard(await this.runtime.execute(videoClass, 'krkr2-web/video.tjs'))
      this.setState('ready')
      if (!this.control.cancelled) {
        const maintenance = new SystemMaintenance(
          { now: this.deps.now, schedule: this.deps.schedule },
          () => this.systemEvents?.continuousActive ?? false,
          (level) => this.requestAutomaticCompact(level),
        )
        this.maintenance = maintenance
        if (this.control.cancelled) maintenance.close()
      }
    })
  }
  mount(resources: Resource[]): void {
    if (this.state !== 'ready') throw new Error('Files can only be mounted before starting a game')
    this.storage.mount(resources)
    this.images.clear()
    this.notify()
  }
  start(entry = 'startup.tjs'): Promise<void> {
    if (this.state !== 'ready') return Promise.reject(new Error('Session is not ready'))
    this.setState('running')
    this.applyPause()
    return this.execute(async () => {
      const resource = await this.resolveResource(entry)
      return this.runtime!.execute(
        await this.withTextError(toPublicStoragePath(resource.name), async () =>
          this.deps.decodeScript(await resource.read(), '', this.textEncoding.codec)),
        resource.name,
      )
    }, 1, true).then(() => undefined)
  }
  evaluate(source: string): Promise<string> {
    if (!['ready', 'running'].includes(this.state))
      return Promise.reject(new Error('Session cannot evaluate scripts in its current state'))
    return this.execute(() => this.runtime!.execute(source, 'console.tjs', true))
  }
  private execute(operation: () => Promise<ScriptValue>, priority: 0 | 1 | 2 = 1, startup = false): Promise<string> {
    return this.queue.enqueue(async () => {
      await this.control.wait()
      this.control.check()
      this.executing = true
      this.paintedLayers.clear()
      let failed = false,
        recorded = false
      try {
        let value: ScriptValue = undefined,
          display = 'undefined',
          exitAfterStartup = false
        try {
          const compact = this.takeAutomaticCompact()
          if (compact.kind === 'invoke')
            this.discard(await this.runtime!.invoke(compact.callback, compact.args))
          value = await operation()
          // Sample at the startup entry's return. A later onPaint/focus tail
          // is not part of TVPInitializeStartupScript's Window-count check.
          exitAfterStartup = startup && this.exitOnNoWindowStartup &&
            !this.windows!.registered().length && !this.debugPanels.get('controller')
          await this.outerNativeCheckpoint()
          await this.inputs?.synchronize()
          if (
            this.hasPendingRedraw() &&
            [...this.redrawRequests].some((id) => !this.deferredPaint.has(id))
          )
            this.dirty = true
          if ((this.dirty || this.windowUpdates.pending) && !this.systemEvents?.disabled) {
            const reply = this.inputs!.start(this.prepareFrame())
            if (reply.kind === 'invoke')
              this.discard(await this.runtime!.invoke(reply.callback, reply.args))
          }
          display = isScriptObject(value)
            ? '[TJS object]'
            : value instanceof Uint8Array
              ? `[octet: ${value.length} bytes]`
              : String(value)
        } catch (error) {
          failed = true
          if (!this.control.cancelled) {
            await this.recordScriptFailure(error)
            recorded = true
          }
          throw error
        } finally {
          let closingError: unknown,
            closingFailed = false
          try {
            this.discard(value)
            if (!this.control.cancelled && this.runtime?.inspect().pendingHandles)
              await this.runtime.collect()
            if (!this.control.cancelled) await this.inputs?.synchronize()
            if (!this.control.cancelled) await this.outerNativeCheckpoint()
          } catch (error) {
            closingError = error
            closingFailed = true
          }
          try {
            await this.videos?.flushCloses()
          } catch (error) {
            if (!closingFailed) closingError = error
            closingFailed = true
          }
          try {
            await this.sounds?.flushCloses()
          } catch (error) {
            if (!closingFailed) closingError = error
            closingFailed = true
          }
          try {
            // Immediate exit has already scheduled Stop after this VM entry.
            // Its durable gate owns the flush: attempting it here as well
            // would silently retry a failed persistent write during Stop.
            if (!this.exitRequested) await this.flushFiles()
          } catch (error) {
            if (!failed && !closingFailed) throw error
            this.reportFlushFailure(error)
          }
          if (closingFailed) {
            if (!failed) throw closingError
            this.log('Deferred cleanup failed: ' + String(closingError), 'error')
          }
        }
        if (exitAfterStartup) this.terminateRequested = true
        this.attemptedFrameVersion = this.frameWorkVersion
        this.present()
        this.notify()
        // A request made before an asynchronous callback yields starts its
        // delay only after this execution completes. Other Layers keep their
        // earlier deadlines, even when this execution painted another Layer.
        this.finishFrameDeadlines()
        if (!this.preparingFrame) {
          for (const receipt of this.eventReceipts.values())
            if (receipt.nativeDone && receipt.epilogueDone) receipt.tailDone = true
          this.completeFrameWaiters()
          this.completeReadyReceipts()
        }
        return display
      } catch (error) {
        if (this.exitRequested && error instanceof Error && error.message === 'Execution cancelled')
          return 'undefined'
        if (!this.control.cancelled) {
          this.cancelEventReceipts(error)
          if (!recorded) {
            await this.recordScriptFailure(error)
            recorded = true
            // Apply streams closed by the observer, without retrying a failed
            // persistent transaction merely to report that it failed.
            try {
              await this.runtime?.flush()
            } catch (e) {
              this.reportFlushFailure(e)
            }
          }
          this.fail(error, recorded, false)
        }
        throw error
      } finally {
        this.executing = false
        if (this.terminateRequested) {
          this.terminateRequested = false
          // Application.Terminate returns to its script. Its posted quit is
          // consumed only when the outer VM entry has unwound; an I/O yield
          // inside that entry is not a second application message loop.
          this.completeReadyReceipts()
          if (!this.control.cancelled) this.requestExit()
        }
        if (this.exitAfterOperation) {
          this.exitAfterOperation = false
          // The native entry has returned. Resolve completed admissions in
          // this same host turn as requesting exit, so a user-close caller
          // observes termination without cancelling remaining script code.
          this.completeReadyReceipts()
          this.requestExit()
        }
        if (this.hasOutsideReceipts() && !this.control.cancelled) this.requestReceiptCheckpoint()
      }
    }, priority)
  }
  private requestExit(): void {
    this.exitRequested = true
    // Native main-window closure posts termination after the current VM entry.
    // Do not await the queue which this entry itself is still occupying.
    void this.stop().catch((error) => {
      this.deps.event({ type: 'log', level: 'error', text: String(error) })
    })
  }
  /** Compact listeners do not expose a user event. While the VM is suspended,
   * retain only the strongest requested level; it includes weaker cache work.
   * The private original native method runs at a safe outer or modal boundary. */
  private requestAutomaticCompact(level: number): void {
    if (this.control.cancelled || !this.compactCallback) return
    this.pendingCompact = Math.max(this.pendingCompact, level)
    this.modalWakeup?.()
    if (this.compactQueued) return
    this.compactQueued = true
    void this.execute(async () => undefined, 0).then(() => {
      this.compactQueued = false
      if (this.pendingCompact) this.requestAutomaticCompact(this.pendingCompact)
    }, (error) => {
      this.compactQueued = false
      if (!this.control.cancelled) this.fail(error)
    })
  }
  private takeAutomaticCompact(): HostReply {
    if (this.control.cancelled || !this.pendingCompact || !this.compactCallback)
      return { kind: 'value', value: undefined }
    const level = this.pendingCompact
    this.pendingCompact = 0
    return { kind: 'invoke', callback: this.compactCallback, args: [BigInt(level)] }
  }
  /** This method is only called after an exported VM operation has returned.
   * Unlike a child host call, that return proves even an enclosing native drain
   * has unwound. Never use it from Modal.dispatch or a Checkpoint host handler. */
  private async outerNativeCheckpoint(): Promise<void> {
    if (this.control.cancelled || !this.runtime) return
    // An eventNext native drain may fail after detaching invalid jobs but
    // before their first continuation. If no later event checkpoint consumed
    // them, this exported return provides the final native-unwind fallback.
    for (const id of this.outerRecoveryReceipts) {
      const receipt = this.eventReceipts.get(id)
      if (receipt) this.releaseReceipt(receipt)
    }
    if (this.outerRecoveryReceipts.size && this.nativeReleasesPending())
      await this.runtime.collect()
    if (!this.nativeReleasesPending()) {
      for (const checkpoint of [...this.checkpoints.values()].reverse()) {
        this.restoreCheckpointPaint(checkpoint)
        for (const id of checkpoint.receipts) {
          const receipt = this.eventReceipts.get(id)
          if (receipt?.checkpoint === checkpoint.id) this.markReceiptNativeDone(receipt)
        }
        this.checkpoints.delete(checkpoint.id)
      }
      for (const id of this.outerRecoveryReceipts) {
        const receipt = this.eventReceipts.get(id)
        if (receipt) this.markReceiptNativeDone(receipt)
      }
      this.outerRecoveryReceipts.clear()
      this.abortedReceiptRounds.clear()
    }
    const reply = this.beginCheckpoint(undefined)
    if (reply.kind === 'invoke') this.discard(await this.runtime.invoke(reply.callback, reply.args))
  }
  private log(text: string, level: 'info' | 'error' = 'info'): void {
    const entry = this.diagnostics.capture(text, level)
    // Browser-originated diagnostics cannot reenter a suspended VM. Deliver
    // their observers in the next serialized execution, independent of timers.
    if (this.debug?.listening && !this.debug.delivering && !this.control.cancelled)
      void this.execute(async () => {
        const reply = this.debug!.dispatch(entry, false)
        return reply.kind === 'invoke'
          ? this.runtime!.invoke(reply.callback, reply.args)
          : undefined
      }).catch(() => {})
  }
  private recordFailure(error: unknown): void {
    const text = this.errorText(error)
    try {
      const bounded =
        text.length <= 256 * 1024 ? text : text.slice(0, 256 * 1024 - 10) + '…[日志截断]'
      this.diagnostics.capture(bounded, 'error')
      this.diagnostics.error()
    } catch (loggingError) {
      this.deps.event({ type: 'log', level: 'error', text })
      this.reportFlushFailure(loggingError)
    }
  }
  private async recordScriptFailure(error: unknown): Promise<void> {
    const text = this.errorText(error),
      bounded = text.length <= 256 * 1024 ? text : text.slice(0, 256 * 1024 - 10) + '…[日志截断]'
    let entry
    try {
      entry = this.diagnostics.begin(bounded, false, 'error')
    } catch {
      this.recordFailure(error)
      return
    }
    try {
      const reply = this.debug!.dispatch(entry)
      if (reply.kind === 'invoke')
        this.discard(await this.runtime!.invoke(reply.callback, reply.args))
    } catch (observerError) {
      this.deps.event({ type: 'log', level: 'error', text })
      this.deps.event({
        type: 'log',
        level: 'error',
        text: `日志回调或输出失败：${String(observerError)}；原始异常仍被保留。`,
      })
    }
    try {
      this.diagnostics.error()
    } catch (e) {
      this.reportFlushFailure(e)
    }
  }
  private reportFlushFailure(error: unknown): void {
    this.deps.event({
      type: 'log',
      level: 'error',
      text: `日志或存档写入失败：${this.errorText(error)}；已有数据仍可导出，停止时可重试提交。`,
    })
  }
  private errorText(error: unknown): string {
    if (error instanceof TvpError && this.runtime?.formatTvpMessage) {
      try { return this.runtime.formatTvpMessage(error.tvpMessage) }
      catch (formatError) {
        // Logging must retain both failures without replacing the operation's
        // original error or entering script to obtain a translated message.
        const detail = formatError instanceof Error ? formatError.message : String(formatError)
        return `${error.message}; TVP message formatting failed: ${detail}`
      }
    }
    return error instanceof Error ? error.message : String(error)
  }
  private async flushFiles(native = true, forceDiagnostics = false): Promise<void> {
    let failed = false,
      error: unknown
    const capture = (value: unknown) => {
      if (!failed) error = value
      failed = true
    }
    if (native) {
      try {
        await this.runtime?.flush()
      } catch (e) {
        capture(e)
      }
    }
    this.materializeLogs()
    if (forceDiagnostics || !this.diagnostics.fileOutputDisabled || this.saves.hasPendingGameWrites)
      try {
        await this.saves.flush()
      } catch (e) {
        if (this.saves.hasPendingGameWrites) capture(e)
        else this.diagnostics.disableFileOutput(e, true)
      }
    if (failed) throw error
  }
  private materializeLogs(): void {
    try {
      this.diagnostics.flush()
    } catch (error) {
      this.diagnostics.disableFileOutput(error)
    }
  }
  private discard(value: ScriptValue): void {
    if (isScriptObject(value)) this.runtime!.release(value)
  }
  private hasPendingRedraw(): boolean {
    for (const id of this.redrawRequests)
      if (
        !this.layers.has(id) ||
        !this.layers.get(id).callOnPaint ||
        !this.inputControllers.forLayer(id).attached(id) ||
        this.layerObjects?.isClosing(id)
      ) {
        this.redrawRequests.delete(id)
        this.deferredPaint.delete(id)
        this.modalReadyRedraw.delete(id)
      }
    return this.redrawRequests.size !== 0
  }
  private armRedraw(): void {
    const pending = this.hasPendingRedraw()
    if (
      !pending ||
      this.control.cancelled ||
      this.control.paused ||
      this.state !== 'running' ||
      this.systemEvents?.disabled ||
      this.activity.state !== 'visible'
    ) {
      this.cancelRedraw?.()
      this.cancelRedraw = undefined
      this.redrawWakeAt = undefined
      return
    }
    if (this.redrawQueued) return
    let deadline = Infinity
    for (const deferred of this.deferredPaint.values())
      if (deferred.deadline !== undefined) deadline = Math.min(deadline, deferred.deadline)
    if (deadline === this.redrawWakeAt) return
    this.cancelRedraw?.()
    this.cancelRedraw = undefined
    this.redrawWakeAt = undefined
    // A Layer whose onPaint is still running has no deadline yet.
    if (!Number.isFinite(deadline)) return
    this.redrawWakeAt = deadline
    // Only one delayed frame and one serialized execution can be in flight.
    // Its deadline belongs to the earliest waiting Layer, not the last Layer
    // painted: frequent explicit paints must not starve an unrelated Layer.
    this.cancelRedraw = this.deps.schedule(
      () => {
        this.cancelRedraw = undefined
        this.redrawWakeAt = undefined
        if (!this.hasPendingRedraw() || this.control.cancelled) return
        const due = [...this.deferredPaint]
          .filter(
            ([, deferred]) =>
              deferred.deadline !== undefined && deferred.deadline <= this.deps.now(),
          )
          .map(([id, deferred]) => [id, deferred.generation] as const)
        if (!due.length) {
          this.armRedraw()
          return
        }
        if (this.modalLoop?.hasTjsContinuation) {
          for (const [id, generation] of due) this.modalReadyRedraw.set(id, generation)
          this.frameRequested = true
          this.dirty = true
          this.modalWakeup?.()
          return
        }
        // A Pad save owns a host scope, not a suspended TJS pump. Its ordinary
        // redraw deadlines must keep using this existing serialized execution.
        this.redrawQueued = true
        void this.execute(async () => {
          // Recheck when the VM actually takes this task: it can have waited
          // behind an asynchronous call, a newer paint of the same Layer, or a
          // page transition. A stale wake cannot unlock a replacement request.
          if (!this.systemEvents?.disabled && this.activity.state === 'visible')
            for (const [id, generation] of due)
              if (this.deferredPaint.get(id)?.generation === generation) {
                this.deferredPaint.delete(id)
                this.invalidateLayer(id)
              }
          return undefined
        }, 2)
          .catch(() => {}) // execute records and fails the session itself.
          .finally(() => {
            this.redrawQueued = false
            this.armRedraw()
          })
      },
      Math.max(0, deadline - this.deps.now()),
    )
  }
  private *prepareFrame(source?: number | readonly number[], explicit = false): InputOperation {
    if (source === undefined) {
      yield* this.deliverWindowUpdates(false)
      return
    }
    if (this.preparingFrame && !explicit) return
    const wasPreparing = this.preparingFrame
    this.preparingFrame = true
    const layers = this.layers,
      painted = this.paintedLayers,
      deferred = this.deferredPaint,
      pending = this.redrawRequests,
      beginPaint = () => {
        // Drop only the consumed Layer's scheduled wake, preserving the
        // earliest deadline of other Layers while this callback is suspended.
        this.armRedraw()
      }
    function* visit(id: number, paint: boolean, seen = new Set<number>()): InputOperation {
      if (!layers.has(id) || seen.has(id)) return
      seen.add(id)
      if (paint && (explicit || (!painted.has(id) && !deferred.has(id)))) {
        pending.delete(id)
        if (explicit) deferred.delete(id)
        if (layers.get(id).callOnPaint) {
          beginPaint()
          painted.add(id)
          layers.set(id, 'callOnPaint', 0)
          yield { target: id, method: 'onPaint', args: [] }
        }
      }
      if (!layers.has(id)) return
      for (const child of [...layers.get(id).children]) yield* visit(child, paint, seen)
      // Native completion traversals invalidate even an empty children snapshot
      // after visiting it. User edits remain visible until such a traversal.
      if (layers.has(id)) layers.invalidateChildren(id)
    }
    try {
      const roots = typeof source === 'number' ? [source] : source,
        windowPass = typeof source !== 'number',
        updateWindow = windowPass && roots.length && this.layers.has(roots[0]!)
          ? this.layers.get(roots[0]!).windowId : undefined
      for (const root of roots) yield* visit(root, true)
      if (this.transitions?.active && (!windowPass || updateWindow !== undefined))
        yield* this.transitions.advance(updateWindow)
      for (const root of roots) yield* visit(root, false)
    } finally {
      this.preparingFrame = wasPreparing
    }
  }
  private invalidateWindow(windowId: number): void {
    if (!this.registeredWindow(windowId) || this.control.cancelled) return
    this.windowUpdates.post(windowId)
    this.dirty = true
    if (!this.executing && this.state === 'running') this.requestReceiptCheckpoint()
  }
  private invalidateLayer(id: number): void {
    this.dirty = true
    const windowId = this.layerWindow(id)
    if (windowId !== undefined) this.invalidateWindow(windowId)
  }
  private layerWindow(id: number): number | undefined {
    if (!this.layers.has(id)) return undefined
    let layer = this.layers.get(id)
    if (!layer.width || !layer.height) return undefined
    // Detached Layers have no native manager/window invalidation route.
    while (layer.parent) {
      if (!layer.visible) return undefined
      layer = this.layers.get(layer.parent)
    }
    // DrawDevice::NotifyLayerImageChange ignores secondary managers. Their
    // pending paints still run when the Window's primary manager is exposed.
    return layer.primary && this.inputControllers.get(layer.windowId)?.root() === layer.id
      ? layer.windowId : undefined
  }
  private *deliverWindowUpdates(explicit = true): InputOperation {
    if (!this.windowUpdates.begin()) return
    const savedPainted = this.paintedLayers
    this.paintedLayers = new Set()
    const visited = new Set<number>()
    try {
      for (let id = this.windowUpdates.next(); id !== undefined; id = this.windowUpdates.next()) {
        this.control.check()
        const window = this.registeredWindow(id)
        if (!window) continue
        const roots = this.layers.ids().filter((layerId) => {
          const layer = this.layers.get(layerId)
          return layer.windowId === id && layer.primary && !layer.parent
        })
        const repeated = visited.has(id)
        visited.add(id)
        // New invalidations during delivery may consume the second native
        // entry immediately. Work left after the two-entry cap remains deferred
        // until its existing bounded scheduler wake (unless explicitly forced).
        this.paintedLayers.clear()
        yield* this.prepareFrame(roots, explicit || repeated)
        if (this.registeredWindow(id) === window && !this.control.cancelled) this.present(id, true)
      }
    } finally {
      for (const id of this.paintedLayers) savedPainted.add(id)
      this.paintedLayers = savedPainted
      this.windowUpdates.finish()
      this.armRedraw()
    }
  }
  pause(): void {
    if (!['running', 'paused'].includes(this.state))
      throw new Error('Only an active session can be paused')
    this.userPaused = true
    this.applyPause()
    this.armRedraw()
    this.notify()
  }
  resume(): void {
    if (this.state !== 'paused') throw new Error('Session is not paused')
    this.userPaused = false
    this.applyPause()
    this.notify()
  }
  setSystemDisplay(update: SystemDisplayUpdate): boolean {
    if (this.control.cancelled || ['stopping', 'stopped', 'failed'].includes(this.state))
      return false
    return this.systemEnvironment.display.update(update)
  }

  setActivity(activity: ActivityState): void {
    validateActivity(activity)
    if (this.control.cancelled || activity.sequence <= this.activity.sequence) return
    const previous = this.activity
    if (previous.state === 'visible' && activity.state !== 'visible')
      this.observeAdmission(this.acceptWindowPopup({ type: 'application', active: false }))
    else if (previous.state !== 'visible' && activity.state === 'visible') this.applicationActive = true
    this.activity = { ...activity }
    // Freeze transport deadlines before applyPause sends pauseAll requests.
    this.pauseMediaRequestTimeouts()
    if (activityPaused(activity) && !activityPaused(previous) && this.state === 'paused')
      this.events?.pause(true)
    if (previous.state === 'visible' && activity.state !== 'visible') {
      this.windowMoves?.cancel()
      this.clearVirtualCursors()
      this.keyStates.release()
      for (const window of this.windows?.registered() ?? []) window.inputActive = false
      this.inputControllers.resetTransient()
      this.menus.dismiss(undefined, undefined, 'unavailable')
      // Commit only materialized overlay writes. Never reenter a suspended VM
      // to flush native streams from a page lifecycle callback.
      void this.flushFiles(false)
        .then(() => this.notify())
        .catch((error) => {
          if (!this.control.cancelled)
            this.deps.event({
              type: 'log',
              level: 'error',
              text: `后台存档提交失败：${String(error)}；待写数据仍可导出。`,
            })
        })
    }
    if (activity.state === 'visible') this.dirty = true
    this.applyPause()
    this.armRedraw()
    this.notify()
  }
  /** Mirrors the single Application/Tag REMOVE_POST native input source.
   * Current application facts are independent of popup-close notifications.
   * SystemImpl explicitly permits repeated delivered states; there is no
   * last-delivered/WasActive latch beyond the current-state delivery guard. */
  acceptApplicationActivation(value: ApplicationActivation): SessionAdmission {
    validateApplicationActivation(value)
    if (this.control.cancelled || value.sequence <= this.applicationActivation.sequence ||
        ['stopping', 'stopped', 'failed'].includes(this.state)) return ignoredAdmission()
    const active = value.active
    this.applicationActivation = { ...value }
    if (!active) this.requestAutomaticCompact(10)
    if (!['running', 'paused'].includes(this.state)) return ignoredAdmission()
    return this.acceptEvent(() => this.systemEvents!.application(active), {
      source: this.applicationEventSource, replace: true, priority: 1, discardable: false,
      valid: () => !this.control.cancelled && this.applicationActivation.active === active,
    })
  }
  private pauseMediaRequestTimeouts(): void {
    const paused = this.activity.state === 'frozen' || this.activity.state === 'away'
    this.deps.audio?.setRequestTimeoutsPaused?.(paused)
    this.deps.video?.setRequestTimeoutsPaused?.(paused)
  }
  private applyPause(): void {
    if (!['running', 'paused'].includes(this.state)) return
    const paused =
      this.userPaused ||
      (this.graphicsStatus.state !== 'ready' &&
        !(this.graphicsStatus.state === 'restoring' && this.graphicsStatus.pending === true)) ||
      activityPaused(this.activity)
    if (paused === (this.state === 'paused')) return
    this.maintenance?.setPaused(paused)
    if (paused) {
      this.windowMoves?.cancel()
      this.clearVirtualCursors()
      this.keyStates.release()
      for (const window of this.windows?.registered() ?? []) window.inputActive = false
      this.inputControllers.resetTransient()
      this.menus.dismiss(undefined, undefined, 'unavailable')
      this.presentMenus()
      this.control.pause()
      this.events?.pause(activityPaused(this.activity))
      this.systemEvents?.pause()
      this.transitions?.pause()
      this.modalLoop?.setPaused(true)
    } else {
      this.control.resume()
      this.events?.resume()
      this.systemEvents?.resume()
      this.transitions?.resume()
      this.modalLoop?.setPaused(false)
    }
    void this.sounds?.pause(paused).catch((error) => {
      if (!this.control.cancelled) this.fail(error)
    })
    void this.videos?.pause(paused).catch((error) => {
      if (!this.control.cancelled) this.fail(error)
    })
    this.setState(paused ? 'paused' : 'running')
    this.armRedraw()
  }
  retryGraphics(): void {
    if (this.control.cancelled) return
    this.deps.renderer.retry?.()
    this.present()
  }
  click(x: number, y: number): Promise<void> {
    return this.input({ type: 'down', x, y, button: 0, shift: 8, clicks: 1 }).then(() =>
      this.input({ type: 'up', x, y, button: 0, shift: 0, clicks: 1 }),
    )
  }
  pointerMove(x: number, y: number): Promise<void> {
    return this.input({ type: 'move', x, y, shift: 0, button: 0, clicks: 0 })
  }
  private registeredWindow(id: number): WindowRecord | undefined {
    try {
      const window = this.windows?.get(id)
      return window && !window.closing && !window.finished ? window : undefined
    } catch {
      return undefined
    }
  }
  private syncActiveWindow(): void {
    const active = this.windows?.active
    if (this.windowId !== (active?.id ?? 0)) this.windowRevision = -1
    this.windowId = active?.id ?? 0
    if (active) {
      this.window = active.state
    }
  }
  private windowPresentations(): WindowPresentation[] {
    return (this.windows?.registered() ?? []).map((window) => ({
      id: window.id,
      view: { ...window.state.view(), blocked: this.windowModals?.blocked(window.id) ?? false },
      main: this.windows?.mainId === window.id,
      active: this.windowId === window.id,
    }))
  }
  private closeWindowRegions(): void {
    this.windowRegionRequests.clear()
    this.windowRegions.clear()
    this.deps.event({ type: 'window-regions-clear' })
  }
  private publishWindowRegion(window: WindowRecord, region: WindowRegion | null): void {
    if (!Number.isSafeInteger(this.nextWindowRegionRevision + 1))
      throw new Error('Window region revision exhausted')
    const previous = this.windowRegions.get(window.id),
      copy = region ? copyWindowRegion(region) : null,
      revision = this.nextWindowRegionRevision++
    this.windowRegions.replace(window.id, region)
    try {
      // The event receives private plane ownership. It may be transferred or
      // consumed by a host without mutating the Session's retained snapshot.
      this.deps.event({ type: 'window-region', windowId: window.id, revision, region: copy })
    } catch (error) {
      this.windowRegions.replace(window.id, previous)
      throw error
    }
    window.state.regionRevision = revision
    window.state.revision++
    this.dirty = true
  }
  /** Screen observation is independent of a delayed Window input admission.
   * A replay cannot restore a cursor hidden after that same physical sample. */
  screenPointerState(screen: PhysicalPointerScreen): void {
    const next = copyPhysicalScreen(screen)
    if (this.state !== 'running' || this.activity.state !== 'visible' || this.control.cancelled ||
        screen.sequence <= (this.physicalScreen?.sequence ?? 0)) return
    this.physicalScreen = next
    if (next.restoreWindowId === undefined) return
    const window = this.registeredWindow(next.restoreWindowId)
    if (!window || !window.state.visible || this.windowModals?.blocked(window.id) || window.state.mouseCursorState !== 1) return
    const baseline = this.hiddenCursorPositions.get(window.id)
    if (!baseline || baseline.kind !== 'screen') {
      // Before the page has observed a screen position, the hide-time OS
      // coordinate is unknowable. Establish it without inventing movement.
      this.hiddenCursorPositions.set(window.id, { kind: 'screen', x: next.x, y: next.y })
    } else if (baseline.x !== next.x || baseline.y !== next.y) this.restoreTemporaryCursor(window)
  }
  private restoreTemporaryCursor(window: WindowRecord): void {
    if (window.state.mouseCursorState !== 1) return
    this.hiddenCursorPositions.delete(window.id)
    window.state.set('mouseCursorState', 0)
    this.presentWindowViews()
  }
  pointerState(x: number, y: number, windowId = this.windowId, pointerSequence?: number,
    physicalScreen?: PhysicalPointerScreen): void {
    const screen = physicalScreen && copyPhysicalScreen(physicalScreen)
    if (
      [x, y].some((value) => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid physical cursor coordinates')
    if (
      pointerSequence !== undefined &&
      (!Number.isSafeInteger(pointerSequence) || pointerSequence < 1)
    )
      throw new Error('Invalid physical pointer sequence')
    if (this.activity.state !== 'visible' || this.state !== 'running') return
    const window = this.registeredWindow(windowId)
    if (!window || !window.state.visible || this.windowModals?.blocked(windowId)) return
    if (pointerSequence !== undefined) {
      if (pointerSequence <= (this.physicalPointerSequences.get(windowId) ?? 0)) return
      this.physicalPointerSequences.set(windowId, pointerSequence)
    }
    this.windowPointers.set(windowId, { x, y })
    if (screen) this.screenPointerState(screen)
    else if (window.state.mouseCursorState === 1) {
      // Legacy injected input has only its own unframed coordinate domain;
      // it must never reinterpret an established real screen baseline.
      const baseline = this.hiddenCursorPositions.get(windowId), point = { x: Math.trunc(x), y: Math.trunc(y) }
      if (!baseline) this.hiddenCursorPositions.set(windowId, { kind: 'viewport', ...point })
      else if (baseline.kind === 'viewport' && (baseline.x !== point.x || baseline.y !== point.y))
        this.restoreTemporaryCursor(window)
    }
    // Observation remains independent of script delivery. The packet carrying
    // this same sample must not retire a newer script write a second time.
    this.clearVirtualCursors(windowId)
  }
  private cursorWindow(id: number): WindowRecord | undefined {
    const layer = this.layers.get(id),
      window = this.registeredWindow(layer.windowId),
      controller = this.inputControllers.get(layer.windowId)
    // The primary Layer can exchange positions within its manager, so its
    // current identity need not equal the manager's stable creation identity.
    return window && controller && controller.attached(id)
      ? window
      : undefined
  }
  private cursorOffset(layer: LayerState): { x: bigint; y: bigint } {
    let x = 0n, y = 0n
    for (let current = layer; current.parent; current = this.layers.get(current.parent)) {
      x = BigInt.asIntN(32, x + BigInt(current.left))
      y = BigInt.asIntN(32, y + BigInt(current.top))
    }
    return { x, y }
  }
  private currentVirtualCursor(windowId: number): VirtualCursorState | undefined {
    const cursor = this.virtualCursors.get(windowId)
    if (!cursor) return undefined
    const controller = this.inputControllers.get(windowId)
    if (
      this.state !== 'running' || this.activity.state !== 'visible' ||
      this.control.cancelled || this.registeredWindow(windowId) !== cursor.window ||
      !cursor.window.state.visible || this.windowModals?.blocked(windowId) ||
      this.fontSelection.active || this.clipboardBusy > 0 ||
      controller?.epoch !== cursor.controllerEpoch ||
      this.windowInputGeneration !== cursor.inputGeneration ||
      (cursor.layer !== undefined && (
        !this.layers.has(cursor.layer.id) || this.layers.get(cursor.layer.id) !== cursor.layer ||
        this.layerObjects?.isClosing(cursor.layer.id) ||
        this.cursorWindow(cursor.layer.id) !== cursor.window))
    ) {
      this.virtualCursors.delete(windowId)
      return undefined
    }
    return cursor
  }
  private clearVirtualCursors(windowId?: number): void {
    const changed = windowId === undefined
      ? this.virtualCursors.size !== 0
      : this.virtualCursors.has(windowId)
    if (windowId === undefined) this.virtualCursors.clear()
    else this.virtualCursors.delete(windowId)
    if (changed) this.presentInputViews()
  }
  private cursorPosition(id: number): { x: number; y: number } {
    const layer = this.layers.get(id)
    let root = layer
    while (root.parent) root = this.layers.get(root.parent)
    // Native detached Layers have no Manager and return zero immediately.
    // A secondary manager is different: DrawDevice supplies primary (0,0),
    // then the Layer getter still subtracts its ancestry's coordinates.
    if (!root.primary || !this.registeredWindow(layer.windowId)) return { x: 0, y: 0 }
    const window = this.cursorWindow(id), offset = this.cursorOffset(layer)
    if (!window) return {
      x: Number(BigInt.asIntN(32, -offset.x)),
      y: Number(BigInt.asIntN(32, -offset.y)),
    }
    const pointer = this.currentVirtualCursor(window.id)?.view ??
      this.windowPointers.get(window.id) ?? { x: 0, y: 0 },
      state = window.state,
      primaryLayer = this.layers.get(this.inputControllers.get(window.id)!.root()),
      geometry = drawDeviceGeometry(state, primaryLayer.width, primaryLayer.height),
      primary = toPrimary(paintBoxPoint(state, pointer.x, pointer.y), geometry,
        primaryLayer.width, primaryLayer.height)
    // Native client pixels and the inverse drawing transform truncate toward
    // zero before subtracting Layer positions, including negative coordinates.
    return {
      x: Number(BigInt.asIntN(32, BigInt(primary.x) - offset.x)),
      y: Number(BigInt.asIntN(32, BigInt(primary.y) - offset.y)),
    }
  }
  private setCursorPosition(id: number, x: number, y: number): void {
    const layer = this.layers.get(id), window = this.cursorWindow(id)
    if (
      !window || !window.state.visible || this.state !== 'running' ||
      this.activity.state !== 'visible' || this.control.cancelled ||
      this.layerObjects?.isClosing(id) ||
      this.windowModals?.blocked(window.id) || this.fontSelection.active ||
      this.clipboardBusy > 0
    ) return
    const controller = this.inputControllers.get(window.id)!,
      offset = this.cursorOffset(layer), state = window.state,
      primaryLayer = this.layers.get(controller.root()),
      geometry = drawDeviceGeometry(state, primaryLayer.width, primaryLayer.height),
      position = fromPrimary({
        x: Number(BigInt.asIntN(32, BigInt(x) + offset.x)),
        y: Number(BigInt.asIntN(32, BigInt(y) + offset.y)),
      }, geometry, primaryLayer.width, primaryLayer.height),
      view: VirtualCursor = {
        ...position,
        revision: this.nextVirtualCursorRevision,
        basePhysicalSequence: this.physicalPointerSequences.get(window.id) ?? 0,
      }
    if (!Number.isSafeInteger(this.nextVirtualCursorRevision + 1))
      throw new Error('Virtual cursor revision exhausted')
    // Check before publishing any new position. An over-budget event cannot
    // leave a moved marker whose hover operation was never admitted.
    if (this.postedInputPending >= 256) throw new Error('Posted input queue budget exceeded')
    const previous = this.virtualCursors.get(window.id),
      cursor: VirtualCursorState = {
        view, layer, window, controllerEpoch: controller.epoch,
        inputGeneration: this.windowInputGeneration,
      }
    this.nextVirtualCursorRevision++
    this.virtualCursors.set(window.id, cursor)
    try {
      this.postInput({
        type: 'move', x: view.x, y: view.y, shift: controller.shift, button: 0, clicks: 0,
      }, window, () => this.currentVirtualCursor(window.id) === cursor)
    } catch (error) {
      if (previous) this.virtualCursors.set(window.id, previous)
      else this.virtualCursors.delete(window.id)
      throw error
    }
    this.restoreTemporaryCursor(window)
    this.presentInputViews()
  }
  private windowMouseKeys(window: WindowRecord): WindowMouseKeys {
    let record = this.mouseKeys.get(window.id)
    if (!record) {
      const state = new MouseKeyState()
      state.configure(window.state.useMouseKey, this.deps.now())
      record = { state, scaleX: 1, scaleY: 1,
        down: { x: 0, y: 0, paintBoxPoint: { x: 0, y: 0 } },
        move: { x: 0, y: 0, paintBoxPoint: { x: 0, y: 0 } } }
      this.mouseKeys.set(window.id, record)
    }
    return record
  }
  private mouseKeyActions(window: WindowRecord, actions: readonly MouseKeyAction[], held = this.physicalKeys): SessionAdmission {
    const record = this.windowMouseKeys(window), controller = this.inputControllers.get(window.id)
    if (!controller || !actions.length) return ignoredAdmission()
    const admissions: SessionAdmission[] = []
    try { for (const action of actions) {
      const current = this.currentVirtualCursor(window.id)?.view ??
        this.windowPointers.get(window.id) ?? { x: 0, y: 0 }
      if (action.type === 'move') {
        const point = { x: current.x + action.dx * record.scaleX,
          y: current.y + action.dy * record.scaleY }
        if (![point.x, point.y].every((value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER))
          throw new Error('Mouse key position is out of range')
        if (!Number.isSafeInteger(this.nextVirtualCursorRevision + 1))
          throw new Error('Virtual cursor revision exhausted')
        const cursor: VirtualCursorState = {
          view: { ...point, revision: this.nextVirtualCursorRevision++,
            basePhysicalSequence: this.physicalPointerSequences.get(window.id) ?? 0 },
          window, controllerEpoch: controller.epoch, inputGeneration: this.windowInputGeneration,
        }
        const previous = this.virtualCursors.get(window.id), previousMove = record.move
        this.virtualCursors.set(window.id, cursor)
        let shift = 0
        for (const [key, flag] of [[16, 1], [18, 2], [17, 4], [1, 8], [2, 16], [4, 32], [5, 256], [6, 512]])
          if (held.has(key!)) shift |= flag!
        const inside = point.x >= 0 && point.y >= 0 && point.x < window.state.viewportWidth && point.y < window.state.viewportHeight
        const wasInside = current.x >= 0 && current.y >= 0 && current.x < window.state.viewportWidth && current.y < window.state.viewportHeight
        try {
          if (inside || controller.capture)
            admissions.push(this.acceptInput({ type: 'move', ...point, shift, button: 0, clicks: 0,
              windowId: window.id }, false, () => this.currentVirtualCursor(window.id) === cursor))
          else if (wasInside)
            admissions.push(this.acceptInput({ type: 'leave', windowId: window.id }, false,
              () => this.currentVirtualCursor(window.id) === cursor))
        } catch (error) {
          if (previous) this.virtualCursors.set(window.id, previous)
          else this.virtualCursors.delete(window.id)
          record.move = previousMove
          throw error
        }
        this.restoreTemporaryCursor(window)
        this.presentInputViews()
      } else {
        // InternalKeyDown/Up uses ScrollBox-relative integers directly as
        // PaintBox arguments. This differs from an actual mouse message,
        // whose PaintBox origin has already been subtracted by VCL.
        const point = action.position === 'down' ? record.down : action.position === 'move' ? record.move : {
          x: current.x, y: current.y,
          paintBoxPoint: { x: deviceInt(current.x), y: deviceInt(current.y) },
        }
        admissions.push(this.acceptInput({ type: action.type, ...point, windowId: window.id,
          button: action.button, shift: 0, clicks: action.type === 'click' ? 1 : 0 }, false))
      }
    } } catch (error) {
      // A later action (left up follows click) may fail admission after an
      // earlier event already owns a receipt. Preserve its cleanup/reporting.
      for (const admission of admissions) this.observeAdmission(admission)
      throw error
    }
    return { status: admissions.some((entry) => entry.status === 'accepted') ? 'accepted' : 'ignored',
      completion: Promise.all(admissions.map((entry) => entry.completion)).then(() => {}) }
  }
  keyState(keys: number[]): void {
    if (keys.length > 256 || keys.some((key) => !Number.isInteger(key) || key < 0 || key > 65535))
      throw new Error('Invalid keyboard state')
    if (this.control.cancelled || ['stopping', 'stopped', 'failed'].includes(this.state)) return
    // Browser suspension reaches the host asynchronously. A late nonempty
    // snapshot cannot restore held keys or create presses while paused.
    if (this.activity.state === 'visible' && this.state !== 'paused') this.keyStates.replace(keys)
    else this.keyStates.release()
    for (const controller of this.inputControllers.values())
      controller.keys = new Set(this.physicalKeys)
  }
  async input(packet: InputPacket, observe = true): Promise<void> {
    await this.acceptInput(packet, observe).completion
  }
  private acceptEvent(
    prepare: () => HostReply,
    options: EventOptions,
    delivery?: { release(): void; before(): readonly number[] },
    receiptReservation?: object,
  ): SessionAdmission {
    const reserved = receiptReservation !== undefined && this.fileDropReceiptReservations.delete(receiptReservation)
    if (receiptReservation !== undefined && !reserved) throw new ExecutionCancelled()
    if (!delivery && !reserved && this.eventReceipts.size + this.fileDropReceiptReservations.size >= 65536)
      throw new Error('Event receipt budget exceeded')
    let resolve!: () => void, reject!: (error: unknown) => void
    const completion = new Promise<void>((yes, no) => {
        resolve = yes
        reject = no
      }),
      receipt: SessionEventReceipt = {
        id: this.nextReceipt++,
        completion,
        resolve,
        reject,
        epilogueDone: false,
        nativeDone: false,
        tailDone: false,
        terminal: false,
        failed: false,
        frameWindows: [],
        frameAfter: new Map(),
      }
    // Construct the record and transfer its cleanup before enqueue: a disabled
    // discard settles synchronously, before admission has returned to us.
    this.eventReceipts.set(receipt.id, receipt)
    receipt.deferredSettlement = () => {
      try {
        options.onSettled?.(
          receipt.outcome ?? { kind: 'disposed', error: new ExecutionCancelled() },
          receipt.round,
        )
      } catch (error) {
        this.receiptCleanupFailure(receipt, error)
      }
      try {
        delivery?.release()
      } catch (error) {
        this.receiptCleanupFailure(receipt, error)
      }
    }
    const settled = (outcome: EventOutcome, round?: number) => {
      if (receipt.terminal || receipt.outcome) return
      receipt.outcome = outcome
      receipt.round = round
      receipt.epilogueDone = outcome.kind !== 'failed'
      if (outcome.kind === 'aborted' || outcome.kind === 'disposed')
        this.receiptFailure(receipt, outcome.error)
      if (outcome.kind !== 'delivered' && outcome.kind !== 'failed') {
        receipt.frameWindows = []
        receipt.frameAfter.clear()
      }
      if (round === undefined) this.outsideReceipts.add(receipt.id)
      else {
        let pending = this.settledRounds.get(round)
        if (!pending) this.settledRounds.set(round, (pending = new Set()))
        pending.add(receipt.id)
        const aborted = this.abortedReceiptRounds.get(round)
        if (aborted) {
          receipt.epilogueDone = true
          this.receiptFailure(receipt, aborted)
          this.outerRecoveryReceipts.add(receipt.id)
        }
      }
      // A normal event already has its own TJS round. Its lease ends at the
      // original settlement point. A never-entered video owns a lease too;
      // bind its cleanup to a new continuation before releasing that lease.
      if (round !== undefined || !delivery) this.releaseReceipt(receipt)
      if (this.control.cancelled) this.finishReceipt(receipt, new ExecutionCancelled())
      else if (round === undefined) this.requestReceiptCheckpoint()
      this.modalWakeup?.()
    }
    try {
      // A video already owns its callback. Even preparation or budget failure
      // must transfer that lease into a native-fenced failed receipt.
      if (!reserved && this.eventReceipts.size + this.fileDropReceiptReservations.size > 65536)
        throw new Error('Event receipt budget exceeded')
      receipt.frameWindows = (delivery?.before() ?? []).flatMap((id) => {
        const window = this.registeredWindow(id)
        return window ? [window] : []
      })
      const admission = this.systemEvents!.enqueue(prepare, { ...options, onSettled: settled })
      // Body rejection is owned by the receipt. It is not the native/frame
      // boundary and must not escape as an unobserved second Promise.
      void admission.completion.catch(() => {})
      return { status: admission.status === 'accepted' ? 'accepted' : 'ignored', completion }
    } catch (error) {
      if (!delivery) {
        this.eventReceipts.delete(receipt.id)
        receipt.terminal = true
        this.releaseReceipt(receipt)
        receipt.resolve() // No completion was handed to this rejected caller.
        throw error
      }
      // Video transport still waits for the rejected admission's owned lease
      // to cross a native boundary before its listener can acknowledge it.
      settled({ kind: 'aborted', error })
      return { status: 'ignored', completion }
    }
  }
  private receiptFailure(receipt: SessionEventReceipt, error: unknown): void {
    if (!receipt.failed) {
      receipt.failed = true
      receipt.error = error
    }
  }
  private receiptCleanupFailure(receipt: SessionEventReceipt, error: unknown): void {
    this.receiptFailure(receipt, error)
    if (this.control.cancelled) this.cancellationErrors.push(error)
  }
  private releaseReceipt(receipt: SessionEventReceipt): void {
    const release = receipt.deferredSettlement
    receipt.deferredSettlement = undefined
    try {
      release?.()
    } catch (error) {
      this.receiptCleanupFailure(receipt, error)
    }
  }
  private finishReceipt(receipt: SessionEventReceipt, cancelled?: unknown): void {
    if (receipt.terminal) return
    receipt.terminal = true
    this.eventReceipts.delete(receipt.id)
    this.outsideReceipts.delete(receipt.id)
    this.outerRecoveryReceipts.delete(receipt.id)
    if (receipt.round !== undefined) {
      const pending = this.settledRounds.get(receipt.round)
      pending?.delete(receipt.id)
      if (!pending?.size) this.settledRounds.delete(receipt.round)
    }
    this.releaseReceipt(receipt)
    if (receipt.failed) receipt.reject(receipt.error)
    else if (cancelled !== undefined) receipt.reject(cancelled)
    else receipt.resolve()
  }
  private cancelEventReceipts(error: unknown): void {
    for (const receipt of [...this.eventReceipts.values()]) this.finishReceipt(receipt, error)
    for (const checkpoint of this.checkpoints.values()) this.restoreCheckpointPaint(checkpoint)
    this.checkpoints.clear()
    this.settledRounds.clear()
    this.outsideReceipts.clear()
    this.outerRecoveryReceipts.clear()
    this.abortedReceiptRounds.clear()
    for (const waiter of this.frameWaiters) waiter.reject(error)
    this.frameWaiters.clear()
    this.frameRequested = false
  }
  private nativeReleasesPending(): boolean {
    if (!this.runtime || this.control.cancelled) return false
    const native = this.runtime.inspect()
    return native.drainingReleased || native.pendingHandles > 0 || native.pendingInvalidations > 0
  }
  private completeReadyReceipts(): void {
    // A host-only save does not suspend the outer VM entry. Keep its main-close
    // receipts pending until execute.finally requests ordinary termination.
    if (this.exitAfterOperation && !this.modalLoop?.hasTjsContinuation) return
    for (const receipt of [...this.eventReceipts.values()]) {
      if (!receipt.nativeDone || !receipt.tailDone || !receipt.epilogueDone) continue
      const frameComplete = receipt.frameWindows.every(
        (window) =>
          this.registeredWindow(window.id) !== window ||
          // A hidden Window keeps the decoded Layer pixels but has no
          // visible surface obligation. This is an explicit skipped frame,
          // not evidence that presenting an empty layer list succeeded.
          !window.state.visible ||
          (this.windowPresentationsCompleted.get(window.id) ?? 0) >=
            (receipt.frameAfter.get(window.id) ?? Infinity),
      )
      if (receipt.failed || frameComplete) this.finishReceipt(receipt)
    }
  }
  private markReceiptNativeDone(receipt: SessionEventReceipt): void {
    if (receipt.nativeDone) return
    receipt.nativeDone = true
    receipt.checkpoint = undefined
    this.outerRecoveryReceipts.delete(receipt.id)
    // A present before this event's callback/native cleanup is not its frame
    // evidence. Require a later successful submission to each affected Window.
    for (const window of receipt.frameWindows)
      receipt.frameAfter.set(window.id, (this.windowPresentationsCompleted.get(window.id) ?? 0) + 1)
    if (receipt.frameWindows.some((window) => this.registeredWindow(window.id) === window))
      this.dirty = true
  }
  private beginCheckpoint(round?: number, tail = false, paint = false, force = false): HostReply {
    if (!this.checkpointCallbacks || this.control.cancelled)
      return { kind: 'value', value: undefined }
    const ids = [...this.eventReceipts.values()]
      .filter(
        (receipt) =>
          receipt.outcome &&
          receipt.epilogueDone &&
          !receipt.nativeDone &&
          receipt.checkpoint === undefined &&
          (receipt.round === undefined ||
            receipt.round === round ||
            this.outerRecoveryReceipts.has(receipt.id)),
      )
      .map((receipt) => receipt.id)
    if (!tail && !force && !ids.length) return { kind: 'value', value: undefined }
    if (this.checkpoints.size >= 256) throw new Error('Native checkpoint budget exceeded')
    const checkpoint: SessionCheckpoint = {
      id: this.nextCheckpoint++,
      receipts: ids,
      tailReceipts: tail
        ? [...this.eventReceipts.values()]
            .filter((receipt) => receipt.nativeDone && receipt.epilogueDone && !receipt.tailDone)
            .map((receipt) => receipt.id)
        : [],
      tail,
      paint: paint && this.activity.state === 'visible',
      phase: 'issued',
      paintBlocked: false,
      paintStarted: false,
      frameRan: false,
    }
    this.checkpoints.set(checkpoint.id, checkpoint)
    for (const id of ids) {
      const receipt = this.eventReceipts.get(id)!
      receipt.checkpoint = checkpoint.id
      this.releaseReceipt(receipt)
    }
    return {
      kind: 'invoke',
      callback: this.checkpointCallbacks.pump,
      args: [BigInt(checkpoint.id)],
    }
  }
  private restoreCheckpointPaint(checkpoint: SessionCheckpoint): void {
    if (!checkpoint.savedPainted) return
    this.paintedLayers = checkpoint.savedPainted
    checkpoint.savedPainted = undefined
  }
  private parkCheckpoint(checkpoint: SessionCheckpoint): void {
    this.restoreCheckpointPaint(checkpoint)
    checkpoint.phase = 'parked'
    for (const id of checkpoint.receipts) {
      const receipt = this.eventReceipts.get(id)
      if (receipt?.checkpoint !== checkpoint.id) continue
      receipt.checkpoint = undefined
      this.outerRecoveryReceipts.add(id)
    }
    this.checkpoints.delete(checkpoint.id)
    // Do not make an ancestor drain/onPaint into runnable modal work. Only a
    // later native continuation with an inactive drain (or actual exported
    // return) may discharge this fence. Empty blocked checkpoints own nothing
    // and must not accumulate while a finalizer runs a long modal loop.
  }
  private failCheckpoint(checkpoint: SessionCheckpoint, error: unknown): void {
    for (const id of [...checkpoint.receipts, ...checkpoint.tailReceipts]) {
      const receipt = this.eventReceipts.get(id)
      if (receipt) this.receiptFailure(receipt, error)
    }
    this.parkCheckpoint(checkpoint)
  }
  private async checkpointHost(
    operation: string,
    args: ScriptValue[],
    context: HostContext,
  ): Promise<HostReply> {
    const empty: HostReply = { kind: 'value', value: undefined }
    if (operation === 'Checkpoint.bind') {
      if (
        this.checkpointCallbacks ||
        args.length !== 3 ||
        args.some((value) => !isScriptObject(value))
      )
        throw new Error('Checkpoint callbacks must be bound once')
      const retained: ScriptObject[] = []
      try {
        for (const value of args) retained.push(context.retain(value as ScriptObject))
        this.checkpointCallbacks = {
          pump: retained[0]!,
          publish: retained[1]!,
          commit: retained[2]!,
        }
      } catch (error) {
        for (const value of retained) context.release(value)
        throw error
      }
      return empty
    }
    const id = Number(args[0]),
      checkpoint = this.checkpoints.get(id)
    if (!Number.isSafeInteger(id) || id <= 0 || !checkpoint) {
      if (operation === 'Checkpoint.abort' || this.control.cancelled) return empty
      throw new Error('Native checkpoint has ended')
    }
    if (operation === 'Checkpoint.abort') {
      this.failCheckpoint(checkpoint, new Error(String(args[1] ?? 'Native checkpoint failed')))
      return empty
    }
    if (operation === 'Checkpoint.enter') {
      if (checkpoint.phase !== 'issued') throw new Error('Native checkpoint entered twice')
      checkpoint.phase = 'entered'
      if (this.nativeReleasesPending()) {
        this.parkCheckpoint(checkpoint)
        return { kind: 'value', value: 0n }
      }
      return { kind: 'value', value: 1n }
    }
    if (operation === 'Checkpoint.ownership')
      return this.inputs!.start(this.inputControllers.synchronize())
    if (operation === 'Checkpoint.paint') {
      if (!checkpoint.tail) return empty
      if (this.preparingFrame) {
        checkpoint.paintBlocked = true
        return empty
      }
      if (!checkpoint.paint || this.systemEvents?.disabled || this.activity.state !== 'visible')
        return empty
      this.consumeReadyFrame()
      if (
        this.hasPendingRedraw() &&
        [...this.redrawRequests].some((layer) => !this.deferredPaint.has(layer))
      )
        this.dirty = true
      if (!this.dirty && !this.windowUpdates.pending) return empty
      checkpoint.savedPainted = this.paintedLayers
      this.paintedLayers = new Set()
      checkpoint.paintStarted = true
      return this.inputs!.start(this.prepareFrame())
    }
    if (operation === 'Checkpoint.afterPaint') {
      if (checkpoint.paintStarted) checkpoint.frameRan = true
      this.restoreCheckpointPaint(checkpoint)
      return empty
    }
    if (operation === 'Checkpoint.cleanup') {
      try {
        await this.flushCheckpointCleanup(checkpoint.tail && !checkpoint.paintBlocked)
      } catch (error) {
        this.failCheckpoint(checkpoint, error)
        throw error
      }
      return empty
    }
    if (operation === 'Checkpoint.fence') {
      const publish = Number(args[1]) === 1
      if (
        (publish && checkpoint.phase !== 'entered') ||
        (!publish && checkpoint.phase !== 'publishing')
      )
        throw new Error('Invalid native checkpoint continuation')
      checkpoint.phase = publish ? 'publishing' : 'committing'
      return {
        kind: 'invoke',
        callback: publish ? this.checkpointCallbacks!.publish : this.checkpointCallbacks!.commit,
        args: [BigInt(id)],
      }
    }
    if (operation === 'Checkpoint.publish') {
      if (checkpoint.phase !== 'publishing') throw new Error('Invalid checkpoint publication')
      if (this.nativeReleasesPending()) {
        this.parkCheckpoint(checkpoint)
        return { kind: 'value', value: 0n }
      }
      // The previous native release may itself have retired media. Backend
      // closes are host work; never await a receipt or SerialQueue from here.
      try {
        await this.flushCheckpointCleanup(checkpoint.tail && !checkpoint.paintBlocked)
      } catch (error) {
        this.failCheckpoint(checkpoint, error)
        throw error
      }
      if (checkpoint.tail && !checkpoint.paintBlocked) {
        this.attemptedFrameVersion = this.frameWorkVersion
        this.present()
        this.notify()
        this.finishFrameDeadlines()
      }
      return { kind: 'value', value: 1n }
    }
    if (operation === 'Checkpoint.commit') {
      if (checkpoint.phase !== 'committing') throw new Error('Invalid checkpoint commit')
      if (checkpoint.paintStarted && !checkpoint.frameRan)
        throw new Error('Window update has not completed')
      if (this.nativeReleasesPending()) {
        this.parkCheckpoint(checkpoint)
        return empty
      }
      for (const receiptId of checkpoint.receipts) {
        const receipt = this.eventReceipts.get(receiptId)
        if (receipt?.checkpoint === id) this.markReceiptNativeDone(receipt)
      }
      if (checkpoint.tail && !checkpoint.paintBlocked) {
        for (const receiptId of [...checkpoint.tailReceipts, ...checkpoint.receipts]) {
          const receipt = this.eventReceipts.get(receiptId)
          if (receipt?.nativeDone) receipt.tailDone = true
        }
        this.completeFrameWaiters()
      }
      this.checkpoints.delete(id)
      this.completeReadyReceipts()
      if (checkpoint.tail && this.exitAfterOperation && this.modalLoop?.hasTjsContinuation) {
        this.exitAfterOperation = false
        this.requestExit()
      }
      return empty
    }
    throw new Error(`Unknown checkpoint operation: ${operation}`)
  }
  private async flushCheckpointCleanup(files: boolean): Promise<void> {
    let failed = false,
      primary: unknown
    for (const action of [
      () => this.videos?.flushCloses(),
      () => this.sounds?.flushCloses(),
      ...(files ? [() => this.flushFiles()] : []),
    ]) {
      try {
        await action()
      } catch (error) {
        if (!failed) {
          failed = true
          primary = error
        } else this.reportFlushFailure(error)
      }
    }
    if (failed) throw primary
  }
  /** ModalLoop uses these three hooks; all script remains in its HostReply stack. */
  setModalWakeup(wake?: () => void): void {
    this.modalWakeup = wake
  }
  hasModalWork(): boolean {
    if (this.control.cancelled || this.control.paused) return false
    return (
      this.pendingCompact > 0 ||
      !!this.systemEvents?.hasDispatchableWork() ||
      (!this.nativeReleasesPending() && (this.hasOutsideReceipts() || this.hasPendingFrameWork()))
    )
  }
  beginModalDispatch(): HostReply {
    if (!this.hasModalWork()) return { kind: 'value', value: undefined }
    if (this.pendingCompact) return this.takeAutomaticCompact()
    if (this.hasOutsideReceipts() && !this.nativeReleasesPending())
      return this.beginCheckpoint(undefined)
    if (this.systemEvents?.disabled) return this.beginCheckpoint(undefined, true, false)
    return this.systemEvents!.beginNested({ windowUpdate: this.hasPendingFrameWork() })
  }
  private hasOutsideReceipts(): boolean {
    return [...this.outsideReceipts, ...this.outerRecoveryReceipts].some((id) => {
      const receipt = this.eventReceipts.get(id)
      return !!receipt && !receipt.nativeDone && receipt.checkpoint === undefined
    })
  }
  private hasPendingFrameWork(): boolean {
    if (this.preparingFrame) return false
    // Hidden, unpaused sessions still owe an explicit skipped window-update
    // tail to completed admissions. Dirty pixels alone cannot keep a hidden
    // modal loop awake; the tail obligation disappears once committed.
    if ([...this.eventReceipts.values()].some((receipt) => receipt.nativeDone && !receipt.tailDone))
      return true
    return (
      this.activity.state === 'visible' &&
      (this.frameRequested || (!this.systemEvents?.disabled && this.windowUpdates.pending) ||
        (this.dirty && this.frameWorkVersion !== this.attemptedFrameVersion))
    )
  }
  private requestReceiptCheckpoint(): void {
    this.modalWakeup?.()
    if (this.executing || this.checkpointQueued || this.control.cancelled) return
    this.checkpointQueued = true
    void this.execute(async () => {
      const reply = this.beginCheckpoint(undefined)
      return reply.kind === 'invoke' ? this.runtime!.invoke(reply.callback, reply.args) : undefined
    }, 2)
      .catch((error) => {
        if (!this.control.cancelled) this.fail(error)
      })
      .finally(() => {
        this.checkpointQueued = false
        if (this.hasOutsideReceipts() && !this.control.cancelled) this.requestReceiptCheckpoint()
      })
  }
  private requestFrameCheckpoint(): Promise<void> {
    this.frameRequested = true
    this.dirty = true
    const completion = new Promise<void>((resolve, reject) =>
      this.frameWaiters.add({ resolve, reject }),
    )
    this.requestReceiptCheckpoint()
    return completion
  }
  private consumeReadyFrame(): void {
    if (this.systemEvents?.disabled || this.activity.state !== 'visible') return
    // Only a real scheduled wake may consume a deferred self-update. An
    // unrelated event round (including eventDisabled=false) may see an old
    // deadline but must preserve it until the rearmed timer actually fires.
    for (const [id, generation] of this.modalReadyRedraw) {
      if (this.deferredPaint.get(id)?.generation === generation) {
        this.deferredPaint.delete(id)
        this.invalidateLayer(id)
      }
      this.modalReadyRedraw.delete(id)
    }
  }
  private finishFrameDeadlines(): void {
    this.hasPendingRedraw()
    for (const id of this.redrawRequests) {
      let deferred = this.deferredPaint.get(id)
      if (!deferred && !this.systemEvents?.disabled) {
        deferred = { generation: ++this.redrawGeneration }
        this.deferredPaint.set(id, deferred)
      }
      if (deferred) deferred.deadline ??= this.deps.now() + 16
    }
    this.armRedraw()
  }
  private completeFrameWaiters(): void {
    this.frameRequested = false
    for (const waiter of this.frameWaiters) waiter.resolve()
    this.frameWaiters.clear()
  }
  private observeAdmission(admission: SessionAdmission): void {
    void admission.completion.catch((error) => {
      if (!this.control.cancelled) this.fail(error)
    })
  }
  private keyboardReceiver(source: WindowRecord): WindowRecord {
    return this.windows?.keyTrapper((window) => !this.windowModals?.blocked(window.id)) ?? source
  }
  private keyboardRoute(source: WindowRecord): NonNullable<InputView['keyboardRoute']> {
    const receiver = this.keyboardReceiver(source),
      controller = this.inputControllers.get(receiver.id),
      sourceController = this.inputControllers.get(source.id),
      focused = controller?.focused ?? 0,
      imeMode = controller?.view().imeMode ?? 0,
      inputSignature = JSON.stringify([
        receiver.id,
        controller?.epoch ?? 0,
        controller?.ownershipEpoch ?? 0,
        sourceController?.epoch ?? 0,
        sourceController?.ownershipEpoch ?? 0,
        receiver.state.keyboardRevision,
        source.state.keyboardRevision,
        this.windowInputGeneration,
        !!this.windowModals?.blocked(source.id),
        this.fontSelection.active,
      ]),
      signature = JSON.stringify([
        inputSignature,
        focused,
        controller?.focusRevision ?? 0,
        sourceController?.focusRevision ?? 0,
        imeMode,
      ]),
      previous = this.keyboardRoutes.get(source.id)
    if (previous?.signature === signature) return previous.route
    const route = {
      windowId: receiver.id,
      focused,
      imeMode,
      revision: this.nextKeyboardRouteRevision++,
      inputRevision:
        previous?.inputSignature === inputSignature
          ? previous.route.inputRevision!
          : this.nextKeyboardRouteRevision++,
    }
    this.keyboardRoutes.set(source.id, { signature, inputSignature, route })
    return route
  }
  private refreshKeyboardRoutes(): void {
    // Observe intermediate routing changes even when a script restores the old
    // visible/trap values before the next frame reaches the browser.
    for (const source of this.windows?.registered() ?? []) this.keyboardRoute(source)
  }
  private stalePointerMove(packet: InputPacket, windowId: number): boolean {
    // Leave also changes the last-hit cursor. Its physical observation may
    // precede a script cursor write while delivery waits behind a popup.
    if ((packet.type !== 'move' && packet.type !== 'leave') || packet.pointerSequence === undefined) return false
    const sequence = packet.pointerSequence,
      cursor = this.currentVirtualCursor(windowId)
    return sequence < (this.physicalPointerSequences.get(windowId) ?? 0) ||
      (!!cursor && sequence <= cursor.view.basePhysicalSequence)
  }
  async acceptFileDrop(identity: WindowFileDropIdentity, tree: DropResourceTree): Promise<SessionAdmission> {
    if (!identity || !Number.isSafeInteger(identity.windowId) || identity.windowId < 1 ||
        !Number.isSafeInteger(identity.surfaceEpoch) || identity.surfaceEpoch < 0 ||
        !Number.isSafeInteger(identity.sequence) || identity.sequence < 1)
      throw new Error('Invalid file drop identity')
    let cancelWait!: () => void
    const cancelled = new Promise<null>((resolve) => { cancelWait = () => resolve(null) }),
      pending = { windowId: identity.windowId, cancelled: false, cancelWait },
      key = `${identity.windowId}:${identity.surfaceEpoch}:${identity.sequence}`,
      window = this.registeredWindow(identity.windowId), generation = this.windowInputGeneration,
      surfaceEpoch = () => this.deps.renderer.windowSurfaceEpoch
        ? this.deps.renderer.windowSurfaceEpoch(identity.windowId) : 0,
      valid = () => !!window && !pending.cancelled && !this.control.cancelled && this.state === 'running' &&
        this.activity.state === 'visible' && !this.fontSelection.active &&
        this.registeredWindow(window.id) === window && window.state.visible &&
        !this.windowModals?.blocked(window.id) && generation === this.windowInputGeneration &&
        surfaceEpoch() === identity.surfaceEpoch
    if (!valid() || !window || identity.sequence <= (this.fileDropSequences.get(window.id) ?? 0))
      return ignoredAdmission()
    // A sequence prevents replay; a later distinct drop does not revoke an
    // earlier one. Native WM_DROPFILES events are not coalesced.
    this.fileDropSequences.set(window.id, identity.sequence)
    if (this.eventReceipts.size + this.fileDropReceiptReservations.size >= 65536)
      throw new Error('Event receipt budget exceeded')
    const releaseQueue = this.systemEvents!.reserveAdmission()
    this.fileDropReceiptReservations.add(pending)
    this.pendingFileDrops.set(key, pending)
    try {
      const result = await Promise.race([this.commitDroppedResources(tree, valid).then((names) => ({ names })), cancelled])
      if (!result || !valid()) return ignoredAdmission()
      const { names } = result
      let lease: ScriptObject | undefined
      // Consume both pre-reserved slots synchronously. No other input or
      // Timer can occupy them between namespace commit and event admission.
      releaseQueue()
      return this.acceptEvent(() => {
        lease = this.runtime!.upgrade(window.owner)
        return lease ? { kind: 'invoke', callback: lease, member: 'onFileDrop',
          args: [scriptList([...names].reverse())] } : { kind: 'value', value: undefined }
      }, {
        priority: 1, source: window, valid,
        // eventDisabled delays this input; it does not discard the file list.
        discardable: false,
        onSettled: () => { const owned = lease; lease = undefined; if (owned) this.runtime!.release(owned) },
      }, undefined, pending)
    } catch (error) { if (!valid()) return ignoredAdmission(); throw error }
    finally {
      releaseQueue()
      this.fileDropReceiptReservations.delete(pending)
      if (this.pendingFileDrops.get(key) === pending) this.pendingFileDrops.delete(key)
    }
  }
  cancelFileDrop(identity: WindowFileDropIdentity): void {
    if (!identity || !Number.isSafeInteger(identity.windowId) || identity.windowId < 1 ||
        !Number.isSafeInteger(identity.surfaceEpoch) || identity.surfaceEpoch < 0 ||
        !Number.isSafeInteger(identity.sequence) || identity.sequence < 1) return
    const pending = this.pendingFileDrops.get(`${identity?.windowId}:${identity?.surfaceEpoch}:${identity?.sequence}`)
    if (pending) { pending.cancelled = true; pending.cancelWait() }
  }
  acceptInput(packet: InputPacket, observe = true, additionalValid?: () => boolean): SessionAdmission {
    if (packet.type === 'popupHide')
      return this.acceptWindowPopup({ type: 'window', windowId: packet.windowId ?? this.windowId })
    const admissions: SessionAdmission[] = []
    try {
      admissions.push(this.acceptFormInput(packet, observe, additionalValid, admissions))
    } catch (error) {
      for (const admission of admissions) this.observeAdmission(admission)
      throw error
    }
    if (admissions.length === 1) return admissions[0]!
    return { status: admissions.some((entry) => entry.status === 'accepted') ? 'accepted' : 'ignored',
      completion: Promise.all(admissions.map((entry) => entry.completion)).then(() => {}) }
  }
  private acceptFormInput(packet: InputPacket, observe: boolean,
    additionalValid: (() => boolean) | undefined, preludes: SessionAdmission[]): SessionAdmission {
    if (this.fontSelection.active && packet.type !== 'cancel' && packet.type !== 'deactivate')
      return ignoredAdmission()
    for (const value of Object.values(packet))
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      )
        throw new Error('Invalid input coordinates or key')
    if (packet.type === 'text' && packet.text.length > 65536)
      throw new Error('Input text budget exceeded')
    if (packet.paintBoxPoint !== undefined) {
      const point = packet.paintBoxPoint
      if (
        !['move', 'down', 'up', 'wheel', 'click'].includes(packet.type) ||
        !point || typeof point !== 'object' ||
        ![point.x, point.y].every((value) =>
          Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
      ) throw new Error('Invalid PaintBox mouse coordinates')
    }
    if (packet.mouseKeyObservation !== undefined) {
      const sample = packet.mouseKeyObservation
      if (!sample || !Number.isSafeInteger(sample.windowId) || sample.windowId <= 0 ||
          !Number.isSafeInteger(sample.pointerSequence) || sample.pointerSequence < 0 ||
          ![sample.x, sample.y].every((value) => Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER) ||
          ![sample.scaleX, sample.scaleY].every((value) => Number.isFinite(value) && value > 0 && value <= 65536))
        throw new Error('Invalid mouse key observation')
    }
    if (packet.mouseKeyKeys !== undefined && (packet.type !== 'mouseKeyTick' ||
        !Array.isArray(packet.mouseKeyKeys) || packet.mouseKeyKeys.length > 256 ||
        packet.mouseKeyKeys.some((key) => !Number.isInteger(key) || key < 0 || key > 65535)))
      throw new Error('Invalid mouse key tick state')
    if (
      packet.pointerSequence !== undefined &&
      (!Number.isSafeInteger(packet.pointerSequence) || packet.pointerSequence < 1)
    )
      throw new Error('Invalid physical pointer sequence')
    if (
      packet.keyboardRouteRevision !== undefined &&
      (!Number.isSafeInteger(packet.keyboardRouteRevision) || packet.keyboardRouteRevision < 1)
    )
      throw new Error('Invalid keyboard route revision')
    if (
      packet.keyboardInputRevision !== undefined &&
      (!Number.isSafeInteger(packet.keyboardInputRevision) || packet.keyboardInputRevision < 1)
    )
      throw new Error('Invalid keyboard input revision')
    if (
      (packet.type === 'keyDown' || packet.type === 'keyUp') &&
      packet.systemKey !== undefined &&
      typeof packet.systemKey !== 'boolean'
    )
      throw new Error('Invalid system key classification')
    if ((packet.type === 'keyDown' || packet.type === 'keyUp') && packet.popupHidePosted !== undefined &&
        (typeof packet.popupHidePosted !== 'boolean' || packet.type !== 'keyDown' || !packet.systemKey))
      throw new Error('Invalid popup system key prelude')
    if (this.activity.state !== 'visible') return ignoredAdmission()
    const windowId = packet.windowId ?? this.windowId,
      window = this.registeredWindow(windowId),
      controller = this.inputControllers.get(windowId)
    if (!window || !controller) return ignoredAdmission()
    if (
      this.windowModals?.blocked(windowId) &&
      packet.type !== 'cancel' &&
      packet.type !== 'deactivate'
    )
      return ignoredAdmission()
    packet = { ...this.captureMousePoint(packet, window), windowId }
    if (
      packet.type === 'activate' &&
      (!window.state.visible || !window.state.focusable || this.state !== 'running')
    )
      return ignoredAdmission()
    if (
      packet.type === 'activate' &&
      window.state.visible &&
      window.state.focusable &&
      this.state === 'running'
    ) {
      if (window.inputActive && this.windowId === windowId) return ignoredAdmission()
      window.inputActive = true
      this.windows!.activate(windowId)
      this.syncActiveWindow()
    } else if (packet.type === 'deactivate') {
      const wasActive = window.inputActive
      window.inputActive = false
      if (this.windowId === windowId) {
        this.windows!.activate(0)
        this.syncActiveWindow()
      }
      if (!wasActive && this.state === 'running') return ignoredAdmission()
    }
    if (this.state !== 'running' && (packet.type === 'cancel' || packet.type === 'deactivate'))
      controller.resetTransient()
    if (observe && this.state === 'running' && packet.type !== 'click' && packet.type !== 'mouseKeyTick') {
      // A logical Window losing focus releases its local roles, not the
      // physical keys held elsewhere in the page. Restore the shared snapshot
      // before applying the next packet's key/shift changes.
      if (packet.type !== 'cancel' && packet.type !== 'deactivate')
        controller.keys = new Set(this.physicalKeys)
      controller.observe(packet)
      if (packet.type !== 'cancel' && packet.type !== 'deactivate') {
        this.keyStates.replace(controller.keys)
        for (const other of this.inputControllers.values())
          if (other !== controller) other.keys = new Set(this.physicalKeys)
      }
    }
    // A sequenced packet also establishes physical authority if its separate
    // observation RPC has not arrived. The duplicate sample is harmless when
    // that RPC already ran, including if a script moved the cursor in between.
    if (
      (observe || packet.pointerSequence !== undefined) &&
      (packet.type === 'down' || packet.type === 'move' ||
        packet.type === 'up' || packet.type === 'wheel')
    ) this.pointerState(packet.x, packet.y, windowId, packet.pointerSequence, packet.physicalScreen)
    if (this.state !== 'running') return ignoredAdmission()
    if (this.stalePointerMove(packet, windowId)) return ignoredAdmission()
    if (packet.type === 'activate' || packet.type === 'down' || packet.type === 'keyDown')
      this.applicationActive = true
    // WindowForm posts popup input events before mouse down and before system
    // key trapping/conversion. Script postInputEvent bypasses this Form path.
    if (packet.type === 'down' ||
        (packet.type === 'keyDown' && packet.systemKey && !packet.popupHidePosted))
      preludes.push(this.queuePopupHide(windowId, 1))
    if (packet.type === 'down' || packet.type === 'move') {
      const record = this.windowMouseKeys(window), point = { x: packet.x, y: packet.y,
        paintBoxPoint: { ...packet.paintBoxPoint! } }
      if (packet.type === 'down') record.down = point
      else record.move = point
    }
    const keyboard = packet.type === 'keyDown' || packet.type === 'keyUp' || packet.type === 'text',
      receiver = keyboard ? this.keyboardReceiver(window) : window,
      receiverController = this.inputControllers.get(receiver.id)
    if (!receiverController) return ignoredAdmission()
    if (keyboard) {
      if (!window.state.visible) return ignoredAdmission()
      const route = this.keyboardRoute(window)
      // Ordinary keystrokes follow focus moves performed by preceding input
      // (such as Tab) even before the updated view reaches the DOM. IME commits
      // retain exact Layer ownership. Both generations retire when either
      // Window/receiver or its input lifetime changes. Physical observation
      // above still releases keys from a retired route.
      if (
        packet.keyboardInputRevision !== undefined
          ? packet.keyboardInputRevision !== route.inputRevision
          : packet.keyboardRouteRevision !== undefined &&
            packet.keyboardRouteRevision !== route.revision
      )
        return ignoredAdmission()
      if (
        receiver.state.trapKey &&
        receiver.state.visible &&
        !receiver.state.admitTrappedKey(
          packet.type as 'keyDown' | 'keyUp' | 'text',
          packet.type === 'keyDown' || packet.type === 'keyUp' ? packet.systemKey : false,
        )
      )
        return ignoredAdmission()
    }
    if (keyboard || packet.type === 'mouseKeyTick') {
      const record = this.windowMouseKeys(receiver), sample = packet.mouseKeyObservation
      if (sample && sample.windowId !== receiver.id) return ignoredAdmission()
      if (sample) {
        record.scaleX = sample.scaleX
        record.scaleY = sample.scaleY
        if (sample.pointerSequence) {
          this.pointerState(sample.x, sample.y, receiver.id, sample.pointerSequence, sample.physicalScreen)
          // A stationary physical pointer has new client coordinates after
          // the Window moves or its CSS size changes. Refresh that projection
          // without pretending a new physical movement superseded a live
          // virtual cursor, and never accept an older physical authority.
          if (sample.pointerSequence === this.physicalPointerSequences.get(receiver.id) &&
              !this.currentVirtualCursor(receiver.id))
            this.windowPointers.set(receiver.id, { x: sample.x, y: sample.y })
        }
      }
      if (packet.type === 'mouseKeyTick') {
        if (!receiver.inputActive || this.windowId !== receiver.id || !receiver.state.useMouseKey ||
            !receiver.state.visible || this.menus.hasPopup || this.state !== 'running') return ignoredAdmission()
        const held = packet.mouseKeyKeys ? new Set(packet.mouseKeyKeys) : this.physicalKeys
        return this.mouseKeyActions(receiver, record.state.tick(this.deps.now(), held), held)
      }
      if (packet.type === 'text') {
        const text = [...packet.text].filter((character) => !record.state.text(character)).join('')
        if (!text) return ignoredAdmission()
        packet = { ...packet, text }
      } else if (packet.type === 'keyDown' || packet.type === 'keyUp') {
        const point = this.currentVirtualCursor(receiver.id)?.view ?? this.windowPointers.get(receiver.id),
          inside = !!point && point.x >= 0 && point.y >= 0 && point.x < receiver.state.viewportWidth && point.y < receiver.state.viewportHeight,
          result = record.state.key(packet.type === 'keyDown', packet.key, this.deps.now(), this.physicalKeys, inside)
        if (result.consumed) return this.mouseKeyActions(receiver, result.actions)
      }
    }
    // Freeze the receiver at admission. Changes to trapKey while this receipt
    // waits must not retarget it or change the physical source's active Window.
    const routedPacket = { ...packet, windowId: receiver.id }
    const epoch = controller.epoch,
      receiverEpoch = receiverController.epoch,
      generation = this.windowInputGeneration
    return this.acceptEvent(
      () =>
        this.inputs!.packet(
          routedPacket,
          () => !this.stalePointerMove(packet, windowId) &&
            (!additionalValid || additionalValid()) &&
            (receiver === window || (
                this.registeredWindow(windowId) === window &&
                window.state.visible &&
                controller.epoch === epoch)),
        ),
      {
        valid: () =>
          this.registeredWindow(windowId) === window &&
          this.registeredWindow(receiver.id) === receiver &&
          !this.stalePointerMove(packet, windowId) &&
          (!additionalValid || additionalValid()) &&
          (!keyboard || window.state.visible) &&
          // Admission can precede an earlier callback's focus change. A
          // composition queued behind it must not commit to the new Layer.
          (packet.type !== 'text' ||
            packet.keyboardInputRevision !== undefined ||
            packet.keyboardRouteRevision === undefined ||
            packet.keyboardRouteRevision === this.keyboardRoute(window).revision) &&
          generation === this.windowInputGeneration &&
          (!this.windowModals?.blocked(windowId) ||
            packet.type === 'cancel' ||
            packet.type === 'deactivate') &&
          epoch === controller.epoch &&
          receiverEpoch === receiverController.epoch &&
          (!keyboard || !this.windowModals?.blocked(receiver.id)) &&
          this.state === 'running' &&
          this.activity.state === 'visible',
        priority: 1,
        discardable: packet.type === 'move',
        source: receiver,
      },
    )
  }
  private captureMousePoint(packet: InputPacket, window: WindowRecord): InputPacket {
    if (packet.type !== 'move' && packet.type !== 'down' && packet.type !== 'up' && packet.type !== 'wheel' && packet.type !== 'click')
      return packet
    return {
      ...packet,
      paintBoxPoint: { ...(packet.paintBoxPoint ?? paintBoxPoint(window.state, packet.x, packet.y)) },
    }
  }
  private postInput(packet: InputPacket, window: WindowRecord, additionalValid?: () => boolean): void {
    const controller = this.inputControllers.get(window.id)
    if (this.registeredWindow(window.id) !== window || !controller) return
    if (this.postedInputPending >= 256) throw new Error('Posted input queue budget exceeded')
    const epoch = controller.epoch,
      generation = this.windowInputGeneration,
      valid = () =>
        this.registeredWindow(window.id) === window &&
        generation === this.windowInputGeneration &&
        !this.windowModals?.blocked(window.id) &&
        epoch === controller.epoch &&
        this.activity.state === 'visible' &&
        (!additionalValid || additionalValid())
    packet = { ...this.captureMousePoint(packet, window), windowId: window.id }
    this.postedInputPending++
    // Queue a VM call, never reenter the active TJS host import. A destroyed
    // window cannot deliver its pending input to a newly created window.
    void this.systemEvents!.post(() => this.inputs!.packet(packet, additionalValid ? valid : undefined), {
      valid,
      priority: 1,
      source: window,
    })
      .catch((error) => {
        if (!this.control.cancelled) this.fail(error)
      })
      .finally(() => this.postedInputPending--)
  }
  async exitFullScreen(windowId = this.windowId): Promise<void> {
    if (this.windowModals?.blocked(windowId)) return
    const window = this.registeredWindow(windowId)
    if (window) await this.setWindowProperty(window, 'fullScreen', 0)
    this.present()
  }
  async activateWindow(windowId: number): Promise<void> {
    await this.acceptActivateWindow(windowId).completion
  }
  acceptActivateWindow(windowId: number): SessionAdmission {
    if (this.state !== 'running' || this.activity.state !== 'visible') return ignoredAdmission()
    const window = this.registeredWindow(windowId)
    if (
      !window ||
      !window.state.visible ||
      !window.state.focusable ||
      this.windowModals?.blocked(windowId)
    )
      return ignoredAdmission()
    const previous = this.windows?.active
    // Enqueue both notifications now, in observed order. Waiting for the old
    // callback before selecting the target lets an older request steal focus
    // back from a newer Window while that callback is suspended.
    const deactivated =
      previous && previous !== window
        ? this.acceptInput({ type: 'deactivate', windowId: previous.id }, false)
        : ignoredAdmission()
    this.windows!.activate(windowId)
    this.syncActiveWindow()
    let activated: SessionAdmission
    try {
      activated = this.acceptInput({ type: 'activate', windowId }, false)
    } catch (error) {
      // A submitted deactivation keeps its own lifetime even if the second
      // admission fails; observe it before propagating the synchronous error.
      void deactivated.completion.catch((failure) => {
        if (!this.control.cancelled) this.fail(failure)
      })
      throw error
    }
    // A focus command is distinct from the state echoed after browser input.
    // Treating every roster update as a command creates an activation loop.
    this.deps.event({ type: 'window-activate', windowId })
    this.present()
    return {
      status:
        deactivated.status === 'accepted' || activated.status === 'accepted'
          ? 'accepted'
          : 'ignored',
      completion: Promise.all([deactivated.completion, activated.completion]).then(() => undefined),
    }
  }
  moveWindow(windowId: number, left: number, top: number): void {
    if (this.windowModals?.blocked(windowId)) return
    const window = this.registeredWindow(windowId)
    if (!window) return
    window.state.set('left', left)
    window.state.set('top', top)
    this.present()
  }
  /** Host drag updates bypass the serialized VM queue while beginMove owns
   * its modal continuation. Identity/sequence validation stays in the core. */
  windowMove(message: WindowMoveMessage): boolean {
    if (this.control.cancelled || !['running', 'paused'].includes(this.state)) return false
    return this.windowMoves?.receive(message) ?? false
  }
  acceptWindowPopup(message: WindowPopupMessage): SessionAdmission {
    if (!message || (message.type !== 'window' && message.type !== 'application'))
      throw new Error('Invalid Window popup message')
    if (message.type === 'window') {
      if (!Number.isSafeInteger(message.windowId) || message.windowId <= 0)
        throw new Error('Invalid Window popup source')
      const admission = this.queuePopupHide(message.windowId)
      if (this.registeredWindow(message.windowId)?.state.visible) this.applicationActive = true
      return admission
    }
    if (typeof message.active !== 'boolean') throw new Error('Invalid application activation')
    if (this.applicationActive === message.active) return ignoredAdmission()
    const admission = message.active ? ignoredAdmission() : this.queuePopupHide()
    this.applicationActive = message.active
    return admission
  }
  private queuePopupHide(sourceWindowId?: number, reserve = 0): SessionAdmission {
    if (this.control.cancelled || !this.windows || !['running', 'paused'].includes(this.state))
      return ignoredAdmission()
    const popup = (window: WindowRecord) =>
      window.state.visible && !window.state.focusable && window.state.stayOnTop
    if (sourceWindowId !== undefined) {
      const source = this.registeredWindow(sourceWindowId)
      if (!source || !source.state.visible || this.windowModals?.blocked(sourceWindowId) || popup(source))
        return ignoredAdmission()
    }
    // The original Form snapshots eligibility as it posts in reverse Window
    // registration order, not activation/stack order. It does not coalesce.
    const targets = this.windows.registered().reverse().filter(popup),
      generation = this.windowInputGeneration, admissions: SessionAdmission[] = []
    if (this.eventReceipts.size + targets.length + reserve > 65536)
      throw new Error('Event receipt budget exceeded')
    try {
      for (const window of targets) {
        let lease: ScriptObject | undefined
        admissions.push(this.acceptEvent(() => {
          lease = this.runtime!.upgrade(window.owner)
          return lease ? { kind: 'invoke', callback: lease, member: 'onPopupHide', args: [] }
            : { kind: 'value', value: undefined }
        }, {
          priority: 1, source: window,
          // OnPopupHide checks CanDeliverEvents again. Changing focusable or
          // stayOnTop after posting does not revoke this already queued event.
          valid: () => this.registeredWindow(window.id) === window && window.state.visible &&
            generation === this.windowInputGeneration && !this.windowModals?.blocked(window.id) &&
            !this.systemEvents!.disabled,
          onSettled: () => { const owned = lease; lease = undefined; if (owned) this.runtime!.release(owned) },
        }))
      }
    } catch (error) {
      for (const admission of admissions) this.observeAdmission(admission)
      throw error
    }
    return { status: admissions.some((entry) => entry.status === 'accepted') ? 'accepted' : 'ignored',
      completion: Promise.all(admissions.map((entry) => entry.completion)).then(() => {}) }
  }
  private windowGeometrySignature(window: WindowRecord, state = window.state): string {
    const id = this.inputControllers.get(window.id)?.root() ?? 0,
      primary = this.layers.has(id) ? this.layers.get(id) : undefined
    return JSON.stringify([state.width, state.height, state.innerSunken, state.borderStyle,
      state.showScrollBars, state.fullScreen, state.layerLeft, state.layerTop,
      state.zoomNumer, state.zoomDenom, state.minWidth, state.minHeight, state.maxWidth, state.maxHeight,
      state.innerWidthRequest, state.innerHeightRequest, id, primary?.width ?? 0, primary?.height ?? 0,
      this.menus.snapshot(window.id).root ?? null])
  }
  private measureWindowGeometry(window: WindowRecord, candidate: WindowState,
    operation: WindowGeometryRequest['operation'], size?: WindowGeometryRequest['size'], resetScroll = false): Promise<void> {
    const work = this.commitWindowGeometry(window, candidate, operation, size, resetScroll)
    this.geometryTransactions.set(window.id, work)
    void work.finally(() => {
      if (this.geometryTransactions.get(window.id) === work) this.geometryTransactions.delete(window.id)
    }).catch(() => {})
    return work
  }
  private async commitWindowGeometry(window: WindowRecord, candidate: WindowState,
    operation: WindowGeometryRequest['operation'], size?: WindowGeometryRequest['size'], resetScroll = false): Promise<void> {
    this.control.check()
    if (this.registeredWindow(window.id) !== window) throw new Error('Window geometry destination changed')
    const requestId = this.nextGeometryRequest++
    if (!Number.isSafeInteger(this.nextGeometryRequest)) throw new Error('Window geometry identities exhausted')
    this.geometryRequests.set(window.id, requestId)
    const primaryId = this.inputControllers.get(window.id)?.root() ?? 0,
      primary = this.layers.has(primaryId) ? this.layers.get(primaryId) : undefined,
      request: WindowGeometryRequest = { requestId, windowId: window.id, revision: requestId,
        view: candidate.view(), menus: this.menus.snapshot(window.id),
        primary: { width: primary?.width ?? 0, height: primary?.height ?? 0 },
        innerRequest: { width: candidate.innerWidthRequest, height: candidate.innerHeightRequest },
        operation, ...(size ? { size: { ...size } } : {}), resetScroll },
      signature = this.windowGeometrySignature(window, candidate),
      check = () => {
        this.control.check()
        if (this.registeredWindow(window.id) !== window || this.geometryRequests.get(window.id) !== requestId ||
            this.windowGeometrySignature(window, candidate) !== signature)
          throw new Error('Window geometry destination changed')
      },
      before = window.state.geometry, beforeFullscreen = window.state.fullScreen
    let geometry: WindowGeometry
    try {
      const measured = await cancelable(this.windowGeometry.measure(request), this.control)
      check()
      geometry = validateWindowGeometry(request, measured)
    } catch (error) {
      if (this.geometryRequests.get(window.id) === requestId) {
        if (before) this.geometryRequests.set(window.id, before.revision)
        else this.geometryRequests.delete(window.id)
      }
      throw error
    }
    candidate.commitGeometry(geometry)
    if (operation === 'create') {
      candidate.innerWidthRequest = geometry.client.width
      candidate.innerHeightRequest = geometry.client.height
    }
    // Geometry awaits cannot overwrite unrelated physical/key state that
    // changed while the host measured an isolated DOM candidate.
    for (const key of ['width', 'height', 'innerSunken', 'borderStyle', 'showScrollBars', 'fullScreen',
      'layerLeft', 'layerTop', 'zoomNumer', 'zoomDenom', 'minWidth', 'minHeight', 'maxWidth', 'maxHeight',
      'innerWidthRequest', 'innerHeightRequest', 'fullscreenRestore'] as const)
      Object.assign(window.state, { [key]: candidate[key] })
    if (candidate.fullScreen !== !!beforeFullscreen) {
      window.state.left = candidate.left
      window.state.top = candidate.top
    }
    window.state.commitGeometry(geometry)
    this.geometrySignatures.set(window.id, this.windowGeometrySignature(window))
    this.geometryPrimaryIds.set(window.id, primaryId)
    this.geometryScrollSequences.set(window.id, 0)
    if (before && (before.outer.width !== geometry.outer.width || before.outer.height !== geometry.outer.height ||
        before.client.width !== geometry.client.width || before.client.height !== geometry.client.height))
      this.queueResize(window)
    this.invalidateWindow(window.id)
  }
  private ensureWindowGeometry(window: WindowRecord): Promise<void> {
    const transaction = this.geometryTransactions.get(window.id)
    if (transaction) return transaction.catch(() => {}).then(() => {
      this.control.check()
      return this.ensureWindowGeometry(window)
    })
    if (this.geometrySignatures.get(window.id) === this.windowGeometrySignature(window)) return Promise.resolve()
    const pending = this.geometryPending.get(window.id)
    if (pending) return pending
    const old = window.state.geometry,
      primaryId = this.inputControllers.get(window.id)?.root() ?? 0,
      primary = this.layers.has(primaryId) ? this.layers.get(primaryId) : undefined,
      actual = old?.actualZoom ?? { numer: window.state.zoomNumer, denom: window.state.zoomDenom },
      reset = !!old && (this.geometryPrimaryIds.get(window.id) !== primaryId || old.paintBox.width !== deviceMulDiv(primary?.width ?? 0, actual.numer, actual.denom) ||
        old.paintBox.height !== deviceMulDiv(primary?.height ?? 0, actual.numer, actual.denom)),
      work = this.measureWindowGeometry(window, window.state.copy(), old ? 'content' : 'create', undefined, reset)
        .finally(() => { if (this.geometryPending.get(window.id) === work) this.geometryPending.delete(window.id) })
    this.geometryPending.set(window.id, work)
    return work
  }
  private async synchronizeWindowGeometry(): Promise<void> {
    // Native release continuations still finish Layers/MenuItems after Stop
    // closes host ports. Geometry must never block those terminal releases.
    if (this.control.cancelled) return
    for (const window of this.windows?.registered() ?? []) {
      if (this.control.cancelled) return
      await this.ensureWindowGeometry(window)
    }
  }
  private observeWindowScroll(observation: WindowGeometryScroll): void {
    const window = this.registeredWindow(observation.windowId), geometry = window?.state.geometry
    if (!window || !geometry || this.control.cancelled || this.geometryPending.has(window.id) ||
        observation.surfaceEpoch !== geometry.surfaceEpoch || observation.baseRevision !== geometry.revision ||
        this.geometryRequests.get(window.id) !== geometry.revision ||
        !Number.isSafeInteger(observation.sequence) || observation.sequence <= (this.geometryScrollSequences.get(window.id) ?? 0))
      return
    try {
      const updated = scrollWindowGeometry(geometry, observation.x, observation.y)
      this.geometryScrollSequences.set(window.id, observation.sequence)
      window.state.commitGeometry(updated)
      this.invalidateWindow(window.id)
      this.present()
    } catch (error) {
      this.deps.event({ type: 'log', level: 'error', text: error instanceof Error ? error.message : String(error) })
    }
  }
  async resizeWindow(windowId: number, width: number, height: number): Promise<void> {
    // Recheck after every await: several host requests may be waiting on the
    // same script transaction, and the first resumed request now owns the slot.
    while (this.geometryTransactions.has(windowId))
      await this.geometryTransactions.get(windowId)!.catch(() => {})
    if (this.control.cancelled) return
    if (this.windowModals?.blocked(windowId)) return
    const window = this.registeredWindow(windowId)
    if (!window) return
    const candidate = window.state.copy()
    candidate.resize(width, height)
    await this.measureWindowGeometry(window, candidate, 'outer', { width, height })
    this.present()
  }
  /** A new surface needs its own measured epoch without replaying stale size
   * values captured before an in-flight script geometry transaction. */
  async refreshWindowGeometry(windowId: number): Promise<void> {
    while (this.geometryTransactions.has(windowId))
      await this.geometryTransactions.get(windowId)!.catch(() => {})
    if (this.control.cancelled) return
    const window = this.registeredWindow(windowId)
    if (!window) return
    await this.measureWindowGeometry(window, window.state.copy(), 'content')
    this.present()
  }
  private async setWindowProperty(window: WindowRecord, property: string, value: string | number,
    script = false): Promise<void> {
    const geometryProperty = ['width', 'height', 'innerWidth', 'innerHeight', 'innerSunken', 'borderStyle',
        'showScrollBars', 'fullScreen', 'layerLeft', 'layerTop', 'zoomNumer', 'zoomDenom',
        'minWidth', 'minHeight', 'maxWidth', 'maxHeight'].includes(property)
    if (geometryProperty) {
      while (this.geometryTransactions.has(window.id))
        await this.geometryTransactions.get(window.id)!.catch(() => {})
      this.control.check()
      if (this.registeredWindow(window.id) !== window) throw new Error('Window geometry destination changed')
      if (property === 'fullScreen' && !!Number(value) && !window.state.fullScreen) {
        // Validate before changing the previous fullscreen owner. Recopy our
        // candidate only after those awaited transitions and queued host work.
        const checked = window.state.copy()
        if (script) checked.setScript(property, value)
        else checked.set(property, value)
        for (const other of this.windows!.registered())
          if (other !== window && other.state.fullScreen) await this.setWindowProperty(other, 'fullScreen', 0)
        while (this.geometryTransactions.has(window.id))
          await this.geometryTransactions.get(window.id)!.catch(() => {})
        this.control.check()
        if (this.registeredWindow(window.id) !== window) throw new Error('Window geometry destination changed')
      }
    }
    const before = [window.state.width, window.state.height], wasVisible = window.state.visible,
      previousCursorState = window.state.mouseCursorState,
      candidate = geometryProperty ? window.state.copy() : window.state
    if (script) candidate.setScript(property, value)
    else candidate.set(property, value)
    if (property === 'mouseCursorState' && window.state.mouseCursorState !== previousCursorState) {
      this.hiddenCursorPositions.delete(window.id)
      if (window.state.mouseCursorState === 1) {
        const screen = this.physicalScreen, point = screen ?? this.windowPointers.get(window.id)
        if (point) this.hiddenCursorPositions.set(window.id, { kind: screen ? 'screen' : 'viewport',
          x: Math.trunc(point.x), y: Math.trunc(point.y) })
      }
    }
    if (geometryProperty) {
      if (property === 'fullScreen' && candidate.fullScreen !== window.state.fullScreen) {
        if (candidate.fullScreen) {
          candidate.fullscreenRestore = { left: window.state.left, top: window.state.top,
            width: window.state.width, height: window.state.height, innerSunken: window.state.innerSunken }
          candidate.left = candidate.top = 0
          candidate.innerSunken = false
        } else if (candidate.fullscreenRestore) {
          Object.assign(candidate, candidate.fullscreenRestore)
          candidate.fullscreenRestore = undefined
        }
      }
      const inner = property === 'innerWidth' || property === 'innerHeight',
        outer = property === 'width' || property === 'height',
        size = inner || outer ? { [property === 'width' || property === 'innerWidth' ? 'width' : 'height']: Number(value) } : undefined
      await this.measureWindowGeometry(window, candidate, inner ? 'inner' : outer ? 'outer' : 'chrome', size)
    }
    if ((property === 'visible' && !window.state.visible) ||
        (property === 'fullScreen' && window.state.fullScreen)) this.windowMoves?.cancel(window.id)
    if (property === 'useMouseKey') {
      const record = this.windowMouseKeys(window)
      this.observeAdmission(this.mouseKeyActions(window,
        record.state.configure(window.state.useMouseKey, this.deps.now())))
    }
    if (property === 'visible' && !window.state.visible) this.clearVirtualCursors(window.id)
    if (property === 'visible' && window.state.visible && !wasVisible) this.invalidateWindow(window.id)
    if (property === 'visible' || property === 'focusable' || property === 'trapKey')
      this.refreshKeyboardRoutes()
    if (before[0] !== window.state.width || before[1] !== window.state.height)
      this.queueResize(window)
    if (property === 'visible' || property === 'focusable' || (property === 'fullScreen' && window.state.fullScreen)) {
      if (window.state.visible && window.state.focusable)
        void this.activateWindow(window.id).catch((error) => {
          if (!this.control.cancelled) this.fail(error)
        })
      else {
        this.menus.dismiss(window.id, undefined, 'unavailable')
        void this.input({ type: 'deactivate', windowId: window.id }, false).catch(() => {})
        if (!this.windows!.active) {
          const next = this.windows!.registered()
            .reverse()
            .find((candidate) => candidate.state.visible && candidate.state.focusable)
          if (next)
            void this.activateWindow(next.id).catch((error) => {
              if (!this.control.cancelled) this.fail(error)
            })
        }
      }
    }
    this.dirty = true
  }
  async closeWindow(windowId: number): Promise<void> {
    await this.acceptCloseWindow(windowId).completion
  }
  acceptCloseWindow(windowId: number): SessionAdmission {
    return this.enqueueCloseWindow(windowId)
  }
  private enqueueCloseWindow(windowId: number, onNotEntered?: () => void): SessionAdmission {
    const window = this.registeredWindow(windowId)
    if (
      !window ||
      (!onNotEntered && !window.state.visible) ||
      this.windowModals?.blocked(windowId) ||
      !['running', 'paused'].includes(this.state)
    ) {
      if (onNotEntered) throw new Error('Modal close query is no longer eligible')
      return ignoredAdmission()
    }
    let lease: ScriptObject | undefined,
      entered = false,
      modalCompletion: Promise<void> | undefined
    const admission = this.acceptEvent(
      () => {
        entered = true
        lease = this.runtime!.upgrade(window.owner)
        return lease
          ? { kind: 'invoke', callback: lease, member: '__windowUserClose', args: [] }
          : { kind: 'value', value: undefined }
      },
      {
        source: window,
        priority: 1,
        valid: () =>
          this.registeredWindow(windowId) === window &&
          window.state.visible &&
          !this.windowModals?.blocked(windowId) &&
          !this.systemEvents!.disabled,
        onSettled: () => {
          modalCompletion = this.windowModals?.acceptedCompletion(windowId)
          const owned = lease
          lease = undefined
          try {
            if (owned) this.runtime!.release(owned)
          } finally {
            if (!entered) onNotEntered?.()
          }
        },
      },
    )
    return {
      status: admission.status,
      completion: admission.completion.then(() => modalCompletion),
    }
  }
  /** Publish cursor authority without requesting a frame or reentering TJS.
   * Physical observation can call this while a script is suspended. */
  private presentInputViews(): void {
    for (const window of this.windows?.registered() ?? []) {
      const view = this.inputControllers.get(window.id)?.view()
      if (!view) continue
      const cursor = this.currentVirtualCursor(window.id),
        input: InputView = {
          ...view, keyboardRoute: this.keyboardRoute(window),
          ...(this.gamepadSettings ? { gamepad: { ...this.gamepadSettings } } : {}),
          virtualCursor: cursor ? { ...cursor.view } : null,
        }
      const serialized = JSON.stringify(input)
      if (this.windowInputViews.get(window.id) !== serialized) {
        this.windowInputViews.set(window.id, serialized)
        this.deps.event({ type: 'window-input', windowId: window.id, input })
      }
    }
    const active = this.registeredWindow(this.windowId),
      cursor = active ? this.currentVirtualCursor(active.id) : undefined,
      input: InputView = {
        ...this.inputController.view(),
        ...(this.gamepadSettings ? { gamepad: { ...this.gamepadSettings } } : {}),
        ...(active ? { keyboardRoute: this.keyboardRoute(active) } : {}),
        virtualCursor: cursor ? { ...cursor.view } : null,
      },
      serialized = JSON.stringify(input)
    if (serialized !== this.inputView) {
      this.inputView = serialized
      this.deps.event({ type: 'input', input })
    }
  }
  private presentWindowViews(): void {
    const windows = this.windowPresentations(),
      windowViews = JSON.stringify(windows)
    if (this.windowsView !== windowViews) {
      this.windowsView = windowViews
      this.deps.event({ type: 'windows', windows })
    }
    if (this.windowRevision !== this.window.revision) {
      this.windowRevision = this.window.revision
      this.deps.event({ type: 'window', window: this.window.view() })
    }
  }
  present(onlyWindowId?: number, synchronous = false): void {
    this.presentInputViews()
    this.presentWindowViews()
    this.presentMenus()
    if (
      (!this.dirty && !synchronous) ||
      (this.preparingFrame && !synchronous) ||
      this.state === 'stopped' ||
      this.state === 'stopping' ||
      (!this.deps.renderer.openWindow &&
        (this.graphicsStatus.state === 'lost' || this.graphicsStatus.state === 'failed')) ||
      (this.activity.state !== 'visible' && this.graphicsStatus.state !== 'restoring')
    )
      return
    const version = this.frameWorkVersion,
      targets = (this.windows?.registered() ?? []).filter((window) =>
        onlyWindowId === undefined || window.id === onlyWindowId)
    if (!targets.length && !this.deps.renderer.openWindow)
      this.deps.renderer.present([], this.width, this.height)
    let complete = true
    for (const target of targets) {
      // A synchronous native Window delivery may already have submitted these
      // pixels. The outer publication still publishes host views and receipts,
      // but must not present that same revision a second time.
      if (!synchronous && this.windowPresentedVersions.get(target.id) === version) continue
      const window = target.state
      if (!window.geometry || this.geometryRequests.get(target.id) !== window.geometry.revision) {
        complete = false
        continue
      }
      if (this.geometrySignatures.get(target.id) !== this.windowGeometrySignature(target)) {
        complete = false
        void this.ensureWindowGeometry(target).then(() => this.present()).catch((error) => {
          if (!this.control.cancelled && this.registeredWindow(target.id) === target) this.fail(error)
        })
        continue
      }
      const viewportWidth = Math.max(1, window.viewportWidth), viewportHeight = Math.max(1, window.viewportHeight),
        primaryId = this.inputControllers.get(target.id)?.root() ?? 0,
        primary = this.layers.has(primaryId) ? this.layers.get(primaryId) : undefined,
        geometry = drawDeviceGeometry(window, primary?.width ?? 0, primary?.height ?? 0)
      const presented = this.deps.renderer.present(
        window.visible && window.viewportWidth > 0 && window.viewportHeight > 0 &&
          primary && primary.width > 0 && primary.height > 0
          ? this.composer.frame(
              viewportWidth,
              viewportHeight,
              geometry.x,
              geometry.y,
              geometry.width / primary.width,
              target.id,
              geometry.height / primary.height,
              primaryId,
            )
          : [],
        viewportWidth,
        viewportHeight,
        target.id,
      )
      if (presented === false) complete = false
      else {
        if (this.registeredWindow(target.id) === target) this.windowPresentedVersions.set(target.id, version)
        if (window.visible && this.registeredWindow(target.id) === target) this.windowPresentationsCompleted.set(
          target.id,
          (this.windowPresentationsCompleted.get(target.id) ?? 0) + 1,
        )
      }
    }
    // Pending onPaint callbacks are separate from composed pixels. In
    // particular, disabled game events cannot make host-only Pad operations
    // repeatedly submit an unchanged frame. A reentrant renderer invalidation
    // gets a newer version and remains dirty for its own publication.
    if (complete && onlyWindowId === undefined && this.frameWorkVersion === version) this.dirty = false
    this.completeReadyReceipts()
  }
  private queueResize(window: WindowRecord): void {
    if (window.resizePending || this.registeredWindow(window.id) !== window) return
    window.resizePending = true
    let lease: ScriptObject | undefined
    void this.systemEvents!.post(
      () => {
        lease = this.runtime!.upgrade(window.owner)
        return lease
          ? { kind: 'invoke', callback: lease, member: 'onResize', args: [] }
          : { kind: 'value', value: undefined }
      },
      {
        priority: 1,
        source: window,
        valid: () => this.registeredWindow(window.id) === window && !this.systemEvents!.disabled,
        onTaken: () => {
          window.resizePending = false
        },
      },
    )
      .finally(() => {
        if (lease) this.runtime?.release(lease)
      })
      .catch((error) => {
        if (!this.control.cancelled) this.fail(error)
      })
  }
  private presentMenus(): void {
    const registered = this.windows?.registered() ?? [],
      membership = `${this.windowId}:${registered.map((window) => window.id).join(',')}`
    if (this.menuRevision === this.menus.revision && this.menuWindowsView === membership) return
    this.menuRevision = this.menus.revision
    this.menuWindowsView = membership
    this.deps.event({
      type: 'window-menus',
      windows: registered.map((window) => ({
        windowId: window.id,
        menus: this.menus.snapshot(window.id),
      })),
    })
    // Keep the legacy event last for existing single-window consumers.
    this.deps.event({ type: 'menus', menus: this.menus.snapshot(this.windowId) })
  }
  async menuClick(id: number, popup?: MenuPopupIdentity): Promise<void> {
    await this.acceptMenuClick(id, popup).completion
  }
  private queueMenuNotification(view: number): void {
    if (this.control.cancelled || this.systemEvents!.disabled) return
    const item = this.menuItems!.byView(view)
    if (!item) return
    let lease: ScriptObject | undefined
    this.observeAdmission(
      this.acceptEvent(
        () => {
          lease = this.runtime!.upgrade(item.owner)
          return lease
            ? { kind: 'invoke', callback: lease, member: 'onClick', args: [] }
            : { kind: 'value', value: undefined }
        },
        {
          valid: () => {
            // Native OnClick follows the current registration ancestry. This is
            // an already selected command, not a new DOM hit or shortcut: later
            // visibility/caption/child changes do not cancel it on their own.
            let current = item
            while (!current.window && current.parent) current = current.parent
            const window = current.window
            return (
              !item.finished &&
              !item.closing &&
              this.menuItems!.byView(view) === item &&
              this.menus.canNotify(view) &&
              !!window &&
              this.registeredWindow(window.id) === window &&
              !window.finished &&
              !window.closing &&
              window.state.visible &&
              !this.windowModals?.blocked(window.id) &&
              this.activity.state === 'visible' &&
              this.state === 'running' &&
              !this.systemEvents!.disabled
            )
          },
          priority: 1,
          discardable: true,
          source: item,
          onSettled: () => {
            const owned = lease
            lease = undefined
            if (owned) this.runtime!.release(owned)
          },
        },
      ),
    )
  }
  acceptMenuClick(id: number, popup?: MenuPopupIdentity): SessionAdmission {
    if (this.fontSelection.active) return ignoredAdmission()
    if (this.state !== 'running' || this.activity.state !== 'visible') return ignoredAdmission()
    const item = this.menuItems?.byView(id),
      window = this.menuItems?.windowByView(id),
      controller = window && this.inputControllers.get(window.id)
    if (
      !item ||
      item.closing ||
      item.finished ||
      !window?.state.visible ||
      !controller ||
      this.windowModals?.blocked(window.id)
    )
      return ignoredAdmission()
    if (popup && popup.windowId !== window.id) return ignoredAdmission()
    if (this.systemEvents!.disabled && !this.menus.hasPopup) return ignoredAdmission()
    if (!this.menus.choose(id, window.id, popup?.requestId)) {
      this.presentMenus()
      return ignoredAdmission()
    }
    const epoch = controller.epoch,
      generation = this.windowInputGeneration
    let lease: ScriptObject | undefined
    return this.acceptEvent(
      () => {
        lease = this.runtime!.upgrade(item.owner)
        return lease
          ? { kind: 'invoke', callback: lease, member: 'onClick', args: [] }
          : { kind: 'value', value: undefined }
      },
      {
        valid: () =>
          epoch === controller.epoch &&
          generation === this.windowInputGeneration &&
          !this.windowModals?.blocked(window.id) &&
          this.inputControllers.get(window.id) === controller &&
          this.activity.state === 'visible' &&
          this.state === 'running' &&
          !this.systemEvents!.disabled &&
          window.state.visible &&
          this.menus.selectable(id) &&
          !item.finished &&
          !item.closing &&
          this.menuItems?.windowByView(id) === window,
        priority: 1,
        discardable: true,
        source: item,
        onSettled: () => {
          const owned = lease
          lease = undefined
          if (owned) this.runtime!.release(owned)
        },
      },
    )
  }
  menuDismiss(popup?: MenuPopupIdentity): void {
    this.menus.dismiss(popup?.windowId, popup?.requestId)
    this.presentMenus()
  }
  setSystemFonts(fonts: FontDescriptor[]): void {
    this.control.check()
    this.fontCatalog.setSystem(fonts)
    this.fontSelection.refresh()
  }
  selectFont(id: number, face: string | null): void {
    if (this.control.cancelled) return
    if (face === null) this.fontSelection.cancel(id)
    else if (this.activity.state === 'visible') this.fontSelection.choose(id, face)
  }
  async padFont(id: number, epoch: number): Promise<PadFontData | null> {
    if (!Number.isSafeInteger(id) || !Number.isSafeInteger(epoch) || this.control.cancelled)
      return null
    const request = this.pads?.fontRequest(id, epoch)
    if (!request) return null
    await this.fontCatalog.prepare()
    this.control.check()
    const current = this.pads?.fontRequest(id, epoch)
    if (!current || JSON.stringify(current) !== JSON.stringify(request)) return null
    const choices = this.padFonts.get(request.fontFace.toLowerCase())
    if (!choices?.length) return null
    const face =
      choices.find(
        (face) => face.bold === request.fontBold && face.italic === request.fontItalic,
      ) ?? choices[0]!
    if (face.resource.size > 16 * 1024 * 1024) throw new Error('Pad font exceeds 16 MiB')
    const bytes = await cancelable(face.resource.read(), this.control)
    this.control.check()
    if (bytes.length !== face.resource.size) throw new Error('Pad font resource length changed')
    const latest = this.pads?.fontRequest(id, epoch)
    if (!latest || JSON.stringify(latest) !== JSON.stringify(request)) return null
    return { family: request.fontFace, bold: face.bold, italic: face.italic, bytes }
  }
  pad(message: PadMessage): PadAck {
    if (
      this.control.cancelled ||
      !['running', 'paused'].includes(this.state) ||
      (this.activity.state !== 'visible' &&
        message?.kind !== 'save-outcome' &&
        message?.kind !== 'save-cancel') ||
      !this.pads
    )
      return { status: 'ignored' }
    return this.pads.admit(message)
  }
  private canUseSystemDialog(): boolean {
    return !this.control.cancelled && this.state === 'running' &&
      this.activity.state === 'visible' && !this.fontSelection.active
  }
  selectSystemDialog(id: number, value: string | null): boolean | Promise<boolean> {
    if (
      this.control.cancelled ||
      this.state !== 'running' ||
      this.activity.state !== 'visible' ||
      this.fontSelection.active
    )
      return false
    return this.systemDialogs?.respond(id, value, () => this.canUseSystemDialog()) ?? false
  }
  async browseStorageSelector(id: number, directory: string): Promise<import('./ports/storage-selector.ts').StorageSelectorDirectory | null> {
    if (!this.canUseSystemDialog()) return null
    return this.systemDialogs?.browse(id, directory, () => this.canUseSystemDialog()) ?? null
  }
  async previewFont(
    id: number,
    face: string,
    kind: 'sample' | 'label' = 'sample',
  ): Promise<FontPreview | null> {
    this.control.check()
    const request = this.fontSelection.preview(id, face)
    if (!request) return null
    if (this.fontPreviewBusy) throw new Error('Font preview is already running')
    this.fontPreviewBusy = true
    try {
      if (kind !== 'sample' && kind !== 'label') throw new Error('Unknown font preview kind')
      const font = {
          ...request.font,
          height: kind === 'label' ? 18 : Math.min(64, Math.abs(request.font.height)),
        },
        size = fontPreviewSize(kind, font.height),
        bitmap = new Bitmap(size.width, size.height),
        draws = await this.fonts.draw(kind === 'label' ? face : request.sample, font, 0x202124, {
          antialiased: true,
          shadowLevel: 0,
          shadowWidth: 0,
          shadowColor: 0,
          shadowX: 0,
          shadowY: 0,
        })
      for (const draw of draws) {
        this.control.check()
        bitmap.composite(
          draw.pixels,
          8 + draw.x + (draw.pixels.left ?? 0),
          8 + draw.y + (draw.pixels.top ?? 0),
          0,
        )
        await this.yieldGraphics()
      }
      if (!this.fontSelection.preview(id, face)) return null
      return { ...bitmap.pixels, requestId: id, face }
    } finally {
      this.fontPreviewBusy = false
    }
  }
  inspectOwnership(): {
    eventReceipts: number
    eventCheckpoints: number
    modalScopes: number
    modalWaits: number
    eventSources: number
    soundSources: number
    pendingSoundCloses: number
    videoSources: number
    pendingVideoCloses: number
    windowSources: number
    menuSources: number
    layerSources: number
    padSources: number
    padTextUnits: number
    fontSources: number
    closingLayers: number
    closingWindows: number
    dependents: number
    pendingInvalidations: number
    weakOwners: number
    objectIdentities: number
    scriptObjects: number
    pendingHandles: number
  } {
    const runtime = this.runtime?.inspect()
    return {
      eventReceipts: this.eventReceipts.size,
      eventCheckpoints: this.checkpoints.size,
      modalScopes: this.modalLoop?.depth ?? 0,
      modalWaits: this.modalLoop?.pendingWaits ?? 0,
      eventSources: this.events?.count ?? 0,
      soundSources: this.sounds?.count ?? 0,
      pendingSoundCloses: this.sounds?.pendingCloses ?? 0,
      videoSources: this.videos?.count ?? 0,
      pendingVideoCloses: this.videos?.pendingCloses ?? 0,
      windowSources: this.windows?.count ?? 0,
      menuSources: this.menuItems?.count ?? 0,
      layerSources: this.layerObjects?.count ?? 0,
      padSources: this.pads?.count ?? 0,
      padTextUnits: this.pads?.textUnits ?? 0,
      fontSources: this.layerObjects?.fontCount ?? 0,
      closingLayers: this.layerObjects?.closing ?? 0,
      closingWindows: this.windows?.closing ?? 0,
      dependents: runtime?.dependents ?? 0,
      pendingInvalidations: runtime?.pendingInvalidations ?? 0,
      weakOwners: runtime?.weakOwners ?? 0,
      objectIdentities: runtime?.objectIdentities ?? 0,
      scriptObjects: runtime?.scriptObjects ?? 0,
      pendingHandles: runtime?.pendingHandles ?? 0,
    }
  }
  snapshot(): SessionSnapshot {
    const runtime = this.runtime?.inspect()
    return {
      windows: this.windowPresentations(),
      activeWindow: this.windowId,
      mainWindow: this.windows?.mainId ?? 0,
      debug: this.debugPanels.snapshot(),
      eventDisabled: this.systemEvents?.disabled ?? false,
      revision: this.snapshotRevision,
      state: this.state,
      userPaused: this.userPaused,
      graphics: { ...this.graphicsStatus },
      activity: { ...this.activity },
      resources: this.storage.count,
      ...(this.project ? { project: { ...this.project } } : {}),
      ...this.layers.inspect(),
      handles: runtime?.handles ?? 0,
      memoryBytes: runtime?.memoryBytes ?? 0,
      backend: runtime?.backend ?? 'loading',
      width: this.width,
      height: this.height,
      title: this.title,
      saveFiles: this.saves.count,
      pendingSaves: this.saves.pending,
      ...this.images.snapshot(),
      ...this.cursors.snapshot(),
    }
  }
  private notify(): void {
    this.pads?.present()
    this.snapshotRevision++
    this.deps.event({ type: 'state', snapshot: this.snapshot() })
  }
  private readonly debugPanels = new DebugPanels(() => this.notify())
  setDebugVisibility(panel: DebugPanel, visible: boolean): void {
    this.debugPanels.set(panel, visible)
  }
  private setState(state: SessionState): void {
    this.state = state
    if (state === 'stopping' || state === 'stopped' || state === 'failed') this.keyStates.reset()
    if (state !== 'running') this.clearVirtualCursors()
    this.notify()
  }
  fail(error: unknown, recorded = false, persist = true): void {
    if (this.state === 'stopping' || this.state === 'stopped') return
    this.control.cancel()
    this.events?.dispose()
    this.systemEvents?.dispose()
    this.debug?.dispose()
    if (!recorded) this.recordFailure(error)
    this.materializeLogs()
    this.setState('failed')
    if (persist)
      void this.flushFiles(false)
        .then(() => this.notify())
        .catch((e) => {
          this.reportFlushFailure(e)
          this.notify()
        })
  }
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise
    this.setState('stopping')
    this.control.cancel()
    this.events?.dispose()
    this.systemEvents?.dispose()
    this.debug?.dispose()
    this.stopPromise = this.queue
      .drain()
      .then(async () => {
        await this.flushFiles(true, true)
        await this.disposeResources()
        this.setState('stopped')
      })
      .catch((error) => {
        this.stopPromise = undefined
        this.setState('failed')
        throw error
      })
    return this.stopPromise
  }
  private disposeResources(): Promise<void> {
    if (this.disposalPromise) return this.disposalPromise
    this.disposalPromise = (async () => {
      let primary: unknown,
        failed = false
      const attempt = async (action: () => unknown) => {
        try {
          await action()
        } catch (error) {
          if (!failed) {
            primary = error
            failed = true
          }
        }
      }
      // Saving is a separate, retryable gate before entering this terminal
      // cleanup. Once here, one media failure must not retain the VM or other
      // resources. Cache the outcome so a retry never disposes a device twice.
      await attempt(() => this.appLocks.close())
      await attempt(() => this.closeClipboard())
      await attempt(() => this.closeHelp())
      await attempt(async () => {
        while (this.cancellationWork.size) await Promise.all([...this.cancellationWork])
        if (this.cancellationErrors.length) {
          const errors = this.cancellationErrors.splice(0)
          if (errors.length === 1) throw errors[0]
          throw new AggregateError(errors, 'Session cancellation cleanup failed')
        }
      })
      await attempt(() => this.pads?.dispose())
      await attempt(() => this.modalLoop?.dispose())
      await attempt(() => {
        const callback = this.compactCallback
        this.compactCallback = undefined
        if (callback) this.runtime?.release(callback)
      })
      await attempt(() => {
        this.detachPendingEvents?.()
        this.detachPendingEvents = undefined
        this.setModalWakeup(undefined)
        const callbacks = this.checkpointCallbacks
        this.checkpointCallbacks = undefined
        if (callbacks) {
          let failed = false,
            first: unknown
          for (const callback of [callbacks.pump, callbacks.publish, callbacks.commit]) {
            try {
              this.runtime?.release(callback)
            } catch (error) {
              if (!failed) {
                failed = true
                first = error
              }
            }
          }
          if (failed) throw first
        }
      })
      await attempt(() => this.videos?.dispose())
      await attempt(() => this.sounds?.dispose())
      await attempt(() => this.inputs?.dispose())
      await attempt(() => this.closeCursors())
      await attempt(() => this.layerObjects?.dispose())
      await attempt(() => this.kag.clear())
      await attempt(() => this.windows?.dispose())
      this.windowPresentedVersions.clear()
      this.virtualCursors.clear()
      this.mouseKeys.clear()
      this.windowRegions.clear()
      this.windowRegionRequests.clear()
      this.physicalPointerSequences.clear()
      this.windowPointers.clear()
      this.keyboardRoutes.clear()
      await attempt(() => this.menuItems?.dispose())
      await attempt(() => this.menus.clear())
      await attempt(() => this.presentMenus())
      const runtime = this.runtime
      this.runtime = undefined
      await attempt(() => runtime?.dispose())
      await attempt(() => this.layers.clear())
      await attempt(() => this.storage.clear())
      await attempt(() => this.deps.renderer.dispose())
      await attempt(() => this.saves.close())
      if (failed) throw primary
    })()
    return this.disposalPromise
  }
  exportSaves(): SaveFile[] {
    this.materializeLogs()
    return this.saves.export()
  }
  async idle(): Promise<void> {
    await this.queue.drain()
    await this.videos?.flushCloses()
    await this.sounds?.flushCloses()
    await this.queue.drain()
  }
  async importSaves(files: SaveFile[]): Promise<void> {
    if (this.state !== 'ready' && this.state !== 'paused')
      throw new Error('Pause the game before importing saves')
    this.materializeLogs()
    await this.saves.import(files)
    this.notify()
  }
  async commitDroppedResources(tree: DropResourceTree, valid: () => boolean): Promise<string[]> {
    this.control.check()
    const names = await this.dropped.commit(tree, valid)
    this.control.check()
    return names
  }
  private async readResource(name: string): Promise<Uint8Array> {
    return (await this.resolveResource(name, 'TVPCannotOpenStorage')).read()
  }
  private async withTextError<T>(name: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation() }
    catch (error) { throw mapTextStreamError(error, name) }
  }
  private textWriterMode(name: string, mode: string): StreamMode {
    try { return parseTextWriterMode(mode) }
    catch (error) { throw mapTextStreamError(error, name) }
  }
  private async resolveResource(name: string, missing: TvpMessageId = 'TVPCannotFindStorage'): Promise<Resource> {
    const resource = await this.findResource(name)
    if (!resource) throw new TvpError(missing, [name], `Resource not found: ${name}`)
    return resource
  }
  private async findResource(name: string): Promise<Resource | undefined> {
    this.materializeLogs()
    return this.storage.lookupAsync(name, (candidate) => this.saves.resource(candidate),
      this.saves.list().map((file) => this.saves.resource(file.name)!))
  }
  private async resourceExists(name: string): Promise<boolean> {
    return !!await this.findResource(name)
  }
  private async storageWriteTarget(name: string, mode: StreamMode): Promise<string> {
    const requested = storageWritePath(name, this.project?.directory)
    this.storage.assertWritable(requested)
    this.materializeLogs()
    if (mode.hasOffset || mode.append) {
      const existing = await this.findResource(toPublicStoragePath(requested))
      if (existing) {
        const target = storageWritePath(existing.name)
        this.storage.assertWritable(target)
        return target
      }
      // Append alone is a Web extension that may create a new file. An explicit
      // offset still selects UPDATE and requires a target, including ao0.
      if (mode.hasOffset) throw new TvpError('TVPCannotOpenStorage', [name], `Update target not found: ${name}`)
    } else {
      // Ordinary WRITE does not search auto paths, but must keep the spelling
      // of a direct existing target instead of creating a case-only shadow.
      const existing = this.saves.resource(requested) ?? this.storage.find(requested)
      if (existing) {
        const target = storageWritePath(existing.name)
        this.storage.assertWritable(target)
        return target
      }
    }
    return requested
  }
  private async decodeImage(bytes: Uint8Array): Promise<DecodedImage> {
    const png = decodePng(bytes)
    if (png) {
      const plan = await this.finishGraphics(png)
      const expanded = await this.deps.inflateImage(plan.compressed, plan.expandedLength)
      return this.finishGraphics(plan.decode(expanded))
    }
    const bmp = decodeBmp(bytes)
    if (bmp) return bmp
    const work = decodeTlg(bytes) ?? decodeGif(bytes)
    return work ? this.finishGraphics(work) : this.deps.graphics.decode(bytes)
  }
  private closeCursors(): void {
    this.cursors.dispose()
    if (this.cursorDefinitionsCleared) return
    this.cursorDefinitionsCleared = true
    this.deps.event({ type: 'cursor-assets-clear' })
  }
  private async decodeCursorAsset(bytes: Uint8Array): Promise<CursorAsset> {
    let deadline = this.deps.now() + 8
    const checkpoint = async () => {
      this.control.check()
      if (this.deps.now() >= deadline) {
        await this.yieldGraphics()
        deadline = this.deps.now() + 8
      }
    }
    // Select the directory entry before decoding it. Malformed alternatives
    // that the native loader does not select must not break a valid cursor.
    return loadCursorBytes(bytes, {
      png: (payload) => this.decodeImage(payload), checkpoint,
    }, windowsDesktopCursorProfile)
  }
  private async yieldGraphics(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.deps.schedule(resolve, 0)
    })
    await this.control.wait()
    this.control.check()
  }
  private async finishGraphics<T>(work: Generator<void, T>): Promise<T> {
    let deadline = this.deps.now() + 8
    try {
      while (true) {
        this.control.check()
        const next = work.next()
        if (next.done) return next.value
        if (this.deps.now() >= deadline) {
          await this.yieldGraphics()
          deadline = this.deps.now() + 8
        }
      }
    } finally {
      work.return(undefined as T)
    }
  }
  private closeClipboard(): void {
    if (this.clipboardClosed) return
    this.clipboardClosed = true
    this.clipboard.close()
  }
  private closeHelp(): void {
    if (this.helpClosed) return
    this.helpClosed = true
    this.help.close()
  }

  private async clipboardCall<T>(operation: () => Promise<T>): Promise<T> {
    this.control.check()
    this.clipboardBusy++
    try {
      this.clearVirtualCursors()
      const pending = operation()
      this.pads?.present()
      return await cancelable(pending, this.control)
    } catch (error) {
      if (this.control.cancelled) throw new ExecutionCancelled()
      // The generic TJS host error bridge carries a message. Keep the actual
      // browser exception name alongside its message instead of losing it.
      const name = error instanceof Error ? error.name : 'Error',
        message = error instanceof Error ? error.message : String(error)
      try {
        assertClipboardText(name)
        assertClipboardText(message)
      } catch (limitError) {
        const failure = limitError as Error
        throw new Error(`${failure.name}: ${failure.message}`, { cause: error })
      }
      throw new Error(`${name}: ${message}`, { cause: error })
    } finally {
      this.clipboardBusy--
      this.pads?.present()
    }
  }

  private async host(
    operation: string,
    args: ScriptValue[],
    context: HostContext,
  ): Promise<HostReply> {
    if (operation === 'Pad.class')
      return {
        kind: 'value',
        value: { type: 'class', namespace: 'Pad', id: 0, className: 'Pad', properties: [] },
      }
    if (operation === 'Pad.construct') {
      if (!isScriptObject(args[0])) throw new Error('Expected native Pad owner')
      return { kind: 'value', value: BigInt(this.pads!.construct(args[0])) }
    }
    if (operation.startsWith('Pad.')) {
      const id = Number(args[0])
      if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Pad identifier')
      if (operation === 'Pad.nativeInvalidate') this.pads?.remove(id)
      else if (operation === 'Pad.get')
        return { kind: 'value', value: this.pads!.get(id, String(args[1])) }
      else if (operation === 'Pad.set') this.pads!.set(id, String(args[1]), args[2])
      else throw new Error('Unknown Pad operation')
      return { kind: 'value', value: undefined }
    }
    if (operation === 'System.class') return { kind: 'value', value: systemClassValue(args) }
    if (operation === 'System.bindCompact') {
      if (this.compactCallback || !isScriptObject(args[0])) throw new Error('Invalid native compact binding')
      this.compactCallback = context.retain(args[0])
      return { kind: 'value', value: undefined }
    }
    if (operation === 'System.createUUID')
      return { kind: 'value', value: this.systemEnvironment.createUUID() }
    if (operation === 'System.get') {
      const property = args[1]
      if (
        args[0] !== 0n ||
        typeof property !== 'string' ||
        !systemReadonlyProperties.includes(property as (typeof systemReadonlyProperties)[number])
      )
        throw new Error('Invalid System property')
      if (systemDisplayProperties.includes(property as (typeof systemDisplayProperties)[number]))
        return {
          kind: 'value',
          value: this.systemEnvironment.display.get(
            property as (typeof systemDisplayProperties)[number],
          ),
        }
      return {
        kind: 'value',
        value:
          property === 'versionInformation'
            ? this.systemEnvironment.versionInformation(this.runtime?.languageVersion)
            : this.systemEnvironment[
                property as Exclude<
                  (typeof systemReadonlyProperties)[number],
                  'versionInformation' | (typeof systemDisplayProperties)[number]
                >
              ],
      }
    }
    if (operation === 'System.title') {
      if (args.length) {
        if (typeof args[0] !== 'string') throw new Error('System title requires text')
        this.systemEnvironment.title = args[0]
      }
      return { kind: 'value', value: this.systemEnvironment.title }
    }
    if (operation === 'Clipboard.class')
      return {
        kind: 'value',
        value: {
          type: 'class',
          namespace: 'Clipboard',
          id: 0,
          className: 'Clipboard',
          properties: [],
        },
      }
    if (operation === 'Clipboard.hasText') {
      const result = await this.clipboardCall(() => this.clipboard.hasText())
      if (typeof result !== 'boolean') throw new Error('DataError: Invalid clipboard format result')
      return { kind: 'value', value: result ? 1n : 0n }
    }
    if (operation === 'Clipboard.read') {
      const result = await this.clipboardCall(async () => {
        const content = await this.clipboard.readText()
        if (content?.hasText === true) assertClipboardText(content.text)
        return content
      })
      if (
        !result ||
        (result.hasText !== false && !(result.hasText === true && typeof result.text === 'string'))
      )
        throw new Error('DataError: Invalid clipboard text result')
      return { kind: 'value', value: result.hasText ? result.text : undefined }
    }
    if (operation === 'Clipboard.write') {
      if (typeof args[0] !== 'string') throw new Error('Clipboard text must be a native string')
      await this.clipboardCall(() => {
        assertClipboardText(args[0])
        return this.clipboard.writeText(args[0])
      })
      return { kind: 'value', value: undefined }
    }
    if (operation.startsWith('Checkpoint.')) return this.checkpointHost(operation, args, context)
    if (operation.startsWith('Modal.')) {
      if (!this.modalLoop) throw new Error('Modal dispatcher is unavailable')
      if (operation === 'Modal.wait' && this.terminateRequested) {
        // Posted quit ends application modal loops, but does not dismiss the
        // native TrackPopupMenuEx loop. Keep menu waits and the quit request
        // alive until a real menu result or lifecycle cancellation unwinds it.
        // System.exit instead cancels the VM immediately and never returns.
        const token = Number(args[0])
        if (token === this.modalLoop.activeToken && this.modalLoop.info(token)?.kind !== 'menu')
          this.modalLoop.cancel(token, 'application-termination')
      }
      return this.modalLoop.host(operation, args)
    }
    if (
      operation === 'Session.eventCheckpoint' ||
      operation === 'Session.windowUpdateCheckpoint' ||
      operation === 'Session.abortRoundReceipts'
    ) {
      const round = Number(args[0])
      if (!Number.isSafeInteger(round) || round <= 0)
        throw new Error('Invalid event checkpoint round')
      if (operation === 'Session.abortRoundReceipts') {
        const error = new Error(String(args[1] ?? 'System event round aborted'))
        this.abortedReceiptRounds.set(round, error)
        // Native release can throw before a continuation is entered. The
        // enclosing execute failure/stop still owns these detached receipts.
        for (const id of this.settledRounds.get(round) ?? []) {
          const receipt = this.eventReceipts.get(id)
          if (receipt) {
            receipt.epilogueDone = true
            this.receiptFailure(receipt, error)
            this.outerRecoveryReceipts.add(id)
          }
        }
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Session.eventCheckpoint' && Number(args[1]))
        for (const id of this.settledRounds.get(round) ?? []) {
          const receipt = this.eventReceipts.get(id)
          if (receipt) receipt.epilogueDone = true
        }
      return this.beginCheckpoint(
        round,
        operation === 'Session.windowUpdateCheckpoint',
        operation === 'Session.windowUpdateCheckpoint' && !!Number(args[1]),
        true,
      )
    }
    if (
      operation.startsWith('Debug.') &&
      !operation.startsWith('Debug.panel') &&
      operation !== 'Debug.visible'
    )
      return this.debug!.host(operation, args)
    if (operation === 'Input.padConfigured')
      return { kind: 'value', value: this.gamepadSettings ? 1n : 0n }
    if (operation === 'Input.configurePad' || operation === 'Input.padRepeat') {
      const integer = (index: number) => {
        const value = args[index]
        if (typeof value !== 'bigint') throw new Error('Invalid gamepad timing argument')
        return Number(BigInt.asIntN(32, value))
      }
      if (operation === 'Input.configurePad') {
        if (!this.gamepadSettings)
          this.gamepadSettings = { enabled: args[0] === 1n, delay: integer(1), interval: integer(2) }
      } else if (this.gamepadSettings) {
        if (args[0] === '-paddelay') this.gamepadSettings.delay = integer(1)
        else if (args[0] === '-padinterval') this.gamepadSettings.interval = integer(1)
        else throw new Error('Unknown gamepad repeat argument')
      }
      this.presentInputViews()
      return { kind: 'value', value: undefined }
    }
    if (operation.startsWith('KAG.'))
      return { kind: 'value', value: await this.kag.host(operation, args, context) }
    if (operation === 'Input.get' && args[1] === 'keyState')
      return { kind: 'value', value: this.keyStates.query(
        typeof args[0] === 'bigint' ? args[0] : Number(args[0]),
        args[2] === undefined || !!Number(args[2]),
      ) ? 1n : 0n }
    if (operation.startsWith('Input.')) return this.inputs!.host(operation, args, context)
    if (operation.startsWith('Transition.')) return this.transitions!.host(operation, args)
    if (operation.startsWith('Sound.') || operation.startsWith('PhaseVocoder.'))
      return { kind: 'value', value: await this.sounds!.host(operation, args, context) }
    if (operation === 'Video.layer') {
      const layer = args[2] === null ? null : this.layerObjects!.cast(args[2])
      return { kind: 'value', value: await this.videos!.host(operation,
        [args[0], args[1], layer ? BigInt(layer.id) : null, args[2]], context) }
    }
    if (operation === 'Video.geometry') {
      const mutation = await this.videos!.geometry(Number(args[0]), String(args[1]), args.slice(2))
      if (!mutation) return { kind: 'value', value: undefined }
      const firstLayer = mutation.layer(0) ?? mutation.layer(1),
        controller = this.inputControllers.get(mutation.windowId) ??
          (firstLayer === undefined ? this.inputControllers.active : this.inputControllers.forLayer(firstLayer)),
        session = this
      return this.inputs!.start((function* (): InputOperation {
        for (let channel = 0; channel < 2; channel++) {
          const id = mutation.layer(channel)
          if (id === undefined || !session.layers.has(id)) continue
          yield* session.inputControllers.forLayer(id).change(() => {
            const values = mutation.values(), previousWindow = session.layerWindow(id)
            for (const field of ['left', 'top', 'visible'] as const)
              if (values[field] !== undefined) session.layers.set(id, field, values[field]!)
            if (previousWindow !== undefined) session.invalidateWindow(previousWindow)
            session.invalidateLayer(id)
          })
        }
        return undefined
      })(), controller)
    }
    if (operation.startsWith('Video.'))
      return { kind: 'value', value: await this.videos!.host(operation, args, context) }
    if (operation === 'System.getArgument') {
      if (typeof args[0] !== 'string') throw new Error('System.getArgument requires an option name')
      return { kind: 'value', value: this.systemArguments.get(args[0]) }
    }
    if (operation === 'System.applicationReadError') {
      if (typeof args[0] !== 'string') throw new Error('Invalid application event lookup diagnostic')
      this.log(args[0])
      return { kind: 'value', value: undefined }
    }
    if (
      operation === 'System.bindEvents' ||
      [
        'System.eventNext',
        'System.eventCall',
        'System.eventDone',
        'System.eventFailed',
        'System.eventInvalid',
        'System.eventEnd',
        'System.eventWindowUpdate',
      ].includes(operation)
    ) {
      if (operation === 'System.eventNext' && this.deps.now() >= this.eventYieldAt) {
        await this.deps.yieldToHost()
        await this.control.wait()
        this.control.check()
        this.eventYieldAt = this.deps.now() + 8
      }
      return this.systemEvents!.host(operation, args)
    }
    const number = (i: number) => {
      const value = args[i]
      if (
        (typeof value !== 'bigint' && typeof value !== 'number') ||
        !Number.isFinite(Number(value)) ||
        Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER
      )
        throw new Error(`${operation}: expected a finite numeric argument at ${i}`)
      return Number(value)
    }
    // Native image, color and drawing entry points narrow TJS integers to 32 bits.
    // Preserve the low bits before Number conversion.
    const clipInteger = (i: number) => {
      const value = args[i]
      return typeof value === 'bigint' ? Number(BigInt.asIntN(32, value)) : number(i) | 0
    }
    const text = (i: number) => {
      if (typeof args[i] !== 'string') throw new Error(`${operation}: expected text at ${i}`)
      return args[i] as string
    }
    let value: ScriptValue
    switch (operation) {
      case 'System.toActualColor':
        value = BigInt(this.systemColors.toActualColor(clipInteger(0)))
        break
      case 'System.dialog': {
        if (!isScriptObject(args[0])) throw new Error('System dialog request must be an object')
        const kind = text(1)
        if (kind !== 'inform' && kind !== 'input-string') throw new Error('Unknown System dialog')
        return this.systemDialogs!.show(
          this.runtime!.objectIdentity(args[0]),
          kind,
          text(2),
          text(3),
          text(4),
        )
      }
      case 'System.dialogAbort':
        if (isScriptObject(args[0]))
          this.systemDialogs?.abort(this.runtime!.objectIdentity(args[0]))
        break
      case 'Debug.panel': {
        const id = number(0)
        if (id !== 0 && id !== 1) throw new Error('Invalid Debug panel')
        value = {
          type: 'class',
          namespace: 'Debug.panel',
          id,
          className: id === 0 ? 'Console' : 'Controller',
          properties: [{ name: 'visible', writable: true, static: true, boolean: true }],
        }
        break
      }
      case 'Debug.panel.get':
      case 'Debug.panel.set': {
        const id = number(0)
        if ((id !== 0 && id !== 1) || text(1) !== 'visible')
          throw new Error('Invalid Debug panel property')
        const panel = id === 0 ? 'console' : 'controller'
        if (operation.endsWith('.set')) this.debugPanels.set(panel, !!number(2))
        value = this.debugPanels.get(panel) ? 1n : 0n
        break
      }
      case 'Debug.visible':
        if (args.length > 1) this.debugPanels.set(text(0), !!number(1))
        value = this.debugPanels.get(text(0)) ? 1n : 0n
        break
      case 'System.eventDisabled':
        if (args.length) return this.systemEvents!.setDisabled(!!number(0))
        value = this.systemEvents!.disabled ? 1n : 0n
        break
      case 'System.eventError':
        this.systemEvents!.report(text(0), !!number(1))
        break
      case 'System.addContinuous':
      case 'System.hasContinuous':
      case 'System.removeContinuous':
        if (!isScriptObject(args[0]) && args[0] !== null)
          throw new Error('Continuous handler must be an object')
        if (operation === 'System.hasContinuous') value = this.systemEvents!.has(args[0]) ? 1n : 0n
        else if (operation === 'System.addContinuous') this.systemEvents!.add(args[0], number(1))
        else this.systemEvents!.remove(args[0])
        break
      case 'System.setArgument':
        this.systemArguments.set(text(0), text(1))
        break
      case 'System.tick':
        value = BigInt(Math.trunc(this.deps.now()))
        break
      case 'System.cacheLimit':
        if (args.length) this.images.setLimit(number(0))
        value = BigInt(this.images.limit)
        break
      case 'System.clearGraphicCache':
        this.images.clear()
        break
      case 'System.doCompact': {
        const level = clipInteger(0), listeners: [string, () => void][] = []
        if (typeof args[1] === 'string') this.deps.event({
          type: 'log', level: 'error', text: `Compact Event (Native GC): ${args[1]}`,
        })
        if (level >= 10) listeners.push(
          ['Layer composition', () => this.composer.clear()],
          ['Storage auto paths', () => this.storage.invalidateSearch()],
        )
        if (level >= 15) listeners.push(
          ['Source images', () => this.images.compact()],
          ['Font faces', () => this.fonts.compact()],
          ['Raster scratch', () => this.deps.graphics.compact?.()],
        )
        for (const [name, compact] of listeners) {
          this.control.check()
          try { compact() }
          catch (error) {
            this.control.check()
            if (error instanceof ExecutionCancelled) throw error
            // Fixed compact delivery reports a faulty listener and continues
            // to the next one. It is not a request to clear active resources.
            this.deps.event({ type: 'log', level: 'error', text: `Compact Event (${name}): ${String(error)}` })
          }
        }
        break
      }
      case 'System.touchImages': {
        if (!isScriptObject(args[0])) throw new Error('System.touchImages requires an Array')
        const names = context.snapshot(args[0])
        if (names.type !== 'array' || names.items.some((name) => typeof name !== 'string'))
          throw new Error('System.touchImages requires an Array of names')
        await this.images.touch(names.items as string[], number(1), number(2))
        break
      }
      case 'System.createAppLock':
        value = BigInt(await this.appLocks.acquire(text(0)))
        break
      case 'System.exit':
        this.requestExit()
        break
      case 'System.terminate':
        this.terminateRequested = true
        this.modalLoop?.notify()
        break
      case 'System.exitOnWindowClose':
        if (args.length) this.exitOnWindowClose = !!number(0)
        value = this.exitOnWindowClose ? 1n : 0n
        break
      case 'System.exitOnNoWindowStartup':
        if (args.length) this.exitOnNoWindowStartup = !!clipInteger(0)
        value = this.exitOnNoWindowStartup ? 1n : 0n
        break
      case 'Scripts.class':
        return { kind: 'value', value: { type: 'native-class', name: 'Scripts' } }
      case 'Scripts.textEncoding.get':
        value = this.textEncoding.label
        break
      case 'Scripts.textEncoding.set':
        this.textEncoding.set(text(0))
        break
      case 'Scripts.readCompile':
        value = await this.withTextError(text(0), async () => this.deps.readText(
          await this.readResource(text(0)),
          '',
          this.textEncoding.codec,
        ))
        break
      case 'Scripts.execStorage': {
        const resource = await this.resolveResource(text(0))
        return {
          kind: 'script',
          source: await this.withTextError(toPublicStoragePath(resource.name), async () => this.deps.decodeScript(
            await resource.read(),
            typeof args[1] === 'string' ? args[1] : '',
            this.textEncoding.codec,
          )),
          name: resource.name.replace(/^.*[\\/>]/, ''),
          context: isScriptObject(args[2]) ? args[2] : undefined,
          expression: args[3] === 1n,
        }
      }
      case 'Scripts.dump':
        return { kind: 'dump' }
      case 'Scripts.writeDump': {
        const bytes = args[0],
          requested = 'savedata/krkr2-web.dump.txt'
        if (
          !(bytes instanceof Uint8Array) ||
          bytes.length > 16 * 1024 * 1024 ||
          bytes[0] !== 255 ||
          bytes[1] !== 254 ||
          bytes.length % 2
        )
          throw new Error('Invalid script dump')
        try {
          this.saves.writeDiagnostic(this.saves.locate(requested) ?? requested, bytes)
        } catch (error) {
          this.log(`脚本转储无法写入：${String(error).slice(0, 4096)}`, 'error')
          break
        }
        // A new explicit dump retries diagnostics once; pending game writes
        // still make a failed transaction fatal and remain exportable.
        await this.flushFiles(false, true)
        return this.debug!.dispatch(this.diagnostics.begin('Dumped to ' + requested))
      }
      case 'Storage.readText':
        value = await this.withTextError(text(0), async () => this.deps.readText(
          await this.readResource(text(0)),
          text(1),
          this.textEncoding.codec,
        ))
        break
      case 'Storage.readBinary': {
        const bytes = await this.readResource(text(0)),
          offset = modeOffset(text(1))
        if (offset > bytes.length) throw new Error('Binary stream offset exceeds file length')
        if (bytes.length - offset > 64 * 1024 * 1024)
          throw new Error('Binary stream exceeds 64 MiB budget')
        value = bytes.subarray(offset)
        break
      }
      case 'Storage.validateTextWrite':
        // Text mode errors belong to construction, before a stream can queue
        // bytes on destruction. Match the native mode-before-path ordering.
        value = await this.storageWriteTarget(text(0), this.textWriterMode(text(0), text(1)))
        break
      case 'Storage.validateWrite':
        storageWritePath(text(0), this.project?.directory)
        value = await this.storageWriteTarget(text(0), parseStreamMode(text(1)))
        break
      case 'Storage.writeText':
      case 'Storage.writeBinary': {
        this.materializeLogs()
        const mode = text(1),
          parsed =
            operation === 'Storage.writeText' ? this.textWriterMode(text(0), mode) : parseStreamMode(mode),
          path = storageWritePath(text(0))
        const encoded =
          operation === 'Storage.writeText'
            ? await this.withTextError(text(0), () => this.deps.writeText(text(2), mode)) : args[2]
        if (!(encoded instanceof Uint8Array)) throw new Error('Expected binary file contents')
        let output = encoded
        if (parsed.hasOffset || parsed.append) {
          let original: Uint8Array = new Uint8Array()
          // Native saved the preflight target on its stream. Never resolve it
          // through a possibly changed auto-path list during serialization.
          const existing = this.saves.resource(path) ?? this.storage.find(path)
          if (existing) original = await existing.read()
          else if (parsed.hasOffset) throw new TvpError('TVPCannotOpenStorage', [path], `Update target not found: ${path}`)
          const position = parsed.append ? original.length : parsed.offset,
            length = Math.max(original.length, position + encoded.length)
          if (length > 64 * 1024 * 1024) throw new Error('Save file exceeds 64 MiB budget')
          output = new Uint8Array(length)
          output.set(original)
          output.set(encoded, position)
        }
        this.saves.write(path, output)
        this.notify()
        break
      }
      case 'Storages.class':
        return {
          kind: 'value',
          value: {
            type: 'class',
            namespace: 'Storages',
            id: 0,
            className: 'Storages',
            properties: [],
          },
        }
      case 'Storages.selectFilePath':
        value = normalizeSelectorPath(getFullStoragePath(text(0), this.project?.directory))
        break
      case 'Storages.selectFile': {
        this.materializeLogs()
        const selector = await cancelable(new StorageSelector(
          this.storage,
          this.saves,
          this.systemEnvironment.dataPath,
        ).prepare(args.slice(1)), this.control)
        this.control.check()
        return this.systemDialogs!.showStorageSelector(
          number(0),
          selector.caption,
          selector.presentation,
          selector.choose,
          selector.browse,
        )
      }
      case 'Storages.selectFileAbort':
        try {
          this.systemDialogs?.abortStorageSelector(number(0))
        } catch (error) {
          // Native preserves the original exception when continuation entry
          // and cleanup both fail. Record cleanup here, without entering TJS,
          // so it is neither lost nor deferred to an unrelated later call.
          const describe = (value: unknown): string =>
            value instanceof AggregateError
              ? `${value.message}: ${value.errors.map(describe).join('; ')}`
              : value instanceof Error
                ? value.message
                : String(value)
          try {
            this.deps.event({
              type: 'log',
              level: 'error',
              text: `文件选择器清理失败：${describe(error)}；原始调用异常优先保留。`,
            })
          } catch (reportingError) {
            throw new AggregateError(
              [error, reportingError],
              'Storage selector cleanup reporting failed',
            )
          }
          throw error
        }
        break
      case 'System.shellExecute':
        value = BigInt(await openHelpDocument(text(0), text(1), {
          currentDirectory: this.project?.directory,
          find: (name) => this.findResource(name),
          decode: (bytes) => this.withTextError(text(0), () => this.deps.readText(bytes, '', this.textEncoding.codec)),
          host: this.help,
          control: this.control,
        }))
        break
      case 'Storages.getLocalName':
        value = getWebLocalName(text(0), this.project?.directory)
        break
      case 'Storages.getFullPath':
        value = getFullStoragePath(text(0), this.project?.directory)
        break
      case 'Storages.extractStorageExt':
        value = extractStorageExt(text(0))
        break
      case 'Storages.extractStorageName':
        value = extractStorageName(text(0))
        break
      case 'Storages.extractStoragePath':
        value = extractStoragePath(text(0))
        break
      case 'Storages.chopStorageExt':
        value = chopStorageExt(text(0))
        break
      case 'Storages.exists':
        value = BigInt(await this.resourceExists(text(0)))
        break
      case 'Storages.getPlacedPath': {
        const resource = await this.findResource(text(0))
        value = resource ? toPublicStoragePath(resource.name) : ''
        break
      }
      case 'Storages.addAutoPath':
        this.storage.addAutoPath(text(0))
        break
      case 'Storages.removeAutoPath':
        this.storage.removeAutoPath(text(0))
        break
      case 'Events.create': {
        const type = text(0),
          callback = args[1]
        if ((type !== 'timer' && type !== 'trigger') || !isScriptObject(callback))
          throw new Error('Invalid event source')
        value = BigInt(this.events!.create(type, callback))
        break
      }
      case 'Menu.bind':
        if (!isScriptObject(args[0])) throw new Error('Expected menu cleanup function')
        this.menuItems!.bind(args[0])
        break
      case 'Menu.create':
        if (!isScriptObject(args[0]) || !isScriptObject(args[1]))
          throw new Error('Expected MenuItem instance and private state')
        value = this.menuItems!.create(args[0], args[1], args[2])
        break
      case 'Menu.invalidate':
        if (!isScriptObject(args[1])) throw new Error('Expected native menu owner')
        return this.menuItems!.invalidate(number(0), args[1])
      case 'Menu.releaseSlot':
        this.menuItems!.releaseSlot(number(0), number(1))
        break
      case 'Menu.abort':
        this.menuItems!.abort(number(0))
        break
      case 'Menu.finish':
        this.menuItems!.finish(number(0))
        break
      case 'Menu.state':
        value = this.menuItems!.state(args[0])
        break
      case 'Menu.view':
        value = BigInt(this.menuItems!.get(args[0]).view)
        break
      case 'Menu.relation':
        value = this.menuItems!.relation(args[0], text(1))
        break
      case 'Menu.index':
        value = BigInt(
          this.menuItems!.index(args[0], args[1] === undefined ? undefined : number(1)),
        )
        break
      case 'Menu.action':
        if (args[0] === null) break
        if (!isScriptObject(args[0]) || !isScriptObject(args[1]))
          throw new Error('MenuItem action requires an object owner and target')
        return {
          kind: 'invoke',
          callback: args[0],
          member: 'action',
          args: [scriptRecord({ type: 'onClick', target: args[1] })],
          ignoreStatus: true,
        }
      case 'Menu.get': {
        const property = text(1)
        if (
          !['caption', 'checked', 'enabled', 'group', 'radio', 'shortcut', 'visible'].includes(
            property,
          )
        )
          throw new Error('Unsupported menu property')
        const field = this.menus.get(this.menuItems!.get(args[0]).view)[property as 'caption']
        value = typeof field === 'string' ? field : BigInt(Number(field))
        break
      }
      case 'Menu.set':
        this.menuItems!.set(
          args[0],
          text(1),
          typeof args[2] === 'string' ? text(2) : number(2),
        )
        break
      case 'Menu.insert':
        value = this.menuItems!.insert(
          args[0],
          args[1],
          args[2] === undefined ? undefined : number(2),
        )
        break
      case 'Menu.remove':
        value = this.menuItems!.remove(args[0], args[1])
        break
      case 'Menu.popup': {
        const item = this.menuItems!.get(args[0]),
          window = this.menuItems!.windowByView(item.view)
        if (
          this.activity.state !== 'visible' ||
          item.closing ||
          (window && !window.state.visible) ||
          (!window && this.menus.windowId(item.view) !== undefined)
        ) {
          value = 0n
          break
        }
        if (!isScriptObject(args[4])) throw new Error('Popup request must be an object')
        return this.menuModals!.show(
          item,
          this.runtime!.objectIdentity(args[4]),
          number(1) >>> 0,
          number(2) | 0,
          number(3) | 0,
        )
      }
      case 'Menu.modalAbort':
        if (isScriptObject(args[0])) this.menuModals?.abort(this.runtime!.objectIdentity(args[0]))
        break
      case 'Events.get': {
        const source = this.events!.get(number(0)),
          property = text(1)
        if (!['interval', 'enabled', 'capacity', 'mode', 'cached'].includes(property))
          throw new Error('Unknown event property')
        const field = source[property as 'interval' | 'enabled' | 'capacity' | 'mode' | 'cached']
        value = property === 'interval' ? Number(field) : BigInt(Number(field))
        break
      }
      case 'Events.set':
        this.events!.set(number(0), text(1), number(2))
        break
      case 'Events.trigger':
        this.events!.trigger(number(0))
        break
      case 'Events.cancel':
        this.events!.cancel(number(0))
        break
      case 'Events.destroy':
        this.events!.destroy(number(0))
        break
      case 'Window.create': {
        if (!isScriptObject(args[0]) || !isScriptObject(args[1]))
          throw new Error('Expected Window instance and native cleanup')
        const window = this.windows!.create(args[0], args[1], context),
          readiness = this.deps.renderer.waitWindowReady?.(window.id)
        if (readiness) {
          try {
            // Finish this Window's surface before the constructor continues
            // into image allocation. Stop must unblock this wait before drain.
            await cancelable(readiness.promise, this.control)
          } finally {
            readiness.cancel()
          }
        }
        await this.ensureWindowGeometry(window)
        value = BigInt(window.id)
        break
      }
      case 'Window.showModal':
        if (!isScriptObject(args[1])) throw new Error('Modal Window request must be an object')
        return this.windowModals!.show(number(0), this.runtime!.objectIdentity(args[1]))
      case 'Window.beginMove':
        if (!isScriptObject(args[1])) throw new Error('Window move request must be an object')
        return this.windowMoves!.begin(number(0), this.runtime!.objectIdentity(args[1]))
      case 'Window.moveAbort':
        if (isScriptObject(args[1]))
          this.windowMoves?.abort(number(0), this.runtime!.objectIdentity(args[1]))
        break
      case 'Window.modalAbort':
        if (isScriptObject(args[1]))
          this.windowModals?.abort(number(0), this.runtime!.objectIdentity(args[1]))
        break
      case 'Window.modalClose':
        value = this.windowModals?.requestClose(number(0)) ? 1n : 0n
        break
      case 'Window.modalRespond':
        value = this.windowModals?.respond(number(0), !!number(1)) ? 1n : 0n
        break
      case 'Window.main':
        value = this.windows!.main
        break
      case 'Window.isMain':
        value = this.windows!.mainId === number(0) ? 1n : 0n
        break
      case 'Window.activate':
        void this.activateWindow(number(0)).catch((error) => {
          if (!this.control.cancelled) this.fail(error)
        })
        break
      case 'Window.invalidate':
        if (!isScriptObject(args[1])) throw new Error('Expected native Window owner')
        if (this.exitOnWindowClose && this.windows!.mainId === number(0))
          this.exitAfterOperation = true
        return this.windows!.invalidate(number(0), args[1])
      case 'Window.finish':
        this.windows!.finish(number(0))
        break
      case 'Window.detachInput': {
        this.clearVirtualCursors(number(0))
        const controller = this.inputControllers.get(number(0))
        controller?.clear()
        return this.inputs!.start(this.inputControllers.synchronize(), controller)
      }
      case 'Window.identity':
        if (args[0] === null) value = 'null'
        else {
          if (!isScriptObject(args[0]))
            throw new Error('Window registration requires an object closure')
          value = this.runtime!.objectIdentity(args[0])
        }
        break
      case 'Window.primary': {
        const window = this.windows!.get(number(0))
        const id = this.inputControllers.get(window.id)?.root() ?? 0
        value = !id || window.finished ? null : (this.layerObjects!.owner(id) ?? null)
        break
      }
      case 'Window.resize':
      case 'Window.innerResize': {
        const window = this.windows!.get(number(0))
        while (this.geometryTransactions.has(window.id))
          await this.geometryTransactions.get(window.id)!.catch(() => {})
        const candidate = window.state.copy(),
          width = number(1), height = number(2), inner = operation === 'Window.innerResize'
        candidate.assertWindowed()
        if (inner) candidate.resizeInner(width, height)
        else candidate.resize(width, height)
        await this.measureWindowGeometry(window, candidate, inner ? 'inner' : 'outer', { width, height })
        break
      }
      case 'Window.position': {
        const window = this.windows!.get(number(0))
        window.state.assertWindowed()
        await this.setWindowProperty(window, 'left', number(1))
        await this.setWindowProperty(window, 'top', number(2))
        break
      }
      case 'Window.constraints': {
        const window = this.windows!.get(number(0)), prefix = text(1)
        if (prefix !== 'min' && prefix !== 'max') throw new Error('Invalid Window constraint kind')
        window.state.assertWindowed()
        await this.setWindowProperty(window, `${prefix}Width`, number(2))
        await this.setWindowProperty(window, `${prefix}Height`, number(3))
        break
      }
      case 'Window.userHide':
        // Form.OnCloseQueryCalled uses its own Visible field, not the public
        // Window setter. Preserve the same hide side effects without its guard.
        await this.setWindowProperty(this.windows!.get(number(0)), 'visible', 0)
        break
      case 'Window.setMaskRegion': {
        const window = this.windows!.get(number(0)),
          primary = this.inputControllers.get(window.id)?.root() ?? 0
        if (window.closing || window.finished) throw new Error('Window has been invalidated')
        if (!primary) throw new TvpError('TVPWindowHasNoLayer', [], 'Window has no primary Layer')
        const pixels = this.layers.bitmap(primary).pixels,
          request = this.nextWindowRegionRequest++
        if (!Number.isSafeInteger(this.nextWindowRegionRequest)) throw new Error('Window region request identity exhausted')
        this.windowRegionRequests.set(window.id, request)
        const check = () => {
          this.control.check()
          if (this.registeredWindow(window.id) !== window ||
              this.windowRegionRequests.get(window.id) !== request)
            throw new Error('Window region destination changed')
        }
        const region = await cancelable(createWindowRegion(pixels, clipInteger(1) >>> 0, {
          maxRectangles: this.windowRegions.availableRectangles(window.id),
          checkpoint: check,
          yieldControl: async () => {
            await this.deps.yieldToHost()
            await this.control.wait()
            check()
          },
        }), this.control)
        check()
        this.publishWindowRegion(window, region)
        break
      }
      case 'Window.removeMaskRegion': {
        const window = this.windows!.get(number(0))
        if (window.closing || window.finished) throw new Error('Window has been invalidated')
        this.windowRegionRequests.delete(window.id)
        this.publishWindowRegion(window, null)
        break
      }
      case 'Window.postInput': {
        const window = this.windows!.get(number(0)),
          name = text(1)
        if (name === 'onKeyPress')
          this.postInput({ type: 'text', text: text(2).slice(0, 1) }, window)
        else if (name === 'onKeyDown' || name === 'onKeyUp')
          this.postInput(
            {
              type: name === 'onKeyDown' ? 'keyDown' : 'keyUp',
              key: number(2) & 65535,
              shift: number(3),
            },
            window,
          )
        else throw new Error('Unknown input event')
        break
      }
      case 'Window.get': {
        const window = this.windows!.get(number(0))
        // BaseWindow invalidates registered objects before WindowImpl closes
        // the Form. Those finalizers can still read the owner's last committed
        // properties, even though host delivery/measurement was retired first.
        // Reopening geometry here would abort otherwise valid native cleanup.
        if (!this.control.cancelled && !window.closing && !window.finished)
          await this.ensureWindowGeometry(window)
        const field = window.state[text(1) as keyof WindowState]
        if (typeof field !== 'string' && typeof field !== 'boolean' && typeof field !== 'number')
          throw new Error('Unsupported window property')
        value = typeof field === 'string' ? field : BigInt(Number(field))
        break
      }
      case 'Window.set': {
        await this.setWindowProperty(this.windows!.get(number(0)), text(1),
          typeof args[2] === 'string' ? text(2) : number(2), true)
        break
      }
      case 'Window.zoom': {
        const window = this.windows!.get(number(0))
        while (this.geometryTransactions.has(window.id))
          await this.geometryTransactions.get(window.id)!.catch(() => {})
        const candidate = window.state.copy()
        candidate.setZoom(number(1), number(2))
        await this.measureWindowGeometry(window, candidate, 'content')
        break
      }
      case 'Window.layerPosition': {
        const window = this.windows!.get(number(0))
        while (this.geometryTransactions.has(window.id))
          await this.geometryTransactions.get(window.id)!.catch(() => {})
        const candidate = window.state.copy()
        candidate.set('layerLeft', number(1))
        candidate.set('layerTop', number(2))
        await this.measureWindowGeometry(window, candidate, 'content')
        break
      }
      case 'Window.update': {
        const window = this.windows!.get(number(0)), primaryId = this.inputControllers.get(window.id)?.root() ?? 0,
          primary = this.layers.has(primaryId) ? this.layers.get(primaryId) : undefined,
          drawing = primary && drawDeviceGeometry(window.state, primary.width, primary.height)
        // Form.UpdateWindow exposes the primary source rectangle through the
        // DrawDevice; a missing/zero drawing surface posts no new invalidation.
        if (primary && primary.width > 0 && primary.height > 0 && drawing!.width > 0 && drawing!.height > 0)
          this.invalidateWindow(window.id)
        if (this.windowUpdates.delivering) break
        await this.synchronizeWindowGeometry()
        return this.inputs!.start(this.deliverWindowUpdates())
      }
      case 'Layer.create': {
        if (!isScriptObject(args[0]) || !isScriptObject(args[3]))
          throw new Error('Expected Layer instance and native state')
        value = BigInt(this.layerObjects!.create(args[0], args[1], args[2], args[3]))
        this.invalidateLayer(Number(value))
        break
      }
      case 'Layer.bindLifetime':
        if (!isScriptObject(args[0])) throw new Error('Expected Layer cleanup')
        this.layerObjects!.bind(args[0])
        break
      case 'Layer.invalidate':
        if (!isScriptObject(args[1])) throw new Error('Expected native Layer owner')
        return this.layerObjects!.invalidate(number(0), args[1])
      case 'Layer.stopTransitions':
        return this.inputs!.start(this.transitions!.invalidate(number(0)))
      case 'Layer.detach': {
        const id = number(0)
        this.layerObjects!.detachManager(id)
        return this.inputs!.detach(id, () => this.layers.detach(id), true)
      }
      case 'Layer.releaseImage': {
        this.layers.releaseImages(number(0))
        this.invalidateLayer(number(0))
        break
      }
      case 'Layer.finish':
        this.layerObjects!.finish(number(0))
        break
      case 'Layer.abort':
        this.layerObjects!.abort(number(0))
        break
      case 'Layer.state':
        value = this.layerObjects!.get(number(0)).state
        break
      case 'Layer.identity':
        value = BigInt(this.layerObjects!.cast(args[0]).id)
        break
      case 'Layer.relation':
        value = this.layerObjects!.relation(number(0), text(1))
        break
      case 'Layer.childrenRevision':
        value = BigInt(this.layers.get(number(0)).childrenRevision)
        break
      case 'Layer.action':
        if (!isScriptObject(args[0]) || !isScriptObject(args[1]))
          throw new Error('Expected Layer action owner and event')
        return {
          kind: 'invoke',
          callback: args[0],
          member: 'action',
          args: [args[1]],
          ignoreStatus: true,
        }
      case 'Font.bind':
        if (!isScriptObject(args[0])) throw new Error('Expected Font instance')
        this.layerObjects!.bindFont(args[0], args[1])
        break
      case 'Font.state':
        value = this.layerObjects!.fontState(args[0])
        break
      case 'Font.invalidate':
        this.layerObjects!.finishFont(number(0))
        break
      case 'Layer.get': {
        if (text(1) === 'cursorX' || text(1) === 'cursorY') {
          const position = this.cursorPosition(number(0))
          value = BigInt(text(1) === 'cursorX' ? position.x : position.y)
          break
        }
        const field = this.layers.property(number(0), text(1))
        value = typeof field === 'string' ? field : BigInt(Number(field))
        break
      }
      case 'Layer.set':
        if (text(1) === 'cursor') {
          const id = number(0), layer = this.layers.get(id), record = this.layerObjects!.get(id),
            request = (this.cursorLoads.get(layer) ?? 0) + 1
          if (!Number.isSafeInteger(request)) throw new Error('Layer cursor request identity exhausted')
          this.cursorLoads.set(layer, request)
          const valid = () => !record.finished && !record.closing && this.layers.has(id) &&
            this.layers.get(id) === layer && this.cursorLoads.get(layer) === request,
            cursor = typeof args[2] === 'string'
              ? await cancelable(this.cursors.load(args[2], valid), this.control)
              : clipInteger(2)
          this.control.check()
          if (!valid()) throw new Error('Cursor load destination changed')
          const controller = this.inputControllers.forLayer(id)
          return this.inputs!.start(controller.setCursor(id, cursor), controller)
        }
        if (text(1) === 'hint') {
          const id = number(0), controller = this.inputControllers.forLayer(id)
          return this.inputs!.start(controller.setHint(id, text(2)), controller)
        }
        if (text(1) === 'showParentHint') {
          // Native SetShowParentHint only stores the flag. It does not notify
          // the Window or cause an input recheck, even for the hovered Layer.
          this.layers.set(number(0), 'showParentHint', number(2))
          break
        }
        if (text(1) === 'cursorX' || text(1) === 'cursorY') {
          const id = number(0), coordinate = clipInteger(2), layer = this.layers.get(id)
          if (text(1) === 'cursorX') layer.cursorXWork = coordinate
          else this.setCursorPosition(id, layer.cursorXWork, coordinate)
          break
        }
        if (text(1) === 'neutralColor') {
          // The native setter accepts an int64, then stores its low uint32.
          // Mask before converting to Number so large TJS integers stay exact.
          const color = args[2]
          this.layers.set(
            number(0),
            'neutralColor',
            typeof color === 'bigint' ? Number(BigInt.asUintN(32, color)) : number(2),
          )
          break
        }
        if (['width', 'height', 'imageWidth', 'imageHeight'].includes(text(1))) {
          const id = number(0), controller = this.inputControllers.forLayer(id),
            before = this.layers.property(id, text(1)), previousWindow = this.layerWindow(id),
            layer = this.layers.get(id), oldWidth = layer.width, oldHeight = layer.height,
            oldImageLeft = layer.imageLeft, oldImageTop = layer.imageTop
          // These setters normally return through the Input pump, bypassing
          // the host switch tail. Commit primary sizing/scroll before that
          // pump rechecks hover or the calling TJS reads its cursor position.
          try { this.layers.set(id, text(1), number(2)) }
          finally {
            // An empty image request may already have shrunk the display
            // rectangle before throwing, while the image property is unchanged.
            if (before !== this.layers.property(id, text(1)) || layer.width !== oldWidth ||
                layer.height !== oldHeight || layer.imageLeft !== oldImageLeft || layer.imageTop !== oldImageTop) {
              if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
              this.invalidateLayer(id)
            }
          }
          await this.synchronizeWindowGeometry()
          return this.inputs!.change(() => {}, controller)
        }
        return this.inputs!.change(
          () => {
            const visual = ['left', 'top', 'imageLeft', 'imageTop', 'visible', 'opacity', 'type',
              'hasImage', 'order', 'absolute', 'absoluteOrderMode', 'cached'].includes(text(1)),
              previousWindow = visual ? this.layerWindow(number(0)) : undefined,
              before = visual ? this.layers.property(number(0), text(1)) : undefined
            this.layers.set(
              number(0),
              text(1),
              typeof args[2] === 'string'
                ? text(2)
                : text(1).startsWith('clip') ||
                    text(1) === 'attentionLeft' ||
                    text(1) === 'attentionTop'
                  ? clipInteger(2)
                  : number(2),
            )
            if (['attentionLeft', 'attentionTop', 'useAttention'].includes(text(1)))
              this.inputControllers.forLayer(number(0)).attentionChanged(number(0))
            if (text(1) === 'imeMode') this.refreshKeyboardRoutes()
            if (text(1) === 'callOnPaint' && !this.preparingFrame) {
              this.paintedLayers.delete(number(0))
              this.deferredPaint.delete(number(0))
            }
            this.dirty = true
            if (visual && before !== this.layers.property(number(0), text(1))) {
              if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
              this.invalidateLayer(number(0))
            }
          },
          this.inputControllers.forLayer(number(0)),
        )
      case 'Layer.setCursorPos':
        this.setCursorPosition(number(0), clipInteger(1), clipInteger(2))
        break
      case 'Layer.setAttentionPos': {
        const id = number(0),
          left = clipInteger(1),
          top = clipInteger(2)
        this.layers.setAttentionPos(id, left, top)
        this.inputControllers.forLayer(id).attentionChanged(id)
        this.dirty = true
        break
      }
      case 'Layer.position':
      case 'Layer.bounds': {
        const id = number(0), previousWindow = this.layerWindow(id),
          changed = operation === 'Layer.bounds'
            ? this.layers.bounds(id, clipInteger(1), clipInteger(2), clipInteger(3), clipInteger(4))
            : this.layers.position(id, clipInteger(1), clipInteger(2))
        if (changed) {
          if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
          this.invalidateLayer(id)
        }
        // SetPosition/SetBounds notify visual geometry, not ForceMouseRecheck.
        // A later real pointer/recheck observes the complete rectangle; there
        // is no callback between the two coordinates or before final sizing.
        break
      }
      case 'Layer.resize': {
        const id = number(0), layer = this.layers.get(id), width = number(1), height = number(2),
          changed = layer.width !== width || layer.height !== height, previousWindow = this.layerWindow(id)
        this.layers.resize(id, width, height)
        if (changed) {
          if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
          this.invalidateLayer(id)
        }
        break
      }
      case 'Layer.fill':
        if (
          this.layers.fill(
            number(0),
            { x: clipInteger(1), y: clipInteger(2), width: clipInteger(3), height: clipInteger(4) },
            clipInteger(5),
          )
        )
          this.invalidateLayer(number(0))
        break
      case 'Layer.image': {
        const id = number(0),
          record = this.layerObjects!.get(id),
          ticket = this.layers.beginImageLoad(id)
        try {
          const { image, province } = await cancelable(
            this.images.load(text(1), clipInteger(2) >>> 0),
            this.control,
          )
          this.control.check()
          if (record.finished) throw new Error('Layer has been invalidated')
          const previousWindow = this.layerWindow(id)
          if (!this.layers.finishImageLoad(ticket, image, province))
            throw new Error('Image load destination changed')
          value = image.metadata ? scriptRecord(Object.fromEntries(image.metadata)) : null
          if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
          this.invalidateLayer(number(0))
        } catch (error) {
          if (error instanceof ProvinceImageLoadError) {
            this.control.check()
            // Native keeps the completed main image when its companion fails.
            // A changed destination or stopped session must not receive it.
            if (!record.finished) {
              const { width, height } = ticket.layer, previousWindow = this.layerWindow(id)
              // The failure skips LoadImages' final Update. Only a change to
              // the Layer's display dimensions requests one during that load.
              if (
                this.layers.finishImageLoad(ticket, error.image) &&
                (ticket.layer.width !== width || ticket.layer.height !== height)
              ) {
                if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
                this.invalidateLayer(number(0))
              }
            }
            throw error.cause
          }
          throw error
        }
        break
      }
      case 'Layer.provinceImage': {
        const id = number(0),
          record = this.layerObjects!.get(id),
          ticket = this.layers.beginProvinceImage(id)
        try {
          const province = await cancelable(
            this.images.province(text(1), ticket.width, ticket.height),
            this.control,
          )
          this.control.check()
          // Font finalizers may load while the Layer is closing: native images
          // remain usable until releaseImage. That release revokes the ticket.
          if (record.finished) throw new Error('Layer has been invalidated')
          if (!this.layers.finishProvinceImage(ticket, province))
            throw new Error('Province image load destination changed')
        } catch (error) {
          this.layers.failProvinceImage(ticket)
          throw error
        }
        break
      }
      case 'Layer.text': {
        const id = number(0),
          opacity = this.layers.textOpacity(id, clipInteger(6))
        if (!opacity) break
        if (!isScriptObject(args[5])) throw new Error('Expected font data')
        const data = context.snapshot(args[5])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const font = fontSpec(data),
          draws = await this.fonts.draw(
            text(3),
            font,
            this.systemColors.toActualColor(clipInteger(4)),
            {
              antialiased: !!number(7),
              shadowLevel: clipInteger(8),
              shadowColor: clipInteger(9) >>> 0,
              shadowWidth: clipInteger(10),
              shadowX: clipInteger(11),
              shadowY: clipInteger(12),
            },
          )
        const session = this,
          left = clipInteger(1),
          top = clipInteger(2)
        await this.finishGraphics(
          (function* () {
            for (const { pixels, x, y } of draws) {
              if (
                session.layers.composite(
                  id,
                  pixels,
                  left + x + (pixels.left ?? 0),
                  top + y + (pixels.top ?? 0),
                  opacity,
                )
              )
                session.invalidateLayer(id)
              yield
            }
          })(),
        )
        break
      }
      case 'Layer.gamma': {
        const id = number(0)
        this.layers.bitmap(id).adjustGamma(
          [0, 1, 2].map((channel) => ({
            gamma: number(1 + channel * 3),
            floor: number(2 + channel * 3),
            ceil: number(3 + channel * 3),
          })),
          this.layers.face(id) === 4,
        )
        this.layers.get(id).imageModified = true
        this.invalidateLayer(number(0))
        break
      }
      case 'Font.attention': {
        const layer = this.layerObjects!.fontLayer(args[0])
        if (!isScriptObject(args[1])) throw new Error('Expected font data')
        const data = context.snapshot(args[1])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const entry = data.entries,
          height = Number(entry.height)
        this.layers.get(layer.id).attentionFont = {
          face: typeof entry.face === 'string' ? entry.face : 'sans-serif',
          height: Number.isFinite(height) ? height : 0,
          bold: !!entry.bold,
          italic: !!entry.italic,
          underline: !!entry.underline,
          strikeout: !!entry.strikeout,
        }
        break
      }
      case 'Font.measure': {
        this.layerObjects!.fontState(args[2], true)
        if (!isScriptObject(args[1])) throw new Error('Expected font data')
        const data = context.snapshot(args[1])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const metrics = await this.fonts.measure(text(0), fontSpec(data))
        value = scriptRecord({
          width: BigInt(Math.round(metrics.width)),
          height: BigInt(Math.round(metrics.height)),
        })
        break
      }
      case 'Font.bounds': {
        if (!isScriptObject(args[1])) throw new Error('Expected font data')
        const data = context.snapshot(args[1])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const bounds = await this.fonts.bounds(text(0), fontSpec(data))
        value = scriptRecord(
          Object.fromEntries(Object.entries(bounds).map(([key, number]) => [key, BigInt(number)])),
        )
        break
      }
      case 'Font.map':
      case 'Font.unmap': {
        if (!isScriptObject(args[0])) throw new Error('Expected font data')
        const data = context.snapshot(args[0])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const spec = fontSpec(data)
        if (operation === 'Font.map') await this.fonts.map(spec, text(1))
        else this.fonts.unmap(spec)
        break
      }
      case 'Font.list': {
        if (!isScriptObject(args[1])) throw new Error('Expected font data')
        const data = context.snapshot(args[1])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const spec = fontSpec(data)
        await this.fontCatalog.prepare(spec)
        await this.control.wait()
        this.control.check()
        value = scriptList((await this.fontCatalog.list(number(0), spec)).map((font) => font.name))
        break
      }
      case 'Font.select': {
        if (!isScriptObject(args[4])) throw new Error('Expected font data')
        const data = context.snapshot(args[4])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        if (this.activity.state !== 'visible') {
          value = null
          break
        }
        const spec = fontSpec(data)
        await this.fontCatalog.prepare(spec)
        await this.control.wait()
        this.control.check()
        this.inputControllers.resetTransient()
        value = await this.fontSelection.open(number(0), text(1), text(2), text(3), spec)
        break
      }
      case 'Layer.resizeImage': {
        const id = number(0), bitmap = this.layers.bitmap(id), width = number(1), height = number(2),
          changed = bitmap.width !== width || bitmap.height !== height, previousWindow = this.layerWindow(id),
          layer = this.layers.get(id), oldWidth = layer.width, oldHeight = layer.height,
          oldImageLeft = layer.imageLeft, oldImageTop = layer.imageTop
        let completed = false
        try {
          this.layers.resizeImage(id, width, height)
          completed = true
        } finally {
          if ((completed && changed) || layer.width !== oldWidth || layer.height !== oldHeight ||
              layer.imageLeft !== oldImageLeft || layer.imageTop !== oldImageTop) {
            if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
            this.invalidateLayer(id)
          }
        }
        break
      }
      case 'Layer.color':
        if (
          this.layers.color(
            number(0),
            { x: clipInteger(1), y: clipInteger(2), width: clipInteger(3), height: clipInteger(4) },
            clipInteger(5),
            clipInteger(6),
          )
        )
          this.invalidateLayer(number(0))
        break
      case 'Layer.imagePos':
        this.layers.imagePosition(number(0), number(1), number(2))
        this.invalidateLayer(number(0))
        break
      case 'Layer.clip': {
        const bitmap = this.layers.bitmap(number(0))
        if (args.length === 1) bitmap.resetClip()
        else
          bitmap.setClip({
            x: clipInteger(1),
            y: clipInteger(2),
            width: clipInteger(3),
            height: clipInteger(4),
          })
        break
      }
      case 'Layer.assignImages': {
        const id = number(0), previousWindow = this.layerWindow(id)
        if (this.layers.assignImages(id, number(1))) {
          if (previousWindow !== undefined) this.invalidateWindow(previousWindow)
          this.invalidateLayer(id)
        }
        break
      }
      case 'Layer.independImage': {
        const plane = text(1)
        if (plane !== 'main' && plane !== 'province') throw new Error('Invalid image plane')
        // Both buffers are already exclusively owned. Still validate the live
        // Layer and accept the TJS-converted copy argument without allocating.
        number(2)
        this.layers.independImage(number(0), plane)
        break
      }
      case 'Layer.copy':
        if (
          this.layers.copy(number(0), clipInteger(1), clipInteger(2), number(3), {
            x: clipInteger(4),
            y: clipInteger(5),
            width: clipInteger(6),
            height: clipInteger(7),
          })
        )
          this.invalidateLayer(number(0))
        break
      case 'Layer.piledCopy': {
        const id = number(0),
          source = number(3),
          left = number(1),
          top = number(2),
          rect = { x: number(4), y: number(5), width: number(6), height: number(7) }
        // Native PiledCopy rejects either missing main image before Complete
        // can run onPaint. A callback cannot repair an invalid copy request.
        const destination = this.layers.bitmap(id)
        this.layers.sourceBitmap(source)
        // ClipDestPointAndSrcRect precedes native Complete. An empty target
        // leaves its source's pending paint untouched; the source drawing clip
        // does not participate in this preflight.
        const target = intersect(destination.clip, {
          x: left,
          y: top,
          width: rect.width,
          height: rect.height,
        })
        if (!target.width || !target.height) break
        const clippedSource = {
          x: rect.x + target.x - left,
          y: rect.y + target.y - top,
          width: target.width,
          height: target.height,
        }
        const session = this
        return this.inputs!.start(
          (function* () {
            yield* session.prepareFrame(source)
            // onPaint can change the destination's clip or replace its image.
            // Keep the original clipped request, but use the current image and
            // its bounds, as native MainImage->CopyRect does after Complete.
            if (
              session.layers
                .bitmap(id)
                .copyPixels(
                  session.composer.snapshot(source),
                  target.x,
                  target.y,
                  clippedSource,
                  false,
                  target,
                )
            )
              session.layers.get(id).imageModified = true
            session.invalidateLayer(id)
            return undefined
          })(),
        )
      }
      case 'Layer.operate': {
        const id = number(0),
          source = number(3),
          face = this.layers.face(id)
        if (number(10) && face !== 0 && face !== 1)
          throw new Error('pileRect and blendRect require dfAlpha or dfOpaque')
        const mode = number(8) === 128 ? this.layers.get(source).type : number(8)
        if (
          this.layers
            .bitmap(id)
            .operate(
              this.layers.sourceBitmap(source).pixels,
              number(1),
              number(2),
              { x: number(4), y: number(5), width: number(6), height: number(7) },
              mode,
              face,
              number(9),
              this.layers.get(id).holdAlpha,
            )
        ) {
          this.layers.get(id).imageModified = true
          this.invalidateLayer(number(0))
        }
        break
      }
      case 'Layer.stretch':
      case 'Layer.stretchOperate': {
        const id = number(0),
          face = this.layers.face(id),
          bitmap = this.layers.bitmap(id),
          operate = operation === 'Layer.stretchOperate',
          mode = operate ? (number(12) === 128 ? this.layers.get(number(5)).type : number(12)) : 1
        if (!operate && ![0, 1, 4].includes(face))
          throw new Error('Stretch copy requires dfAlpha, dfOpaque or dfAddAlpha')
        if (operate) {
          validateBlend(mode, face)
          if (number(14) && face !== 0 && face !== 1)
            throw new Error('stretchPile and stretchBlend require dfAlpha or dfOpaque')
        }
        const output = stretchPixels(
          this.layers.sourceBitmap(number(5)).pixels,
          { x: number(1), y: number(2), width: number(3), height: number(4) },
          { x: number(6), y: number(7), width: number(8), height: number(9) },
          bitmap.clip,
          number(10),
          number(11),
        )
        if (!output.pixels.width || !output.pixels.height) break
        if (operate) {
          if (
            !bitmap.operate(
              output.pixels,
              output.left,
              output.top,
              { x: 0, y: 0, width: output.pixels.width, height: output.pixels.height },
              mode,
              face,
              number(13),
              this.layers.get(id).holdAlpha,
            )
          )
            break
        } else
          bitmap.copyPixels(
            output.pixels,
            output.left,
            output.top,
            { x: 0, y: 0, width: output.pixels.width, height: output.pixels.height },
            face === 1 && this.layers.get(id).holdAlpha,
          )
        this.layers.get(id).imageModified = true
        this.invalidateLayer(number(0))
        break
      }
      case 'Layer.affineCopy':
      case 'Layer.affine': {
        const id = number(0),
          source = number(1),
          copy = operation === 'Layer.affineCopy',
          layer = this.layers.get(id),
          bitmap = this.layers.bitmap(id),
          face = this.layers.face(id),
          mode = copy ? 'copy' : number(14) === 128 ? this.layers.get(source).type : number(14)
        validateBlend(mode === 'copy' ? 1 : mode, face)
        if (number(17) && face !== 0 && face !== 1)
          throw new Error('affinePile and affineBlend require dfAlpha or dfOpaque')
        const raster = await this.finishGraphics(
          affinePixels(
            this.layers.sourceBitmap(source).pixels,
            { x: number(2), y: number(3), width: number(4), height: number(5) },
            !!number(6),
            [number(7), number(8), number(9), number(10), number(11), number(12)],
            bitmap.clip,
            number(13),
          ),
        )
        this.control.check()
        if (
          bitmap.affine(
            raster,
            mode,
            face,
            number(15),
            layer.holdAlpha,
            copy && number(16) ? layer.neutralColor : undefined,
          )
        ) {
          layer.imageModified = true
          this.invalidateLayer(number(0))
        }
        break
      }
      case 'Layer.saveImage': {
        const path = storageWritePath(text(1), this.project?.directory)
        this.storage.assertWritable(path)
        const id = number(0),
          layer = this.layers.get(id),
          bytes = await this.imageWriter.encode(
            this.layers.bitmap(id).pixels,
            text(2),
            layerImageMetadata(layer.type, layer.imageLeft, layer.imageTop),
          )
        this.control.check()
        this.saves.write(path, bytes)
        break
      }
      case 'Layer.flip':
        this.layers.flip(number(0), !!number(1))
        this.invalidateLayer(number(0))
        break
      case 'Layer.convertType': {
        const id = number(0),
          from = number(1),
          face = this.layers.face(id),
          layer = this.layers.get(id)
        if (!((from === 0 && face === 4) || (from === 4 && face === 0)))
          throw new Error('convertType requires dfAlpha to dfAddAlpha, or dfAddAlpha to dfAlpha')
        layer.bitmap?.convert(face === 4)
        layer.imageModified = true
        this.invalidateLayer(number(0))
        break
      }
      case 'Layer.grayscale':
        this.layers.bitmap(number(0)).grayscale()
        this.layers.get(number(0)).imageModified = true
        this.invalidateLayer(number(0))
        break
      case 'Layer.boxBlur': {
        const id = number(0),
          bitmap = this.layers.bitmap(id),
          clip = { ...bitmap.clip }
        const result = await this.finishGraphics(
          boxBlur(bitmap.pixels, clip, number(1), number(2), this.layers.face(id) === 0),
        )
        this.control.check()
        if (result) {
          bitmap.copyPixels(result, clip.x, clip.y, {
            x: 0,
            y: 0,
            width: result.width,
            height: result.height,
          })
          this.layers.get(id).imageModified = true
          this.invalidateLayer(number(0))
        }
        break
      }
      case 'Layer.children':
        value = this.layerObjects!.children(number(0))
        break
      case 'Layer.parent': {
        const id = number(0),
          parent = this.layerObjects!.parent(id, args[1])
        return this.inputs!.detach(id, () => {
          const oldWindow = this.layerWindow(id)
          this.layers.reparent(id, parent)
          if (oldWindow !== undefined) this.invalidateWindow(oldWindow)
          this.invalidateLayer(number(0))
        })
      }
      case 'Layer.parentCheck':
        this.layers.validateParent(number(0), number(1))
        break
      case 'Layer.move':
        this.layers.move(number(0), number(1), !!number(2))
        this.invalidateLayer(number(0))
        break
      case 'Layer.pixelGet':
      case 'Layer.pixelSet': {
        const plane = text(3)
        if (plane !== 'main' && plane !== 'mask' && plane !== 'province')
          throw new Error('Invalid pixel plane')
        if (operation === 'Layer.pixelGet')
          value = BigInt(this.layers.getPixel(number(0), clipInteger(1), clipInteger(2), plane))
        else {
          if (
            this.layers.setPixel(number(0), clipInteger(1), clipInteger(2), clipInteger(4), plane)
          )
            this.invalidateLayer(number(0))
        }
        break
      }
      case 'Layer.update': {
        const id = number(0),
          region =
            args.length > 1
              ? { x: number(1), y: number(2), width: number(3), height: number(4) }
              : undefined
        // A later explicit update + piledCopy is another synchronous completion.
        // Only requests made by an in-progress completion defer its own repaint.
        if (!this.preparingFrame) {
          this.paintedLayers.delete(id)
          this.deferredPaint.delete(id)
        }
        if (this.layers.update(id, region) && this.inputControllers.forLayer(id).attached(id)) {
          if (this.windowUpdates.delivering && this.preparingFrame && this.paintedLayers.has(id) && !this.deferredPaint.has(id))
            this.deferredPaint.set(id, { generation: ++this.redrawGeneration })
          this.redrawRequests.add(id)
          this.invalidateLayer(number(0))
        }
        break
      }
      case 'Plugins.link':
        throw new Error(`Plugin is not implemented: ${text(0)}`)
      default:
        throw new Error(`Unsupported host API: ${operation}`)
    }
    if (['Layer.create', 'Layer.finish', 'Layer.abort', 'Layer.set', 'Layer.resize', 'Layer.bounds', 'Layer.image',
      'Layer.resizeImage', 'Layer.assignImages', 'Menu.create', 'Menu.finish', 'Menu.abort',
      'Menu.set', 'Menu.insert', 'Menu.remove'].includes(operation))
      await this.synchronizeWindowGeometry()
    return { kind: 'value', value }
  }
}
