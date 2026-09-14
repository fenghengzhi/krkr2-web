import { PausableTimeouts } from '../../shared/pausable-timeouts.ts'
import {
  emptyVideoSnapshot,
  type VideoCommand,
  type VideoEvent,
  type VideoResult,
  type VideoSettings,
  type VideoSnapshot,
  type VideoTimeline,
} from '../../../engine/ports/video.ts'
import { videoFrameAt, videoFrameTime } from '../../../engine/media/video-time.ts'
import type { Pixels } from '../../../engine/ports/graphics.ts'
import type { WindowView } from '../../../engine/scene/window.ts'
import type { VideoMessage, VideoRequest } from '../../../protocol/video.ts'
import type { WebAudioHost } from '../../audio/web/host.ts'
interface Movie {
  id: number
  epoch: number
  element: HTMLVideoElement
  container: HTMLDivElement
  url: string
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
}
export class WebVideoHost {
  private readonly timeouts = new PausableTimeouts()
  setRequestTimeoutsPaused(paused: boolean): void {
    this.timeouts.setPaused(paused)
  }
  private movies = new Map<number, Movie>()
  private closed = false
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
  private plane: HTMLDivElement
  private activation: HTMLButtonElement
  private view?: WindowView
  private observer: ResizeObserver
  constructor(
    private readonly port: MessagePort,
    private readonly canvas: HTMLCanvasElement,
    private readonly audio: WebAudioHost,
  ) {
    this.plane = document.createElement('div')
    this.plane.className = 'video-plane'
    Object.assign(this.plane.style, {
      position: 'absolute',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '2',
    })
    this.activation = document.createElement('button')
    this.activation.textContent = '播放视频'
    this.activation.hidden = true
    Object.assign(this.activation.style, {
      position: 'absolute',
      left: '50%',
      top: '50%',
      transform: 'translate(-50%,-50%)',
      pointerEvents: 'auto',
      zIndex: '20',
    })
    this.activation.onclick = () => this.activate()
    this.plane.append(this.activation)
    canvas.parentElement?.append(this.plane)
    this.observer = new ResizeObserver(() => this.layout())
    this.observer.observe(canvas)
    port.onmessage = (event: MessageEvent<VideoRequest | VideoMessage>) => {
      const message = event.data
      if ('type' in message) {
        if (message.type === 'ack')
          for (const movie of this.movies.values())
            if (movie.inFlight === message.serial) movie.inFlight = undefined
        return
      }
      void this.command(message.command).then(
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
    }
  }
  setWindow(view: WindowView): void {
    this.view = view
    this.layout()
  }
  private layout(): void {
    const width = this.canvas.clientWidth,
      height = this.canvas.clientHeight,
      view = this.view
    Object.assign(this.plane.style, {
      left: `${this.canvas.offsetLeft}px`,
      top: `${this.canvas.offsetTop}px`,
      width: `${width}px`,
      height: `${height}px`,
      visibility: view?.visible === false ? 'hidden' : 'visible',
    })
    const sx = width / (view?.width ?? 800),
      sy = height / (view?.height ?? 600),
      zoom = (view?.zoomNumer ?? 1) / (view?.zoomDenom ?? 1)
    for (const movie of this.movies.values()) {
      const s = movie.settings,
        layer = s.mode === 1
      Object.assign(movie.container.style, {
        position: 'absolute',
        left: `${(s.left * zoom + (view?.layerLeft ?? 0)) * sx}px`,
        top: `${(s.top * zoom + (view?.layerTop ?? 0)) * sy}px`,
        width: `${s.width * zoom * sx}px`,
        height: `${s.height * zoom * sy}px`,
        visibility: layer || !s.visible ? 'hidden' : 'visible',
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
    }
    this.activation.hidden = ![...this.movies.values()].some(
      (movie) => movie.blocked && movie.status === 'play',
    )
  }
  activate(): void {
    this.audio.activate()
    for (const movie of this.movies.values()) if (movie.status === 'play') this.play(movie)
  }
  private get(id: number): Movie {
    const movie = this.movies.get(id)
    if (!movie || movie.disposed) throw new Error('Video is closed')
    return movie
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
      position: Math.floor(time),
      frame: timeline?.times.length ? videoFrameAt(timeline, time) : -1,
      originalWidth: movie.element.videoWidth,
      originalHeight: movie.element.videoHeight,
      totalTime: Math.round(duration),
      numberOfFrame: timeline?.times.length ?? 0,
      fps: timeline?.duration ? (timeline.times.length * 1000) / timeline.duration : 0,
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
  private frame(movie: Movie, time = movie.element.currentTime * 1000): VideoEvent {
    return {
      type: 'frame',
      id: movie.id,
      epoch: movie.epoch,
      snapshot: this.snapshot(movie, time),
      pixels: this.pixels(movie),
    }
  }
  private cancelFrame(movie: Movie): void {
    if (movie.callback !== undefined) {
      movie.element.cancelVideoFrameCallback(movie.callback)
      movie.callback = undefined
    }
  }
  private arm(movie: Movie): void {
    if (movie.disposed || this.isPaused || movie.status !== 'play' || movie.callback !== undefined)
      return
    movie.callback = movie.element.requestVideoFrameCallback((_now, metadata) => {
      movie.callback = undefined
      if (movie.disposed || this.isPaused || movie.seeking || movie.status !== 'play') return
      try {
        const snapshot = this.snapshot(movie, metadata.mediaTime * 1000),
          s = movie.settings
        if (s.segmentLoopEndFrame > 0 && snapshot.frame >= s.segmentLoopEndFrame) {
          void this.seek(
            movie,
            videoFrameTime(movie.timeline, Math.max(0, s.segmentLoopStartFrame)),
          ).then(
            () => {
              this.emit({
                type: 'period',
                id: movie.id,
                epoch: movie.epoch,
                snapshot: this.snapshot(movie),
                reason: 3,
              })
              this.play(movie)
            },
            (error) => this.fail(error),
          )
          return
        }
        if (movie.inFlight === undefined && (s.mode === 1 || s.mode === 2))
          this.emit(this.frame(movie, metadata.mediaTime * 1000), true, movie)
        if (movie.periodArmed && s.periodEventFrame >= 0 && snapshot.frame >= s.periodEventFrame) {
          s.periodEventFrame = -1
          movie.periodArmed = false
          this.emit({
            type: 'period',
            id: movie.id,
            epoch: movie.epoch,
            snapshot: this.snapshot(movie),
            reason: 1,
          })
        }
      } catch (error) {
        this.fail(error)
      }
      this.arm(movie)
    })
  }
  private fail(error: unknown): void {
    this.emit({ type: 'error', message: error instanceof Error ? error.message : String(error) })
  }
  private play(movie: Movie): void {
    if (movie.disposed || this.isPaused) return
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
      const done = (error?: unknown) => {
        cancelTimeout()
        movie.element.removeEventListener(name, success)
        movie.element.removeEventListener('error', failure)
        movie.abort.signal.removeEventListener('abort', cancel)
        error ? reject(error) : resolve()
      }
      const success = () => done(),
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
      movie.element.addEventListener(name, success, { once: true })
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
  private settings(movie: Movie, settings: VideoSettings): void {
    if (settings.periodEventFrame >= 0 && !movie.timeline?.times.length)
      throw new Error('This video container has no supported frame index')
    if (settings.enabledAudioStream > 0)
      throw new Error(
        'Selecting alternate video audio tracks is not supported by this browser backend',
      )
    if (settings.segmentLoopEndFrame >= 0) {
      videoFrameTime(movie.timeline, settings.segmentLoopStartFrame)
      if (!movie.timeline || settings.segmentLoopEndFrame > movie.timeline.times.length)
        throw new Error('Video segment ends outside its frame index')
    }
    if (settings.periodEventFrame !== movie.settings.periodEventFrame)
      movie.periodArmed =
        settings.periodEventFrame >= 0 && this.snapshot(movie).frame < settings.periodEventFrame
    movie.settings = { ...settings }
    movie.element.playbackRate = settings.playRate
    movie.element.preservesPitch = false
    movie.audio.set(
      settings.enabledAudioStream === -1 ? 0 : settings.audioVolume,
      settings.audioBalance,
    )
    this.layout()
  }
  private async open(command: Extract<VideoCommand, { op: 'open' }>): Promise<VideoResult> {
    this.remove(command.id)
    if (command.settings.mode === 3)
      throw new Error('Media Foundation video mode is unavailable on the Web')
    if (
      this.movies.size >= 16 ||
      [...this.movies.values()].reduce((sum, movie) => sum + movie.bytes, command.bytes.length) >
        128 * 1024 * 1024
    )
      throw new Error('Video resource budget exceeded')
    const element = document.createElement('video')
    element.playsInline = true
    element.preload = 'auto'
    element.controls = false
    element.dataset.videoId = String(command.id)
    const extension = command.name.split('?')[0]!.split('.').pop()?.toLowerCase(),
      mime =
        extension === 'webm'
          ? 'video/webm'
          : extension === 'mp4' || extension === 'm4v' || extension === 'mov'
            ? 'video/mp4'
            : ''
    const url = URL.createObjectURL(
      new Blob([command.bytes as Uint8Array<ArrayBuffer>], { type: mime }),
    )
    let audio: ReturnType<WebAudioHost['connectMedia']>
    try {
      audio = this.audio.connectMedia(element)
    } catch (error) {
      URL.revokeObjectURL(url)
      throw error
    }
    const container = document.createElement('div')
    container.append(element)
    const movie: Movie = {
      id: command.id,
      epoch: command.epoch,
      element,
      container,
      url,
      bytes: command.bytes.length,
      settings: { ...command.settings },
      status: 'stop',
      timeline: command.timeline,
      blocked: false,
      disposed: false,
      periodArmed: false,
      seeking: false,
      abort: new AbortController(),
      audio,
    }
    this.movies.set(movie.id, movie)
    this.plane.insertBefore(container, this.activation)
    this.layout()
    element.onended = () => {
      if (movie.disposed || movie.status !== 'play') return
      if (movie.settings.loop)
        void this.seek(movie, 0).then(
          () => {
            this.emit({
              type: 'period',
              id: movie.id,
              epoch: movie.epoch,
              snapshot: this.snapshot(movie),
              reason: 0,
            })
            this.play(movie)
          },
          (error) => this.fail(error),
        )
      else {
        movie.status = 'stop'
        this.cancelFrame(movie)
        this.emit({
          type: 'ended',
          id: movie.id,
          epoch: movie.epoch,
          snapshot: this.snapshot(movie),
        })
      }
    }
    try {
      await this.wait(
        movie,
        'loadeddata',
        () => element.readyState >= 2,
        () => {
          element.src = url
          element.load()
        },
      )
      if (
        !element.videoWidth ||
        element.videoWidth > 4096 ||
        element.videoHeight > 4096 ||
        !Number.isFinite(element.duration)
      )
        throw new Error('Invalid video dimensions or duration')
      this.settings(movie, command.settings)
      element.addEventListener(
        'error',
        () => {
          if (!movie.disposed)
            this.fail(
              new Error(`Video playback failed: ${element.error?.message ?? element.error?.code}`),
            )
        },
        { signal: movie.abort.signal },
      )
      return { snapshot: this.snapshot(movie), events: [] }
    } catch (error) {
      if (this.movies.get(movie.id) === movie) this.remove(movie.id)
      throw error
    }
  }
  private async command(command: VideoCommand): Promise<VideoResult> {
    if (command.op === 'shutdown') {
      await this.close()
      return { events: [] }
    }
    if (command.op === 'cancel') {
      this.paused = true
      for (const id of this.movies.keys()) this.remove(id)
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
      this.remove(command.id)
      return { events: [] }
    }
    const movie = this.get(command.id),
      events: VideoEvent[] = []
    movie.epoch = command.epoch
    if (command.op === 'set') this.settings(movie, command.settings)
    else if (command.op === 'seek' || command.op === 'rewind') {
      const time =
        command.op === 'seek'
          ? command.frame !== undefined
            ? videoFrameTime(movie.timeline, command.frame) + 0.0001
            : command.position!
          : 0
      await this.seek(movie, time)
      events.push(this.frame(movie))
    } else if (command.op === 'prepare') {
      if (movie.settings.mode === 1) {
        movie.element.pause()
        this.cancelFrame(movie)
        movie.status = 'pause'
        await this.seek(movie, 0)
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
      movie.status = 'play'
      this.play(movie)
    } else if (command.op === 'stop' || command.op === 'pause') {
      movie.status = command.op === 'pause' ? 'pause' : 'stop'
      movie.blocked = false
      movie.element.pause()
      this.cancelFrame(movie)
      this.layout()
    }
    return { snapshot: this.snapshot(movie), events }
  }
  private remove(id: number): void {
    const movie = this.movies.get(id)
    if (!movie) return
    this.movies.delete(id)
    movie.disposed = true
    movie.abort.abort()
    this.cancelFrame(movie)
    movie.audio.close()
    movie.element.pause()
    movie.element.removeAttribute('src')
    movie.element.load()
    movie.container.remove()
    if (movie.surface) {
      movie.surface.width = 1
      movie.surface.height = 1
    }
    URL.revokeObjectURL(movie.url)
    this.layout()
  }
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    for (const id of this.movies.keys()) this.remove(id)
    this.observer.disconnect()
    this.plane.remove()
  }
}
