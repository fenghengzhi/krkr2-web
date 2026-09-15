import { SessionClient } from './session-client.ts'
import { ClipboardChannel } from './clipboard-channel.ts'
import type { ClipboardRequest } from '../protocol/clipboard.ts'
import type { BackendPreference, GameInput, SessionEvent } from '../protocol/session.ts'
import { WebAudioHost } from '../backends/audio/web/host.ts'
import type { AudioState } from '../protocol/audio.ts'
import { WebVideoHost } from '../backends/video/browser/host.ts'
import { BrowserInputCoordinator } from '../backends/input/coordinator.ts'
import { BrowserWindowSurfaces } from './window-surfaces.ts'
import { PageActivityMonitor } from './page-activity.ts'
import { activityPaused, initialActivity } from '../engine/ports/activity.ts'
import type { InputView } from '../engine/ports/input.ts'
import type { WindowPresentation, WindowView } from '../engine/scene/window.ts'
import type { WindowSurfaceIdentity } from '../protocol/surfaces.ts'
import { normalizeSystemDataPath } from '../engine/system/environment.ts'

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
  get(windowId: number, surfaceEpoch?: number): PlayerWindowSurface | undefined
  dispose(): void
}

export interface PlayerOptions {
  windows: PlayerWindowHost
  /** Optional game-relative startup directory; never a host filesystem path. */
  dataPath?: string
  onClipboardRequest?(request: ClipboardRequest | null): void
  ownsClipboardFocus?(target: EventTarget | null): boolean
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
  const audioChannel = new MessageChannel()
  const audio = new WebAudioHost(audioChannel.port1, onAudio)
  const videoChannel = new MessageChannel()
  const video = new WebVideoHost(videoChannel.port1, audio)
  const clipboardChannel = new MessageChannel()
  const surfaceChannel = new MessageChannel()
  const windows = new Map<number, WindowPresentation>()
  const inputViews = new Map<number, InputView>()
  const retiredWindows = new Set<number>()
  let identity = ''
  let stopping: Promise<void> | undefined
  let input: BrowserInputCoordinator | undefined
  let surfaces: BrowserWindowSurfaces | undefined
  let activity = initialActivity()
  let workerPaused = true
  let fontSelecting = false
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
  const retireWindow = (windowId: number) => {
    retiredWindows.add(windowId)
    windows.delete(windowId)
    inputViews.delete(windowId)
    if (focusRequest?.windowId === windowId) focusRequest = undefined
    // Retirement is independent of whether a presentation or canvas ever
    // arrived. Tombstone before cleanup so late messages cannot recreate it.
    updateParts([() => surfaces?.retireWindow(windowId), () => video.removeWindow(windowId)])
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
  }
  const session = new SessionClient((event) => {
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
  input = new BrowserInputCoordinator(
    (packet) => session.input(packet),
    (keys) => session.keyState(keys),
    (x, y, windowId) => session.pointerState(x, y, windowId),
    onError,
    {
      isTransientFocus: (target) => {
        if (options.ownsClipboardFocus?.(target)) return true
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
      input!.attach(windowId, surfaceEpoch, canvas, surface.element)
      if (window) input!.setWindow(windowId, window.view)
      if (state) input!.setInput(windowId, state)
      video.attachWindow(windowId, surfaceEpoch, canvas, surface.videoPlane)
      if (window) video.setWindow(window.view, windowId)
      options.onSurfaceAttach?.(surface, identity)
      syncInput()
    },
    onDetach: (_canvas, identity) => {
      const { windowId, surfaceEpoch } = identity,
        surface = options.windows.get(windowId, surfaceEpoch),
        errors: unknown[] = []
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
  return {
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
      )
      await session.mount()
      // Only ordered Session events update the host. A start RPC snapshot can
      // arrive after a newer event and must not resurrect a removed Window.
      return session.start(entry)
    },
    session,
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
          // Retire the buttons locally. A clipboard-close message on its own
          // port must not resume TJS catch before the stop RPC cancels control.
          () => options.onClipboardRequest?.(null),
          () => video.setPagePaused(true),
          () => input?.close(),
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
        if (session.isDisposed) {
          for (const action of [
            () => pageActivity.close(),
            () => surfaces!.dispose(),
            () => options.windows.dispose(),
            () => video.close(),
            () => audio.close(),
            ...[surfaceChannel, videoChannel, audioChannel, clipboardChannel].flatMap((channel) => [
              () => channel.port1.close(),
              () => channel.port2.close(),
            ]),
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
}
