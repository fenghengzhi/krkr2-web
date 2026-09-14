import {
  defaultVideoSettings,
  emptyVideoSnapshot,
  type VideoBackend,
  type VideoCommand,
  type VideoEvent,
  type VideoSettings,
  type VideoSnapshot,
} from '../ports/video.ts'
import type { Pixels } from '../ports/graphics.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type ScriptObject,
  type ScriptValue,
} from '../script/runtime.ts'
interface Video {
  id: number
  callback: ScriptObject
  snapshot: VideoSnapshot
  ready: boolean
  layers: (number | null)[]
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
  constructor(
    private readonly objects: HostContext,
    private readonly backend: VideoBackend | undefined,
    private readonly read: (name: string) => Promise<Uint8Array>,
    private readonly frame: (id: number, pixels: Pixels) => void,
    private readonly dispatch: (
      callback: ScriptObject,
      args: ScriptValue[],
      valid: () => boolean,
      before: () => void,
      immediate: boolean,
    ) => Promise<void>,
    private readonly error: (error: unknown) => void,
  ) {
    this.unsubscribe = backend?.listen((event) => this.receive(event))
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
    for (const id of new Set(video.layers)) if (id !== null) this.frame(id, event.pixels)
  }
  private async receive(event: VideoEvent): Promise<void> {
    try {
      if (event.type === 'error') throw new Error(event.message)
      const video = this.videos.get(event.id)
      if (!video || video.snapshot.epoch !== event.epoch) return
      video.snapshot = event.snapshot
      const valid = () =>
        this.videos.get(video.id) === video && video.snapshot.epoch === event.epoch
      const callbacks = this.callbacks(event)
      await this.dispatch(
        video.callback,
        [scriptList(callbacks.map((item) => scriptList([item.name, scriptList(item.args)])))],
        valid,
        () => this.pixels(video, event),
        event.type !== 'ended',
      )
    } catch (error) {
      this.error(error)
    }
  }
  async host(operation: string, args: ScriptValue[], context: HostContext): Promise<ScriptValue> {
    if (operation === 'Video.create') {
      if (!isScriptObject(args[0])) throw new Error('Invalid VideoOverlay callback')
      if (this.videos.size >= 16) throw new Error('Video overlay limit exceeded')
      const id = this.next++
      this.videos.set(id, {
        id,
        callback: context.retain(args[0]),
        snapshot: emptyVideoSnapshot(id, this.epoch++),
        ready: false,
        layers: [null, null],
      })
      return BigInt(id)
    }
    const video = this.get(Number(args[0]))
    if (operation === 'Video.destroy') {
      this.videos.delete(video.id)
      context.release(video.callback)
      if (video.ready) await this.command({ op: 'close', id: video.id, epoch: this.epoch++ })
      return
    }
    if (operation === 'Video.layer') {
      const channel = Number(args[1]),
        id = args[2] === null ? null : Number(args[2])
      if ((channel !== 0 && channel !== 1) || (id !== null && !Number.isSafeInteger(id)))
        throw new Error('Invalid video layer')
      video.layers[channel] = id
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
      const result = await this.command(command)
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
      video.snapshot.epoch = this.epoch++
      if (video.ready) await this.command({ op: 'close', ...identity() })
      video.ready = false
      video.snapshot = {
        ...emptyVideoSnapshot(video.id, video.snapshot.epoch),
        ...videoSettings(video.snapshot),
      }
      if (previous !== 'unload') callbacks.push({ name: 'onStatusChanged', args: ['unload'] })
    } else if (method === 'open') {
      const name = text(0)
      video.snapshot.epoch = this.epoch++
      await apply({
        op: 'open',
        ...identity(),
        name,
        bytes: await this.read(name.split('?')[0]!),
        settings: videoSettings(video.snapshot),
      })
      video.ready = true
      callbacks.push({ name: 'onStatusChanged', args: [video.snapshot.status] })
    } else if (['play', 'stop', 'pause', 'rewind', 'prepare'].includes(method)) {
      if (video.ready) {
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
    if (this.backend) await this.command({ op: 'cancel' })
  }
  async dispose(): Promise<void> {
    this.unsubscribe?.()
    for (const video of this.videos.values()) this.objects.release(video.callback)
    this.videos.clear()
    await this.backend?.close()
  }
}
