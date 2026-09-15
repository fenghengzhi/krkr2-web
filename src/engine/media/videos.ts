import {
  defaultVideoSettings,
  emptyVideoSnapshot,
  type VideoBackend,
  type VideoCommand,
  type VideoEvent,
  type VideoSettings,
  type VideoSnapshot,
  type VideoResult,
} from '../ports/video.ts'
import type { Pixels } from '../ports/graphics.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type ScriptObject,
  type ScriptWeakObject,
  type ScriptRuntime,
  type ScriptValue,
} from '../script/runtime.ts'
interface Video {
  id: number
  owner: ScriptWeakObject
  window?: ScriptWeakObject
  windowId: number
  snapshot: VideoSnapshot
  ready: boolean
  detached: boolean
  resourceRequested: boolean
  inflight: Set<Promise<VideoResult>>
  closing?: Promise<void>
  version: number
  layers: ({ id: number; owner: ScriptWeakObject } | null)[]
}
interface Callback {
  name: string
  args: ScriptValue[]
}
export const videoSettings = (state: VideoSnapshot): VideoSettings =>
  Object.fromEntries(
    Object.keys(defaultVideoSettings()).map((key) => [key, state[key as keyof VideoSettings]]),
  ) as unknown as VideoSettings
export class VideoService {
  private next = 1
  private epoch = 1
  private videos = new Map<number, Video>()
  private unsubscribe?: () => void
  private disposed = false
  private closes = new Set<Promise<void>>()
  private closeErrors: unknown[] = []
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly backend: VideoBackend | undefined,
    private readonly read: (name: string) => Promise<Uint8Array>,
    private readonly frame: (id: number, pixels: Pixels) => void,
    private readonly dispatch: (
      callback: ScriptObject,
      member: string | undefined,
      args: ScriptValue[],
      valid: () => boolean,
      before: () => void,
      immediate: boolean,
      source: object,
    ) => Promise<void>,
    private readonly error: (error: unknown) => void,
    private readonly cancelQueued: (source: object) => void = () => {},
    private readonly deliveryBoundary: () => Promise<void> = () => Promise.resolve(),
  ) {
    this.unsubscribe = backend?.listen((event) => this.receive(event))
  }
  get count(): number {
    return this.videos.size
  }
  get pendingCloses(): number {
    return this.closes.size
  }
  disconnectWindow(id: number): void {
    for (const video of this.videos.values()) if (video.windowId === id) this.disconnect(video)
  }
  private cancelEvents(video: Video): void {
    video.version++
    this.cancelQueued(video)
  }
  private queueClose(video: Video): void {
    if (!video.resourceRequested || video.closing) return
    const closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...video.inflight])
      await this.command({ op: 'close', id: video.id, epoch: this.epoch++ })
      video.resourceRequested = false
    })
    video.closing = closing
    this.closes.add(closing)
    void closing.then(
      () => {
        this.closes.delete(closing)
        video.closing = undefined
      },
      (error) => {
        this.closes.delete(closing)
        video.closing = undefined
        this.closeErrors.push(error)
      },
    )
  }
  private disconnect(video: Video): void {
    if (video.detached) return
    video.detached = true
    this.cancelEvents(video)
    if (video.window) this.objects.unobserve(video.window)
    video.window = undefined
    video.ready = false
    video.snapshot = {
      ...emptyVideoSnapshot(video.id, this.epoch++),
      ...videoSettings(video.snapshot),
    }
    this.queueClose(video)
  }
  private retire(id: number): void {
    const video = this.videos.get(id)
    if (!video) return
    this.videos.delete(id)
    this.cancelEvents(video)
    this.objects.unobserve(video.owner)
    if (video.window) this.objects.unobserve(video.window)
    video.window = undefined
    for (const layer of video.layers) if (layer) this.objects.unobserve(layer.owner)
    video.layers.fill(null)
    this.queueClose(video)
  }
  async flushCloses(): Promise<void> {
    while (this.closes.size) await Promise.allSettled([...this.closes])
    if (this.closeErrors.length) {
      const error = this.closeErrors[0]
      this.closeErrors.length = 0
      throw error
    }
  }
  private get(id: number): Video {
    const video = this.videos.get(id)
    if (!video) throw new Error('VideoOverlay has been invalidated')
    return video
  }
  private async command(command: VideoCommand) {
    if (!this.backend) throw new Error('This environment has no video backend')
    return this.backend.command(command)
  }
  private async videoCommand(video: Video, command: VideoCommand): Promise<VideoResult> {
    if (this.videos.get(video.id) !== video || video.detached)
      throw new Error('VideoOverlay has been invalidated or disconnected')
    if (command.op === 'open') video.resourceRequested = true
    const epoch = video.snapshot.epoch,
      pending = this.command(command)
    video.inflight.add(pending)
    try {
      const result = await pending
      if (this.videos.get(video.id) !== video || video.detached || video.snapshot.epoch !== epoch)
        throw new Error('VideoOverlay operation has been invalidated or disconnected')
      return result
    } finally {
      video.inflight.delete(pending)
    }
  }
  private callbacks(event: VideoEvent): Callback[] {
    if (event.type === 'error') throw new Error(event.message)
    if (event.type === 'ended') return [{ name: 'onStatusChanged', args: ['stop'] }]
    if (event.type === 'period') return [{ name: 'onPeriod', args: [BigInt(event.reason ?? 0)] }]
    return (event.snapshot.mode === 1 || event.snapshot.mode === 2) && event.snapshot.frame >= 0
      ? [{ name: 'onFrameUpdate', args: [BigInt(event.snapshot.frame)] }]
      : []
  }
  private pixels(video: Video, event: VideoEvent): void {
    if (event.type !== 'frame' || !event.pixels || video.snapshot.mode !== 1) return
    const ids = new Set(video.layers.flatMap((layer) => (layer ? [layer.id] : [])))
    for (const id of ids) this.frame(id, event.pixels)
  }
  private async receive(event: VideoEvent): Promise<void> {
    let lease: ScriptObject | undefined
    try {
      if (this.disposed) return
      if (event.type === 'error') throw new Error(event.message)
      const video = this.videos.get(event.id)
      if (!video || video.detached || video.snapshot.epoch !== event.epoch) return
      // Native asynchronous status changes revoke earlier undelivered video
      // events. Frame/period events keep their immediate/discardable semantics.
      if (event.type === 'ended') this.cancelEvents(video)
      video.snapshot = event.snapshot
      const version = video.version
      const valid = () =>
        this.videos.get(video.id) === video &&
        !video.detached &&
        video.version === version &&
        video.snapshot.epoch === event.epoch
      const callbacks = this.callbacks(event)
      lease = this.objects.upgrade(video.owner)
      if (!lease) {
        this.retire(video.id)
        return
      }
      const callback = callbacks[0]
      await this.dispatch(
        lease,
        callback?.name,
        callback?.args ?? [],
        valid,
        () => this.pixels(video, event),
        event.type !== 'ended',
        video,
      )
    } catch (error) {
      this.error(error)
    } finally {
      if (lease) {
        // Release at event completion, while the VM can still drain the native
        // handle. Only then wait for presentation before acknowledging a frame.
        this.objects.release(lease)
        await this.deliveryBoundary()
      }
    }
  }
  async host(operation: string, args: ScriptValue[], context: HostContext): Promise<ScriptValue> {
    if (operation === 'Video.create') {
      if (this.disposed) throw new Error('Video service is disposed')
      if (!isScriptObject(args[0]) || !isScriptObject(args[1]))
        throw new Error('VideoOverlay requires its instance and Window')
      if (this.videos.size >= 16) throw new Error('Video overlay limit exceeded')
      const id = this.next++
      const windowId = Number(args[2])
      if (!Number.isSafeInteger(windowId) || windowId <= 0)
        throw new Error('Invalid video Window identity')
      const owner = this.objects.observe(args[0], () => this.retire(id))
      let window: ScriptWeakObject | undefined
      try {
        const video: Video = {
          id,
          owner,
          windowId,
          snapshot: emptyVideoSnapshot(id, this.epoch++),
          ready: false,
          detached: false,
          resourceRequested: false,
          inflight: new Set(),
          version: 0,
          layers: [null, null],
        }
        video.window = window = this.objects.observe(args[1], () => this.disconnect(video))
        this.videos.set(id, video)
      } catch (error) {
        this.objects.unobserve(owner)
        if (window) this.objects.unobserve(window)
        throw error
      }
      return BigInt(id)
    }
    const video = this.get(Number(args[0]))
    if (operation === 'Video.destroy') {
      this.retire(video.id)
      return
    }
    if (operation === 'Video.layer' || operation === 'Video.layerGet') {
      const channel = Number(args[1])
      if (channel !== 0 && channel !== 1) throw new Error('Invalid video layer channel')
      if (operation === 'Video.layerGet') return video.layers[channel]?.owner ?? null
      const previous = video.layers[channel],
        id = args[2] === null ? null : Number(args[2])
      if (id !== null && (!Number.isSafeInteger(id) || !isScriptObject(args[3])))
        throw new Error('Invalid video layer')
      let binding: Video['layers'][number] = null
      if (id !== null) {
        const owner = this.objects.observe(args[3] as ScriptObject, () => {
          if (video.layers[channel] === binding) video.layers[channel] = null
        })
        try {
          binding = { id, owner }
        } catch (error) {
          this.objects.unobserve(owner)
          throw error
        }
      }
      video.layers[channel] = binding
      if (previous) this.objects.unobserve(previous.owner)
      return
    }
    if (operation !== 'Video.call' || typeof args[1] !== 'string' || !isScriptObject(args[2]))
      throw new Error('Invalid video call')
    const copied = context.snapshot(args[2])
    if (copied.type !== 'array') throw new Error('Video arguments must be an Array')
    const input = copied.items,
      method = args[1],
      callbacks: Callback[] = []
    const text = (i: number) => {
      if (typeof input[i] !== 'string') throw new Error('Expected video text argument')
      return input[i] as string
    }
    const number = (i: number) => {
      const value = Number(input[i])
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        throw new Error('Invalid video numeric argument')
      return value
    }
    const apply = async (command: VideoCommand) => {
      const result = await this.videoCommand(video, command)
      if (result.snapshot) video.snapshot = result.snapshot
      for (const event of result.events) {
        this.pixels(video, event)
        callbacks.push(...this.callbacks(event))
      }
    }
    const identity = () => ({ id: video.id, epoch: video.snapshot.epoch })
    let value: ScriptValue
    if (method === 'close') {
      const previous = video.snapshot.status
      this.cancelEvents(video)
      video.snapshot.epoch = this.epoch++
      if (video.closing) await video.closing
      else if (video.resourceRequested) {
        await this.command({ op: 'close', ...identity() })
        video.resourceRequested = false
      }
      video.ready = false
      video.snapshot = {
        ...emptyVideoSnapshot(video.id, video.snapshot.epoch),
        ...videoSettings(video.snapshot),
      }
      if (previous !== 'unload') callbacks.push({ name: 'onStatusChanged', args: ['unload'] })
    } else if (method === 'open') {
      if (video.detached) throw new Error('VideoOverlay is disconnected from its Window')
      const name = text(0)
      this.cancelEvents(video)
      video.snapshot.epoch = this.epoch++
      await apply({
        op: 'open',
        ...identity(),
        windowId: video.windowId,
        name,
        bytes: await this.read(name.split('?')[0]!),
        settings: videoSettings(video.snapshot),
      })
      video.ready = true
      callbacks.push({ name: 'onStatusChanged', args: [video.snapshot.status] })
    } else if (['play', 'stop', 'pause', 'rewind', 'prepare'].includes(method)) {
      if (video.ready) {
        this.cancelEvents(video)
        const previous = video.snapshot.status
        video.snapshot.epoch = this.epoch++
        await apply({ op: method as 'play', ...identity() })
        if (previous !== video.snapshot.status)
          callbacks.unshift({ name: 'onStatusChanged', args: [video.snapshot.status] })
      }
    } else if (method === 'get') {
      const property = text(0)
      if (video.ready) await apply({ op: 'inspect', ...identity() })
      if (
        video.ready &&
        video.snapshot.frame < 0 &&
        ['frame', 'fps', 'numberOfFrame'].includes(property)
      )
        throw new Error('This video container has no supported frame index')
      if (!(property in video.snapshot)) throw new Error(`Unsupported video property: ${property}`)
      const result = video.snapshot[property as keyof VideoSnapshot]
      value =
        typeof result === 'string'
          ? result
          : typeof result === 'number' &&
              (property === 'fps' || property === 'playRate' || property === 'mixingMovieAlpha')
            ? result
            : BigInt(Number(result))
    } else if (method === 'set') {
      const property = text(0),
        setting = number(1)
      if (property === 'position' || property === 'frame') {
        if (video.ready) {
          this.cancelEvents(video)
          video.snapshot.epoch = this.epoch++
          await apply({
            op: 'seek',
            ...identity(),
            ...(property === 'frame' ? { frame: setting } : { position: setting }),
          })
        }
      } else {
        const state = { ...video.snapshot }
        if (property === 'mode') {
          if (video.ready) return scriptRecord({ value, callbacks: scriptList([]) })
          if (![0, 1, 2, 3].includes(setting)) throw new Error('Invalid video mode')
          state.mode = setting as 0
        } else if (property === 'visible' || property === 'loop') state[property] = !!setting
        else if (['left', 'top', 'width', 'height'].includes(property)) {
          if (
            !Number.isSafeInteger(setting) ||
            Math.abs(setting) > 65536 ||
            ((property === 'width' || property === 'height') && (setting <= 0 || setting > 4096))
          )
            throw new Error('Invalid video bounds')
          state[property as 'left'] = setting
        } else if (property === 'playRate') {
          if (setting <= 0 || setting > 16) throw new Error('Video playback rate must be in (0,16]')
          state.playRate = setting
        } else if (property === 'audioVolume')
          state.audioVolume = Math.max(0, Math.min(100000, setting))
        else if (property === 'audioBalance')
          state.audioBalance = Math.max(-100000, Math.min(100000, setting))
        else if (property === 'mixingMovieAlpha')
          state.mixingMovieAlpha = Math.max(0, Math.min(1, setting))
        else if (property === 'mixingMovieBGColor') state.mixingMovieBGColor = setting >>> 0
        else if (property === 'periodEventFrame') {
          if (!Number.isSafeInteger(setting) || setting < -1)
            throw new Error('Invalid video period frame')
          state.periodEventFrame = setting
        } else throw new Error(`Unsupported video setting: ${property}`)
        if (video.ready) await apply({ op: 'set', ...identity(), settings: videoSettings(state) })
        else video.snapshot = state
      }
    } else if (method === 'segment') {
      const start = number(0),
        end = number(1)
      if (
        !Number.isSafeInteger(start) ||
        !Number.isSafeInteger(end) ||
        (!(start === -1 && end === -1) && !(start >= 0 && end > start))
      )
        throw new Error('Invalid video loop segment')
      const state = { ...video.snapshot, segmentLoopStartFrame: start, segmentLoopEndFrame: end }
      if (video.ready) await apply({ op: 'set', ...identity(), settings: videoSettings(state) })
      else video.snapshot = state
    } else if (method === 'audioStream') {
      const index = number(0)
      if (
        index < -1 ||
        !Number.isInteger(index) ||
        (video.ready && index >= video.snapshot.numberOfAudioStream)
      )
        throw new Error('Invalid video audio stream')
      if (video.ready)
        await apply({
          op: 'set',
          ...identity(),
          settings: { ...videoSettings(video.snapshot), enabledAudioStream: index },
        })
    } else throw new Error(`Unsupported VideoOverlay method: ${method}`)
    return scriptRecord({
      value,
      callbacks: scriptList(
        callbacks.map((item) => scriptList([item.name, scriptList(item.args)])),
      ),
    })
  }
  async pause(paused: boolean): Promise<void> {
    if (this.backend) await this.command({ op: 'pauseAll', paused })
  }
  async cancel(): Promise<void> {
    for (const video of this.videos.values()) this.cancelEvents(video)
    if (this.backend) await this.command({ op: 'cancel' })
  }
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.unsubscribe = undefined
    for (const id of this.videos.keys()) this.retire(id)
    let primary: unknown,
      failed = false
    try {
      await this.flushCloses()
    } catch (error) {
      primary = error
      failed = true
    }
    try {
      await this.backend?.close()
    } catch (error) {
      if (!failed) {
        primary = error
        failed = true
      }
    }
    if (failed) throw primary
  }
}
