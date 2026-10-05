import type { PadHost } from './pad-host.ts'
import { SessionClient } from './session-client.ts'
import { ClipboardChannel } from './clipboard-channel.ts'
import { HelpChannel } from './help-channel.ts'
import type { HelpDocument } from '../engine/ports/help.ts'
import type { ClipboardRequest } from '../protocol/clipboard.ts'
import type { BackendPreference, GameInput, SessionEvent } from '../protocol/session.ts'
import { WebAudioHost } from '../backends/audio/web/host.ts'
import type { AudioState } from '../protocol/audio.ts'
import { WebVideoHost } from '../backends/video/browser/host.ts'
import { BrowserInputCoordinator } from '../backends/input/coordinator.ts'
import { selectCursorAsset, type SelectedCursorAsset } from '../backends/input/cursor.ts'
import type { CursorAsset } from '../formats/cursor/index.ts'
import { BrowserWindowSurfaces } from './window-surfaces.ts'
import { PageActivityMonitor } from './page-activity.ts'
import { activityPaused, initialActivity } from '../engine/ports/activity.ts'
import type { InputView } from '../engine/ports/input.ts'
import type { WindowPresentation, WindowView } from '../engine/scene/window.ts'
import type { WindowMoveRequest, WindowMoveMessage } from '../engine/ports/window-move.ts'
import { copyWindowRegion, WindowRegions, type WindowRegion } from '../engine/scene/window-region.ts'
import type { WindowSurfaceIdentity } from '../protocol/surfaces.ts'
import { normalizeSystemDataPath } from '../engine/system/environment.ts'
import { copySystemColorPalette } from '../engine/graphics/system-colors.ts'
import { sampleSystemColorPalette } from './system-colors.ts'
import { BrowserSystemDisplay } from './system-display.ts'
import { copySystemDisplayMetrics, type SystemDisplayMetrics } from '../engine/system/display.ts'

/** Player-facing DOM ownership; compatible with the app's GameWindows host. */
export interface PlayerWindowSurface {
  readonly windowId: number
  readonly surfaceEpoch: number
  readonly canvas: HTMLCanvasElement
  readonly element: HTMLElement
  readonly menu: HTMLElement
  readonly content: HTMLElement
  readonly videoPlane: HTMLElement
}

export interface PlayerWindowHost {
  attach(windowId: number, surfaceEpoch: number): HTMLCanvasElement | undefined
  detach(windowId: number, surfaceEpoch: number): void
  update(windowId: number, view: WindowView, active: boolean, surfaceEpoch?: number): void
  /** Apply an immutable native pixel region to this exact live surface. */
  setRegion(windowId: number, revision: number, region: WindowRegion | null, surfaceEpoch: number): void
  beginMove?(request: WindowMoveRequest, surfaceEpoch: number,
    publish: (message: WindowMoveMessage) => void, signal: AbortSignal): Promise<void>
  get(windowId: number, surfaceEpoch?: number): PlayerWindowSurface | undefined
  /** Actual host placement, which may suppress a requested fullscreen window. */
  isFullscreen?(windowId: number, surfaceEpoch: number): boolean
  dispose(): void
}

export interface PlayerOptions {
  windows: PlayerWindowHost
  pads?: PadHost
  /** Route a host editor's Stop button through the embedding application's
   * lifecycle. Without an application owner, stop this player directly. */
  onStopRequested?(): Promise<void>
  /** Optional game-relative startup directory; never a host filesystem path. */
  dataPath?: string
  /** 31 RGB values for legacy indices 0..30 (25 must be zero); defaults to page CSS colors. */
  systemColors?: readonly number[]
  /** Fixed, copied virtual display geometry. Defaults to the live player desktop. */
  systemDisplay?: SystemDisplayMetrics
  /** Stable containing stage; defaults to the canvas's parent before surface attachment. */
  desktopElement?: HTMLElement
  onClipboardRequest?(request: ClipboardRequest | null): void
  ownsClipboardFocus?(target: EventTarget | null): boolean
  /** Install a readonly presentation synchronously, or throw if unavailable.
   * Returning acknowledges installation, never a queued or dismissed view. */
  onHelpDocument?(document: HelpDocument | null): void
  ownsHelpFocus?(target: EventTarget | null): boolean
  /** Input and video are attached, and the canvas has not yet been transferred. */
  onSurfaceAttach?(surface: PlayerWindowSurface, identity: WindowSurfaceIdentity): void
  /** Input and video are detached; the surface DOM is still available. */
  onSurfaceDetach?(surface: PlayerWindowSurface, identity: WindowSurfaceIdentity): void
  onError?(error: unknown): void
}

