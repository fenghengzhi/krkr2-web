import { SessionClient } from './session-client.ts'
import type { BackendPreference, GameInput, SessionEvent } from '../protocol/session.ts'
import { WebAudioHost } from '../backends/audio/web/host.ts'
import type { AudioState } from '../protocol/audio.ts'
import { WebVideoHost } from '../backends/video/browser/host.ts'
import { BrowserInput } from '../backends/input/browser.ts'
import { PageActivityMonitor } from './page-activity.ts'
import { activityPaused, initialActivity } from '../engine/ports/activity.ts'

export function createPlayer(
  canvas: HTMLCanvasElement,
  onEvent: (event: SessionEvent) => void,
  onAudio: (state: AudioState) => void = () => {},
  pauseWhenHidden = true,
) {
  const audioChannel = new MessageChannel()
  const audio = new WebAudioHost(audioChannel.port1, onAudio)
  const videoChannel = new MessageChannel()
  const video = new WebVideoHost(videoChannel.port1, canvas, audio)
  let identity = ''
  let input: BrowserInput | undefined
  let activity = initialActivity()
  let workerPaused = true
  let fontSelecting = false
  const syncInput = () =>
    input?.setSuspended(workerPaused || fontSelecting || activity.state !== 'visible')
  const session = new SessionClient((event) => {
    if (event.type === 'font-selection') {
      fontSelecting = !!event.request
      syncInput()
    }
    if (event.type === 'window') {
      video.setWindow(event.window)
      input?.setWindow(event.window)
    }
    if (event.type === 'input') input?.setInput(event.input)
    if (event.type === 'state') {
      workerPaused = event.snapshot.state !== 'running'
      syncInput()
    }
    onEvent(event)
  })
  const onError = (error: unknown) => {
    canvas.dispatchEvent(new CustomEvent('playererror', { detail: error }))
  }
  input = new BrowserInput(
    canvas,
    (packet) => session.input(packet),
    (keys) => session.keyState(keys),
    (x, y) => session.pointerState(x, y),
    onError,
  )
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
    setPauseWhenHidden: (paused: boolean) => pageActivity.setPauseWhenHidden(paused),
    async load(
      files: GameInput,
      entry = 'startup.tjs',
      backend: BackendPreference = 'auto',
      debugMode = false,
    ) {
      identity = await session.prepare(files)
      await session.initialize(
        canvas,
        backend,
        identity,
        audioChannel.port2,
        videoChannel.port2,
        debugMode,
      )
      await session.mount()
      const snapshot = await session.start(entry)
      return snapshot
    },
    session,
    toggleAudio() {
      audio.toggle()
      video.activate()
    },
    get gameId() {
      return identity
    },
    async stop() {
      video.setPagePaused(true)
      void audio.setPagePaused(true).catch(onError)
      input?.close()
      try {
        await session.stop()
      } finally {
        if (session.isDisposed) {
          pageActivity.close()
          await video.close()
          videoChannel.port1.close()
          videoChannel.port2.close()
          await audio.close()
          audioChannel.port1.close()
          audioChannel.port2.close()
        }
      }
    },
  }
}
