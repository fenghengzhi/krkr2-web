import {
  defaultVideoSettings,
  emptyVideoSnapshot,
  type VideoBackend,
  type VideoCommand,
  type VideoEvent,
  type VideoSettings,
  type VideoSnapshot,
  type VideoResult,
  type VideoMixingBitmap,
  type PreparedVideoSource,
  type VideoSourceControl,
} from '../ports/video.ts'
import type { Pixels } from '../ports/graphics.ts'
import { videoBalanceReadback } from './video-audio.ts'
import { VideoPeriod } from './video-period.ts'
import { videoColorRanges, videoColorSetting, type VideoColorControl, type VideoColorRangeField } from './video-color.ts'
import { TjsError } from '../system/tjs-error.ts'
import { ExecutionCancelled } from '../scheduler/control.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type HostReply,
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
  sourceCancels: Set<() => void>
  closing?: Promise<void>
  version: number
  prepareToken: number
  layers: ({ id: number; owner: ScriptWeakObject } | null)[]
}
interface Callback {
  name: string
  args: ScriptValue[]
}
export interface VideoLayerGeometry {
  windowId: number
  values(): Partial<Record<'left' | 'top' | 'visible', number>>
  /** Resolve each slot after preceding Layer callbacks, just like the native
   * Layer1/Layer2 reads. Weak bindings must not survive invalidation/rebinding. */
  layer(channel: number): number | undefined
}
export function videoSettings(state: VideoSnapshot): VideoSettings {
  const settings = Object.fromEntries(
    Object.keys(defaultVideoSettings()).map((key) => [key, state[key as keyof VideoSettings]]),
  ) as unknown as VideoSettings
  if (state.color) settings.color = { ...state.color }
  return settings
}
/** Native VideoOverlay owns these fields across Close/Open. Rate, mixer and
 * audio controls belong to the media graph, which Open constructs afresh. */