export function createPlayer(
  canvas: HTMLCanvasElement,
  onEvent: (event: SessionEvent) => void,
  onAudio: (state: AudioState) => void = () => {},
  pauseWhenHidden = true,
  options: PlayerOptions,
) {
  const dataPath = options.dataPath
  normalizeSystemDataPath(dataPath)
  const suppliedSystemColors = options.systemColors
  const suppliedSystemDisplay = options.systemDisplay
  const systemDisplay =
    suppliedSystemDisplay === undefined
      ? undefined
      : copySystemDisplayMetrics(suppliedSystemDisplay)
  const desktopElement =
    options.desktopElement ?? canvas.parentElement ?? canvas.ownerDocument.documentElement
  const browser = canvas.ownerDocument.defaultView
  if (
    !browser ||
    !(desktopElement instanceof (browser as Window & typeof globalThis).HTMLElement) ||
    desktopElement.ownerDocument !== canvas.ownerDocument ||
    !desktopElement.ownerDocument.defaultView
  )
    throw new Error('System display desktop must belong to the player document')
  const systemColors =
    suppliedSystemColors === undefined
      ? sampleSystemColorPalette(canvas)
      : copySystemColorPalette(suppliedSystemColors)
  const audioChannel = new MessageChannel()
  const audio = new WebAudioHost(audioChannel.port1, onAudio)
  const videoChannel = new MessageChannel()
  const video = new WebVideoHost(videoChannel.port1, audio)
  const clipboardChannel = new MessageChannel()
  const helpChannel = new MessageChannel()
  const surfaceChannel = new MessageChannel()
  const windows = new Map<number, WindowPresentation>()
  const inputViews = new Map<number, InputView>()
  const windowRegions = new WindowRegions()
  const regionRevisions = new Map<number, number>()
  let regionsRetired = false
  const cursorAssets = new Map<number, SelectedCursorAsset>()
  const unselectedCursorAssets = new Map<number, CursorAsset>()
  const cursorAssetIds = new Set<number>()
  let cursorsRetired = false
  const retiredWindows = new Set<number>()
  let identity = ''
  let stopping: Promise<void> | undefined
  let input: BrowserInputCoordinator | undefined
  let surfaces: BrowserWindowSurfaces | undefined
  let display: BrowserSystemDisplay | undefined
  let activity = initialActivity()
  let workerPaused = true
  let fontSelecting = false
  let moving: { request: WindowMoveRequest; epoch: number; abort: AbortController } | undefined
  let focusRequest: { windowId: number; epoch?: number; revision: number } | undefined
  const syncInput = () => {
    const suspended = workerPaused || fontSelecting || activity.state !== 'visible'
    input?.setSuspended(suspended)
    if (focusRequest && focusRequest.revision !== input?.focusRevision) focusRequest = undefined
    if (!suspended && focusRequest && input?.focus(focusRequest.windowId, focusRequest.epoch))
      focusRequest = undefined
  }
  const onError = (error: unknown) => {
    if (options.onError) options.onError(error)
    else canvas.dispatchEvent(new CustomEvent('playererror', { detail: error }))
  }
  const updateParts = (actions: (() => void)[]) => {
    const errors: unknown[] = []
    for (const action of actions) {
      try {
        action()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length === 1) onError(errors[0])
    else if (errors.length) onError(new AggregateError(errors, 'Window presentation update failed'))
  }
  const syncDisplay = () => {
    if (!display || stopping || systemDisplay !== undefined) return
    updateParts([
      () =>
        display?.setFullscreen(
          [...windows.values()].some(({ id, view }) => {
            const surface = surfaces?.get(id)
            return (
              !!surface &&
              view.visible &&
              view.fullScreen &&
              (options.windows.isFullscreen?.(id, surface.identity.surfaceEpoch) ?? true)
            )
          }),
        ),
    ])
  }
  const applyRegion = (windowId: number, surfaceEpoch: number) => {
    const revision = regionRevisions.get(windowId)
    if (revision === undefined || regionsRetired || retiredWindows.has(windowId)) return
    const region = windowRegions.get(windowId)
    options.windows.setRegion(windowId, revision, region ? copyWindowRegion(region) : null, surfaceEpoch)
  }
  const clearRegions = () => {
    if (regionsRetired) return
    regionsRetired = true
    const ids = [...regionRevisions.keys()]
    windowRegions.clear()
    regionRevisions.clear()
    // Retirement wins immediately, including while the Worker drains Stop.
    // A final local revision also excludes stale direct calls to a live host.
    updateParts(ids.map((id) => () => {
      const epoch = surfaces?.get(id)?.identity.surfaceEpoch
      if (epoch !== undefined) options.windows.setRegion(id, Number.MAX_SAFE_INTEGER, null, epoch)
    }))
  }
  const retireMove = () => {
    const previous = moving
    moving = undefined
    // Local retirement cannot send a reply that resumes TJS ahead of Stop or
    // of the engine's own modal-stack cancellation/cleanup.
    try { previous?.abort.abort() }
    finally { input?.setHostMoving(false) }
  }
  const beginMove = (incoming: WindowMoveRequest | null) => {
    retireMove()
    if (!incoming || stopping || retiredWindows.has(incoming.windowId)) return
    const request = Object.freeze({ ...incoming }),
      epoch = surfaces?.get(request.windowId)?.identity.surfaceEpoch,
      fallback = (message: string) => {
        void session.windowMove({ type: 'error', ...request, sequence: Number.MAX_SAFE_INTEGER,
          message: (message || 'Window move presentation failed').slice(0, 4096) }).catch((error) => {
            if (moving?.request.requestId === request.requestId) retireMove()
            onError(error)
          })
      }
    if (epoch === undefined || !options.windows.beginMove) {
      fallback('Window move host is unavailable')
      return
    }
    const operation = { request, epoch, abort: new AbortController() }
    moving = operation
    const current = () => moving === operation && !stopping && !operation.abort.signal.aborted &&
      !retiredWindows.has(request.windowId) && surfaces?.get(request.windowId)?.identity.surfaceEpoch === epoch
    let terminalSent = false
    try {
      input?.setHostMoving(true)
      const completion = options.windows.beginMove(request, epoch, (message) => {
        if (!current()) return
        if (message.requestId !== request.requestId || message.windowId !== request.windowId)
          throw new Error('Window move host returned a mismatched identity')
        terminalSent ||= message.type !== 'update'
        void session.windowMove(message).catch((error) => {
          if (current()) fallback(error instanceof Error ? error.message : String(error))
        })
      }, operation.abort.signal)
      void Promise.resolve(completion).then(() => {
        // Keep admission blocked until the ordered engine null event confirms
        // interaction retirement. TJS modal unwinding may follow that event.
        if (current() && !terminalSent) fallback('Window move host completed without a result')
      }, (error: unknown) => {
        if (current()) fallback(error instanceof Error ? error.message : String(error))
        else onError(error)
      })
    } catch (error) {
      if (current()) fallback(error instanceof Error ? error.message : String(error))
    }
  }
  const retireWindow = (windowId: number) => {
    retiredWindows.add(windowId)
    windows.delete(windowId)
    inputViews.delete(windowId)
    windowRegions.replace(windowId, null)
    regionRevisions.delete(windowId)
    if (moving?.request.windowId === windowId) retireMove()
    if (focusRequest?.windowId === windowId) focusRequest = undefined
    // Retirement is independent of whether a presentation or canvas ever
    // arrived. Tombstone before cleanup so late messages cannot recreate it.
    updateParts([() => surfaces?.retireWindow(windowId), () => video.removeWindow(windowId)])
    syncDisplay()
  }
  const updateWindows = (presentations: WindowPresentation[]) => {
    const removed = new Set(windows.keys())
    for (const window of presentations) {
      if (retiredWindows.has(window.id)) continue
      removed.delete(window.id)
      windows.set(window.id, window)
      const epoch = surfaces?.get(window.id)?.identity.surfaceEpoch
      updateParts([
        () => {
          if (epoch !== undefined)
            options.windows.update(window.id, window.view, window.active, epoch)
        },
        () => {
          if (epoch !== undefined) input?.setWindow(window.id, window.view)
        },
        () => video.setWindow(window.view, window.id),
      ])
    }
    for (const id of removed) retireWindow(id)
    syncDisplay()
  }
  const session = new SessionClient((event) => {
    // Stop retires page ownership synchronously, before the Worker drains its
    // channel. A previously sent definition arriving now is merely stale.
    if (event.type === 'cursor-asset' && !cursorsRetired) {
      try {
        if (!Number.isSafeInteger(event.id) || event.id < 2 || cursorAssetIds.has(event.id))
          throw new Error('Invalid cursor asset identity')
        // Keep the full decoded definition if presentation rejects a timeline
        // whose native playback policy has not yet been established.
        unselectedCursorAssets.set(event.id, event.asset)
        cursorAssetIds.add(event.id)
        if (!event.asset.frames.every((frame) => frame.images.length === 1))
          throw new Error('Cursor handle contains an unresolved image selection')
        // The Session performs native-profile selection before assigning an ID.
        cursorAssets.set(event.id, selectCursorAsset(event.asset, () => 0))
        unselectedCursorAssets.delete(event.id)
        input?.refreshCursors()
      } catch (error) { onError(error) }
    }
    if (event.type === 'cursor-assets-clear') {
      cursorsRetired = true
      cursorAssets.clear()
      unselectedCursorAssets.clear()
      cursorAssetIds.clear()
      input?.refreshCursors()
    }
    if (event.type === 'window-regions-clear') clearRegions()
    if (event.type === 'window-move') beginMove(event.request)
    if (event.type === 'window-region' && !regionsRetired && !stopping && !retiredWindows.has(event.windowId)) {
      updateParts([() => {
        if (!Number.isSafeInteger(event.windowId) || event.windowId < 1 ||
            !Number.isSafeInteger(event.revision) || event.revision < 1)
          throw new Error('Invalid Window region identity')
        if (event.revision <= (regionRevisions.get(event.windowId) ?? 0)) return
        const region = event.region ? copyWindowRegion(event.region) : null
        windowRegions.replace(event.windowId, region)
        regionRevisions.set(event.windowId, event.revision)
        const epoch = surfaces?.get(event.windowId)?.identity.surfaceEpoch
        if (epoch !== undefined) applyRegion(event.windowId, epoch)
      }])
    }
    if (event.type === 'font-selection') {
      fontSelecting = !!event.request
    }
    if (event.type === 'window-closed') retireWindow(event.windowId)
    if (event.type === 'window-activate' && !retiredWindows.has(event.windowId))
      focusRequest = { windowId: event.windowId, revision: input!.focusRevision }
    if (event.type === 'windows') updateWindows(event.windows)
    if (event.type === 'window-input' && !retiredWindows.has(event.windowId)) {
      inputViews.set(event.windowId, event.input)
      if (surfaces?.get(event.windowId)) input?.setInput(event.windowId, event.input)
    }
    if (event.type === 'state') {
      if (event.snapshot.windows) updateWindows(event.snapshot.windows)
      workerPaused = event.snapshot.state !== 'running'
    }
    onEvent(event)
    if (event.type === 'pads') options.pads?.update(event)
    // Roster snapshots describe completed script work; they never command DOM
    // focus. Only explicit native activation can request a move, and later user
    // focus supersedes a request still waiting for its surface or dialog.
    syncInput()
  })
  const clipboard = new ClipboardChannel(clipboardChannel.port1, session.generation, (request) => {
    if (options.onClipboardRequest) options.onClipboardRequest(request)
    else if (request)
      clipboard.respond({
        id: request.id,
        generation: request.generation,
        ok: false,
        error: { name: 'NotSupportedError', message: 'A clipboard presentation is not available' },
      })
  })
  const help = new HelpChannel(
    helpChannel.port1,
    session.generation,
    options.onHelpDocument,
    onError,
  )
  input = new BrowserInputCoordinator(
    (packet) => session.input(packet),
    (keys) => session.keyState(keys),
    (x, y, windowId, sequence) => session.pointerState(x, y, windowId, sequence),
    onError,
    {
      cursor: {
        resolve: (id) => cursorAssets.get(id),
        scene: (windowId, epoch) => video.cursorScene(windowId, epoch),
      },
      isTransientFocus: (target) => {
        if (options.ownsClipboardFocus?.(target)) return true
        if (options.ownsHelpFocus?.(target)) return true
        if (!(target instanceof Element)) return false
        const popup = target.closest<HTMLElement>(
          '.game-menu-overlay[data-window-id][data-request-id]',
        )
        if (!popup) return false
        const windowId = Number(popup.dataset.windowId),
          requestId = Number(popup.dataset.requestId)
        return (
          Number.isSafeInteger(requestId) &&
          requestId > 0 &&
          (windows.has(windowId) || !!surfaces?.get(windowId)) &&
          !retiredWindows.has(windowId)
        )
      },
    },
  )
  syncInput()
  surfaces = new BrowserWindowSurfaces(surfaceChannel.port1, session.generation, options.windows, {
    onAttach: (canvas, identity) => {
      const { windowId, surfaceEpoch } = identity,
        surface = options.windows.get(windowId, surfaceEpoch)
      if (retiredWindows.has(windowId)) throw new Error('Window has been retired')
      if (!surface || surface.canvas !== canvas)
        throw new Error('Window host returned an inconsistent surface')
      const window = windows.get(windowId),
        state = inputViews.get(windowId)
      if (window) options.windows.update(windowId, window.view, window.active, surfaceEpoch)
      applyRegion(windowId, surfaceEpoch)
      input!.attach(windowId, surfaceEpoch, canvas, surface.element)
      if (window) input!.setWindow(windowId, window.view)
      if (state) input!.setInput(windowId, state)
      video.attachWindow(windowId, surfaceEpoch, canvas, surface.videoPlane)
      if (window) video.setWindow(window.view, windowId)
      input!.refreshCursors()
      options.onSurfaceAttach?.(surface, identity)
      syncDisplay()
      syncInput()
    },
    onDetach: (_canvas, identity) => {
      const { windowId, surfaceEpoch } = identity,
        surface = options.windows.get(windowId, surfaceEpoch),
        errors: unknown[] = []
      if (moving?.request.windowId === windowId && moving.epoch === surfaceEpoch) {
        const request = moving.request
        retireMove()
        if (!stopping && !retiredWindows.has(windowId))
          void session.windowMove({ type: 'cancel', requestId: request.requestId, windowId,
            sequence: Number.MAX_SAFE_INTEGER }).catch(onError)
      }
      if (
        focusRequest?.windowId === windowId &&
        (focusRequest.epoch === undefined || focusRequest.epoch === surfaceEpoch)
      )
        focusRequest = windows.has(windowId) ? { ...focusRequest, epoch: undefined } : undefined
      if (surface?.content.contains(document.activeElement) && windows.has(windowId))
        focusRequest = { windowId, revision: input!.focusRevision }
      for (const action of [
        () => input!.detach(windowId, surfaceEpoch),
        () => video.detachWindow(windowId, surfaceEpoch),
        () => {
          if (surface) options.onSurfaceDetach?.(surface, identity)
        },
      ]) {
        try {
          action()
        } catch (error) {
          errors.push(error)
        }
      }
      syncDisplay()
      if (errors.length === 1) throw errors[0]
      if (errors.length) throw new AggregateError(errors, 'Window host cleanup failed')
    },
  })
  const pageActivity = new PageActivityMonitor((state) => {
    activity = state
    const paused = activityPaused(state)
    const suspended = state.state === 'frozen' || state.state === 'away'
    audio.setRequestTimeoutsPaused(suspended)
    video.setRequestTimeoutsPaused(suspended)
    video.setPagePaused(paused)
    void audio.setPagePaused(paused).catch(onError)
    void session.setActivity(state).catch(onError)
    // Post visibility before any activation packet produced by releasing input.
    syncInput()
  }, pauseWhenHidden)
  const player = {
    isWindowActive(windowId: number, epoch?: number): boolean {
      return !retiredWindows.has(windowId) && input!.isActive(windowId, epoch)
    },
    focusWindow(windowId: number, epoch?: number): boolean {
      if (retiredWindows.has(windowId)) return false
      const focused = input!.focus(windowId, epoch)
      if (focused) focusRequest = undefined
      return focused
    },
    setPauseWhenHidden: (paused: boolean) => pageActivity.setPauseWhenHidden(paused),
    async load(
      files: GameInput,
      entry = 'startup.tjs',
      backend: BackendPreference = 'auto',
      debugMode = false,
    ) {
      identity = await session.prepare(files)
      await session.initialize(
        surfaceChannel.port2,
        backend,
        identity,
        audioChannel.port2,
        videoChannel.port2,
        debugMode,
        clipboardChannel.port2,
        dataPath,
        systemColors,
        helpChannel.port2,
        !!options.windows.beginMove,
      )
      await session.mount()
      // Only ordered Session events update the host. A start RPC snapshot can
      // arrive after a newer event and must not resurrect a removed Window.
      return session.start(entry)
    },
    session,
    pads: options.pads,
    clipboard,
    toggleAudio() {
      audio.toggle()
      video.activate()
    },
    get gameId() {
      return identity
    },
    stop(): Promise<void> {
      if (stopping) return stopping
      stopping = (async () => {
        const errors: unknown[] = []
        for (const action of [
          () => display?.close(),
          // Retire the buttons locally. A clipboard-close message on its own
          // port must not resume TJS catch before the stop RPC cancels control.
          () => options.pads?.dispose(),
          () => options.onClipboardRequest?.(null),
          () => help.suspend(),
          () => retireMove(),
          () => video.setPagePaused(true),
          () => input?.close(),
          () => clearRegions(),
          () => {
            cursorsRetired = true
            cursorAssets.clear()
            unselectedCursorAssets.clear()
            cursorAssetIds.clear()
          },
        ]) {
          try {
            action()
          } catch (error) {
            errors.push(error)
          }
        }
        void audio.setPagePaused(true).catch(onError)
        try {
          await session.stop()
        } catch (error) {
          errors.push(error)
        }
        try {
          clipboard.close()
        } catch (error) {
          errors.push(error)
        }
        try {
          help.close()
        } catch (error) {
          errors.push(error)
        }
        if (session.isDisposed) {
          for (const action of [
            () => pageActivity.close(),
            () => surfaces!.dispose(),
            () => options.windows.dispose(),
            () => video.close(),
            () => audio.close(),
            ...[surfaceChannel, videoChannel, audioChannel, clipboardChannel, helpChannel].flatMap(
              (channel) => [() => channel.port1.close(), () => channel.port2.close()],
            ),
          ]) {
            try {
              await action()
            } catch (error) {
              errors.push(error)
            }
          }
          windows.clear()
          inputViews.clear()
          retiredWindows.clear()
          focusRequest = undefined
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length) throw new AggregateError(errors, 'Player cleanup failed')
      })().catch((error: unknown) => {
        stopping = undefined
        throw error
      })
      return stopping
    },
  }
  try {
    display = new BrowserSystemDisplay(
      desktopElement,
      (update) => {
        void session.setSystemDisplay(update).catch(onError)
      },
      systemDisplay,
    )
  } catch (error) {
    // The monitor cleans partial observer setup itself. Retire the remaining
    // player resources without lazily creating a Worker just to send Stop.
    session.dispose()
    void player.stop().catch(onError)
    throw error
  }
  options.pads?.attach({
    generation: session.generation,
    send: (message) => session.pad(message),
    font: (id, epoch) => session.padFont(id, epoch),
    stop: () => (options.onStopRequested ? options.onStopRequested() : player.stop()),
  })
  return player
}
