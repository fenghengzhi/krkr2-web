import { SessionClient } from './session-client.ts'
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
  const audioChannel = new MessageChannel()
  const audio = new WebAudioHost(audioChannel.port1, onAudio)
  const videoChannel = new MessageChannel()
  const video = new WebVideoHost(videoChannel.port1, audio)
  const surfaceChannel = new MessageChannel()
  const windows = new Map<number, WindowPresentation>()
  const inputViews = new Map<number, InputView>()
  const attachedWindows = new Set<number>()
  let identity = ''
  let stopping: Promise<void> | undefined
  let input: BrowserInputCoordinator | undefined
  let surfaces: BrowserWindowSurfaces | undefined
  let activity = initialActivity()
  let workerPaused = true
  let fontSelecting = false
  let activeWindow = 0
  let focusRequest: { windowId: number; epoch?: number } | undefined
  const syncInput = () => {
    const suspended = workerPaused || fontSelecting || activity.state !== 'visible'
    input?.setSuspended(suspended)
    if (
      !suspended &&
      focusRequest &&
      focusRequest.windowId === activeWindow &&
      input?.focus(focusRequest.windowId, focusRequest.epoch)
    )
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
  const updateWindows = (presentations: WindowPresentation[]) => {
    const nextActive = presentations.find((window) => window.active)?.id ?? 0
    if (nextActive !== activeWindow) {
      activeWindow = nextActive
      focusRequest = nextActive ? { windowId: nextActive } : undefined
    }
    const removed = new Set(windows.keys())
    for (const window of presentations) {
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
    for (const id of removed) {
      windows.delete(id)
      inputViews.delete(id)
      attachedWindows.delete(id)
      const surface = surfaces?.get(id)
      // Roster removal retires a native Window. Graphics retries only detach its
      // surface, preserving the movie's decoder, clock, and audio connection.
      updateParts([
        () => {
          if (surface) input?.detach(id, surface.identity.surfaceEpoch)
        },
        () => video.removeWindow(id),
      ])
    }
  }
  const session = new SessionClient((event) => {
    if (event.type === 'font-selection') {
      fontSelecting = !!event.request
    }
    if (event.type === 'windows') updateWindows(event.windows)
    if (event.type === 'window-input') {
      inputViews.set(event.windowId, event.input)
      if (surfaces?.get(event.windowId)) input?.setInput(event.windowId, event.input)
    }
    if (event.type === 'state') {
      if (event.snapshot.windows) updateWindows(event.snapshot.windows)
      workerPaused = event.snapshot.state !== 'running'
    }
    onEvent(event)
    // App dialogs and active-window/menu state update before a native activation
    // moves DOM focus. Repeated snapshots never create a fresh focus request.
    syncInput()
  })
  input = new BrowserInputCoordinator(
    (packet) => session.input(packet),
    (keys) => session.keyState(keys),
    (x, y, windowId) => session.pointerState(x, y, windowId),
    onError,
  )
  syncInput()
  surfaces = new BrowserWindowSurfaces(surfaceChannel.port1, session.generation, options.windows, {
    onAttach: (canvas, identity) => {
      const { windowId, surfaceEpoch } = identity,
        surface = options.windows.get(windowId, surfaceEpoch)
      if (!surface || surface.canvas !== canvas)
        throw new Error('Window host returned an inconsistent surface')
      const window = windows.get(windowId),
        state = inputViews.get(windowId)
      if (window) options.windows.update(windowId, window.view, window.active, surfaceEpoch)
      input!.attach(windowId, surfaceEpoch, canvas)
      if (window) input!.setWindow(windowId, window.view)
      if (state) input!.setInput(windowId, state)
      video.attachWindow(windowId, surfaceEpoch, canvas, surface.videoPlane)
      if (window) video.setWindow(window.view, windowId)
      options.onSurfaceAttach?.(surface, identity)
      if (!attachedWindows.has(windowId)) {
        attachedWindows.add(windowId)
        if (activeWindow === windowId) focusRequest = { windowId, epoch: surfaceEpoch }
      }
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
        focusRequest = windows.has(windowId) ? { windowId } : undefined
      if (
        surface?.content.contains(document.activeElement) &&
        activeWindow === windowId &&
        windows.has(windowId)
      )
        focusRequest = { windowId }
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
    focusWindow(windowId: number, epoch?: number): boolean {
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
      )
      await session.mount()
      // Only ordered Session events update the host. A start RPC snapshot can
      // arrive after a newer event and must not resurrect a removed Window.
      return session.start(entry)
    },
    session,
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
        for (const action of [() => video.setPagePaused(true), () => input?.close()]) {
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
        if (session.isDisposed) {
          for (const action of [
            () => pageActivity.close(),
            () => surfaces!.dispose(),
            () => options.windows.dispose(),
            () => video.close(),
            () => audio.close(),
            ...[surfaceChannel, videoChannel, audioChannel].flatMap((channel) => [
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
          attachedWindows.clear()
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