const videoObjectSettings = (state: VideoSnapshot) => ({
  left: state.left, top: state.top, width: state.width, height: state.height,
  visible: state.visible, loop: state.loop, mode: state.mode,
  segmentLoopStartFrame: state.segmentLoopStartFrame, segmentLoopEndFrame: state.segmentLoopEndFrame,
  periodEventFrame: state.periodEventFrame,
})
const graphSettings = new Set(['playRate', 'audioVolume', 'audioBalance', 'mixingMovieAlpha', 'mixingMovieBGColor'])
export class VideoService {
  private next = 1
  private epoch = 1
  private videos = new Map<number, Video>()
  private unsubscribe?: () => void
  private disposed = false
  private cancelled = false
  private closes = new Set<Promise<void>>()
  private closeErrors: unknown[] = []
  private nextPrepare = 1
  private callbackDispatcher?: ScriptObject
  private frameDispatcher?: ScriptObject
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly backend: VideoBackend | undefined,
    private readonly read: (name: string, control: VideoSourceControl) => Promise<Uint8Array | PreparedVideoSource>,
    private readonly frame: (id: number, pixels: Pixels) => void,
    private readonly dispatch: (
      callback: ScriptObject,
      member: string | undefined,
      args: ScriptValue[],
      valid: () => boolean,
      before: () => void,
      immediate: boolean,
      source: object,
      /** A Session receipt invokes this at body settlement and owns the
       * following native/frame boundary. Standalone dispatchers may ignore it. */
      release: () => void,
      internal?: boolean,
    ) => Promise<void>,
    private readonly error: (error: unknown) => void,
    private readonly cancelQueued: (source: object) => void = () => {},
    private readonly deliveryBoundary: () => Promise<void> = () => Promise.resolve(),
    private readonly mixingLayer?: (
      source: ScriptValue,
      settings: VideoSettings,
      windowId: number,
      opened: boolean,
    ) => VideoMixingBitmap | null,
  ) {
    this.unsubscribe = backend?.listen((event) => this.receive(event))
  }
  get count(): number {
    return this.videos.size
  }
  get pendingCloses(): number {
    return this.closes.size
  }
  /** Native continuations: they invoke retained TJS closures on the existing
   * VM stack, never enter the runtime from a suspended host import. */
  continuation(operation: string, args: ScriptValue[]): HostReply | undefined {
    if (operation === 'Video.bindCallbacks') {
      if (this.callbackDispatcher || this.frameDispatcher || !isScriptObject(args[0]) || !isScriptObject(args[1]))
        throw new Error('Invalid video callback binding')
      const callback = this.objects.retain(args[0])
      try { this.frameDispatcher = this.objects.retain(args[1]); this.callbackDispatcher = callback }
      catch (error) { this.objects.release(callback); throw error }
      return { kind: 'value', value: undefined }
    }
    if (operation === 'Video.dispatchCallbacks') {
      if (!this.callbackDispatcher || !isScriptObject(args[0]) || !isScriptObject(args[1]))
        throw new Error('Invalid video callbacks')
      return { kind: 'invoke', callback: this.callbackDispatcher, args }
    }
    return undefined
  }
  disconnectWindow(id: number): void {
    for (const video of this.videos.values()) if (video.windowId === id) this.disconnect(video)
  }
  private cancelEvents(video: Video): void {
    video.version++
    for (const cancel of video.sourceCancels) cancel()
    video.sourceCancels.clear()
    this.cancelQueued(video)
  }
  private sourceControl(video: Video): VideoSourceControl {
    const version = video.version
    const check = () => {
      if (this.cancelled || this.disposed || video.detached || this.videos.get(video.id) !== video || version !== video.version)
        throw new ExecutionCancelled()
    }
    return {
      check, checkpoint: async () => check(),
      onCancel: (callback) => {
        if (this.cancelled || this.disposed || video.detached || this.videos.get(video.id) !== video || version !== video.version) callback()
        else video.sourceCancels.add(callback)
        return () => { video.sourceCancels.delete(callback) }
      },
    }
  }
  private readSource(name: string, control: VideoSourceControl): Promise<Uint8Array | PreparedVideoSource> {
    let off = () => {}, rejectCancel!: (error: unknown) => void
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancel = reject })
    off = control.onCancel(() => rejectCancel(new ExecutionCancelled()))
    const actual = Promise.resolve().then(() => { control.check(); return this.read(name, control) }).then((value) => {
      try { control.check(); return value }
      catch (error) { if (!(value instanceof Uint8Array)) value.release(); throw error }
    })
    return Promise.race([actual, cancelled]).finally(() => off())
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
      ...videoObjectSettings(video.snapshot),
      periodEventPast: video.snapshot.periodEventPast ?? false,
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
  async geometry(id: number, method: string, args: ScriptValue[]): Promise<VideoLayerGeometry | undefined> {
    const video = this.get(id), fields = method === 'setPos' ? ['left', 'top'] as const
      : method === 'setSize' ? ['width', 'height'] as const
      : method === 'setBounds' ? ['left', 'top', 'width', 'height'] as const
      : ['left', 'top', 'width', 'height', 'visible'].includes(method)
        ? [method as 'left' | 'top' | 'width' | 'height' | 'visible'] : undefined
    if (!fields || args.length < fields.length) throw new Error('Invalid video geometry arguments')
    const changes: Partial<Record<'left' | 'top' | 'width' | 'height' | 'visible', number>> = {}
    for (let i = 0; i < fields.length; i++) {
      const value = args[i]
      if (typeof value !== 'bigint' && (typeof value !== 'number' || !Number.isSafeInteger(value)))
        throw new Error('Invalid video geometry argument')
      changes[fields[i]!] = fields[i] === 'visible' ? Number(!!value)
        : Number(BigInt.asIntN(32, typeof value === 'bigint' ? value : BigInt(value)))
    }
    if (video.snapshot.mode === 1) {
      // Native layer mode keeps its overlay Rect unchanged. setBounds is a
      // complete no-op, unlike setPos; width/height never resize bound Layers.
      if (method === 'setBounds' || 'width' in changes || 'height' in changes) return
      if ('visible' in changes) {
        video.snapshot.visible = !!changes.visible
        if (!video.ready) return
        const result = await this.videoCommand(video, { op: 'set', id, epoch: video.snapshot.epoch,
          settings: videoSettings(video.snapshot) })
        if (result.snapshot) video.snapshot = result.snapshot
      }
      return { windowId: video.windowId,
        // SetVisible reads the stored member again for Layer2 after Layer1's
        // blur callbacks. Positional method arguments remain fixed instead.
        values: () => method === 'visible' ? { visible: Number(video.snapshot.visible) } : changes,
        layer: (channel) => this.videos.get(id) === video
          ? video.layers[channel]?.id : undefined }
    }
    const state = { ...video.snapshot }
    for (const field of fields) {
      const value = changes[field]!
      if (field === 'visible') state.visible = !!value
      else {
        if (Math.abs(value) > 65536 || ((field === 'width' || field === 'height') && (value <= 0 || value > 4096)))
          throw new Error('Invalid video bounds')
        state[field] = value
      }
    }
    if (video.ready) {
      const result = await this.videoCommand(video, { op: 'set', id, epoch: video.snapshot.epoch,
        settings: videoSettings(state) })
      if (result.snapshot) video.snapshot = result.snapshot
    } else video.snapshot = state
  }
  private async command(command: VideoCommand) {
    if (!this.backend) throw new Error('This environment has no video backend')
    return this.backend.command(command)
  }
  private async videoCommand(video: Video, command: VideoCommand): Promise<VideoResult> {
    if (this.cancelled) throw new ExecutionCancelled()
    if (this.videos.get(video.id) !== video || video.detached)
      throw new Error('VideoOverlay has been invalidated or disconnected')
    if (command.op === 'open') video.resourceRequested = true
    const epoch = video.snapshot.epoch,
      pending = this.command(command)
    video.inflight.add(pending)
    try {
      const result = await pending
      if (this.cancelled) throw new ExecutionCancelled()
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
      ? [{ name: 'onFrameUpdate', args: [BigInt(event.callbackFrame ?? event.snapshot.frame)] }]
      : []
  }
  private pixels(video: Video, event: VideoEvent): void {
    if (event.type !== 'frame' || !event.pixels || video.snapshot.mode !== 1) return
    const ids = new Set(video.layers.flatMap((layer) => (layer ? [layer.id] : [])))
    for (const id of ids) this.frame(id, event.pixels)
  }
  private async receive(event: VideoEvent): Promise<void> {
    let lease: ScriptObject | undefined
    let receiptReleased = false
    const release = () => {
      const owned = lease
      lease = undefined
      if (owned) this.objects.release(owned)
    }
    try {
      if (this.disposed || this.cancelled) return
      if (event.type === 'error') throw new Error(event.message)
      const video = this.videos.get(event.id)
      if (!video || video.detached || video.snapshot.epoch !== event.epoch) return
      const layerFrame = event.type === 'frame' && event.snapshot.mode === 1 &&
        event.snapshot.status === 'play' && !!this.frameDispatcher
      const nativeFrame = layerFrame || (event.type === 'frame' && event.snapshot.mode === 2 &&
        event.snapshot.status === 'play' && event.deferredPeriod === true && !!this.frameDispatcher)
      if ((layerFrame && !video.layers.some(Boolean)) ||
          ((layerFrame || event.prepareToken !== undefined) && (event.prepareToken ?? 0) !== video.prepareToken)) return
      // Native asynchronous status changes revoke earlier undelivered video
      // events. Frame/period events keep their immediate/discardable semantics.
      if (event.type === 'ended') this.cancelEvents(video)
      // A frame may already be in transit when the game changes the mixer.
      // Playback events report the clock, but only a command changes colors.
      video.snapshot = video.snapshot.color ? { ...event.snapshot, color: video.snapshot.color } : event.snapshot
      const version = video.version
      const prepareToken = video.prepareToken
      const valid = () =>
        this.videos.get(video.id) === video &&
        !video.detached &&
        video.version === version &&
        video.snapshot.epoch === event.epoch &&
        (!layerFrame || (video.prepareToken === prepareToken && video.layers.some(Boolean)))
      const callbacks = this.callbacks(event)
      lease = this.objects.upgrade(video.owner)
      if (!lease) {
        this.retire(video.id)
        return
      }
      const callback = callbacks[0]
      await this.dispatch(
        nativeFrame ? this.frameDispatcher! : lease,
        nativeFrame ? undefined : callback?.name,
        nativeFrame ? [lease, callback?.args[0],
          BigInt(layerFrame), BigInt(event.deferredPeriod === true), BigInt(event.epoch),
          BigInt(event.deliveryToken ?? 0)] : callback?.args ?? [],
        valid,
        () => this.pixels(video, event),
        event.type !== 'ended',
        video,
        () => {
          receiptReleased = true
          release()
        },
        nativeFrame && (prepareToken !== 0 || event.deferredPeriod === true),
      )
    } catch (error) {
      this.error(error)
      // Session completion now includes the boundary that used to be awaited
      // in finally. Preserve its cleanup rejection; terminal cancellation is
      // still a dropped transport message, not a successful presented frame.
      if (receiptReleased && !(error instanceof ExecutionCancelled)) throw error
    } finally {
      if (lease) {
        // Release at event completion, while the VM can still drain the native
        // handle. Only then wait for presentation before acknowledging a frame.
        release()
        await this.deliveryBoundary()
      }
    }
  }
  async host(operation: string, args: ScriptValue[], context: HostContext): Promise<ScriptValue> {
    if (operation === 'Video.frameDone') {
      // The callback may have invalidated or reopened its own object. This
      // completion only releases the original producer token, never its new
      // graph, and never bypasses the receipt for actual Layer presentation.
      if (!this.disposed && !this.cancelled && this.videos.has(Number(args[0])))
        await this.command({ op: 'frameDone', id: Number(args[0]), epoch: Number(args[1]), token: Number(args[2]) })
      return
    }
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
          sourceCancels: new Set(),
          version: 0,
          prepareToken: 0,
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
    if (operation === 'Video.preparePending') return BigInt(video.prepareToken !== 0)
    if (operation === 'Video.destroy') {
      this.retire(video.id)
      return
    }
    if (operation === 'Video.mixingLayer') {
      if (!this.mixingLayer) throw new Error('This environment has no video mixing source')
      const bitmap = this.mixingLayer(
        args[1],
        videoSettings(video.snapshot),
        video.windowId,
        video.ready,
      )
      if (video.ready && video.snapshot.mode === 2)
        await this.videoCommand(video, {
          op: 'mixing',
          id: video.id,
          epoch: video.snapshot.epoch,
          bitmap,
        })
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
    const int32 = (i: number) => {
      const value = input[i]
      return Number(BigInt.asIntN(32, typeof value === 'bigint' ? value : BigInt(number(i))))
    }
    const apply = async (command: VideoCommand, check?: () => void) => {
      const result = await this.videoCommand(video, command)
      check?.()
      if (result.snapshot) video.snapshot = result.snapshot
      for (const event of result.events) {
        this.pixels(video, event)
        callbacks.push(...this.callbacks(event))
      }
    }
    const identity = () => ({ id: video.id, epoch: video.snapshot.epoch })
    let value: ScriptValue
    if (method === 'canPrepare') {
      value = BigInt(video.ready && video.snapshot.mode === 1)
    } else if (method === 'prepareArm' || method === 'prepareClear') {
      // IsPrepare is an object latch, not a graph preference: native Close,
      // Open, Stop and Pause do not reset it. A nested prepare is cleared by
      // the outer EC_UPDATE completion, matching the original boolean field.
      video.prepareToken = method === 'prepareArm' ? this.nextPrepare++ : 0
      if (!Number.isSafeInteger(this.nextPrepare)) throw new Error('Video prepare identity budget exceeded')
      if (video.ready) await apply({ op: 'prepare', ...identity(), token: video.prepareToken })
    } else if (method === 'periodTake') {
      const frame = int32(0)
      // Most game frames have no pending cue. Callback commands update this
      // snapshot before returning, so only a due cue needs a host roundtrip.
      if (video.snapshot.periodEventFrame < 0 || video.snapshot.periodEventPast || frame < video.snapshot.periodEventFrame)
        return scriptRecord({ value, callbacks: scriptList([]) })
      if (video.ready) await apply({ op: 'periodTake', ...identity(), frame })
      else {
        // Close in onFrameUpdate retains the object's cue, just as the stock
        // WndProc continues its immediate check after the graph is released.
        const period = new VideoPeriod(video.snapshot.periodEventFrame, video.snapshot.periodEventPast)
        if (period.take(frame)) callbacks.push({ name: 'onPeriod', args: [1n] })
        video.snapshot = { ...video.snapshot, periodEventFrame: period.frame, periodEventPast: period.past }
      }
    } else if (method === 'prepareOpen') {
      if (input.length < 1) throw new TjsError('TJSBadParamCount')
    } else if (method === 'close') {
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
        ...videoObjectSettings(video.snapshot),
        periodEventPast: video.snapshot.periodEventPast ?? false,
      }
      if (previous !== 'unload') callbacks.push({ name: 'onStatusChanged', args: ['unload'] })
    } else if (method === 'open') {
      if (video.detached) throw new Error('VideoOverlay is disconnected from its Window')
      const name = text(0)
      this.cancelEvents(video)
      video.snapshot.epoch = this.epoch++
      const epoch = video.snapshot.epoch, control = this.sourceControl(video),
        source = await this.readSource(name.split('?')[0]!, control)
      try {
        control.check()
        await apply({
          op: 'open', id: video.id, epoch,
          windowId: video.windowId,
          name,
          bytes: source instanceof Uint8Array ? source : source.bytes,
          // Native graph controls are not preferences carried across files.
          // Only the containing VideoOverlay's object fields survive reopening.
          settings: { ...defaultVideoSettings(), ...videoObjectSettings(video.snapshot) },
          periodEventPast: video.snapshot.periodEventPast ?? false,
          prepareToken: video.prepareToken,
        }, control.check)
      } finally {
        if (!(source instanceof Uint8Array)) source.release()
      }
      control.check()
      video.ready = true
      callbacks.push({ name: 'onStatusChanged', args: [video.snapshot.status] })
    } else if (['play', 'stop', 'pause', 'rewind', 'prepareRewind'].includes(method)) {
      if (video.ready) {
        this.cancelEvents(video)
        const previous = video.snapshot.status
        video.snapshot.epoch = this.epoch++
        await apply(method === 'prepareRewind' ? { op: 'rewind', ...identity(), silent: true }
          : { op: method as 'play', ...identity() })
        if (previous !== video.snapshot.status)
          callbacks.unshift({ name: 'onStatusChanged', args: [video.snapshot.status] })
      }
    } else if (method === 'colorGet' || method === 'colorSet') {
      const control = text(0) as VideoColorControl
      if (!Object.hasOwn(videoColorRanges, control)) throw new Error('Unknown video color control')
      const colors = video.ready && video.snapshot.mode === 2 ? video.snapshot.color : undefined
      if (method === 'colorGet') {
        const field = text(1) as VideoColorRangeField | ''
        if (field && !Object.hasOwn(videoColorRanges[control], field)) throw new Error('Unknown video color range')
        value = colors ? field ? Math.fround(videoColorRanges[control][field]) : colors[control] : -1
      } else if (colors) {
        const color = { ...colors, [control]: videoColorSetting(control, number(1)) }
        await apply({ op: 'set', ...identity(), settings: { ...videoSettings(video.snapshot), color } })
      }
    } else if (method === 'get') {
      const property = text(0)
      if (video.ready && property !== 'audioVolume') await apply({ op: 'inspect', ...identity() })
      if (
        video.ready &&
        video.snapshot.frame < 0 &&
        ['frame', 'fps', 'numberOfFrame'].includes(property)
      )
        throw new Error('This video container has no supported frame index')
      if (!(property in video.snapshot)) throw new Error(`Unsupported video property: ${property}`)
      let result = video.snapshot[property as keyof VideoSnapshot]
      // The fixed dsmovie GetAudioVolume returns without writing its output;
      // VideoOvlImpl initializes attenuation to zero, hence public full volume.
      // Keep the actual graph setting separate so reads cannot unmute playback.
      if (property === 'audioVolume') result = 100000
      else if (property === 'audioBalance') result = videoBalanceReadback(Number(result))
      else if (!video.ready && (property === 'enabledAudioStream' || property === 'enabledVideoStream')) result = -1
      else if (!video.ready && (property === 'playRate' || property === 'mixingMovieAlpha')) result = 0
      value =
        typeof result === 'string'
          ? result
          : typeof result === 'number' &&
              (property === 'fps' || property === 'playRate' || property === 'mixingMovieAlpha')
            ? result
            : BigInt(Number(result))
    } else if (method === 'set') {
      const property = text(0)
      // The TJS binding has already performed its numeric conversion. Native
      // setters return before talking to or validating an absent media graph.
      if (!video.ready && graphSettings.has(property))
        return scriptRecord({ value, callbacks: scriptList([]) })
      const setting = property === 'audioVolume' || property === 'audioBalance' || property === 'periodEventFrame'
        ? int32(1)
        : number(1)
      if (property === 'periodEventFrame') {
        if (video.ready) await apply({ op: 'period', ...identity(), frame: setting })
        else {
          const period = new VideoPeriod(video.snapshot.periodEventFrame, video.snapshot.periodEventPast)
          period.set(setting, 0)
          video.snapshot = { ...video.snapshot, periodEventFrame: period.frame, periodEventPast: period.past }
        }
      } else if (property === 'position' || property === 'frame') {
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
        } else if (property === 'loop') state.loop = !!setting
        else if (property === 'playRate') {
          // Fixed dsmovie SetPlayRate only calls SetRate for a positive value.
          if (setting <= 0) return scriptRecord({ value, callbacks: scriptList([]) })
          if (setting > 16) throw new Error('Video playback rate exceeds the supported maximum of 16')
          state.playRate = setting
        } else if (property === 'audioVolume')
          state.audioVolume = Math.max(0, Math.min(100000, setting))
        else if (property === 'audioBalance')
          state.audioBalance = Math.max(-100000, Math.min(100000, setting))
        else if (property === 'mixingMovieAlpha')
          state.mixingMovieAlpha = Math.max(0, Math.min(1, setting))
        else if (property === 'mixingMovieBGColor') state.mixingMovieBGColor = setting >>> 0
        else throw new Error(`Unsupported video setting: ${property}`)
        if (video.ready) await apply({ op: 'set', ...identity(), settings: videoSettings(state) })
        else video.snapshot = state
      }
    } else if (method === 'segment') {
      if (input.length < 2) throw new TjsError('TJSBadParamCount')
      const state = { ...video.snapshot, segmentLoopStartFrame: int32(0), segmentLoopEndFrame: int32(1) }
      if (video.ready) await apply({ op: 'set', ...identity(), settings: videoSettings(state) })
      else video.snapshot = state
    } else if (method === 'audioStream' || method === 'videoStream') {
      const count = method === 'audioStream' ? video.snapshot.numberOfAudioStream : video.snapshot.numberOfVideoStream,
        property = method === 'audioStream' ? 'enabledAudioStream' : 'enabledVideoStream'
      const requested = input[0]
      if (typeof requested !== 'bigint' && (typeof requested !== 'number' || !Number.isSafeInteger(requested)))
        throw new Error('Invalid video stream index')
      // Native TJS binding narrows int64 through signed/unsigned 32-bit.
      // The original SelectStream ignores an unavailable/out-of-range index.
      const index = Number(BigInt.asUintN(32, typeof requested === 'bigint' ? requested : BigInt(requested)))
      if (video.ready && index < count) {
        if (index !== video.snapshot[property]) {
          // A frame already sent by the previous media graph must not restore
          // its stream selection or layer pixels after the replacement commits.
          this.cancelEvents(video)
          video.snapshot.epoch = this.epoch++
        }
        await apply({
          op: 'set',
          ...identity(),
          settings: { ...videoSettings(video.snapshot), [property]: index },
        })
      }
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
    if (this.cancelled) return
    this.cancelled = true
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
    for (const callback of [this.callbackDispatcher, this.frameDispatcher]) {
      if (callback) {
        try { this.objects.release(callback) }
        catch (error) { if (!failed) { primary = error; failed = true } }
      }
    }
    this.callbackDispatcher = this.frameDispatcher = undefined
    if (failed) throw primary
  }
}
