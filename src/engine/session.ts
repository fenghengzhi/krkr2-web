import { bootstrap } from './tvp/bootstrap.ts'
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
import { StorageResolver, normalizePath } from './storage/resolver.ts'
import { ImageLoader } from './storage/images.ts'
import { ImageWriter, layerImageMetadata } from './storage/image-writer.ts'
import { LayerTree } from './scene/layers.ts'
import { LayerService } from './scene/layer-objects.ts'
import { captureVideoMixingBitmap } from './media/video-mixing.ts'
import type { DecodedImage, GraphicsDecoder, Renderer, RendererStatus } from './ports/graphics.ts'
import type { Inflater, Resource } from './ports/storage.ts'
import { MemorySaveStore, type SaveStore, type SaveFile } from './ports/saves.ts'
import { SaveOverlay } from './storage/save-overlay.ts'
import { modeOffset } from '../formats/text/stream.ts'
import { ScriptEvents } from './scheduler/events.ts'
import { SystemEvents, type EventOptions, type EventOutcome } from './scheduler/system-events.ts'
import { systemEventsBridge } from './tvp/system.ts'
import { checkpointBridge } from './tvp/checkpoints.ts'
import { ModalLoop } from './scheduler/modal-loop.ts'
import { WindowModals } from './scene/window-modal.ts'
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
import { FontService } from './graphics/fonts.ts'
import { FontCatalog } from './graphics/font-catalog.ts'
import { FontSelection } from './graphics/font-selection.ts'
import { cancelable } from './scheduler/cancelable.ts'
import { Bitmap, intersect } from './graphics/bitmap.ts'
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
import { inputBridge } from './tvp/input.ts'
import type { InputPacket, InputView } from './ports/input.ts'
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
}
export type EngineEvent =
  | { type: 'state'; snapshot: SessionSnapshot }
  | { type: 'menus'; menus: MenuSnapshot }
  | { type: 'window-menus'; windows: WindowMenus[] }
  | { type: 'window'; window: WindowView }
  | { type: 'windows'; windows: WindowPresentation[] }
  | { type: 'window-closed'; windowId: number }
  | { type: 'window-activate'; windowId: number }
  | { type: 'window-input'; windowId: number; input: InputView }
  | { type: 'input'; input: InputView }
  | { type: 'font-selection'; request: FontSelectionRequest | null }
  | ({ type: 'system-dialog' } & SystemDialogSnapshot)
  | { type: 'log'; level: 'info' | 'error'; text: string }
export interface SessionDependencies {
  systemFonts?: FontDescriptor[]
  activity?: ActivityState
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
  arguments?: ReadonlyMap<string, string>
  now: () => number
  wallNow?: () => number
  yieldToHost: () => Promise<void>
  schedule: (callback: () => void, delay: number) => () => void
  event: (event: EngineEvent) => void
}

