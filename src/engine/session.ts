import { bootstrap } from './tvp/bootstrap.ts'
import { ScriptTextEncoding } from './script/text-encoding.ts'
import { debugBridge } from './tvp/debug.ts'
import { DebugLog } from './diagnostics/log.ts'
import { DebugPanels, type DebugPanel, type DebugVisibility } from './diagnostics/panels.ts'
import { DebugService } from './diagnostics/service.ts'
import { ExecutionControl, SerialQueue } from './scheduler/control.ts'
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
import type { DecodedImage, GraphicsDecoder, Renderer, RendererStatus } from './ports/graphics.ts'
import type { Inflater, Resource } from './ports/storage.ts'
import { MemorySaveStore, type SaveStore, type SaveFile } from './ports/saves.ts'
import { SaveOverlay } from './storage/save-overlay.ts'
import { modeOffset } from '../formats/text/stream.ts'
import { ScriptEvents } from './scheduler/events.ts'
import { SystemEvents } from './scheduler/system-events.ts'
import { systemEventsBridge } from './tvp/system.ts'
import { eventClasses } from './tvp/events.ts'
import { tvpConstants } from './tvp/constants.ts'
import { MemoryAppLocks, type AppLocks } from './ports/system.ts'
import { KagService } from './kag/service.ts'
import { kagClass } from './tvp/kag.ts'
import { menuClass } from './tvp/menus.ts'
import { MenuTree, type MenuSnapshot } from './scene/menus.ts'
import { MenuService } from './scene/menu-items.ts'
import { WindowState, type WindowView } from './scene/window.ts'
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
import { Bitmap } from './graphics/bitmap.ts'
import type { FontDescriptor, FontPreview, FontSelectionRequest } from './ports/fonts.ts'
import { fontPreviewSize } from './ports/fonts.ts'
import type { AudioBackend } from './ports/audio.ts'
import { SoundService } from './media/sounds.ts'
import { soundClasses } from './tvp/sound.ts'
import type { VideoBackend } from './ports/video.ts'
import { VideoService } from './media/videos.ts'
import { videoClass } from './tvp/video.ts'
import { InputController } from './input/controller.ts'
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
import { validateBlend, neutralColor } from './graphics/blend.ts'
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
export interface SessionSnapshot {
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
  | { type: 'window'; window: WindowView }
  | { type: 'input'; input: InputView }
  | { type: 'font-selection'; request: FontSelectionRequest | null }
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
  private readonly layers = new LayerTree()
  private readonly inputController = new InputController(
    this.layers,
    () => this.window,
    () => this.windowId,
  )
  private inputs?: InputService
  private inputView = ''
  private transitions?: SceneTransitions
  private readonly composer = new SceneComposer(this.layers, (id) => this.transitions?.frame(id))
  private preparingFrame = false
  private layerObjects?: LayerService
  private runtime?: ScriptRuntime
  private systemEvents?: SystemEvents
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
  private pointer = { x: 0, y: 0 }
  private readonly fonts: FontService
  private dirty = true
  private stopPromise?: Promise<void>
  private disposalPromise?: Promise<void>
  private exitRequested = false
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
    this.control.onCancel(() => this.menus.dismiss())
    this.control.onCancel(() => {
      this.fontSelection.cancel()
      this.fontCatalog.clear()
    })
    this.control.onCancel(() => {
      this.detachRenderer?.()
      this.transitions?.dispose()
      this.composer.clear()
      this.images.dispose()
      this.fonts.dispose()
      deps.graphics.dispose?.()
      void this.sounds?.pause(true).catch(() => {})
      void this.videos?.cancel().catch(() => {})
    })
    this.detachRenderer = deps.renderer.subscribe?.((status) => {
      if (this.control.cancelled) return
      this.graphicsStatus = { ...status }
      this.dirty = true
      this.applyPause()
      this.notify()
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
      this.inputs = new InputService(
        this.inputController,
        this.runtime,
        (id) => this.layerObjects?.owner(id),
        () => this.windows?.active?.owner,
        (id) => this.layerObjects?.eventOwner(id),
      )
      this.transitions = new SceneTransitions(
        this.layers,
        this.inputController,
        this.runtime,
        (operation) => this.inputs!.start(operation),
        this.deps.now,
        this.deps.schedule,
        () =>
          this.execute(async () => {
            this.dirty = true
            return undefined
          }).then(() => undefined),
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
          this.dirty = true
        },
        (callback, member, args, valid, before, immediate, source) => {
          if (valid()) before()
          return this.systemEvents!.post(
            () =>
              member
                ? { kind: 'invoke', callback, member, args }
                : { kind: 'value', value: undefined },
            {
              valid: () => valid() && (!immediate || !this.systemEvents!.disabled),
              discardable: immediate,
              source,
            },
          )
        },
        (error) => {
          if (!this.control.cancelled) this.fail(error)
        },
        (source) => this.systemEvents!.cancelSource(source),
        () => {
          if (!this.control.cancelled && this.runtime?.inspect().pendingHandles)
            return this.execute(async () => {
              await this.runtime!.collect()
              return undefined
            }).then(() => undefined)
          return this.queue.drain()
        },
      )
      this.windows = new WindowService(
        this.runtime,
        (window) => {
          this.inputController.clear()
          this.menus.hideRoot()
          this.window = window.state
          this.windowId = window.id
          this.windowRevision = -1
          this.dirty = true
        },
        async (window) => {
          this.systemEvents!.cancelSource(window)
          window.resizePending = false
          this.videos?.disconnectWindow(window.id)
          await this.videos?.flushCloses()
        },
        (window) => {
          this.systemEvents?.cancelSource(window)
          this.videos?.disconnectWindow(window.id)
          this.menuItems?.disconnectWindow(window)
          if (this.windowId === window.id) {
            this.windowId = 0
            this.inputController.clear()
          }
          this.dirty = true
        },
      )
      this.menuItems = new MenuService(this.runtime, this.menus, this.windows, (item) => {
        this.systemEvents?.cancelSource(item)
      })
      this.layerObjects = new LayerService(
        this.runtime,
        this.layers,
        this.windows,
        (layer) => {
          this.systemEvents?.cancelSource(layer)
          this.dirty = true
        },
        (layer) => {
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
      let failed = false,
        recorded = false
      try {
        let value: ScriptValue = undefined,
          display = 'undefined'
        try {
          value = await operation()
          await this.inputs?.synchronize()
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
        this.present()
        this.notify()
        return display
      } catch (error) {
        if (this.exitRequested && error instanceof Error && error.message === 'Execution cancelled')
          return 'undefined'
        if (!this.control.cancelled) {
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
      }
    }, priority)
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
  private *prepareFrame(source = this.inputController.root()): InputOperation {
    if (this.preparingFrame) return
    this.preparingFrame = true
    const layers = this.layers
    function* visit(id: number, paint: boolean, seen = new Set<number>()): InputOperation {
      if (!layers.has(id) || seen.has(id)) return
      seen.add(id)
      if (paint && layers.get(id).callOnPaint) {
        layers.set(id, 'callOnPaint', 0)
        yield { target: id, method: 'onPaint', args: [] }
      }
      if (!layers.has(id)) return
      for (const child of [...layers.get(id).children]) yield* visit(child, paint, seen)
      // Native completion traversals invalidate even an empty children snapshot
      // after visiting it. User edits remain visible until such a traversal.
      if (layers.has(id)) layers.invalidateChildren(id)
    }
    try {
      yield* visit(source, true)
      if (this.transitions?.active) yield* this.transitions.advance()
      yield* visit(source, false)
    } finally {
      this.preparingFrame = false
    }
  }
  pause(): void {
    if (!['running', 'paused'].includes(this.state))
      throw new Error('Only an active session can be paused')
    this.userPaused = true
    this.applyPause()
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
      this.inputController.resetTransient()
      this.menus.dismiss()
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
      this.userPaused || this.graphicsStatus.state !== 'ready' || activityPaused(this.activity)
    if (paused === (this.state === 'paused')) return
    if (paused) {
      this.inputController.resetTransient()
      this.menus.dismiss()
      this.presentMenus()
      this.control.pause()
      this.events?.pause(activityPaused(this.activity))
      this.systemEvents?.pause()
      this.transitions?.pause()
    } else {
      this.control.resume()
      this.events?.resume()
      this.systemEvents?.resume()
      this.transitions?.resume()
    }
    void this.sounds?.pause(paused).catch((error) => {
      if (!this.control.cancelled) this.fail(error)
    })
    void this.videos?.pause(paused).catch((error) => {
      if (!this.control.cancelled) this.fail(error)
    })
    this.setState(paused ? 'paused' : 'running')
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
  pointerState(x: number, y: number): void {
    if (
      [x, y].some((value) => !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
    )
      throw new Error('Invalid physical cursor coordinates')
    if (this.activity.state !== 'visible' || this.state !== 'running') return
    this.pointer = { x, y }
    if (this.window.mouseCursorState === 1) this.window.set('mouseCursorState', 0)
  }
  keyState(keys: number[]): void {
    if (keys.length > 256 || keys.some((key) => !Number.isInteger(key) || key < 0 || key > 65535))
      throw new Error('Invalid keyboard state')
    this.inputController.keys = new Set(this.activity.state === 'visible' ? keys : [])
  }
  input(packet: InputPacket, observe = true): Promise<void> {
    if (this.fontSelection.active && packet.type !== 'cancel' && packet.type !== 'deactivate')
      return Promise.resolve()
    for (const value of Object.values(packet))
      if (
        typeof value === 'number' &&
        (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
      )
        return Promise.reject(new Error('Invalid input coordinates or key'))
    if (packet.type === 'text' && packet.text.length > 65536)
      return Promise.reject(new Error('Input text budget exceeded'))
    if (this.activity.state !== 'visible') return Promise.resolve()
    if (this.state !== 'running' && (packet.type === 'cancel' || packet.type === 'deactivate'))
      this.inputController.resetTransient()
    if (observe) {
      this.inputController.observe(packet)
      if (
        packet.type === 'down' ||
        packet.type === 'move' ||
        packet.type === 'up' ||
        packet.type === 'wheel'
      )
        this.pointerState(packet.x, packet.y)
    }
    if (this.state !== 'running') return Promise.resolve()
    const epoch = this.inputController.epoch,
      window = this.windows?.active
    return this.systemEvents!.post(() => this.inputs!.packet(packet), {
      valid: () =>
        this.windows?.active === window &&
        epoch === this.inputController.epoch &&
        this.state === 'running' &&
        this.activity.state === 'visible',
      priority: 1,
      discardable: packet.type === 'move',
      source: window,
    }).then(() => this.queue.drain())
  }
  private postInput(packet: InputPacket, window: WindowRecord): void {
    if (this.windows?.active !== window) return
    if (this.postedInputPending >= 256) throw new Error('Posted input queue budget exceeded')
    const epoch = this.inputController.epoch
    this.postedInputPending++
    // Queue a VM call, never reenter the active TJS host import. A destroyed
    // window cannot deliver its pending input to a newly created window.
    void this.systemEvents!.post(() => this.inputs!.packet(packet), {
      valid: () =>
        this.windows?.active === window &&
        epoch === this.inputController.epoch &&
        this.activity.state === 'visible',
      priority: 1,
      source: window,
    })
      .catch((error) => {
        if (!this.control.cancelled) this.fail(error)
      })
      .finally(() => this.postedInputPending--)
  }
  exitFullScreen(): void {
    this.window.set('fullScreen', 0)
    this.present()
  }
  present(): void {
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
      this.state === 'stopped' ||
      this.state === 'stopping' ||
      this.graphicsStatus.state === 'lost' ||
      this.graphicsStatus.state === 'failed' ||
      (this.activity.state !== 'visible' && this.graphicsStatus.state !== 'restoring')
    )
      return
    const presented = this.deps.renderer.present(
      this.window.visible
        ? this.composer.frame(
            this.width,
            this.height,
            this.window.layerLeft,
            this.window.layerTop,
            this.window.zoomNumer / this.window.zoomDenom,
            this.windowId,
          )
        : [],
      this.width,
      this.height,
    )
    if (presented !== false) this.dirty = false
  }
  private queueResize(window: WindowRecord): void {
    if (window.resizePending || this.windows?.active !== window) return
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
        valid: () => this.windows?.active === window && !this.systemEvents!.disabled,
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
    if (this.menuRevision === this.menus.revision) return
    this.menuRevision = this.menus.revision
    this.deps.event({ type: 'menus', menus: this.menus.snapshot() })
  }
  menuClick(id: number): Promise<void> {
    if (this.fontSelection.active) return Promise.resolve()
    if (this.state !== 'running' || !this.window.visible || this.activity.state !== 'visible')
      return Promise.resolve()
    if (this.systemEvents!.disabled && !this.menus.hasPopup) return Promise.resolve()
    if (!this.menus.choose(id)) {
      this.presentMenus()
      return Promise.resolve()
    }
    const epoch = this.inputController.epoch,
      window = this.windows?.active,
      item = this.menuItems?.byView(id)
    let lease: ScriptObject | undefined
    return this.systemEvents!.post(
      () => {
        lease = item && this.runtime!.upgrade(item.owner)
        return lease
          ? { kind: 'invoke', callback: lease, member: 'onClick', args: [] }
          : { kind: 'value', value: undefined }
      },
      {
        valid: () =>
          epoch === this.inputController.epoch &&
          this.activity.state === 'visible' &&
          this.state === 'running' &&
          !this.systemEvents!.disabled &&
          this.window.visible &&
          this.menus.selectable(id) &&
          !!item &&
          !item.finished &&
          !item.closing &&
          !!window?.menu &&
          this.windows?.active === window,
        priority: 1,
        discardable: true,
        source: item,
      },
    )
      .finally(() => {
        if (lease) this.runtime?.release(lease)
      })
      .then(() => this.queue.drain())
  }
  menuDismiss(): void {
    this.menus.dismiss()
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
    if (
      operation.startsWith('Debug.') &&
      !operation.startsWith('Debug.panel') &&
      operation !== 'Debug.visible'
    )
      return this.debug!.host(operation, args)
    if (operation.startsWith('KAG.'))
      return { kind: 'value', value: await this.kag.host(operation, args, context) }
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
    const text = (i: number) => {
      if (typeof args[i] !== 'string') throw new Error(`${operation}: expected text at ${i}`)
      return args[i] as string
    }
    let value: ScriptValue
    switch (operation) {
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
        this.exitRequested = true
        // stop drains this operation after native execution unwinds. Awaiting it
        // inside a host import would deadlock the VM against its own queue.
        void this.stop().catch((error) => {
          this.deps.event({ type: 'log', level: 'error', text: String(error) })
        })
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
      case 'Menu.target': {
        const item = this.menuItems!.byView(number(0))
        value = item && !item.closing && this.menus.selectable(item.view) ? item.owner : null
        break
      }
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
        if (this.activity.state !== 'visible' || !this.window.visible) {
          value = 0n
          break
        }
        const selected = this.menus.openPopup(
          this.menuItems!.get(args[0]).view,
          number(1),
          number(2),
          number(3),
        )
        this.presentMenus()
        value = BigInt(await selected)
        this.presentMenus()
        break
      }
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
        value = BigInt(this.windows!.create(args[0], args[1], context).id)
        break
      }
      case 'Window.invalidate':
        if (!isScriptObject(args[1])) throw new Error('Expected native Window owner')
        return this.windows!.invalidate(number(0), args[1])
      case 'Window.finish':
        this.windows!.finish(number(0))
        break
      case 'Window.detachInput':
        if (this.windowId === number(0)) this.inputController.clear()
        return this.inputs!.start(this.inputController.synchronize())
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
          before = [window.state.width, window.state.height]
        window.state.set(text(1), typeof args[2] === 'string' ? text(2) : number(2))
        if (before[0] !== window.state.width || before[1] !== window.state.height)
          this.queueResize(window)
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
          const zoom = this.window.zoomNumer / this.window.zoomDenom,
            p = this.layers.localPoint(
              number(0),
              (this.pointer.x - this.window.layerLeft) / zoom,
              (this.pointer.y - this.window.layerTop) / zoom,
            )
          value = BigInt(Math.floor(text(1) === 'cursorX' ? p.x : p.y))
          break
        }
        const field = this.layers.property(number(0), text(1))
        value = typeof field === 'string' ? field : BigInt(Number(field))
        break
      }
      case 'Layer.set':
        return this.inputs!.change(() => {
          this.layers.set(number(0), text(1), typeof args[2] === 'string' ? text(2) : number(2))
          this.dirty = true
        })
      case 'Layer.resize':
        this.layers.resize(number(0), number(1), number(2))
        this.dirty = true
        break
      case 'Layer.fill':
        this.layers.fill(
          number(0),
          { x: number(1), y: number(2), width: number(3), height: number(4) },
          number(5),
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
        if (!isScriptObject(args[5])) throw new Error('Expected font data')
        const data = context.snapshot(args[5])
        if (data.type !== 'dictionary') throw new Error('Expected font dictionary')
        const font = fontSpec(data),
          draws = await this.fonts.draw(text(3), font, number(4), {
            antialiased: !!number(7),
            shadowLevel: number(8),
            shadowColor: number(9),
            shadowWidth: number(10),
            shadowX: number(11),
            shadowY: number(12),
          })
        const session = this,
          id = number(0),
          left = number(1),
          top = number(2),
          opacity = number(6)
        await this.finishGraphics(
          (function* () {
            for (const { pixels, x, y } of draws) {
              session.layers.composite(
                id,
                pixels,
                left + x + (pixels.left ?? 0),
                top + y + (pixels.top ?? 0),
                opacity,
              )
              yield
            }
          })(),
        )
        this.dirty = true
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
        this.inputController.resetTransient()
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
      case 'Layer.clip':
        this.layers
          .bitmap(number(0))
          .setClip({ x: number(1), y: number(2), width: number(3), height: number(4) })
        break
      case 'Layer.assignImages':
        this.layers.assignImages(number(0), number(1))
        this.dirty = true
        break
      case 'Layer.copy':
        this.layers.copy(number(0), number(1), number(2), number(3), {
          x: number(4),
          y: number(5),
          width: number(6),
          height: number(7),
        })
        this.dirty = true
        break
      case 'Layer.piledCopy': {
        const id = number(0),
          source = number(3),
          left = number(1),
          top = number(2),
          rect = { x: number(4), y: number(5), width: number(6), height: number(7) }
        const session = this
        return this.inputs!.start(
          (function* () {
            yield* session.prepareFrame(source)
            session.layers.bitmap(id).copyPixels(session.composer.snapshot(source), left, top, rect)
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
            copy && number(16) ? neutralColor(layer.type) : undefined,
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
          this.layers.setPixel(number(0), number(1), number(2), number(4), plane)
          this.dirty = true
        }
        break
      }
      case 'Layer.update':
        this.layers.get(number(0))
        this.dirty = true
        break
      case 'Plugins.link':
        throw new Error(`Plugin is not implemented: ${text(0)}`)
      default:
        throw new Error(`Unsupported host API: ${operation}`)
    }
    return { kind: 'value', value }
  }
}
