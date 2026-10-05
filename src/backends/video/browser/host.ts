import { PausableTimeouts } from '../../shared/pausable-timeouts.ts'
import {
  emptyVideoSnapshot,
  type VideoCommand,
  type VideoEvent,
  type VideoMixingBitmap,
  type VideoResult,
  type VideoSettings,
  type VideoSnapshot,
  type VideoTimeline,
} from '../../../engine/ports/video.ts'
import { videoFrameAt, videoPresentedFrameAt, videoReportedFrameAt,
  videoClockFrameAt, videoClockFrameTime, videoClockSnapshot, videoClockFrameUpdate } from '../../../engine/media/video-time.ts'
import { videoOutputRectangle } from '../../../engine/media/video-mixing.ts'
import type { Pixels } from '../../../engine/ports/graphics.ts'
import type { WindowView } from '../../../engine/scene/window.ts'
import type { VideoMessage, VideoRequest } from '../../../protocol/video.ts'
import type { WebAudioHost } from '../../audio/web/host.ts'
import type { CursorRasterLayer, CursorScene } from '../../input/cursor.ts'
import { VideoEncodedResources, type VideoEncodedSource, type VideoEncodedVariant } from './encoded-source.ts'
import {
  createVideoMixingSurface,
  releaseVideoMixingSurface,
  videoMixingBudget,
  type VideoMixingSurface,
} from './mixing-bitmap.ts'
interface Movie {
  id: number
  epoch: number
  windowId: number
  element: HTMLVideoElement
  container: HTMLDivElement
  url: string
  source: VideoEncodedSource
  variant: VideoEncodedVariant
  mime: string
  lastSelectedIndex: number
  presentedTime?: number
  switching?: VideoStage
  bytes: number
  settings: VideoSettings
  status: VideoSnapshot['status']
  timeline?: VideoTimeline
  callback?: number
  inFlight?: number
  blocked: boolean
  disposed: boolean
  periodArmed: boolean
  seeking: boolean
  abort: AbortController
  audio: ReturnType<WebAudioHost['connectMedia']>
  surface?: OffscreenCanvas
  mixing?: VideoMixingSurface
}
interface VideoStage {
  id: number
  epoch: number
  windowId: number
  source: VideoEncodedSource
  abort: AbortController
  previous?: Movie
  movie?: Movie
  variant?: VideoEncodedVariant
  disposed: boolean
}
interface VideoWindow {
  epoch: number
  view?: WindowView
  surface?: VideoSurface
}
interface VideoSurface {
  canvas: HTMLCanvasElement
  plane: HTMLElement
  ownedPlane: boolean
  activation: HTMLButtonElement
  observer: ResizeObserver
}
export class WebVideoHost {
  private readonly timeouts = new PausableTimeouts()
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private movies = new Map<number, Movie>()
  private readonly encoded = new VideoEncodedResources()
  private readonly stages = new Map<number, VideoStage>()
  private mixingBytes = 0
  private retainedFrameBytes = 0
  private closed = false
  private closing?: Promise<void>
  private paused = false
  private pagePaused = false
  private get isPaused(): boolean {
    return this.paused || this.pagePaused
  }
  setPagePaused(paused: boolean): void {
    if (this.closed || this.pagePaused === paused) return
    this.pagePaused = paused
    this.applyPause()
  }
  private applyPause(): void {
    for (const movie of this.movies.values())
      if (this.isPaused) {
        movie.element.pause()
        this.cancelFrame(movie)
      } else if (movie.status === 'play') this.play(movie)
  }
  private nextEvent = 1
  private readonly windows = new Map<number, VideoWindow>()
  private readonly retiredWindows = new Set<number>()
  private parking?: HTMLDivElement
  private readonly port: MessagePort
  private readonly audio: WebAudioHost
  constructor(port: MessagePort, audio: WebAudioHost)
  constructor(port: MessagePort, canvas: HTMLCanvasElement, audio: WebAudioHost)
  constructor(
    port: MessagePort,
    canvasOrAudio: HTMLCanvasElement | WebAudioHost,
    audio?: WebAudioHost,
  ) {
    this.port = port
    this.audio = audio ?? (canvasOrAudio as WebAudioHost)
    // The legacy standalone host has one unnamed window. Session opens always
    // carry the native Window identity and use explicit surface attachment.
    if (audio) this.attachWindow(0, 0, canvasOrAudio as HTMLCanvasElement)
    port.onmessage = (event: MessageEvent<VideoRequest | VideoMessage>) => {
      const message = event.data
      if ('type' in message) {
        if (message.type === 'ack')
          for (const movie of this.movies.values())
            if (movie.inFlight === message.serial) movie.inFlight = undefined
        return
      }
      void this.command(message.command)
        .then(
          (result) =>
            port.postMessage(
              { type: 'reply', serial: message.serial, result } satisfies VideoMessage,
              result.events.flatMap((event) =>
                event.type === 'frame' && event.pixels
                  ? [event.pixels.data.buffer as ArrayBuffer]
                  : [],
              ),
            ),
          (error) =>
            port.postMessage({
              type: 'reply',
              serial: message.serial,
              error: error instanceof Error ? error.message : String(error),
            } satisfies VideoMessage),
        )
        .catch((error) => {
          if (!this.closed) this.fail(error)
        })
    }
  }
  private window(id: number): VideoWindow {
    let window = this.windows.get(id)
    if (!window) {
      window = { epoch: -1 }
      this.windows.set(id, window)
    }
    return window
  }
  setWindow(view: WindowView, id = 0): void {
    if (this.closed || this.retiredWindows.has(id)) return
    this.window(id).view = view
    this.layout(id)
  }
  /** A synchronous description of the host-owned raster stack. Read actual
   * DOM rectangles so responsive layout, video output sizing and clipping agree
   * with the pixels beneath a destination-dependent cursor. Layer-mode movies
   * are already inside the game canvas and must not be painted a second time. */
  cursorScene(id: number, epoch: number): CursorScene | undefined {
    const window = this.windows.get(id), surface = window?.surface
    if (this.closed || window?.epoch !== epoch || !surface || !surface.plane.isConnected)
      return undefined
    const layers: CursorRasterLayer[] = [],
      movies = new Map<HTMLDivElement, Movie>([...this.movies.values()].filter((movie) => movie.windowId === id)
        .map((movie) => [movie.container, movie]))
    for (const child of surface.plane.children) {
      const movie = movies.get(child as HTMLDivElement)
      if (!movie || movie.disposed || movie.settings.mode === 1) continue
      const style = getComputedStyle(movie.container)
      if (style.display === 'none' || style.visibility !== 'visible') continue
      const rectangle = movie.container.getBoundingClientRect()
      if (!rectangle.width || !rectangle.height) continue
      layers.push({ rectangle, clip: rectangle, background: style.backgroundColor })
      const video = movie.element, videoStyle = getComputedStyle(video)
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight &&
          videoStyle.display !== 'none' && videoStyle.visibility === 'visible')
        layers.push({ source: video, rectangle: video.getBoundingClientRect(), clip: rectangle,
          opacity: Number(videoStyle.opacity),
          smoothing: videoStyle.imageRendering !== 'pixelated' && videoStyle.imageRendering !== 'crisp-edges' })
      const bitmap = movie.mixing?.canvas
      if (bitmap?.parentElement === movie.container) {
        const bitmapStyle = getComputedStyle(bitmap)
        if (bitmapStyle.display !== 'none' && bitmapStyle.visibility === 'visible')
          layers.push({ source: bitmap, rectangle: bitmap.getBoundingClientRect(), clip: rectangle,
            opacity: Number(bitmapStyle.opacity),
            smoothing: bitmapStyle.imageRendering !== 'pixelated' && bitmapStyle.imageRendering !== 'crisp-edges' })
      }
    }
    return { plane: surface.plane, layers }
  }
  attachWindow(id: number, epoch: number, canvas: HTMLCanvasElement, plane?: HTMLElement): void {
    if (this.closed || this.retiredWindows.has(id)) return
    const window = this.window(id)
    if (epoch <= window.epoch) return
    // Epochs are consumed even if DOM acquisition fails. A retry must acquire a
    // new surface, and an old ResizeObserver cannot move movies back to it.
    this.releaseSurface(id, window)
    window.epoch = epoch
    const target = plane ?? document.createElement('div'),
      activation = document.createElement('button')
    const observer = new ResizeObserver(() => {
      if (this.windows.get(id) === window && window.surface === surface) this.layout(id)
    })
    const surface: VideoSurface = {
      canvas,
      plane: target,
      ownedPlane: !plane,
      activation,
      observer,
    }
    try {
      target.classList.add('video-plane')
      target.dataset.windowId = String(id)
      target.dataset.surfaceEpoch = String(epoch)
      Object.assign(target.style, {
        position: 'absolute',
        overflow: 'hidden',
        pointerEvents: 'none',
        zIndex: '2',
      })
      activation.textContent = '播放视频'
      activation.hidden = true
      Object.assign(activation.style, {
        position: 'absolute',
        left: '50%',
        top: '50%',
        transform: 'translate(-50%,-50%)',
        pointerEvents: 'auto',
        zIndex: '20',
      })
      activation.onclick = () => {
        if (window.surface === surface) this.activate(id)
      }
      target.append(activation)
      if (!plane) canvas.parentElement?.append(target)
      window.surface = surface
      observer.observe(canvas)
      for (const movie of this.movies.values())
        if (movie.windowId === id) target.insertBefore(movie.container, activation)
      this.layout(id)
      this.trimParking()
    } catch (error) {
      // Every acquired observer and node is released, but the acquisition error
      // stays primary if cleanup also fails.
      window.surface = surface
      try {
        this.releaseSurface(id, window)
      } catch {}
      throw error
    }
  }
  detachWindow(id: number, epoch: number): void {
    if (this.closed || this.retiredWindows.has(id)) return
    const window = this.window(id)
    if (epoch < window.epoch) return
    // A detach can beat its asynchronous attach. Consume that epoch even when
    // no DOM was acquired, so the late attachment cannot resurrect it.
    window.epoch = epoch
    this.releaseSurface(id, window)
  }
  /** Retire a native Window, as opposed to replacing its graphics surface. */
  removeWindow(id: number): void {
    if (this.retiredWindows.has(id)) return
    this.retiredWindows.add(id)
    const window = this.windows.get(id)
    let primary: unknown,
      failed = false
    const attempt = (action: () => void) => {
      try {
        action()
      } catch (error) {
        if (!failed) primary = error
        failed = true
      }
    }
    for (const stage of [...this.stages.values()])
      if (stage.windowId === id) attempt(() => this.retireStage(stage))
    for (const movie of this.movies.values())
      if (movie.windowId === id) attempt(() => this.remove(movie.id))
    if (window) attempt(() => this.releaseSurface(id, window))
    this.windows.delete(id)
    attempt(() => this.trimParking())
    if (failed) throw primary
  }
  private park(movie: Movie): void {
    if (!this.parking) {
      const parking = document.createElement('div')
      parking.className = 'video-parking'
      parking.inert = true
      parking.setAttribute('aria-hidden', 'true')
      Object.assign(parking.style, {
        position: 'fixed',
        left: '0',
        top: '0',
        width: '1px',
        height: '1px',
        overflow: 'hidden',
        pointerEvents: 'none',
        opacity: '0',
      })
      document.body.append(parking)
      this.parking = parking
    }
    movie.container.style.visibility = 'hidden'
    this.parking.append(movie.container)
  }
  private trimParking(): void {
    if (this.parking && !this.parking.childElementCount) {
      this.parking.remove()
      this.parking = undefined
    }
  }
  private releaseSurface(id: number, window: VideoWindow): void {
    const surface = window.surface
    if (!surface) return
    window.surface = undefined
    let primary: unknown,
      failed = false
    const attempt = (action: () => void) => {
      try {
        action()
      } catch (error) {
        if (!failed) primary = error
        failed = true
      }
    }
    attempt(() => surface.observer.disconnect())
    // Keep decoded media, its clock and audio graph during graphics recovery.
    // Connected hidden parking also lets a pre-attachment open decode frame 0.
    for (const movie of this.movies.values())
      if (movie.windowId === id) attempt(() => this.park(movie))
    attempt(() => {
      surface.activation.onclick = null
      surface.activation.remove()
    })
    attempt(() => {
      if (surface.ownedPlane) surface.plane.remove()
      else surface.plane.classList.remove('video-plane')
    })
    if (failed) throw primary
  }
  private layout(id?: number): void {
    for (const [windowId, window] of this.windows) {
      if (id !== undefined && windowId !== id) continue
      const surface = window.surface
      if (!surface) continue
      const { canvas, plane, activation } = surface,
        width = canvas.clientWidth,
        height = canvas.clientHeight,
        view = window.view
      Object.assign(plane.style, {
        left: `${canvas.offsetLeft}px`,
        top: `${canvas.offsetTop}px`,
        width: `${width}px`,
        height: `${height}px`,
        visibility: view?.visible === false ? 'hidden' : 'visible',
      })
      const geometry = view?.geometry,
        sx = width / Math.max(1, geometry?.viewport.width ?? view?.width ?? 800),
        sy = height / Math.max(1, geometry?.viewport.height ?? view?.height ?? 600)
      let blocked = false
      for (const movie of this.movies.values()) {
        if (movie.windowId !== windowId) continue
        const s = movie.settings,
          layer = s.mode === 1,
          output = videoOutputRectangle(s, {
            zoomNumer: view?.zoomNumer ?? 1,
            zoomDenom: view?.zoomDenom ?? 1,
            geometry,
          })
        Object.assign(movie.container.style, {
          position: 'absolute',
          // Overlay/mixer rectangles use GetWindowHandle's client offset,
          // already represented by this viewport plane. Only vomLayer pixels
          // travel through the scrolling PaintBox; adding layerLeft here is wrong.
          left: `${output.left * sx}px`,
          top: `${output.top * sy}px`,
          width: `${(s.mode === 2 ? Math.max(0, output.width) : output.width) * sx}px`,
          height: `${(s.mode === 2 ? Math.max(0, output.height) : output.height) * sy}px`,
          visibility: layer || !s.visible || view?.visible === false ? 'hidden' : 'visible',
          overflow: 'hidden',
          backgroundColor: `#${(s.mixingMovieBGColor & 0xffffff).toString(16).padStart(6, '0')}`,
        })
        Object.assign(movie.element.style, {
          display: 'block',
          width: '100%',
          height: '100%',
          objectFit: 'fill',
          opacity: String(s.mode === 2 ? s.mixingMovieAlpha : 1),
        })
        blocked ||= movie.blocked && movie.status === 'play'
      }
      activation.hidden = !blocked || view?.visible === false
    }
  }
  activate(windowId?: number): void {
    this.audio.activate()
    for (const movie of this.movies.values())
      if (movie.status === 'play' && (windowId === undefined || movie.windowId === windowId))
        this.play(movie)
  }
  private get(id: number): Movie {
    const movie = this.movies.get(id)
    if (!movie || movie.disposed) throw new Error('Video is closed')
    return movie
  }
  private current(movie: Movie, epoch = movie.epoch): void {
    if (movie.disposed || this.movies.get(movie.id) !== movie || movie.epoch !== epoch)
      throw new Error('Video operation was closed or superseded')
  }
  private snapshot(movie: Movie, time = movie.element.currentTime * 1000): VideoSnapshot {
    const duration = Number.isFinite(movie.element.duration) ? movie.element.duration * 1000 : 0,
      timeline = movie.timeline
    return {
      ...emptyVideoSnapshot(movie.id, movie.epoch),
      ...movie.settings,
      id: movie.id,
      epoch: movie.epoch,
      status: movie.status,
      ...videoClockSnapshot(timeline, time, duration),
      originalWidth: movie.element.videoWidth,
      originalHeight: movie.element.videoHeight,
      numberOfAudioStream: timeline?.audioStreams ?? 0,
      numberOfVideoStream: timeline?.videoStreams ?? 1,
      enabledVideoStream: 0,
    }
  }
  private emit(event: VideoEvent, frame = false, movie?: Movie): void {
    if (this.closed) return
    const serial = this.nextEvent++
    if (frame && movie) movie.inFlight = serial
    const message: VideoMessage = { type: 'event', event, serial }
    this.port.postMessage(
      message,
      event.type === 'frame' && event.pixels ? [event.pixels.data.buffer as ArrayBuffer] : [],
    )
  }
  private pixels(movie: Movie): Pixels | undefined {
    if (movie.settings.mode !== 1 || movie.element.readyState < 2) return
    return this.decodedPixels(movie)
  }
  private decodedPixels(movie: Movie): Pixels {
    if (movie.element.readyState < 2) throw new Error('Video has no decoded image')
    const width = movie.element.videoWidth,
      height = movie.element.videoHeight
    if (width <= 0 || height <= 0 || width > 4096 || height > 4096)
      throw new Error('Video frame exceeds bitmap dimensions')
    const surface = (movie.surface ??= new OffscreenCanvas(width, height))
    if (surface.width !== width || surface.height !== height) {
      surface.width = width
      surface.height = height
    }
    const context = surface.getContext('2d', { willReadFrequently: true })!
    context.drawImage(movie.element, 0, 0)
    return {
      width,
      height,
      data: new Uint8Array(context.getImageData(0, 0, width, height).data.buffer),
    }
  }
  private frame(movie: Movie, presentationTime?: number): VideoEvent & { type: 'frame' } {
    const snapshot = this.snapshot(movie),
      // Browser rVFC supplies mediaTime, not BufferRenderer's IMediaSample
      // media-time value. Convert this producer's observation by cadence, then
      // apply the original layer/mixer consumer rule independently of getters.
      rendererFrame = presentationTime === undefined ? undefined : videoClockFrameAt(movie.timeline, presentationTime)
    return {
      type: 'frame',
      id: movie.id,
      epoch: movie.epoch,
      snapshot,
      callbackFrame: videoClockFrameUpdate(movie.settings.mode, snapshot.frame, rendererFrame),
      pixels: this.pixels(movie),
    }
  }
  private cancelFrame(movie: Movie): void {
    if (movie.callback !== undefined) {
      const callback = movie.callback
      movie.callback = undefined
      movie.element.cancelVideoFrameCallback(callback)
    }
  }
  private arm(movie: Movie): void {
    if (movie.disposed || movie.switching || this.isPaused || movie.status !== 'play' || movie.callback !== undefined)
      return
    movie.callback = movie.element.requestVideoFrameCallback((_now, metadata) => {
      movie.callback = undefined
      if (movie.disposed || movie.switching || this.isPaused || movie.seeking || movie.status !== 'play') return
      movie.presentedTime = metadata.mediaTime * 1000
      try {
        if (this.advanceClock(movie, false)) return
        const s = movie.settings
        let periodFrame = videoClockFrameUpdate(s.mode, this.snapshot(movie).frame,
          videoClockFrameAt(movie.timeline, metadata.mediaTime * 1000))
        if (movie.inFlight === undefined && (s.mode === 1 || s.mode === 2)) {
          const event = this.frame(movie, metadata.mediaTime * 1000)
          this.emit(event, true, movie)
          periodFrame = event.callbackFrame ?? event.snapshot.frame
        }
        // Native EC_UPDATE publishes the layer frame before testing its period
        // threshold. Mixer uses GetFrame; layer uses its corrected renderer value.
        this.period(movie, periodFrame)
      } catch (error) {
        this.fail(error)
      }
      this.arm(movie)
    })
  }
  private period(movie: Movie, frame: number): void {
    const s = movie.settings
    if (!movie.periodArmed || s.periodEventFrame < 0 || frame < s.periodEventFrame) return
    s.periodEventFrame = -1
    movie.periodArmed = false
    this.emit({ type: 'period', id: movie.id, epoch: movie.epoch, snapshot: this.snapshot(movie), reason: 1 })
  }
  private advanceClock(movie: Movie, fallbackPeriod = true): boolean {
    if (movie.disposed || movie.switching || this.isPaused || movie.seeking || movie.status !== 'play') return true
    const s = movie.settings,
      time = movie.element.currentTime * 1000
    // Segment boundaries use the media clock in both native presentation modes
    // and take precedence over that update's frame/ordinary-period delivery.
    if (s.segmentLoopEndFrame > 0 && movie.timeline) {
      if (videoClockFrameAt(movie.timeline, time) >= s.segmentLoopEndFrame) {
        void this.seek(
          movie,
          videoClockFrameTime(movie.timeline, Math.max(0, s.segmentLoopStartFrame), movie.element.duration * 1000),
        ).then(
          () => {
            if (movie.disposed) return
            this.emit({
              type: 'period',
              id: movie.id,
              epoch: movie.epoch,
              snapshot: this.snapshot(movie),
              reason: 3,
            })
            this.play(movie)
          },
          (error) => {
            if (!movie.disposed) this.fail(error)
          },
        )
        return true
      }
    }
    // Browser timeupdate remains a clock-based supplement when rVFC is delayed
    // or withheld. It is not evidence of a particular decoded/rendered frame.
    if (fallbackPeriod) this.period(movie, videoClockFrameAt(movie.timeline, time))
    return false
  }
  private fail(error: unknown): void {
    this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  private play(movie: Movie): void {
    if (movie.disposed || movie.switching || this.isPaused) return
    const epoch = movie.epoch
    this.arm(movie)
    void movie.element.play().then(
      () => {
        if (movie.disposed || epoch !== movie.epoch) return
        movie.blocked = false
        this.layout()
      },
      (error) => {
        if (movie.disposed || epoch !== movie.epoch) return
        if (error instanceof DOMException && error.name === 'NotAllowedError') {
          movie.blocked = true
          this.layout()
        } else if (!(error instanceof DOMException && error.name === 'AbortError')) this.fail(error)
      },
    )
  }
  private async wait(
    movie: Movie,
    name: string,
    ready: () => boolean,
    start?: () => void,
  ): Promise<void> {
    if (ready() && !start) return
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (error?: unknown) => {
        if (settled) return
        settled = true
        cancelTimeout()
        movie.element.removeEventListener(name, success)
        movie.element.removeEventListener('error', failure)
        movie.abort.signal.removeEventListener('abort', cancel)
        error ? reject(error) : resolve()
      }
      const success = () => {
          try { if (ready()) done() } catch (error) { done(error) }
        },
        failure = () =>
          done(
            new Error(
              `Video decode failed (${movie.element.error?.message ?? movie.element.error?.code ?? 'unknown'})`,
            ),
          ),
        cancel = () => done(new Error('Video operation cancelled'))
      const cancelTimeout = this.timeouts.start(15000, () =>
        done(new Error(`Video ${name} timed out`)),
      )
      movie.element.addEventListener(name, success)
      movie.element.addEventListener('error', failure, { once: true })
      movie.abort.signal.addEventListener('abort', cancel, { once: true })
      if (movie.abort.signal.aborted) {
        cancel()
        return
      }
      try {
        start?.()
        if (ready()) done()
      } catch (error) {
        done(error)
      }
    })
  }
  private async seek(movie: Movie, position: number): Promise<void> {
    if (!Number.isFinite(position) || position < 0 || position > movie.element.duration * 1000)
      throw new Error('Video position is outside the stream')
    movie.seeking = true
    this.cancelFrame(movie)
    try {
      const time = position / 1000
      if (Math.abs(movie.element.currentTime - time) > 1e-8)
        await this.wait(
          movie,
          'seeked',
          () => !movie.element.seeking && Math.abs(movie.element.currentTime - time) < 1e-6,
          () => {
            movie.element.currentTime = time
          },
        )
      if (movie.settings.periodEventFrame >= 0)
        movie.periodArmed = this.snapshot(movie).frame < movie.settings.periodEventFrame
    } finally {
      movie.seeking = false
      this.arm(movie)
    }
  }
  private async seekPresented(movie: Movie, position: number, frameSeek = false): Promise<void> {
    const timeline = movie.timeline,
      // A public frame seek is truncated to 100 ns by the clock conversion.
      // Recover a unique neighbouring PTS before requesting its presentation;
      // arbitrary position seeks retain the ordinary sample-floor lookup.
      target = (frameSeek ? videoPresentedFrameAt(timeline!, position) : undefined) ?? videoFrameAt(timeline!, position),
      // Average-frame positions can lie inside a VFR sample. Firefox reports
      // such requested positions rather than a sample's exact PTS. This is a
      // public clock seek, not an assertion of byte-identical decoded images.
      matches = (time: number) => (frameSeek ? videoReportedFrameAt(timeline!, time) :
        videoPresentedFrameAt(timeline!, time)) === target
    if (Math.abs(movie.element.currentTime * 1000 - position) <= 0.00001 &&
        movie.presentedTime !== undefined && matches(movie.presentedTime)) {
      await this.seek(movie, position)
      if (movie.abort.signal.aborted) throw new Error('Video operation cancelled')
      return
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false, sought = false, presented = false, callback: number | undefined
      let cancelTimeout = () => {}
      const done = (error?: unknown) => {
        if (settled) return
        settled = true
        cancelTimeout()
        if (callback !== undefined) movie.element.cancelVideoFrameCallback(callback)
        movie.abort.signal.removeEventListener('abort', cancel)
        error ? reject(error) : resolve()
      }, complete = () => {
        if (sought && presented) {
          if (movie.element.seeking || Math.abs(movie.element.currentTime * 1000 - position) > 0.001)
            done(new Error('Video seek changed the requested media clock'))
          else done()
        }
      },
        cancel = () => done(new Error('Video operation cancelled')),
        request = () => {
          callback = movie.element.requestVideoFrameCallback((_now, metadata) => {
            callback = undefined
            if (settled) return
            movie.presentedTime = metadata.mediaTime * 1000
            if (matches(movie.presentedTime)) { presented = true; complete() }
            else { try { request() } catch (error) { done(error) } }
          })
        }
      movie.abort.signal.addEventListener('abort', cancel, { once: true })
      if (movie.abort.signal.aborted) { cancel(); return }
      cancelTimeout = this.timeouts.start(15000, () => done(new Error('Video selected track frame timed out')))
      try {
        request()
        void this.seek(movie, position).then(() => { sought = true; complete() }, done)
      } catch (error) { done(error) }
    })
  }
  private async seekRetainedFrame(movie: Movie, position: number, expected: Pixels,
    expectedPresentation: number, timeline: VideoTimeline): Promise<void> {
    const frame = videoReportedFrameAt(timeline, expectedPresentation)
    if (frame === undefined) throw new Error('The previous video presentation cannot be identified')
    const matches = (time: number) => videoReportedFrameAt(timeline, time) === frame,
      sameImage = () => {
        const actual = this.decodedPixels(movie)
        if (actual.width !== expected.width || actual.height !== expected.height ||
            actual.data.length !== expected.data.length)
          throw new Error('Selected audio track changed the decoded image dimensions')
        for (let at = 0; at < actual.data.length; at++)
          if (actual.data[at] !== expected.data[at])
            throw new Error('Selected audio track did not preserve the complete presented image')
      }
    if (Math.abs(movie.element.currentTime * 1000 - position) <= 0.00001 &&
        movie.presentedTime !== undefined && matches(movie.presentedTime)) {
      await this.seek(movie, position)
      if (movie.abort.signal.aborted) throw new Error('Video operation cancelled')
      sameImage()
      return
    }
    await new Promise<void>((resolve, reject) => {
      let settled = false, sought = false, presented = false, callback: number | undefined
      let cancelTimeout = () => {}
      const done = (error?: unknown) => {
        if (settled) return
        settled = true
        cancelTimeout()
        if (callback !== undefined) movie.element.cancelVideoFrameCallback(callback)
        movie.abort.signal.removeEventListener('abort', cancel)
        error ? reject(error) : resolve()
      }, complete = () => {
        if (!sought || !presented || settled) return
        try {
          if (movie.element.seeking || Math.abs(movie.element.currentTime * 1000 - position) > 0.001)
            throw new Error('Selected audio track changed the paused media clock')
          sameImage()
          done()
        } catch (error) { done(error) }
      }, cancel = () => done(new Error('Video operation cancelled')),
        request = () => {
          callback = movie.element.requestVideoFrameCallback((_now, metadata) => {
            callback = undefined
            if (settled) return
            movie.presentedTime = metadata.mediaTime * 1000
            if (matches(movie.presentedTime)) { presented = true; complete() }
            else {
              try { request() } catch (error) { done(error) }
            }
          })
        }
      movie.abort.signal.addEventListener('abort', cancel, { once: true })
      if (movie.abort.signal.aborted) { cancel(); return }
      cancelTimeout = this.timeouts.start(15000, () => done(new Error('Video retained frame timed out')))
      try {
        request()
        void this.seek(movie, position).then(() => { sought = true; complete() }, done)
      } catch (error) { done(error) }
    })
  }
  private loadFirstFrame(movie: Movie, load: () => Promise<void>): Promise<void> {
    // loadeddata may precede the first decoded/presented image. In particular,
    // an immediate paused seek can otherwise be overwritten by that initial
    // image, and layer readback can copy transparent pixels instead of a frame.
    return new Promise((resolve, reject) => {
      let loaded = false,
        presented = false,
        settled = false
      let callback: number | undefined
      let cancelTimeout = () => {}
      const done = (error?: unknown) => {
        if (settled) return
        settled = true
        cancelTimeout()
        if (callback !== undefined) movie.element.cancelVideoFrameCallback(callback)
        movie.abort.signal.removeEventListener('abort', cancel)
        error ? reject(error) : resolve()
      }
      const complete = () => {
        if (loaded && presented) done()
      }
      const cancel = () => done(new Error('Video operation cancelled'))
      movie.abort.signal.addEventListener('abort', cancel, { once: true })
      if (movie.abort.signal.aborted) return cancel()
      cancelTimeout = this.timeouts.start(15000, () =>
        done(new Error('Video first frame timed out')),
      )
      try {
        callback = movie.element.requestVideoFrameCallback((_now, metadata) => {
          movie.presentedTime = metadata.mediaTime * 1000
          presented = true
          complete()
        })
        void load().then(() => {
          loaded = true
          complete()
        }, done)
      } catch (error) {
        done(error)
      }
    })
  }
  private applySettings(movie: Movie, settings: VideoSettings): void {
    if (settings.periodEventFrame >= 0 && !movie.timeline?.times.length)
      throw new Error('This video container has no supported frame index')
    if (!Number.isInteger(settings.enabledAudioStream) || settings.enabledAudioStream < -1 ||
        (settings.enabledAudioStream > 0 && (!movie.timeline || settings.enabledAudioStream >= movie.timeline.audioStreams)))
      throw new Error('Invalid video audio stream')
    if (settings.segmentLoopEndFrame >= 0) {
      videoClockFrameTime(movie.timeline, settings.segmentLoopStartFrame, movie.element.duration * 1000)
      if (settings.segmentLoopEndFrame > videoClockFrameAt(movie.timeline, movie.element.duration * 1000))
        throw new Error('Video segment ends outside its frame clock')
    }
    if (settings.periodEventFrame !== movie.settings.periodEventFrame)
      movie.periodArmed =
        settings.periodEventFrame >= 0 && this.snapshot(movie).frame < settings.periodEventFrame
    movie.settings = { ...settings,
      ...(movie.timeline?.audioStreams === 0 ? { enabledAudioStream: -1 } : {}) }
    movie.element.playbackRate = settings.playRate
    movie.element.preservesPitch = false
    movie.audio.set(
      movie.settings.enabledAudioStream === -1 ? 0 : settings.audioVolume,
      settings.audioBalance,
    )
    this.layout()
  }
  private mixing(movie: Movie, bitmap: VideoMixingBitmap | null): void {
    if (movie.settings.mode !== 2) return
    const previous = movie.mixing
    if (!bitmap) {
      this.releaseMixing(movie)
      return
    }
    const next = createVideoMixingSurface(
      bitmap,
      videoMixingBudget - this.mixingBytes + (previous?.bytes ?? 0),
    )
    try {
      next.canvas.dataset.videoId = String(movie.id)
      next.canvas.dataset.mixingWindowId = String(movie.windowId)
      movie.container.append(next.canvas)
    } catch (error) {
      try {
        releaseVideoMixingSurface(next)
      } catch {}
      throw error
    }
    movie.mixing = next
    this.mixingBytes += next.bytes - (previous?.bytes ?? 0)
    if (previous) releaseVideoMixingSurface(previous)
  }
  private releaseMixing(movie: Movie): void {
    const surface = movie.mixing
    if (!surface) return
    movie.mixing = undefined
    this.mixingBytes -= surface.bytes
    releaseVideoMixingSurface(surface)
  }
  private stageCurrent(stage: VideoStage): void {
    if (this.closed || stage.disposed || stage.abort.signal.aborted || this.stages.get(stage.id) !== stage ||
        this.retiredWindows.has(stage.windowId) || (stage.previous &&
          (this.movies.get(stage.id) !== stage.previous || stage.previous.epoch !== stage.epoch)))
      throw new Error('Video operation was closed or superseded')
  }
  private retireStage(stage: VideoStage): void {
    if (stage.disposed) return
    stage.disposed = true
    if (this.stages.get(stage.id) === stage) this.stages.delete(stage.id)
    if (stage.previous?.switching === stage) stage.previous.switching = undefined
    const errors: unknown[] = []
    for (const release of [() => stage.abort.abort(), () => {
      if (stage.movie) this.disposeMovie(stage.movie)
      else {
        try { stage.variant?.release() } finally { stage.source.release() }
      }
    }]) {
      try { release() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw errors.length === 1 ? errors[0] : new AggregateError(errors, 'Video candidate cleanup failed')
  }
  private createMovie(stage: VideoStage, epoch: number, settings: VideoSettings,
    timeline: VideoTimeline | undefined, mime: string, selected: number): Movie {
    const element = document.createElement('video')
    element.playsInline = true
    element.preload = 'auto'
    element.controls = false
    if (!stage.previous) {
      element.dataset.videoId = String(stage.id)
      element.dataset.windowId = String(stage.windowId)
    }
    let audio: Movie['audio'] | undefined, container: HTMLDivElement | undefined
    try {
      audio = this.audio.connectMedia(element)
      audio.set(0, 0)
      container = document.createElement('div')
      container.append(element)
      const movie: Movie = { id: stage.id, epoch, windowId: stage.windowId, element, container,
        source: stage.source, variant: stage.variant!, url: stage.variant!.url, mime,
        bytes: stage.source.size, lastSelectedIndex: selected, settings: { ...settings }, status: 'stop',
        timeline, blocked: false, disposed: false, periodArmed: false, seeking: false,
        abort: stage.abort, audio }
      stage.movie = movie
      return movie
    } catch (error) {
      // The stage still owns the source and URL when DOM/audio acquisition has
      // not reached a Movie. Preserve the original construction failure.
      for (const release of [() => audio?.close(), () => element.pause(), () => {
        element.removeAttribute('src'); element.load()
      }, () => container?.remove()]) {
        try { release() } catch {}
      }
      throw error
    }
  }
  private bindMovie(movie: Movie): void {
    const element = movie.element
    element.ontimeupdate = () => {
      try { this.advanceClock(movie) } catch (error) { this.fail(error) }
    }
    element.onended = () => {
      if (movie.disposed || movie.status !== 'play' || !element.ended) return
      if (this.advanceClock(movie)) return
      if (movie.settings.loop)
        void this.seek(movie, 0).then(() => {
          if (movie.disposed || this.movies.get(movie.id) !== movie) return
          this.emit({ type: 'period', id: movie.id, epoch: movie.epoch, snapshot: this.snapshot(movie), reason: 0 })
          this.play(movie)
        }, (error) => { if (!movie.disposed) this.fail(error) })
      else {
        movie.status = 'stop'
        this.cancelFrame(movie)
        this.emit({ type: 'ended', id: movie.id, epoch: movie.epoch, snapshot: this.snapshot(movie) })
      }
    }
    element.addEventListener('error', () => {
      if (!movie.disposed)
        this.fail(new Error(`Video playback failed: ${element.error?.message ?? element.error?.code}`))
    }, { signal: movie.abort.signal })
  }
  private async loadMovie(movie: Movie): Promise<void> {
    await this.loadFirstFrame(movie, () => this.wait(movie, 'loadeddata', () => movie.element.readyState >= 2, () => {
      movie.element.src = movie.url
      movie.element.load()
    }))
    if (!movie.element.videoWidth || movie.element.videoWidth > 4096 || movie.element.videoHeight > 4096 ||
        !Number.isFinite(movie.element.duration)) throw new Error('Invalid video dimensions or duration')
  }
  private async open(command: Extract<VideoCommand, { op: 'open' }>): Promise<VideoResult> {
    const windowId = command.windowId ?? 0
    if (this.retiredWindows.has(windowId)) throw new Error('Video Window is closed')
    if (!Number.isSafeInteger(windowId) || windowId < 0)
      throw new Error('Invalid video Window identity')
    this.window(windowId)
    const previous = this.movies.get(command.id)
    const pending = this.stages.get(command.id)
    if ((previous && command.epoch < previous.epoch) || (pending && command.epoch < pending.epoch))
      throw new Error('Video open was superseded')
    this.remove(command.id)
    if (command.settings.mode === 3)
      throw new Error('Media Foundation video mode is unavailable on the Web')
    if (new Set([...this.movies.keys(), ...this.stages.keys()]).size >= 16)
      throw new Error('Video resource budget exceeded')
    const extension = command.name.split('?')[0]!.split('.').pop()?.toLowerCase(),
      mime =
        extension === 'webm'
          ? 'video/webm'
          : extension === 'mp4' || extension === 'm4v' || extension === 'mov'
            ? 'video/mp4'
            : ''
    const source = this.encoded.source(command.bytes),
      stage: VideoStage = { id: command.id, epoch: command.epoch, windowId, source, abort: new AbortController(), disposed: false },
      selected = Math.max(0, command.settings.enabledAudioStream)
    this.stages.set(stage.id, stage)
    try {
      const variant = command.timeline && command.timeline.audioStreams > 1
        ? await this.encoded.select(source, selected, command.timeline, mime, () => this.stageCurrent(stage))
        : this.encoded.original(source, mime)
      if (stage.disposed) { variant.release(); throw new Error('Video operation cancelled') }
      stage.variant = variant
      this.stageCurrent(stage)
      const movie = this.createMovie(stage, command.epoch, command.settings, command.timeline, mime, selected)
      this.movies.set(movie.id, movie)
      const surface = this.windows.get(windowId)?.surface
      if (surface) surface.plane.insertBefore(movie.container, surface.activation)
      else this.park(movie)
      this.layout(windowId)
      await this.loadMovie(movie)
      this.stageCurrent(stage)
      this.current(movie)
      this.applySettings(movie, command.settings)
      this.bindMovie(movie)
      this.stages.delete(stage.id)
      return { snapshot: this.snapshot(movie), events: [] }
    } catch (error) {
      if (this.movies.get(stage.id) === stage.movie) this.movies.delete(stage.id)
      try { this.retireStage(stage) } catch {}
      try { this.layout() } catch {}
      throw error
    }
  }
  private async settings(movie: Movie, settings: VideoSettings): Promise<Movie> {
    const index = settings.enabledAudioStream
    if (index < 0 || index === movie.lastSelectedIndex) {
      this.applySettings(movie, settings)
      return movie
    }
    if (!Number.isSafeInteger(index) || !movie.timeline || index >= movie.timeline.audioStreams)
      throw new Error('Invalid video audio stream')
    const stage: VideoStage = { id: movie.id, epoch: movie.epoch, windowId: movie.windowId, previous: movie,
      source: movie.source.retain(), abort: new AbortController(), disposed: false }
    this.stages.set(movie.id, stage)
    movie.switching = stage
    let committed = false, candidate: Movie | undefined, retained: Pixels | undefined, reserved = 0
    try {
      // Switching is deliberately not gapless. Freeze the authoritative media
      // clock before preparing the candidate, so no period/loop/ended boundary
      // or old-epoch layer frame is consumed during the asynchronous handoff.
      movie.element.pause()
      this.cancelFrame(movie)
      const position = movie.element.currentTime * 1000, presentation = movie.presentedTime,
        bytes = movie.element.videoWidth * movie.element.videoHeight * 4
      // Reserve both complete readbacks before allocation. Decoder/GPU memory
      // and delayed garbage collection are separate from these owned buffers.
      if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > 64 * 1024 * 1024 ||
          bytes * 2 > 128 * 1024 * 1024 - this.retainedFrameBytes)
        throw new Error('Video retained frame resource budget exceeded')
      if (presentation === undefined) throw new Error('Video has no observed presentation')
      this.retainedFrameBytes += reserved = bytes * 2
      retained = this.decodedPixels(movie)
      const variant = await this.encoded.select(stage.source, index, movie.timeline, movie.mime,
        () => this.stageCurrent(stage))
      if (stage.disposed) { variant.release(); throw new Error('Video operation cancelled') }
      stage.variant = variant
      this.stageCurrent(stage)
      candidate = this.createMovie(stage, stage.epoch, settings, movie.timeline, movie.mime, index)
      this.park(candidate)
      await this.loadMovie(candidate)
      this.stageCurrent(stage)
      if (candidate.element.videoWidth !== movie.element.videoWidth || candidate.element.videoHeight !== movie.element.videoHeight ||
          Math.abs(candidate.element.duration - movie.element.duration) > 0.001)
        throw new Error('Selected audio track changed the video presentation timeline')
      this.applySettings(candidate, settings)
      await this.seekRetainedFrame(candidate, position, retained, presentation, movie.timeline)
      this.stageCurrent(stage)
      candidate.periodArmed = movie.periodArmed
      candidate.blocked = movie.blocked
      this.bindMovie(candidate)
      const surface = this.windows.get(movie.windowId)?.surface
      if (surface) surface.plane.insertBefore(candidate.container,
        movie.container.parentElement === surface.plane ? movie.container : surface.activation)
      else this.park(candidate)
      if (movie.mixing) candidate.container.append(movie.mixing.canvas)
      candidate.element.dataset.videoId = String(movie.id)
      candidate.element.dataset.windowId = String(movie.windowId)
      candidate.status = movie.status
      this.movies.set(movie.id, candidate)
      this.layout(movie.windowId)
      candidate.mixing = movie.mixing
      movie.mixing = undefined
      movie.switching = undefined
      this.stages.delete(stage.id)
      committed = true
      // The new graph is still paused. Retire the old graph before allowing
      // playback, so two selected tracks can never be audible together.
      const cleanupErrors: unknown[] = []
      for (const complete of [() => this.disposeMovie(movie), () => this.trimParking(),
        () => { if (candidate!.status === 'play') this.play(candidate!) }]) {
        try { complete() } catch (error) { cleanupErrors.push(error) }
      }
      if (cleanupErrors.length) throw cleanupErrors.length === 1 ? cleanupErrors[0]
        : new AggregateError(cleanupErrors, 'Video selected track was installed but old resource cleanup failed')
      return candidate
    } catch (error) {
      if (!committed) {
        if (candidate && this.movies.get(movie.id) === candidate) this.movies.set(movie.id, movie)
        if (movie.mixing && movie.mixing.canvas.parentElement !== movie.container) {
          try { movie.container.append(movie.mixing.canvas) } catch {}
        }
        try { this.retireStage(stage) } catch {}
        if (!this.closed && !movie.disposed && this.movies.get(movie.id) === movie && !movie.switching) {
          try { this.layout(movie.windowId) } catch {}
          if (movie.status === 'play') this.play(movie)
        }
      }
      throw error
    } finally {
      retained = undefined
      this.retainedFrameBytes -= reserved
    }
  }
  private async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'cancel') {
      this.paused = true
      let primary: unknown,
        failed = false
      for (const id of new Set([...this.movies.keys(), ...this.stages.keys()])) {
        try {
          this.remove(id)
        } catch (error) {
          if (!failed) primary = error
          failed = true
        }
      }
      if (failed) throw primary
      return { events: [] }
    }
    if (this.closed) throw new Error('Video host is closed')
    if (command.op === 'pauseAll') {
      this.paused = command.paused
      this.applyPause()
      return { events: [] }
    }
    if (command.op === 'open') return this.open(command)
    if (command.op === 'close') {
      const movie = this.movies.get(command.id), stage = this.stages.get(command.id)
      if ((movie && command.epoch < movie.epoch) || (stage && command.epoch < stage.epoch)) return { events: [] }
      this.remove(command.id)
      return { events: [] }
    }
    let movie = this.get(command.id)
    const events: VideoEvent[] = []
    if (command.epoch < movie.epoch) throw new Error('Video operation was superseded')
    const opening = this.stages.get(movie.id)
    if (opening && !opening.previous)
      throw new Error('Video is still opening; only close or replacement open is available')
    if (command.op !== 'inspect' && command.op !== 'mixing') {
      const stage = this.stages.get(movie.id)
      if (stage?.previous === movie) this.retireStage(stage)
    }
    movie.epoch = command.epoch
    if (command.op === 'set') {
      const previous = movie
      movie = await this.settings(movie, command.settings)
      if (movie !== previous && (movie.settings.mode === 1 || movie.settings.mode === 2)) events.push(this.frame(movie))
    }
    else if (command.op === 'mixing') this.mixing(movie, command.bitmap)
    else if (command.op === 'seek' || command.op === 'rewind') {
      const time =
        command.op === 'seek'
          ? command.frame !== undefined
            ? videoClockFrameTime(movie.timeline, command.frame, movie.element.duration * 1000)
            : command.position!
          : 0
      if (movie.status !== 'play' && movie.timeline?.times.length)
        await this.seekPresented(movie, time, command.op === 'seek' && command.frame !== undefined)
      else await this.seek(movie, time)
      this.current(movie, command.epoch)
      events.push(this.frame(movie))
    } else if (command.op === 'prepare') {
      if (movie.settings.mode === 1) {
        movie.element.pause()
        this.cancelFrame(movie)
        movie.status = 'pause'
        if (movie.timeline?.times.length) await this.seekPresented(movie, 0)
        else await this.seek(movie, 0)
        this.current(movie, command.epoch)
        events.push(this.frame(movie), {
          type: 'period',
          id: movie.id,
          epoch: movie.epoch,
          snapshot: this.snapshot(movie),
          reason: 2,
        })
      }
    } else if (command.op === 'play') {
      if (movie.element.ended) await this.seek(movie, 0)
      this.current(movie, command.epoch)
      movie.status = 'play'
      this.play(movie)
    } else if (command.op === 'stop' || command.op === 'pause') {
      movie.status = command.op === 'pause' ? 'pause' : 'stop'
      movie.blocked = false
      movie.element.pause()
      this.cancelFrame(movie)
      this.layout()
    }
    this.current(movie, command.epoch)
    return { snapshot: this.snapshot(movie), events }
  }
  private remove(id: number): void {
    const stage = this.stages.get(id)
    const movie = this.movies.get(id)
    if (!movie && !stage) return
    this.movies.delete(id)
    let primary: unknown,
      failed = false
    try {
      if (stage) this.retireStage(stage)
    } catch (error) {
      primary = error
      failed = true
    }
    try { if (movie) this.disposeMovie(movie) }
    catch (error) { if (!failed) primary = error; failed = true }
    try {
      this.layout()
    } catch (error) {
      if (!failed) {
        primary = error
        failed = true
      }
    }
    if (failed) throw primary
  }
  private disposeMovie(movie: Movie): void {
    if (movie.disposed) return
    movie.disposed = true
    movie.inFlight = undefined
    let primary: unknown,
      failed = false
    const attempt = (action: () => void) => {
      try {
        action()
      } catch (error) {
        if (!failed) {
          primary = error
          failed = true
        }
      }
    }
    attempt(() => movie.abort.abort())
    attempt(() => this.releaseMixing(movie))
    attempt(() => this.cancelFrame(movie))
    attempt(() => {
      movie.element.onended = movie.element.ontimeupdate = null
    })
    attempt(() => movie.audio.close())
    attempt(() => movie.element.pause())
    attempt(() => movie.element.removeAttribute('src'))
    attempt(() => movie.element.load())
    attempt(() => movie.container.remove())
    attempt(() => this.trimParking())
    attempt(() => {
      if (movie.surface) {
        movie.surface.width = 1
        movie.surface.height = 1
        movie.surface = undefined
      }
    })
    attempt(() => movie.variant.release())
    attempt(() => movie.source.release())
    if (failed) throw primary
  }
  close(): Promise<void> {
    if (this.closing) return this.closing
    this.closed = true
    this.closing = Promise.resolve().then(() => {
      let primary: unknown,
        failed = false
      const attempt = (action: () => void) => {
        try {
          action()
        } catch (error) {
          if (!failed) {
            primary = error
            failed = true
          }
        }
      }
      for (const id of new Set([...this.movies.keys(), ...this.stages.keys()])) attempt(() => this.remove(id))
      for (const [id, window] of this.windows) attempt(() => this.releaseSurface(id, window))
      this.windows.clear()
      this.retiredWindows.clear()
      attempt(() => this.trimParking())
      if (failed) throw primary
    })
    return this.closing
  }
}