export class EngineSession {
  private readonly textEncoding = new ScriptTextEncoding()
  private readonly fontCatalog: FontCatalog
  private readonly fontSelection: FontSelection
  private fontPreviewBusy = false
  readonly control = new ExecutionControl()
  private readonly queue = new SerialQueue()
  private readonly storage = new StorageResolver()
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
  private readonly layers = new LayerTree()
  private readonly inputControllers = new InputControllers(this.layers, () => this.windowId)
  private get inputController() {
    return this.inputControllers.active
  }
  private inputs?: InputService
  private inputView = ''
  private readonly windowInputViews = new Map<number, string>()
  private windowsView = ''
  private transitions?: SceneTransitions
  private readonly composer = new SceneComposer(this.layers, (id) => this.transitions?.frame(id))
  private preparingFrame = false
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
  private menuModals?: MenuModals
  private systemDialogs?: SystemDialogs
  private windowInputGeneration = 0
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
  private physicalKeys = new Set<number>()
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
  private exitAfterOperation = false
  private readonly cancellationErrors: unknown[] = []
  private readonly cancellationWork = new Set<Promise<void>>()
  constructor(private readonly deps: SessionDependencies) {
    this.fonts = new FontService(
      (name) => this.resolveResource(name),
      deps.graphics,
      (work) => this.finishGraphics(work),
    )
    this.fontCatalog = new FontCatalog({
      files: () => this.storage.list().map((file) => this.resolveResource(file.name)),
      resolve: (name) => this.resolveResource(name),
      bind: (fonts) => this.fonts.registerNamed(fonts),
      check: () => this.control.check(),
      yield: () => this.yieldGraphics(),
      wait: (work) => cancelable(work, this.control),
      warn: (text) => this.log(text),
    })
    this.fontCatalog.setSystem(deps.systemFonts ?? [])
    this.fontSelection = new FontSelection(this.fontCatalog, (request) =>
      this.deps.event({ type: 'font-selection', request }),
    )
    this.systemArguments = new Map(deps.arguments)
    if (deps.activity) {
      validateActivity(deps.activity)
      this.activity = { ...deps.activity }
    }
    this.pauseMediaRequestTimeouts()
    this.saves = new SaveOverlay(deps.saveStore ?? new MemorySaveStore(), (path) =>
      this.images.invalidate(path),
    )
    this.diagnostics = new DebugLog(this.saves, deps.wallNow ?? Date.now, (entry) =>
      deps.event({ type: 'log', level: entry.level, text: entry.text }),
    )
    this.appLocks = deps.appLocks ?? new MemoryAppLocks()
    this.kag = new KagService(
      async (name) =>
        this.deps.readText(await this.readResource(name), '', this.textEncoding.codec),
      (text) => this.log(text),
    )
    this.control.onCancel(() => {
      // Revoke tickets and wake modal waits before any device/user cleanup
      // can throw. Preserve those failures for the terminal stop result.
      this.cancelEventReceipts(new ExecutionCancelled())
      for (const cleanup of [
        () => this.modalLoop?.dispose(),
        () => this.menus.dismiss(undefined, undefined, 'unavailable'),
        () => this.fontSelection.cancel(),
        () => this.fontCatalog.clear(),
        () => this.cancelRedraw?.(),
        () => this.detachRenderer?.(),
        () => this.transitions?.dispose(),
        () => this.composer.clear(),
        () => this.images.dispose(),
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
      for (const cancel of [() => this.sounds?.pause(true), () => this.videos?.cancel()]) {
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
      this.diagnostics.setLocation(this.diagnostics.location, this.systemArguments)
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
        },
        changed: (phase) => {
          // Opening the native dialog captures the old DOM focus before the
          // Window roster applies inert. Unwinding restores eligibility first.
          if (phase === 'open') this.systemDialogs?.present()
          this.present()
          if (phase === 'release') this.systemDialogs?.present()
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
        () => this.requestFrameCheckpoint(),
        () => {
          this.dirty = true
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
          this.layers.image(id, pixels)
          this.layers.resize(id, pixels.width, pixels.height)
          this.videoFrameChanges.set(this.layers.get(id).windowId, ++this.videoFrameChange)
          this.dirty = true
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
          this.windowModals?.invalidate(window.id)
          this.systemEvents?.cancelSource(window)
          this.videos?.disconnectWindow(window.id)
          this.menuItems?.disconnectWindow(window)
          this.inputControllers.remove(window.id)
          this.windowPointers.delete(window.id)
          this.windowInputViews.delete(window.id)
          this.windowPresentationsCompleted.delete(window.id)
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
          for (const existing of this.windows!.registered()) {
            this.systemEvents!.cancelSource(existing)
            if (existing !== window) this.menus.dismiss(existing.id, undefined, 'unavailable')
          }
          this.inputControllers.releaseCaptures()
          window.state.set('visible', 1)
          this.dirty = true
          // Publish blocking before the browser receives a new focus command.
          this.present()
          this.observeAdmission(this.acceptActivateWindow(window.id))
        },
        leave: (window, previousId) => {
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
      this.menuItems = new MenuService(this.runtime, this.menus, this.windows, (item) => {
        this.systemEvents?.cancelSource(item)
      })
      this.menuModals = new MenuModals(this.menus, this.modalLoop, (view) =>
        this.queueMenuNotification(view),
      )
      this.systemDialogs = new SystemDialogs(this.modalLoop, {
        changed: (snapshot) => this.deps.event({ type: 'system-dialog', ...snapshot }),
        enter: () => {
          this.windowInputGeneration++
          for (const window of this.windows!.registered()) this.systemEvents!.cancelSource(window)
          this.inputControllers.releaseCaptures()
          this.physicalKeys.clear()
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
          this.dirty = true
        },
        (layer) => {
          this.redrawRequests.delete(layer.id)
          this.deferredPaint.delete(layer.id)
          this.systemEvents?.cancelSource(layer)
          this.transitions?.drop(layer.id)
          this.dirty = true
        },
      )
      this.discard(await this.runtime.execute(tvpConstants, 'krkr2-web/constants.tjs'))
      this.discard(await this.runtime.execute(debugBridge, 'krkr2-web/debug.tjs'))
      this.discard(await this.runtime.execute(bootstrap, 'krkr2-web/bootstrap.tjs'))
      this.discard(await this.runtime.execute(systemEventsBridge, 'krkr2-web/system-events.tjs'))
      this.discard(await this.runtime.execute(eventClasses, 'krkr2-web/events.tjs'))
      this.discard(await this.runtime.execute(kagClass, 'krkr2-web/kag.tjs'))
      this.discard(await this.runtime.execute(menuClass, 'krkr2-web/menus.tjs'))
      this.discard(await this.runtime.execute(windowClass, 'krkr2-web/window.tjs'))
      this.discard(await this.runtime.execute(inputBridge, 'krkr2-web/input.tjs'))
      this.discard(await this.runtime.execute(checkpointBridge, 'krkr2-web/checkpoints.tjs'))
      this.discard(await this.runtime.execute(modalBridge, 'krkr2-web/modal.tjs'))
      this.discard(await this.runtime.execute(transitionBridge, 'krkr2-web/transitions.tjs'))
      this.discard(await this.runtime.execute(fontClass, 'krkr2-web/font.tjs'))
      this.discard(await this.runtime.execute(layerClass, 'krkr2-web/layer.tjs'))
      this.discard(await this.runtime.execute(rectClass, 'krkr2-web/rect.tjs'))
      this.discard(await this.runtime.execute(soundClasses, 'krkr2-web/sound.tjs'))
      this.discard(await this.runtime.execute(videoClass, 'krkr2-web/video.tjs'))
      this.setState('ready')
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
      const resource = this.resolveResource(entry)
      return this.runtime!.execute(
        await this.deps.decodeScript(await resource.read(), '', this.textEncoding.codec),
        resource.name,
      )
    }).then(() => undefined)
  }
  evaluate(source: string): Promise<string> {
    if (!['ready', 'running'].includes(this.state))
      return Promise.reject(new Error('Session cannot evaluate scripts in its current state'))
    return this.execute(() => this.runtime!.execute(source, 'console.tjs', true))
  }
  private execute(operation: () => Promise<ScriptValue>, priority: 0 | 1 | 2 = 1): Promise<string> {
    return this.queue.enqueue(async () => {
      await this.control.wait()
      this.control.check()
      this.executing = true
      this.paintedLayers.clear()
      let failed = false,
        recorded = false
      try {
        let value: ScriptValue = undefined,
          display = 'undefined'
        try {
          value = await operation()
          await this.outerNativeCheckpoint()
          await this.inputs?.synchronize()
          if (
            this.hasPendingRedraw() &&
            [...this.redrawRequests].some((id) => !this.deferredPaint.has(id))
          )
            this.dirty = true
          if (this.dirty && !this.systemEvents?.disabled) {
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
            await this.flushFiles()
          } catch (error) {
            if (!failed && !closingFailed) throw error
            this.reportFlushFailure(error)
          }
          if (closingFailed) {
            if (!failed) throw closingError
            this.log('Deferred cleanup failed: ' + String(closingError), 'error')
          }
        }
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
    const text = error instanceof Error ? error.message : String(error)
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
    const text = error instanceof Error ? error.message : String(error),
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
      text: `日志或存档写入失败：${String(error)}；已有数据仍可导出，停止时可重试提交。`,
    })
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
        if (this.modalLoop?.depth) {
          for (const [id, generation] of due) this.modalReadyRedraw.set(id, generation)
          this.frameRequested = true
          this.dirty = true
          this.modalWakeup?.()
          return
        }
        this.redrawQueued = true
        void this.execute(async () => {
          // Recheck when the VM actually takes this task: it can have waited
          // behind an asynchronous call, a newer paint of the same Layer, or a
          // page transition. A stale wake cannot unlock a replacement request.
          if (!this.systemEvents?.disabled && this.activity.state === 'visible')
            for (const [id, generation] of due)
              if (this.deferredPaint.get(id)?.generation === generation)
                this.deferredPaint.delete(id)
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
  private *prepareFrame(source?: number): InputOperation {
    if (this.preparingFrame) return
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
      if (paint && !painted.has(id) && !deferred.has(id)) {
        pending.delete(id)
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
      const roots =
        source === undefined
          ? this.inputControllers.values().map((controller) => controller.root())
          : [source]
      for (const root of roots) yield* visit(root, true)
      if (this.transitions?.active) yield* this.transitions.advance()
      for (const root of roots) yield* visit(root, false)
    } finally {
      this.preparingFrame = false
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
  setActivity(activity: ActivityState): void {
    validateActivity(activity)
    if (this.control.cancelled || activity.sequence <= this.activity.sequence) return
    const previous = this.activity
    this.activity = { ...activity }
    // Freeze transport deadlines before applyPause sends pauseAll requests.
    this.pauseMediaRequestTimeouts()
    if (activityPaused(activity) && !activityPaused(previous) && this.state === 'paused')
      this.events?.pause(true)
    if (previous.state === 'visible' && activity.state !== 'visible') {
      this.physicalKeys.clear()
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
    if (paused) {
      this.physicalKeys.clear()
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
  pointerState(x: number, y: number, windowId = this.windowId): void {
    if (
      [x, y].some((value) => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid physical cursor coordinates')
    if (this.activity.state !== 'visible' || this.state !== 'running') return
    const window = this.registeredWindow(windowId)
    if (!window || this.windowModals?.blocked(windowId)) return
    this.windowPointers.set(windowId, { x, y })
    if (window.state.mouseCursorState === 1) window.state.set('mouseCursorState', 0)
  }
  keyState(keys: number[]): void {
    if (keys.length > 256 || keys.some((key) => !Number.isInteger(key) || key < 0 || key > 65535))
      throw new Error('Invalid keyboard state')
    this.physicalKeys = new Set(this.activity.state === 'visible' ? keys : [])
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
  ): SessionAdmission {
    if (!delivery && this.eventReceipts.size >= 65536)
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
      if (this.eventReceipts.size > 65536) throw new Error('Event receipt budget exceeded')
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
    if (this.exitAfterOperation && !(this.modalLoop?.depth ?? 0)) return
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
      if (!this.dirty) return empty
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
      if (checkpoint.tail && this.exitAfterOperation && (this.modalLoop?.depth ?? 0) > 0) {
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
      !!this.systemEvents?.hasDispatchableWork() ||
      (!this.nativeReleasesPending() && (this.hasOutsideReceipts() || this.hasPendingFrameWork()))
    )
  }
  beginModalDispatch(): HostReply {
    if (!this.hasModalWork()) return { kind: 'value', value: undefined }
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
      (this.frameRequested || (this.dirty && this.frameWorkVersion !== this.attemptedFrameVersion))
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
      if (this.deferredPaint.get(id)?.generation === generation) this.deferredPaint.delete(id)
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
  acceptInput(packet: InputPacket, observe = true): SessionAdmission {
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
    packet = { ...packet, windowId }
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
    if (observe) {
      // A logical Window losing focus releases its local roles, not the
      // physical keys held elsewhere in the page. Restore the shared snapshot
      // before applying the next packet's key/shift changes.
      if (packet.type !== 'cancel' && packet.type !== 'deactivate')
        controller.keys = new Set(this.physicalKeys)
      controller.observe(packet)
      if (packet.type !== 'cancel' && packet.type !== 'deactivate') {
        this.physicalKeys = new Set(controller.keys)
        for (const other of this.inputControllers.values())
          if (other !== controller) other.keys = new Set(this.physicalKeys)
      }
      if (
        packet.type === 'down' ||
        packet.type === 'move' ||
        packet.type === 'up' ||
        packet.type === 'wheel'
      )
        this.pointerState(packet.x, packet.y, windowId)
    }
    if (this.state !== 'running') return ignoredAdmission()
    const epoch = controller.epoch,
      generation = this.windowInputGeneration
    return this.acceptEvent(() => this.inputs!.packet(packet), {
      valid: () =>
        this.registeredWindow(windowId) === window &&
        generation === this.windowInputGeneration &&
        (!this.windowModals?.blocked(windowId) ||
          packet.type === 'cancel' ||
          packet.type === 'deactivate') &&
        epoch === controller.epoch &&
        this.state === 'running' &&
        this.activity.state === 'visible',
      priority: 1,
      discardable: packet.type === 'move',
      source: window,
    })
  }
  private postInput(packet: InputPacket, window: WindowRecord): void {
    const controller = this.inputControllers.get(window.id)
    if (this.registeredWindow(window.id) !== window || !controller) return
    if (this.postedInputPending >= 256) throw new Error('Posted input queue budget exceeded')
    const epoch = controller.epoch,
      generation = this.windowInputGeneration
    packet = { ...packet, windowId: window.id }
    this.postedInputPending++
    // Queue a VM call, never reenter the active TJS host import. A destroyed
    // window cannot deliver its pending input to a newly created window.
    void this.systemEvents!.post(() => this.inputs!.packet(packet), {
      valid: () =>
        this.registeredWindow(window.id) === window &&
        generation === this.windowInputGeneration &&
        !this.windowModals?.blocked(window.id) &&
        epoch === controller.epoch &&
        this.activity.state === 'visible',
      priority: 1,
      source: window,
    })
      .catch((error) => {
        if (!this.control.cancelled) this.fail(error)
      })
      .finally(() => this.postedInputPending--)
  }
  exitFullScreen(windowId = this.windowId): void {
    if (this.windowModals?.blocked(windowId)) return
    this.registeredWindow(windowId)?.state.set('fullScreen', 0)
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
  resizeWindow(windowId: number, width: number, height: number): void {
    if (this.windowModals?.blocked(windowId)) return
    const window = this.registeredWindow(windowId)
    if (!window) return
    window.state.resize(width, height)
    this.queueResize(window)
    this.dirty = true
    this.present()
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
  present(): void {
    for (const window of this.windows?.registered() ?? []) {
      const input = this.inputControllers.get(window.id)?.view()
      if (!input) continue
      const serialized = JSON.stringify(input)
      if (this.windowInputViews.get(window.id) !== serialized) {
        this.windowInputViews.set(window.id, serialized)
        this.deps.event({ type: 'window-input', windowId: window.id, input })
      }
    }
    const windows = this.windowPresentations(),
      windowViews = JSON.stringify(windows)
    if (this.windowsView !== windowViews) {
      this.windowsView = windowViews
      this.deps.event({ type: 'windows', windows })
    }
    const input = this.inputController.view(),
      serialized = JSON.stringify(input)
    if (serialized !== this.inputView) {
      this.inputView = serialized
      this.deps.event({ type: 'input', input })
    }
    this.presentMenus()
    if (this.windowRevision !== this.window.revision) {
      this.windowRevision = this.window.revision
      this.deps.event({ type: 'window', window: this.window.view() })
    }
    if (
      !this.dirty ||
      this.preparingFrame ||
      this.state === 'stopped' ||
      this.state === 'stopping' ||
      (!this.deps.renderer.openWindow &&
        (this.graphicsStatus.state === 'lost' || this.graphicsStatus.state === 'failed')) ||
      (this.activity.state !== 'visible' && this.graphicsStatus.state !== 'restoring')
    )
      return
    const targets = this.windows?.registered() ?? []
    if (!targets.length && !this.deps.renderer.openWindow)
      this.deps.renderer.present([], this.width, this.height)
    let complete = true
    for (const target of targets) {
      const window = target.state
      const presented = this.deps.renderer.present(
        window.visible
          ? this.composer.frame(
              window.width,
              window.height,
              window.layerLeft,
              window.layerTop,
              window.zoomNumer / window.zoomDenom,
              target.id,
            )
          : [],
        window.width,
        window.height,
        target.id,
      )
      if (presented === false) complete = false
      else if (window.visible && this.registeredWindow(target.id) === target)
        this.windowPresentationsCompleted.set(
          target.id,
          (this.windowPresentationsCompleted.get(target.id) ?? 0) + 1,
        )
    }
    if (complete) this.dirty = false
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
  selectSystemDialog(id: number, value: string | null): boolean {
    if (
      this.control.cancelled ||
      this.state !== 'running' ||
      this.activity.state !== 'visible' ||
      this.fontSelection.active
    )
      return false
    return this.systemDialogs?.respond(id, value) ?? false
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
    fontSources: number
    closingLayers: number
    closingWindows: number
    dependents: number
    pendingInvalidations: number
    weakOwners: number
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
      fontSources: this.layerObjects?.fontCount ?? 0,
      closingLayers: this.layerObjects?.closing ?? 0,
      closingWindows: this.windows?.closing ?? 0,
      dependents: runtime?.dependents ?? 0,
      pendingInvalidations: runtime?.pendingInvalidations ?? 0,
      weakOwners: runtime?.weakOwners ?? 0,
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
    }
  }
  private notify(): void {
    this.snapshotRevision++
    this.deps.event({ type: 'state', snapshot: this.snapshot() })
  }
  private readonly debugPanels = new DebugPanels(() => this.notify())
  setDebugVisibility(panel: DebugPanel, visible: boolean): void {
    this.debugPanels.set(panel, visible)
  }
  private setState(state: SessionState): void {
    this.state = state
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
      await attempt(async () => {
        while (this.cancellationWork.size) await Promise.all([...this.cancellationWork])
        if (this.cancellationErrors.length) {
          const errors = this.cancellationErrors.splice(0)
          if (errors.length === 1) throw errors[0]
          throw new AggregateError(errors, 'Session cancellation cleanup failed')
        }
      })
      await attempt(() => this.modalLoop?.dispose())
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
      await attempt(() => this.layerObjects?.dispose())
      await attempt(() => this.kag.clear())
      await attempt(() => this.windows?.dispose())
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
  private async readResource(name: string): Promise<Uint8Array> {
    return this.resolveResource(name).read()
  }
  private resolveResource(name: string): Resource {
    const resource = this.findResource(name)
    if (!resource) throw new Error(`Resource not found: ${name}`)
    return resource
  }
  private findResource(name: string): Resource | undefined {
    this.materializeLogs()
    for (const candidate of this.storage.candidates(name)) {
      const saved = this.saves.resource(candidate)
      if (saved) return saved
      const original = this.storage.find(candidate)
      if (original) return original
    }
    return undefined
  }
  private resourceExists(name: string): boolean {
    return !!this.findResource(name)
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
  private async host(
    operation: string,
    args: ScriptValue[],
    context: HostContext,
  ): Promise<HostReply> {
    if (operation.startsWith('Checkpoint.')) return this.checkpointHost(operation, args, context)
    if (operation.startsWith('Modal.')) {
      if (!this.modalLoop) throw new Error('Modal dispatcher is unavailable')
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
    if (operation.startsWith('KAG.'))
      return { kind: 'value', value: await this.kag.host(operation, args, context) }
    if (operation === 'Input.get' && args[1] === 'keyState')
      return { kind: 'value', value: this.physicalKeys.has(Number(args[0])) ? 1n : 0n }
    if (operation.startsWith('Input.')) return this.inputs!.host(operation, args, context)
    if (operation.startsWith('Transition.')) return this.transitions!.host(operation, args)
    if (operation.startsWith('Sound.'))
      return { kind: 'value', value: await this.sounds!.host(operation, args, context) }
    if (operation.startsWith('Video.'))
      return { kind: 'value', value: await this.videos!.host(operation, args, context) }
    if (operation === 'System.getArgument') {
      if (typeof args[0] !== 'string') throw new Error('System.getArgument requires an option name')
      return { kind: 'value', value: this.systemArguments.get(args[0]) }
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
    // Clip and text entry points narrow TJS integers to native tjs_int.
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
      case 'System.exitOnWindowClose':
        if (args.length) this.exitOnWindowClose = !!number(0)
        value = this.exitOnWindowClose ? 1n : 0n
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
        value = await this.deps.readText(
          await this.readResource(text(0)),
          '',
          this.textEncoding.codec,
        )
        break
      case 'Scripts.execStorage': {
        const resource = this.resolveResource(text(0))
        return {
          kind: 'script',
          source: await this.deps.decodeScript(
            await resource.read(),
            typeof args[1] === 'string' ? args[1] : '',
            this.textEncoding.codec,
          ),
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
        value = await this.deps.readText(
          await this.readResource(text(0)),
          text(1),
          this.textEncoding.codec,
        )
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
      case 'Storage.validateWrite':
        if (text(0).includes('>')) throw new Error('Archive storage is read-only')
        normalizePath(text(0))
        modeOffset(text(1))
        break
      case 'Storage.writeText':
      case 'Storage.writeBinary': {
        this.materializeLogs()
        const path = text(0),
          mode = text(1)
        const encoded =
          operation === 'Storage.writeText' ? await this.deps.writeText(text(2), mode) : args[2]
        if (!(encoded instanceof Uint8Array)) throw new Error('Expected binary file contents')
        const offset = modeOffset(mode)
        let output = encoded
        if (offset > 0 || mode.includes('a')) {
          let original: Uint8Array = new Uint8Array()
          if (this.resourceExists(path)) original = await this.readResource(path)
          const position = mode.includes('a') ? original.length : offset
          output = new Uint8Array(Math.max(original.length, position + encoded.length))
          output.set(original)
          output.set(encoded, position)
        }
        this.saves.write(path, output)
        this.notify()
        break
      }
      case 'Storages.exists':
        value = BigInt(this.resourceExists(text(0)))
        break
      case 'Storages.getPlacedPath':
        value = this.resourceExists(text(0)) ? this.resolveResource(text(0)).name : ''
        break
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
        this.menus.set(
          this.menuItems!.get(args[0]).view,
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
        value = BigInt(window.id)
        break
      }
      case 'Window.showModal':
        if (!isScriptObject(args[1])) throw new Error('Modal Window request must be an object')
        return this.windowModals!.show(number(0), this.runtime!.objectIdentity(args[1]))
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
        const id = this.layers
          .ids()
          .find((id) => this.layers.get(id).primary && this.layers.get(id).windowId === window.id)
        value = id === undefined || window.finished ? null : (this.layerObjects!.owner(id) ?? null)
        break
      }
      case 'Window.resize': {
        const window = this.windows!.get(number(0))
        window.state.resize(number(1), number(2))
        this.queueResize(window)
        this.dirty = true
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
        const field = this.windows!.get(number(0)).state[text(1) as keyof WindowState]
        if (typeof field !== 'string' && typeof field !== 'boolean' && typeof field !== 'number')
          throw new Error('Unsupported window property')
        value = typeof field === 'string' ? field : BigInt(Number(field))
        break
      }
      case 'Window.set': {
        const window = this.windows!.get(number(0)),
          before = [window.state.width, window.state.height],
          property = text(1)
        window.state.set(text(1), typeof args[2] === 'string' ? text(2) : number(2))
        if (before[0] !== window.state.width || before[1] !== window.state.height)
          this.queueResize(window)
        if (property === 'fullScreen' && window.state.fullScreen)
          for (const other of this.windows!.registered())
            if (other !== window && other.state.fullScreen) other.state.set('fullScreen', 0)
        if (property === 'visible' || property === 'focusable') {
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
        break
      }
      case 'Window.zoom': {
        const window = this.windows!.get(number(0))
        window.state.set('zoomNumer', number(1))
        window.state.set('zoomDenom', number(2))
        this.dirty = true
        break
      }
      case 'Window.update':
        this.windows!.get(number(0))
        this.dirty = true
        break
      case 'Layer.create': {
        if (!isScriptObject(args[0]) || !isScriptObject(args[3]))
          throw new Error('Expected Layer instance and native state')
        value = BigInt(this.layerObjects!.create(args[0], args[1], args[2], args[3]))
        this.dirty = true
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
        const layer = this.layers.get(number(0))
        if (layer.bitmap) layer.clipBeforeRelease = { ...layer.bitmap.clip }
        layer.bitmap = undefined
        layer.revision++
        this.dirty = true
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
          const windowId = this.layers.get(number(0)).windowId,
            window = this.registeredWindow(windowId)?.state ?? this.window,
            pointer = this.windowPointers.get(windowId) ?? { x: 0, y: 0 },
            zoom = window.zoomNumer / window.zoomDenom,
            p = this.layers.localPoint(
              number(0),
              (pointer.x - window.layerLeft) / zoom,
              (pointer.y - window.layerTop) / zoom,
            )
          value = BigInt(Math.floor(text(1) === 'cursorX' ? p.x : p.y))
          break
        }
        const field = this.layers.property(number(0), text(1))
        value = typeof field === 'string' ? field : BigInt(Number(field))
        break
      }
      case 'Layer.set':
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
        return this.inputs!.change(
          () => {
            this.layers.set(
              number(0),
              text(1),
              typeof args[2] === 'string'
                ? text(2)
                : text(1).startsWith('clip')
                  ? clipInteger(2)
                  : number(2),
            )
            if (text(1) === 'callOnPaint' && !this.preparingFrame) {
              this.paintedLayers.delete(number(0))
              this.deferredPaint.delete(number(0))
            }
            this.dirty = true
          },
          this.inputControllers.forLayer(number(0)),
        )
      case 'Layer.resize':
        this.layers.resize(number(0), number(1), number(2))
        this.dirty = true
        break
      case 'Layer.fill':
        if (
          this.layers.fill(
            number(0),
            { x: number(1), y: number(2), width: number(3), height: number(4) },
            number(5),
          )
        )
          this.dirty = true
        break
      case 'Layer.image': {
        const id = number(0)
        this.layers.bitmap(id)
        const { image, province } = await this.images.load(text(1), number(2))
        this.control.check()
        this.layers.image(id, image, province)
        value = image.metadata ? scriptRecord(Object.fromEntries(image.metadata)) : null
        this.dirty = true
        break
      }
      case 'Layer.provinceImage': {
        const id = number(0),
          bitmap = this.layers.bitmap(id),
          province = await this.images.province(text(1), bitmap.width, bitmap.height)
        this.control.check()
        this.layers.provinceImage(id, province)
        this.dirty = true
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
          draws = await this.fonts.draw(text(3), font, clipInteger(4) >>> 0, {
            antialiased: !!number(7),
            shadowLevel: clipInteger(8),
            shadowColor: clipInteger(9) >>> 0,
            shadowWidth: clipInteger(10),
            shadowX: clipInteger(11),
            shadowY: clipInteger(12),
          })
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
                session.dirty = true
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
        this.dirty = true
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
        value = scriptList(this.fontCatalog.list(number(0), spec).map((font) => font.name))
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
        this.control.check()
        this.inputControllers.resetTransient()
        value = await this.fontSelection.open(number(0), text(1), text(2), text(3), spec)
        break
      }
      case 'Layer.resizeImage':
        this.layers.resizeImage(number(0), number(1), number(2))
        this.dirty = true
        break
      case 'Layer.color':
        this.layers.color(
          number(0),
          { x: number(1), y: number(2), width: number(3), height: number(4) },
          number(5),
          number(6),
        )
        this.dirty = true
        break
      case 'Layer.imagePos':
        this.layers.imagePosition(number(0), number(1), number(2))
        this.dirty = true
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
      case 'Layer.assignImages':
        if (this.layers.assignImages(number(0), number(1))) this.dirty = true
        break
      case 'Layer.copy':
        if (
          this.layers.copy(number(0), number(1), number(2), number(3), {
            x: number(4),
            y: number(5),
            width: number(6),
            height: number(7),
          })
        )
          this.dirty = true
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
        this.layers.bitmap(source)
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
            session.dirty = true
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
              this.layers.bitmap(source).pixels,
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
          this.dirty = true
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
          this.layers.bitmap(number(5)).pixels,
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
        this.dirty = true
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
            this.layers.bitmap(source).pixels,
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
          this.dirty = true
        }
        break
      }
      case 'Layer.saveImage': {
        const name = text(1)
        if (name.includes('>')) throw new Error('Archive storage is read-only')
        const path = normalizePath(name)
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
        this.layers.bitmap(number(0)).flip(!!number(1))
        this.layers.get(number(0)).imageModified = true
        this.dirty = true
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
        this.dirty = true
        break
      }
      case 'Layer.grayscale':
        this.layers.bitmap(number(0)).grayscale()
        this.layers.get(number(0)).imageModified = true
        this.dirty = true
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
          this.dirty = true
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
          this.layers.reparent(id, parent)
          this.dirty = true
        })
      }
      case 'Layer.parentCheck':
        this.layers.validateParent(number(0), number(1))
        break
      case 'Layer.move':
        this.layers.move(number(0), number(1), !!number(2))
        this.dirty = true
        break
      case 'Layer.pixelGet':
      case 'Layer.pixelSet': {
        const plane = text(3)
        if (plane !== 'main' && plane !== 'mask' && plane !== 'province')
          throw new Error('Invalid pixel plane')
        if (operation === 'Layer.pixelGet')
          value = BigInt(this.layers.bitmap(number(0)).getPixel(number(1), number(2), plane))
        else {
          if (this.layers.setPixel(number(0), number(1), number(2), number(4), plane))
            this.dirty = true
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
          if (this.preparingFrame && this.paintedLayers.has(id) && !this.deferredPaint.has(id))
            this.deferredPaint.set(id, { generation: ++this.redrawGeneration })
          this.redrawRequests.add(id)
          this.dirty = true
        }
        break
      }
      case 'Plugins.link':
        throw new Error(`Plugin is not implemented: ${text(0)}`)
      default:
        throw new Error(`Unsupported host API: ${operation}`)
    }
    return { kind: 'value', value }
  }
}
