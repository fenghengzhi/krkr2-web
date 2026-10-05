import {
  defaultSoundSettings,
  emptyLoops,
  type AudioBackend,
  type AudioCommand,
  type AudioResult,
  type AudioEvent,
  type SoundKind,
  type SoundSnapshot,
  type LoopInfo,
} from '../ports/audio.ts'
import {
  isScriptObject,
  scriptList,
  scriptRecord,
  type HostContext,
  type ScriptRuntime,
  type ScriptObject,
  type ScriptWeakObject,
  type ScriptValue,
} from '../script/runtime.ts'
import { PhaseVocoderService, type PhaseVocoderConnection } from './phase-vocoder-service.ts'
import { parseSli } from '../../formats/audio/sli.ts'
import type { Resource } from '../ports/storage.ts'
import { AudioResourceSources, type AudioSourceLease } from '../storage/audio-sources.ts'
interface Sound {
  id: number
  kind: SoundKind
  owner: ScriptWeakObject
  snapshot: SoundSnapshot
  ready: boolean
  resourceRequested: boolean
  inflight: Set<Promise<AudioResult>>
  version: number
  labels: ScriptValue
  filters?: PhaseVocoderConnection
}
type Callback = { name: string; args: ScriptValue[] }
export class SoundService {
  private readonly sources?: AudioResourceSources
  private cancelling?: Promise<void>
  private readonly filters: PhaseVocoderService
  private nextId = 1
  private buffers = new Map<number, Sound>()
  private unsubscribe?: () => void
  private globalVolume = 100000
  private globalFocusMode = 0
  private disposed = false
  private closes = new Set<Promise<void>>()
  private closeErrors: unknown[] = []
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly backend: AudioBackend | undefined,
    private readonly read: (name: string) => Promise<Uint8Array>,
    private readonly exists: (name: string) => boolean,
    private readonly text: (bytes: Uint8Array) => Promise<string>,
    private readonly dispatch: (
      callback: ScriptObject,
      member: string,
      args: ScriptValue[],
      valid: () => boolean,
      source: object,
    ) => Promise<void>,
    private readonly error: (error: unknown) => void,
    private readonly cancelQueued: (source: object) => void = () => {},
    private readonly resourceSource?: {
      resolve(name: string): Resource
      checkpoint(): void | Promise<void>
    },
  ) {
    if (resourceSource) this.sources = new AudioResourceSources(() => resourceSource.checkpoint())
    this.filters = new PhaseVocoderService(objects, async (id, filters) => {
      const sound = this.get(id)
      const result = await this.voiceCommand(sound, { op: 'filters', id, filters })
      if (result.snapshot) sound.snapshot = result.snapshot
      for (const event of result.events) if (event.type === 'error') throw new Error(event.message)
    })
    this.unsubscribe = backend?.listen((event) => this.receive(event))
  }
  get count(): number {
    return this.buffers.size
  }
  get pendingCloses(): number {
    return this.closes.size
  }
  private cancelEvents(sound: Sound): void {
    sound.version++
    this.cancelQueued(sound)
  }
  private retire(id: number): void {
    const sound = this.buffers.get(id)
    if (!sound) return
    this.buffers.delete(id)
    try {
      this.cancelEvents(sound)
    } finally {
      this.objects.unobserve(sound.owner)
    }
    if (!sound.resourceRequested) {
      sound.filters?.release()
      sound.filters = undefined
      return
    }
    // Invalidation is a synchronous native notification. Starting a backend
    // command here could synchronously emit events; defer it until we return.
    const closing = Promise.resolve().then(async () => {
      await Promise.allSettled([...sound.inflight])
      await this.command({ op: 'close', id })
      sound.filters?.release()
      sound.filters = undefined
    })
    this.closes.add(closing)
    void closing.then(
      () => {
        this.closes.delete(closing)
      },
      (error) => {
        this.closes.delete(closing)
        this.closeErrors.push(error)
      },
    )
  }
  async flushCloses(): Promise<void> {
    while (this.closes.size) await Promise.allSettled([...this.closes])
    if (this.closeErrors.length) {
      const error = this.closeErrors[0]
      this.closeErrors.length = 0
      throw error
    }
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
  private async voiceCommand(sound: Sound, command: AudioCommand): Promise<AudioResult> {
    if (this.buffers.get(sound.id) !== sound) throw new Error('SoundBuffer has been invalidated')
    if (command.op === 'create' || command.op === 'open' || command.op === 'openSource') sound.resourceRequested = true
    const pending = this.command(command)
    sound.inflight.add(pending)
    try {
      const result = await pending
      if (this.buffers.get(sound.id) !== sound) throw new Error('SoundBuffer has been invalidated')
      return result
    } finally {
      sound.inflight.delete(pending)
    }
  }
  private async prepare(sound: Sound): Promise<void> {
    if (sound.ready) return
    const result = await this.voiceCommand(sound, {
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
    let lease: ScriptObject | undefined
    try {
      lease = this.objects.upgrade(sound.owner)
    } catch (error) {
      this.error(error)
      return
    }
    if (!lease) {
      this.retire(sound.id)
      return
    }
    const held = lease
    const valid = () =>
      this.buffers.get(sound.id) === sound &&
      sound.version === version &&
      sound.snapshot.epoch === event.epoch
    try {
      void this.dispatch(held, name, args, valid, sound)
        .finally(() => this.objects.release(held))
        .catch(this.error)
    } catch (error) {
      this.objects.release(held)
      this.error(error)
    }
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
    if (operation.startsWith('PhaseVocoder.')) return this.filters.host(operation, args)
    const number = (i: number) => {
      const value = Number(args[i])
      if (!Number.isSafeInteger(value)) throw new Error('Invalid sound numeric argument')
      return value
    }
    if (operation === 'Sound.create') {
      if (this.disposed) throw new Error('Sound service is disposed')
      const kind = args[0],
        callback = args[1]
      if (!['wave', 'midi', 'cdda'].includes(String(kind)) || !isScriptObject(callback))
        throw new Error('Invalid sound constructor')
      if (this.buffers.size >= 256) throw new Error('Sound buffer budget exceeded')
      const id = this.nextId++
      const owner = this.objects.observe(callback, () => this.retire(id))
      try {
        this.buffers.set(id, {
          id,
          kind: kind as SoundKind,
          owner,
          ready: false,
          resourceRequested: false,
          inflight: new Set(),
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
      } catch (error) {
        this.objects.unobserve(owner)
        throw error
      }
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
    if (operation === 'Sound.bindLabels') {
      if (!isScriptObject(args[1]) || !isScriptObject(args[2]))
        throw new Error('Sound labels require their sound owner and Dictionary')
      this.objects.bindDependent(args[1], args[2])
      return
    }
    if (operation === 'Sound.flags') {
      if (!isScriptObject(args[1])) throw new Error('WaveFlags requires its sound owner')
      return {
        type: 'proxy',
        namespace: 'Sound.flags',
        id: sound.id,
        className: 'WaveFlags',
        owner: args[1],
      }
    }
    if (operation.startsWith('Sound.flags.')) {
      const property = String(args[1]),
        action = operation.slice('Sound.flags.'.length)
      if (action === 'get' && property === 'count') return 16n
      if (action === 'call' && property === 'reset') {
        sound.snapshot.flags.fill(0)
        if (sound.snapshot.status !== 'unload')
          for (let index = 0; index < 16; index++)
            await this.voiceCommand(sound, { op: 'flag', id: sound.id, index, value: 0 })
        return
      }
      const index = Number(property)
      if (!Number.isInteger(index) || index < 0 || index >= 16)
        throw new Error('Wave flag index is outside 0..15')
      if (action === 'get') {
        if (sound.snapshot.status === 'unload') return 0n
        if (sound.ready) {
          const result = await this.voiceCommand(sound, { op: 'inspect', id: sound.id })
          if (result.snapshot) sound.snapshot = result.snapshot
        }
        return BigInt(sound.snapshot.flags[index]!)
      }
      if (action === 'set') {
        if (sound.snapshot.status === 'unload') return
        const value = Math.max(0, Math.min(9999, number(2)))
        sound.snapshot.flags[index] = value
        if (sound.ready) {
          const result = await this.voiceCommand(sound, { op: 'flag', id: sound.id, index, value })
          if (result.snapshot) sound.snapshot = result.snapshot
        }
        return
      }
      throw new Error('Unsupported wave flag operation')
    }
    if (operation === 'Sound.destroy') {
      this.retire(sound.id)
      await this.flushCloses()
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
      const result = await this.voiceCommand(sound, command)
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
      this.cancelEvents(sound)
      if (sound.resourceRequested) await this.voiceCommand(sound, { op: 'close', id: sound.id })
      sound.filters?.release()
      sound.filters = undefined
      sound.resourceRequested = false
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
      this.cancelEvents(sound)
      const name = text(0),
        previous = sound.snapshot.status
      if (sound.filters) throw new Error('Sound must unload before opening a new stream')
      if (sound.kind === 'wave') {
        if (!isScriptObject(args[3])) throw new Error('WaveSoundBuffer filters must be an Array')
        sound.filters = this.filters.connect(sound.id, args[3])
      }
      let loops: LoopInfo
      let sourceLease: AudioSourceLease | undefined
      try {
        const sli = name + '.sli'
        loops = this.exists(sli) ? parseSli(await this.text(await this.read(sli))) : emptyLoops()
        if (sound.kind === 'wave' && this.backend?.streaming && this.sources && this.resourceSource) {
          sourceLease = await this.sources.open(this.resourceSource.resolve(name),
            () => !this.disposed && !this.cancelling && this.buffers.get(sound.id) === sound)
          await apply({ op: 'openSource', id: sound.id, kind: sound.kind,
            source: sourceLease.source, bufferedBytes: sourceLease.bufferedBytes,
            releaseSource: sourceLease.release, loops, settings: sound.snapshot,
            filters: sound.filters?.settings() })
        } else {
          const bytes = await this.read(name)
          await apply({ op: 'open', id: sound.id, kind: sound.kind, bytes,
            loops, settings: sound.snapshot, filters: sound.filters?.settings() })
        }
      } catch (error) {
        // Backends release after actual decoder cleanup. Idempotence also
        // covers failures before the backend acquired this resource lease.
        sourceLease?.release()
        // open may already have allocated a backend voice before returning an
        // error. Its serialized close completes before releasing native leases.
        // An expired owner already scheduled close after all inflight work;
        // that task owns its leases until close completes. Releasing them here
        // would let another sound connect while the old decoder is still live.
        if (this.buffers.get(sound.id) !== sound) throw error
        const cleanupErrors: unknown[] = []
        try {
          if (sound.resourceRequested) await this.voiceCommand(sound, { op: 'close', id: sound.id })
        } catch (failure) {
          cleanupErrors.push(failure)
        }
        if (this.buffers.get(sound.id) !== sound) {
          if (cleanupErrors.length)
            throw new AggregateError([error, ...cleanupErrors], 'Sound open and retirement failed')
          throw error
        }
        // A failed close has not proved the decoder is gone. Keep its Source
        // reservation for the next unload/terminal cleanup rather than permit
        // another sound to reuse the same filter while that decoder may exist.
        if (cleanupErrors.length)
          throw new AggregateError([error, ...cleanupErrors], 'Sound open and rollback failed')
        try {
          sound.filters?.release()
        } finally {
          sound.filters = undefined
          sound.resourceRequested = false
          sound.ready = false
        }
        throw error
      }
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
        this.cancelEvents(sound)
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
        const result = await this.voiceCommand(sound, { op: 'inspect', id: sound.id })
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
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling
    this.sources?.dispose()
    // Queue drain waits for TJS host calls. Cancel their source waiters now,
    // before retirement later waits for those same inflight calls to finish.
    this.cancelling = Promise.resolve().then(() =>
      this.backend?.cancel ? this.backend.cancel() : this.pause(true))
    void this.cancelling.catch(() => {})
    return this.cancelling
  }
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.flushCloses()
      return
    }
    this.disposed = true
    this.unsubscribe?.()
    if (this.backend?.cancel) void this.cancel()
    for (const id of [...this.buffers.keys()]) this.retire(id)
    let primary: unknown,
      failed = false
    try {
      await this.flushCloses()
    } catch (error) {
      primary = error
      failed = true
    }
    try {
      this.filters.dispose()
    } catch (error) {
      if (!failed) {
        primary = error
        failed = true
      }
    }
    try {
      await this.cancelling
    } catch (error) {
      if (!failed) { primary = error; failed = true }
    }
    try {
      await this.backend?.close()
    } catch (error) {
      if (!failed) throw error
    } finally { this.sources?.dispose() }
    if (failed) throw primary
  }
}
