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
  type WaveConversion,
} from '../ports/audio.ts'
import { TvpError } from '../system/tvp-error.ts'
import { TjsError } from '../system/tjs-error.ts'
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
import { parseSliBytes, SliSyntaxError, checkSliSize } from '../../formats/audio/sli.ts'
import { WaveFormatError } from '../../formats/audio/wav-format.ts'
import type { Resource } from '../ports/storage.ts'
import { AudioResourceSources, type AudioSourceLease } from '../storage/audio-sources.ts'
import type { EventClock } from '../scheduler/events.ts'
import { MidiOutputExecutor } from './midi-output.ts'
import { CddaDiscs, InvalidCddaDrive, openCddaSelection, type CddaSelection } from '../storage/cdda.ts'
import { waveConversionOption } from './wave-output.ts'
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
  position: [number, number, number]
  canControlPan: boolean
  /** Native secondary-buffer format survives Clear/Open; initially zero. */
  waveOutputRate: number
  waveOutputBits: number
  waveOutputChannels: number
  filters?: PhaseVocoderConnection
  cdda?: CddaSelection
  preparedCdda?: { token: number; selection: CddaSelection }
  preparedMidi: Map<number, { read(): Promise<Uint8Array> }>
  midiWaiters: Set<(error: Error) => void>
}
type Callback = { name: string; args: ScriptValue[] }
export class SoundService {
  private readonly midiOutput: MidiOutputExecutor
  private readonly sources?: AudioResourceSources
  private cancelling?: Promise<void>
  private readonly filters: PhaseVocoderService
  private nextId = 1
  private nextCddaToken = 1
  private nextMidiToken = 1
  private buffers = new Map<number, Sound>()
  private unsubscribe?: () => void
  private globalVolume = 100000
  private globalFocusMode = 0
  private waveOptionsInitialized = false
  private waveConversion?: WaveConversion
  private disposed = false
  private closes = new Set<Promise<void>>()
  private closeErrors: unknown[] = []
  constructor(
    private readonly objects: ScriptRuntime,
    private readonly backend: AudioBackend | undefined,
    private readonly read: (name: string) => Promise<Uint8Array>,
    private readonly findSidecar: (name: string) => Promise<Resource | undefined>,
    private readonly dispatch: (
      callback: ScriptObject,
      member: string,
      args: ScriptValue[],
      valid: () => boolean,
      source: object,
    ) => Promise<void>,
    private readonly error: (error: unknown) => void,
    midiClock: EventClock,
    private readonly cddaDiscs: CddaDiscs,
    private readonly cancelQueued: (source: object) => void = () => {},
    private readonly resourceSource?: {
      resolve(name: string): Resource | Promise<Resource>
      checkpoint(): void | Promise<void>
    },
    private readonly getWaveConversionOption: () => string | undefined = () => undefined,
  ) {
    this.midiOutput = new MidiOutputExecutor(midiClock,
      (message) => this.command({ op: 'midiMessage', message }))
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
    sound.preparedMidi.clear()
    for (const cancel of sound.midiWaiters) cancel(new Error('MIDI resource owner has closed'))
    sound.midiWaiters.clear()
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
  private async unloadMedia(sound: Sound): Promise<SoundSnapshot | undefined> {
    if (!sound.resourceRequested) return
    const result = await this.voiceCommand(sound, { op: sound.kind !== 'cdda' ? 'unload' : 'close', id: sound.id })
    // An unload result exists only for retained Wave/MIDI controls; it owns no
    // decoder or PCM. Its live volume can have advanced during async cleanup.
    return result.snapshot
  }
  private waitMidi<T>(sound: Sound, work: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const valid = () => !this.disposed && !this.cancelling && this.buffers.get(sound.id) === sound
      const cancel = (error: Error) => reject(error)
      if (valid()) sound.midiWaiters.add(cancel)
      else cancel(new Error('MIDI resource owner has closed'))
      // Keep both handlers on the actual provider even after Stop has released
      // its waiter. A late file may not publish a replacement voice.
      work.then((value) => {
        sound.midiWaiters.delete(cancel)
        if (valid()) resolve(value)
        else cancel(new Error('MIDI resource owner has closed'))
      }, (error) => { sound.midiWaiters.delete(cancel); reject(error) })
    })
  }
  private receive(event: AudioEvent): void {
    if (event.type === 'error') {
      this.error(new Error(event.message))
      return
    }
    const sound = this.buffers.get(event.id)
    if (!sound || event.epoch !== sound.snapshot.epoch) return
    const inheritedFade = sound.kind !== 'cdda' && event.type === 'fade'
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
      // Already admitted Wave/MIDI fade callbacks belong to the SoundBuffer.
      // Native status changes still revoke them through version; a stale
      // transport event cannot enter here through a retired media epoch.
      (inheritedFade || sound.snapshot.epoch === event.epoch)
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
      // WaveImpl initializes its process sound options in the first Wave
      // instance constructor, not in script bootstrap or on every Open.
      if (kind === 'wave' && !this.waveOptionsInitialized) {
        this.waveConversion = waveConversionOption(this.getWaveConversionOption())
        this.waveOptionsInitialized = true
      }
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
          position: [0, 0, 0],
          canControlPan: false,
          waveOutputRate: 0,
          waveOutputBits: 0,
          waveOutputChannels: 0,
          preparedMidi: new Map(),
          midiWaiters: new Set(),
          snapshot: {
            id,
            epoch: 0,
            ...defaultSoundSettings(),
            ...(kind === 'wave' && this.waveConversion ? { waveConversion: this.waveConversion } : {}),
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
          const volume = typeof args[1] === 'bigint' ? Number(BigInt.asIntN(32, args[1])) : number(1) | 0
          this.globalVolume = Math.max(0, Math.min(100000, volume))
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
        await this.midiOutput.send(args[1])
        return
      }
      if (property === 'midiOutMethod') return { type: 'native-method', name: 'midiOut' }
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
    const positionAxis = (name: string) => name === 'posX' ? 0 : name === 'posY' ? 1 : name === 'posZ' ? 2 : undefined
    const coordinate = (i: number) => {
      // TJS has already performed AsReal, including its native conversion
      // error. D3DVALUE is float32; it has no integer or finite-value clamp.
      if (typeof input[i] !== 'number') throw new Error('Expected a converted sound coordinate')
      return Math.fround(input[i])
    }
    const fadeParameters = () => {
      if (input.length < 2) throw new TjsError('TJSBadParamCount')
      const narrowed = (at: number) => typeof input[at] === 'bigint'
        ? Number(BigInt.asIntN(32, input[at])) : numeric(at) | 0
      const target = narrowed(0), time = narrowed(1), delay = input[2] === undefined ? 0 : narrowed(2)
      if (time <= 0 || delay < 0) throw new TvpError('TVPInvalidParam')
      return { target, time, delay }
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
    if (method === 'prepareMidi') {
      if (sound.kind !== 'midi') throw new Error('Invalid MIDI owner')
      const name = text(0), resource = this.resourceSource
        ? await this.waitMidi(sound, Promise.resolve(this.resourceSource.resolve(name))) : undefined,
        bytes = resource ? undefined : await this.waitMidi(sound, this.read(name))
      if (this.disposed || this.cancelling || this.buffers.get(sound.id) !== sound)
        throw new Error('MIDI opening lost its sound owner')
      if (!Number.isSafeInteger(this.nextMidiToken)) throw new Error('MIDI opening identity exhausted')
      const token = this.nextMidiToken++
      // Each reentrant Open owns its own stream selection. A Stop callback can
      // open another song without replacing this caller's already-opened file.
      sound.preparedMidi.set(token, { read: resource ? () => resource.read() : async () => bytes! })
      value = BigInt(token)
    } else if (method === 'releaseMidi') {
      sound.preparedMidi.delete(numeric(0))
    } else if (method === 'midiFailure') {
      if (sound.kind !== 'midi') throw new Error('Invalid MIDI owner')
      const previous = sound.snapshot.status
      sound.snapshot.status = 'unload'
      if (previous !== 'unload') {
        this.cancelEvents(sound)
        callbacks.push({ name: 'onStatusChanged', args: ['unload'] })
      }
    } else if (method === 'openMidi') {
      if (sound.kind !== 'midi') throw new Error('Invalid MIDI owner')
      const token = numeric(0), selected = sound.preparedMidi.get(token)
      if (!selected) throw new Error('MIDI opened stream has expired')
      sound.preparedMidi.delete(token)
      const previous = sound.snapshot.status
      const clearMedia = async () => {
        const retained = await this.unloadMedia(sound)
        sound.resourceRequested = !!retained; sound.ready = !!retained
        sound.labels = scriptRecord({})
        sound.snapshot = { ...(retained ?? sound.snapshot), status: previous,
          position: 0, paused: false, frequency: 0, sampleRate: 0, sampleCount: 0,
          reportedSampleCount: undefined, channels: 0, bits: 0, fading: retained?.fading ?? false }
      }
      try {
        await clearMedia()
        const bytes = await this.waitMidi(sound, selected.read())
        if (this.disposed || this.cancelling || this.buffers.get(sound.id) !== sound)
          throw new Error('MIDI opened stream lost its sound owner')
        // MIDIImpl reads SMF directly. An unrelated .mid.sli is not a Wave
        // loop-manager input and must not prevent this music from opening.
        await apply({ op: 'open', id: sound.id, kind: 'midi', bytes,
          loops: emptyLoops(), settings: sound.snapshot })
        sound.ready = true
      } catch (error) {
        if (this.buffers.get(sound.id) === sound && !this.cancelling) {
          try { await clearMedia() }
          catch (cleanup) { throw new AggregateError([error, cleanup], 'MIDI open and retirement failed', { cause: error }) }
        }
        throw error
      }
      if (previous !== sound.snapshot.status) {
        this.cancelEvents(sound)
        callbacks.push({ name: 'onStatusChanged', args: [sound.snapshot.status] })
      }
    } else if (method === 'prepareOpen') {
      if (input.length < 1) throw new TjsError('TJSBadParamCount')
    } else if (method === 'setPos') {
      if (sound.kind !== 'wave') throw new Error('Position requires a WaveSoundBuffer')
      if (input.length < 3) throw new TjsError('TJSBadParamCount')
      const x = coordinate(0), y = coordinate(1), z = coordinate(2)
      sound.position[0] = x; sound.position[1] = y; sound.position[2] = z
    } else if (method === 'prepareCdda') {
      if (sound.kind !== 'cdda') throw new Error('Invalid CDDA owner')
      sound.preparedCdda = undefined
      const version = sound.version
      let selection: CddaSelection | undefined
      try { selection = await this.cddaDiscs.prepare(text(0)) }
      catch (error) {
        if (error instanceof InvalidCddaDrive) return this.result(-1n, [])
        throw error
      }
      if (this.disposed || this.cancelling || this.buffers.get(sound.id) !== sound || sound.version !== version)
        throw new Error('CDDA preparation lost its sound owner')
      if (selection) {
        if (!Number.isSafeInteger(this.nextCddaToken)) throw new Error('CDDA preparation identity exhausted')
        const token = this.nextCddaToken++
        sound.preparedCdda = { token, selection }; value = BigInt(token)
      }
    } else if (method === 'invalidCddaDrive') {
      if (sound.kind !== 'cdda') throw new Error('Invalid CDDA owner')
      throw new TvpError('TVPInvalidCDDADrive')
    } else if (method === 'unload' || method === 'unloadCdda') {
      let keepStopped = false
      if (method === 'unloadCdda') {
        if (sound.kind !== 'cdda' || !sound.preparedCdda || sound.preparedCdda.token !== numeric(0))
          throw new Error('CDDA prepared track is stale')
        keepStopped = sound.cdda?.drive === sound.preparedCdda.selection.drive
      }
      const previous = sound.snapshot.status
      const retained = await this.unloadMedia(sound)
      sound.filters?.release()
      sound.filters = undefined
      sound.resourceRequested = !!retained
      sound.ready = !!retained
      sound.cdda = undefined
      sound.labels = scriptRecord({})
      sound.snapshot = {
        ...(retained ?? sound.snapshot),
        status: keepStopped ? 'stop' : 'unload',
        epoch: retained?.epoch ?? 0,
        position: 0,
        paused: false,
        frequency: 0,
        sampleRate: 0,
        sampleCount: 0,
        reportedSampleCount: undefined,
        channels: 0,
        bits: 0,
        fading: retained?.fading ?? false,
        flags: Array(16).fill(0),
      }
      if (sound.kind !== 'wave' || previous !== sound.snapshot.status) this.cancelEvents(sound)
      if (previous !== sound.snapshot.status) callbacks.push({ name: 'onStatusChanged', args: [sound.snapshot.status] })
    } else if (method === 'open' || method === 'openCdda') {
      let selected: CddaSelection | undefined
      if (method === 'openCdda') {
        if (sound.kind !== 'cdda' || !sound.preparedCdda || sound.preparedCdda.token !== numeric(0))
          throw new Error('CDDA prepared track is stale')
        selected = sound.preparedCdda.selection
      }
      sound.preparedCdda = undefined
      sound.cdda = selected
      if (sound.kind !== 'wave') this.cancelEvents(sound)
      const name = selected?.cue ?? text(0),
        previous = sound.snapshot.status
      if (selected && !selected.parts) {
        // Native open records even an absent track; the device rejects play.
        // Do not invent a platform-specific MCI error string for a Web disc.
        sound.snapshot.status = 'stop'; sound.ready = false
        if (previous !== 'stop') callbacks.push({ name: 'onStatusChanged', args: ['stop'] })
        return this.result(undefined, callbacks)
      }
      if (sound.filters) throw new Error('Sound must unload before opening a new stream')
      if (sound.kind === 'wave') {
        if (!isScriptObject(args[3])) throw new Error('WaveSoundBuffer filters must be an Array')
        sound.filters = this.filters.connect(sound.id, args[3])
      }
      let loops: LoopInfo
      let sourceLease: AudioSourceLease | undefined
      try {
        const sli = name + '.sli'
        loops = emptyLoops()
        const sidecar = selected ? undefined : await this.findSidecar(sli)
        if (sidecar) {
          checkSliSize(sidecar.size)
          const bytes = await sidecar.read()
          if (bytes.length !== sidecar.size) throw new Error('Truncated SLI storage')
          try { loops = parseSliBytes(bytes) }
          catch (error) {
            if (error instanceof SliSyntaxError)
              throw new TvpError('TVPInvalidLoopInformation', [sli], error.message, { cause: error })
            throw error
          }
        }
        if (selected) {
          if (!this.backend?.streaming || !this.sources) throw new Error('Virtual CDDA requires a streaming audio backend')
          const track = await openCddaSelection(selected, this.sources,
              () => !this.disposed && !this.cancelling && this.buffers.get(sound.id) === sound && sound.cdda === selected)
          sourceLease = track
          await apply({ op: 'openSource', id: sound.id, kind: sound.kind,
            source: track.source, cdda: track.cdda, bufferedBytes: track.bufferedBytes,
            releaseSource: track.release, loops, settings: sound.snapshot })
        } else if ((sound.kind === 'wave' || sound.kind === 'cdda') && this.backend?.streaming && this.sources && this.resourceSource) {
          sourceLease = await this.sources.open(await this.resourceSource.resolve(name),
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
        let retained: SoundSnapshot | undefined
        try {
          retained = await this.unloadMedia(sound)
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
          sound.resourceRequested = !!retained
          sound.ready = !!retained
          if (retained) sound.snapshot = retained
        }
        if (sound.kind === 'wave' && error instanceof WaveFormatError)
          throw new TvpError('TVPUnknownWaveFormat', [name], error.message, { cause: error })
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
      if (sound.snapshot.status !== previous) {
        if (sound.kind === 'wave') this.cancelEvents(sound)
        callbacks.push({ name: 'onStatusChanged', args: [sound.snapshot.status] })
      }
    } else if (method === 'play' || method === 'stop') {
      if (method === 'play' && sound.cdda && !sound.cdda.parts)
        throw new Error(`Imported CDDA track ${sound.cdda.track} is absent or is a data track`)
      const previous = sound.snapshot.status
      if (sound.ready) await apply({ op: method, id: sound.id })
      // Native creates the secondary buffer at StartPlay, not open. Our
      // ordinary software output supports pan, and has no DirectSound3D
      // interface. Stop/unload retain this capability just as native Clear.
      if (method === 'play' && sound.kind === 'wave' && sound.snapshot.status === 'play') {
        sound.canControlPan = true
        sound.waveOutputRate = sound.snapshot.sampleRate
        sound.waveOutputBits = sound.snapshot.bits
        sound.waveOutputChannels = sound.snapshot.channels
      }
      if (sound.snapshot.status !== previous) {
        this.cancelEvents(sound)
        callbacks.push({ name: 'onStatusChanged', args: [sound.snapshot.status] })
      }
    } else if (method === 'prepareFade') {
      const { target, time, delay } = fadeParameters()
      value = scriptList([BigInt(target), BigInt(time), BigInt(delay)])
    } else if (method === 'fade') {
      const { target, time, delay } = fadeParameters()
      await this.prepare(sound)
      await apply({
        op: 'fade',
        id: sound.id,
        target,
        time,
        delay,
      })
    } else if (method === 'stopFade') {
      if (sound.ready) await apply({ op: 'stopFade', id: sound.id, finish: !!numeric(0) })
    } else if (method === 'get') {
      const property = text(0)
      if (property === 'labels') return this.result(sound.labels, callbacks)
      const axis = positionAxis(property)
      if (axis !== undefined && sound.kind === 'wave') return this.result(sound.position[axis], callbacks)
      if (sound.ready) {
        const result = await this.voiceCommand(sound, { op: 'inspect', id: sound.id })
        if (result.snapshot) sound.snapshot = result.snapshot
      }
      const state = sound.snapshot
      if (sound.kind === 'wave' && state.waveConversion && (property === 'bits' || property === 'channels'))
        value = BigInt(property === 'bits' ? sound.waveOutputBits : sound.waveOutputChannels)
      else if (property === 'position')
        value = BigInt(
          state.sampleRate ? Math.floor((state.position * 1000) / state.sampleRate) : 0,
        )
      else if (property === 'samplePosition') value = BigInt(state.position)
      else if (property === 'totalTime')
        value = BigInt(
          state.sampleRate ? Math.floor(((state.reportedSampleCount ?? state.sampleCount) * 1000) / state.sampleRate) : 0,
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
      const axis = positionAxis(property)
      if (axis !== undefined && sound.kind === 'wave') {
        sound.position[axis] = coordinate(1)
        return this.result(undefined, callbacks)
      }
      // WaveImpl takes a tjs_int, after the public setter's TJS integer
      // conversion. Preserve its low 32 bits before the gain/pan clamp or frequency
      // sentinel dispatch (in particular 2^32 becomes original-frequency zero).
      // MIDIImpl's two volume controls use the same signed tjs_int narrowing.
      const wavePosition = sound.kind === 'wave' && (property === 'position' || property === 'samplePosition') &&
        sound.snapshot.sampleRate > 0 && sound.snapshot.sampleCount > 0
      // Keep the original int64 until native uint64 arithmetic/range rejection
      // is complete; numeric() deliberately rejects unsafe Number conversion.
      let setting = wavePosition && typeof input[1] === 'bigint' ? 0
        : ((sound.kind === 'wave' && ['pan', 'frequency', 'volume', 'volume2'].includes(property)) ||
          (sound.kind === 'midi' && (property === 'volume' || property === 'volume2'))) && typeof input[1] === 'bigint'
          ? Number(BigInt.asIntN(32, input[1])) : numeric(1)
      if (property === 'volume' || property === 'volume2')
        setting = Math.max(0, Math.min(100000, setting))
      if (property === 'pan') setting = Math.max(-100000, Math.min(100000, setting))
      if (wavePosition) {
        // WaveIntf converts through tjs_int64 to tjs_uint64. WaveImpl then
        // multiplies milliseconds in uint64 before integer division; a public
        // millisecond seek must never introduce an interpolated PCM position.
        // Format is zero before first play and survives Clear/Open until the
        // next successful StartPlay recreates the secondary-buffer format.
        let samples = BigInt.asUintN(64, typeof input[1] === 'bigint' ? input[1] : BigInt(setting))
        if (property === 'position')
          samples = BigInt.asUintN(64, samples * BigInt(sound.waveOutputRate)) / 1000n
        // Native rejects the endpoint as well as larger/negative positions
        // without rewinding, changing status or resetting SLI traversal.
        if (samples >= BigInt(sound.snapshot.reportedSampleCount ?? sound.snapshot.sampleCount))
          return this.result(undefined, callbacks)
        setting = Number(samples)
      } else if (property === 'position') setting = (setting * sound.snapshot.sampleRate) / 1000
      const key = property === 'samplePosition' || property === 'position' ? 'position' : property
      if (!['volume', 'volume2', 'pan', 'looping', 'paused', 'frequency', 'position'].includes(key))
        throw new Error(`Unsupported sound property: ${property}`)
      const resetPosition = sound.kind === 'wave' && key === 'pan' &&
        sound.snapshot.pan !== setting && !sound.canControlPan
      if (sound.ready)
        await apply({ op: 'set', id: sound.id, property: key as 'volume', value: setting })
      else if (key === 'paused' || key === 'looping') sound.snapshot[key] = !!setting
      else sound.snapshot[key as 'volume'] = setting
      if (resetPosition) {
        // WaveImpl::SetPan also does this before a secondary buffer exists,
        // even with the default 3D option disabled. The inverse does not hold:
        // setPos never changes pan or invents a spatial-to-stereo conversion.
        let x = Math.fround(setting / 100000)
        x = Math.fround(x * (x * 0.003))
        sound.position[0] = setting < 0 ? -x : x
        sound.position[1] = Math.fround(0.001); sound.position[2] = 0
      }
    } else throw new Error(`Unsupported sound method: ${method}`)
    return this.result(value, callbacks)
  }
  async pause(paused: boolean): Promise<void> {
    if (this.backend) await this.command({ op: 'pauseAll', paused })
  }
  cancel(): Promise<void> {
    if (this.cancelling) return this.cancelling
    this.midiOutput.cancel()
    this.sources?.dispose()
    // Queue drain waits for TJS host calls. Cancel their source waiters now,
    // before retirement later waits for those same inflight calls to finish.
    this.cancelling = Promise.resolve().then(() =>
      this.backend?.cancel ? this.backend.cancel() : this.pause(true))
    for (const sound of this.buffers.values()) {
      sound.preparedMidi.clear()
      for (const cancel of sound.midiWaiters) cancel(new Error('MIDI resource owner has closed'))
      sound.midiWaiters.clear()
    }
    void this.cancelling.catch(() => {})
    return this.cancelling
  }
  async dispose(): Promise<void> {
    if (this.disposed) {
      await this.flushCloses()
      return
    }
    this.disposed = true
    this.midiOutput.cancel()
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
