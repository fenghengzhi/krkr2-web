import {
  defaultSoundSettings,
  emptyLoops,
  type AudioBackend,
  type AudioCommand,
  type AudioResult,
  type AudioEvent,
  type SoundKind,
  type SoundSnapshot,
} from '../ports/audio.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type ScriptObject,
  type ScriptValue,
} from '../script/runtime.ts'
import { parseSli } from '../../formats/audio/sli.ts'
interface Sound {
  id: number
  kind: SoundKind
  callback: ScriptObject
  snapshot: SoundSnapshot
  ready: boolean
  version: number
  labels: ScriptValue
}
type Callback = { name: string; args: ScriptValue[] }
export class SoundService {
  private nextId = 1
  private buffers = new Map<number, Sound>()
  private unsubscribe?: () => void
  private globalVolume = 100000
  private globalFocusMode = 0
  constructor(
    private readonly objects: HostContext,
    private readonly backend: AudioBackend | undefined,
    private readonly read: (name: string) => Promise<Uint8Array>,
    private readonly exists: (name: string) => boolean,
    private readonly text: (bytes: Uint8Array) => Promise<string>,
    private readonly dispatch: (
      callback: ScriptObject,
      args: ScriptValue[],
      valid: () => boolean,
    ) => Promise<void>,
    private readonly error: (error: unknown) => void,
  ) {
    this.unsubscribe = backend?.listen((event) => this.receive(event))
  }
  private get(id: number): Sound {
    const sound = this.buffers.get(id)
    if (!sound) throw new Error('SoundBuffer has been invalidated')
    return sound
  }
  private async command(command: AudioCommand): Promise<AudioResult> {
    if (!this.backend) throw new Error('This environment has no audio backend')
    return this.backend.command(command)
  }
  private async prepare(sound: Sound): Promise<void> {
    if (sound.ready) return
    const result = await this.command({
      op: 'create',
      id: sound.id,
      settings: sound.snapshot,
      kind: sound.kind,
    })
    sound.ready = true
    if (result.snapshot) sound.snapshot = result.snapshot
  }
  private receive(event: AudioEvent): void {
    if (event.type === 'error') {
      this.error(new Error(event.message))
      return
    }
    const sound = this.buffers.get(event.id)
    if (!sound || event.epoch !== sound.snapshot.epoch) return
    sound.snapshot = event.snapshot
    const version = sound.version,
      name =
        event.type === 'ended'
          ? 'onStatusChanged'
          : event.type === 'fade'
            ? 'onFadeCompleted'
            : 'onLabel'
    const args: ScriptValue[] =
      event.type === 'ended' ? ['stop'] : event.type === 'label' ? [event.label ?? ''] : []
    void this.dispatch(
      sound.callback,
      [name, scriptList(args)],
      () =>
        this.buffers.get(sound.id) === sound &&
        sound.version === version &&
        sound.snapshot.epoch === event.epoch,
    ).catch(this.error)
  }
  private result(value: ScriptValue, callbacks: Callback[]): ScriptValue {
    return scriptRecord({
      value,
      callbacks: scriptList(
        callbacks.map((event) => scriptList([event.name, scriptList(event.args)])),
      ),
    })
  }
  async host(operation: string, args: ScriptValue[], context: HostContext): Promise<ScriptValue> {
    const number = (i: number) => {
      const value = Number(args[i])
      if (!Number.isSafeInteger(value)) throw new Error('Invalid sound numeric argument')
      return value
    }
    if (operation === 'Sound.create') {
      const kind = args[0],
        callback = args[1]
      if (!['wave', 'midi', 'cdda'].includes(String(kind)) || !isScriptObject(callback))
        throw new Error('Invalid sound constructor')
      if (this.buffers.size >= 256) throw new Error('Sound buffer budget exceeded')
      const id = this.nextId++
      this.buffers.set(id, {
        id,
        kind: kind as SoundKind,
        callback: context.retain(callback),
        ready: false,
        version: 0,
        labels: scriptRecord({}),
        snapshot: {
          id,
          epoch: 0,
          ...defaultSoundSettings(),
          status: 'unload',
          fading: false,
          flags: Array(16).fill(0),
          sampleRate: 0,
          sampleCount: 0,
          channels: 0,
          bits: 0,
        },
      })
      return BigInt(id)
    }
    if (operation === 'Sound.global') {
      const property = args[0]
      if (property === 'volume') {
        if (args[1] !== undefined) {
          this.globalVolume = Math.max(0, Math.min(100000, number(1)))
          if (this.backend) await this.command({ op: 'globalVolume', volume: this.globalVolume })
        }
        return BigInt(this.globalVolume)
      }
      if (property === 'focusMode') {
        if (args[1] !== undefined) {
          const mode = number(1)
          if (mode < 0 || mode > 2) throw new Error('Invalid sound global focus mode')
          if (this.backend) await this.command({ op: 'focusMode', mode })
          this.globalFocusMode = mode
        }
        return BigInt(this.globalFocusMode)
      }
      if (property === 'midiOut') {
        if (!(args[1] instanceof Uint8Array)) throw new Error('MIDI output requires an octet')
        await this.command({ op: 'midiOut', data: args[1] })
        return
      }
      throw new Error('Unsupported sound global property')
    }
    const sound = this.get(number(0))
    if (operation === 'Sound.flags')
      return { type: 'proxy', namespace: 'Sound.flags', id: sound.id, className: 'WaveFlags' }
    if (operation.startsWith('Sound.flags.')) {
      const property = String(args[1]),
        action = operation.slice('Sound.flags.'.length)
      if (action === 'get' && property === 'count') return 16n
      if (action === 'call' && property === 'reset') {
        sound.snapshot.flags.fill(0)
        if (sound.ready)
          for (let index = 0; index < 16; index++)
            await this.command({ op: 'flag', id: sound.id, index, value: 0 })
        return
      }
      const index = Number(property)
      if (!Number.isInteger(index) || index < 0 || index >= 16)
        throw new Error('Wave flag index is outside 0..15')
      if (action === 'get') {
        if (sound.ready) {
          const result = await this.command({ op: 'inspect', id: sound.id })
          if (result.snapshot) sound.snapshot = result.snapshot
        }
        return BigInt(sound.snapshot.flags[index]!)
      }
      if (action === 'set') {
        const value = Math.max(0, Math.min(9999, number(2)))
        sound.snapshot.flags[index] = value
        if (sound.ready) {
          const result = await this.command({ op: 'flag', id: sound.id, index, value })
          if (result.snapshot) sound.snapshot = result.snapshot
        }
        return
      }
      throw new Error('Unsupported wave flag operation')
    }
    if (operation === 'Sound.destroy') {
      sound.version++
      this.buffers.delete(sound.id)
      context.release(sound.callback)
      if (sound.ready) await this.command({ op: 'close', id: sound.id })
      return
    }
    if (operation !== 'Sound.call' || typeof args[1] !== 'string' || !isScriptObject(args[2]))
      throw new Error('Invalid sound call')
    const method = args[1],
      array = context.snapshot(args[2])
    if (array.type !== 'array') throw new Error('Sound arguments must be an Array')
    const input = array.items
    const text = (i: number) => {
      if (typeof input[i] !== 'string') throw new Error('Expected sound text argument')
      return input[i] as string
    }
    const numeric = (i: number) => {
      const value = Number(input[i])
      if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)
        throw new Error('Invalid sound argument')
      return value
    }
    const callbacks: Callback[] = []
    let value: ScriptValue
    const apply = async (command: AudioCommand) => {
      const result = await this.command(command)
      if (result.snapshot) sound.snapshot = result.snapshot
      for (const event of result.events) {
        if (event.type === 'error') throw new Error(event.message)
        callbacks.push({
          name:
            event.type === 'fade'
              ? 'onFadeCompleted'
              : event.type === 'ended'
                ? 'onStatusChanged'
                : 'onLabel',
          args:
            event.type === 'ended' ? ['stop'] : event.type === 'label' ? [event.label ?? ''] : [],
        })
      }
    }
    if (method === 'unload') {
      const previous = sound.snapshot.status
      sound.version++
      if (sound.ready) await this.command({ op: 'close', id: sound.id })
      sound.ready = false
      sound.labels = scriptRecord({})
      sound.snapshot = {
        ...sound.snapshot,
        status: 'unload',
        epoch: 0,
        position: 0,
        paused: false,
        frequency: 0,
        sampleRate: 0,
        sampleCount: 0,
        channels: 0,
        bits: 0,
        fading: false,
        flags: Array(16).fill(0),
      }
      if (previous !== 'unload') callbacks.push({ name: 'onStatusChanged', args: ['unload'] })
    } else if (method === 'open') {
      sound.version++
      const name = text(0),
        previous = sound.snapshot.status
      const bytes = await this.read(name),
        sli = name + '.sli',
        loops = this.exists(sli) ? parseSli(await this.text(await this.read(sli))) : emptyLoops()
      await apply({
        op: 'open',
        id: sound.id,
        kind: sound.kind,
        bytes,
        loops,
        settings: sound.snapshot,
      })
      sound.ready = true
      sound.labels = scriptRecord(
        Object.fromEntries(
          loops.labels
            .filter((label) => label.name)
            .map((label) => [
              label.name,
              scriptRecord({
                name: label.name,
                samplePosition: BigInt(label.position),
                position: BigInt(Math.floor((label.position * 1000) / sound.snapshot.sampleRate)),
              }),
            ]),
        ),
      )
      if (sound.snapshot.status !== previous)
        callbacks.push({ name: 'onStatusChanged', args: [sound.snapshot.status] })
    } else if (method === 'play' || method === 'stop') {
      const previous = sound.snapshot.status
      if (sound.ready) await apply({ op: method, id: sound.id })
      if (sound.snapshot.status !== previous) {
        sound.version++
        callbacks.push({ name: 'onStatusChanged', args: [sound.snapshot.status] })
      }
    } else if (method === 'fade') {
      await this.prepare(sound)
      await apply({
        op: 'fade',
        id: sound.id,
        target: numeric(0),
        time: numeric(1),
        delay: numeric(2),
      })
    } else if (method === 'stopFade') {
      if (sound.ready) await apply({ op: 'stopFade', id: sound.id, finish: !!numeric(0) })
    } else if (method === 'get') {
      const property = text(0)
      if (property === 'labels') return this.result(sound.labels, callbacks)
      if (sound.ready) {
        const result = await this.command({ op: 'inspect', id: sound.id })
        if (result.snapshot) sound.snapshot = result.snapshot
      }
      const state = sound.snapshot
      if (property === 'position')
        value = BigInt(
          state.sampleRate ? Math.floor((state.position * 1000) / state.sampleRate) : 0,
        )
      else if (property === 'samplePosition') value = BigInt(state.position)
      else if (property === 'totalTime')
        value = BigInt(
          state.sampleRate ? Math.floor((state.sampleCount * 1000) / state.sampleRate) : 0,
        )
      else if (property === 'status') value = state.status
      else if (
        ['paused', 'looping', 'frequency', 'volume', 'volume2', 'pan', 'bits', 'channels'].includes(
          property,
        )
      )
        value = BigInt(Number(state[property as 'volume']))
      else throw new Error(`Unsupported sound property: ${property}`)
    } else if (method === 'set') {
      const property = text(0)
      let setting = numeric(1)
      if (property === 'volume' || property === 'volume2')
        setting = Math.max(0, Math.min(100000, setting))
      if (property === 'pan') setting = Math.max(-100000, Math.min(100000, setting))
      if (property === 'position') setting = (setting * sound.snapshot.sampleRate) / 1000
      const key = property === 'samplePosition' || property === 'position' ? 'position' : property
      if (!['volume', 'volume2', 'pan', 'looping', 'paused', 'frequency', 'position'].includes(key))
        throw new Error(`Unsupported sound property: ${property}`)
      if (sound.ready)
        await apply({ op: 'set', id: sound.id, property: key as 'volume', value: setting })
      else if (key === 'paused' || key === 'looping') sound.snapshot[key] = !!setting
      else sound.snapshot[key as 'volume'] = setting
    } else throw new Error(`Unsupported sound method: ${method}`)
    return this.result(value, callbacks)
  }
  async pause(paused: boolean): Promise<void> {
    if (this.backend) await this.command({ op: 'pauseAll', paused })
  }
  async dispose(): Promise<void> {
    this.unsubscribe?.()
    for (const sound of this.buffers.values()) {
      sound.version++
      this.objects.release(sound.callback)
    }
    this.buffers.clear()
    await this.backend?.close()
  }
}
