import {
  defaultSoundSettings,
  type AudioAsset,
  type AudioResult,
  type AudioEvent,
  type LoopLink,
  type MixerCommand,
  type PcmAsset,
  type WaveAsset,
  type PcmReadRequest,
  type SoundEvent,
  type SoundKind,
  type SoundSettings,
  type SoundSnapshot,
  type PhaseVocoderFilter,
  type MidiOutputMessage,
} from '../ports/audio.ts'
import { MidiSynth } from './midi-synth.ts'
import { midiBufferVolume } from './midi-volume.ts'
import { midiOutputSteps } from './midi-output.ts'
import {
  AudioFilterChain,
  audioFilterChainMemoryBytes,
  newAudioFilterBudget,
  type AudioFilterBudget,
} from './audio-filter-chain.ts'
import { FilteredWaveSource, filteredWaveSourceMemoryBytes } from './filtered-wave-source.ts'
import { phaseVocoderMemoryBytes, validatePhaseVocoderParameters } from './phase-vocoder.ts'
import { StreamPcm, streamPageFrames, streamPcmReservation } from './stream-pcm.ts'
import { applySliExpression, sliExpressionTarget } from '../../formats/audio/sli.ts'
import { waveAudioGains } from './wave-audio.ts'
import { convertWaveOutput } from './wave-output.ts'
import { waveSpeakerMix, type StereoSpeakerMix } from './wave-speaker-mask.ts'
interface Fade {
  target: number
  delta: number
  count: number
  delay: number
  next: number
}
interface Voice {
  id: number
  kind: SoundKind
  epoch: number
  asset?: AudioAsset
  settings: SoundSettings
  status: SoundSnapshot['status']
  clock: number
  fade?: Fade
  /** Media is retired, but its inherited sound controls survive the next open. */
  unloaded?: boolean
  /** The decoder survives freeDirectSound, but its rendering buffer does not. */
  bufferReleased?: boolean
  flags: number[]
  labelIndex: number
  linkDirty: boolean
  link?: LoopLink
  synth?: MidiSynth
  filters?: PhaseVocoderFilter[]
  filterChain?: AudioFilterChain
  filterSource?: FilteredWaveSource
  filterBudget?: AudioFilterBudget
  sourcePipeline?: boolean
  /** Ordinary self-modifying conditional SLI uses WaveImpl's 8 Hz Decode units. */
  decodeUnitFrames?: number
  speakerMix?: StereoSpeakerMix
  expandedQuad?: boolean
  ended?: boolean
  interpolationPreview?: {
    position: number; labelIndex: number; linkDirty: boolean; link?: LoopLink; flags: number[]
    ended?: boolean; status: SoundSnapshot['status']; fade?: Fade
    filterChain?: AudioFilterChain; filterSource?: FilteredWaveSource
  }
  stream?: StreamPcm
  gains?: { volume: number; volume2: number; globalVolume: number; pan: number; focusVolume: number; left: number; right: number }
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
function conditionalDecodeFrames(kind: SoundKind, asset: AudioAsset, filters: readonly PhaseVocoderFilter[]): number | undefined {
  if (kind !== 'wave' || asset.kind === 'midi' || filters.length || asset.loops.links.some((link) => link.smooth)) return
  let conditional = 0
  for (const link of asset.loops.links)
    if (link.condition !== 'no' && link.variable >= 0 && link.variable < 16) conditional |= 1 << link.variable
  if (!conditional) return
  for (const label of asset.loops.labels) {
    const target = sliExpressionTarget(label.name)
    if (target !== undefined && (conditional & (1 << target))) return Math.floor(asset.sampleRate / 8)
  }
}
const lowerBound = <T>(items: T[], position: number, key: (item: T) => number): number => {
  let left = 0,
    right = items.length
  while (left < right) {
    const mid = (left + right) >>> 1
    if (key(items[mid]!) < position) left = mid + 1
    else right = mid
  }
  return left
}

/** Deterministic renderer shared by AudioWorklet and headless verification.
 * Positions are source samples; output clock is measured in rendered frames. */
export class AudioMixer {
  private voices = new Map<number, Voice>()
  private nextEpoch = 1
  private paused = false
  private globalVolume = 100000
  private waveMuted = false
  private waveMuteVolume = 0
  private pending: AudioEvent[] = []
  private liveMidi = new MidiSynth()
  private midiDelayUntil: number | undefined
  private midiPending: { at: number; message: MidiOutputMessage }[] = []
  private midiPendingIndex = 0
  private time = 0
  frames = 0
  peak = 0
  constructor(readonly sampleRate: number) {
    if (sampleRate < 1000 || sampleRate > 384000) throw new Error('Invalid output sample rate')
  }
  get hasClockWork(): boolean {
    if (this.paused) return false
    if (this.liveMidi.activeNotes || this.midiPending.length) return true
    for (const voice of this.voices.values())
      if (voice.fade || (voice.asset && voice.status === 'play' && (!voice.settings.paused || voice.bufferReleased)))
        return true
    return false
  }
  inspect(): { voices: number; fadingVoices: number; liveMidiNotes: number; clockWork: boolean } {
    return {
      voices: this.voices.size,
      fadingVoices: [...this.voices.values()].filter((voice) => voice.fade).length,
      liveMidiNotes: this.liveMidi.activeNotes,
      clockWork: this.hasClockWork,
    }
  }
  takeStreamRequests(): PcmReadRequest[] {
    return [...this.voices.values()].flatMap((voice) => voice.stream?.takeRequests() ?? [])
  }
  inspectStreams(): { voices: number; bytes: number; pending: number; reservedBytes: number } {
    const streams = [...this.voices.values()].flatMap((voice) => voice.stream ? [voice.stream] : [])
    return { voices: streams.length,
      bytes: streams.reduce((sum, stream) => sum + stream.inspect().bytes, 0),
      pending: streams.reduce((sum, stream) => sum + stream.inspect().pending, 0),
      reservedBytes: streams.reduce((sum, stream) => sum + streamPcmReservation(stream.asset.channels), 0) }
  }
  private get(id: number): Voice {
    const voice = this.voices.get(id)
    if (!voice) throw new Error('Audio voice is closed')
    return voice
  }
  private waveGains(voice: Voice) {
    const { volume, volume2, pan } = voice.settings, cached = voice.gains,
      focusVolume = this.waveMuted ? this.waveMuteVolume : 100000
    if (cached && cached.volume === volume && cached.volume2 === volume2 && cached.pan === pan &&
        cached.globalVolume === this.globalVolume && cached.focusVolume === focusVolume) return cached
    // Reuse across realtime blocks. Table/pow work is done at module startup;
    // unchanged controls allocate nothing, including silent/unloaded fades.
    return voice.gains = { volume, volume2, pan, globalVolume: this.globalVolume, focusVolume,
      ...waveAudioGains(volume, volume2, this.globalVolume, pan, this.waveMuted, this.waveMuteVolume) }
  }
  snapshot(id: number): SoundSnapshot {
    const voice = this.get(id),
      asset = voice.asset
    return {
      ...voice.settings,
      id,
      epoch: voice.epoch,
      position: voice.bufferReleased ? 0 : Math.floor(voice.settings.position),
      status: voice.status,
      fading: !!voice.fade,
      flags: [...voice.flags],
      sampleRate: asset?.sampleRate ?? 0,
      sampleCount: asset?.sampleCount ?? 0,
      ...(asset?.reportedSampleCount === undefined ? {} : { reportedSampleCount: asset.reportedSampleCount }),
      channels: asset ? voice.expandedQuad ? 4 : voice.settings.waveConversion === 'i16m' ? 1 : asset.channels : 0,
      bits: asset && voice.settings.waveConversion ? 16 : voice.filters?.length ? 32 : (asset?.bits ?? 0),
    }
  }
  private event(voice: Voice, type: SoundEvent['type'], label?: string): void {
    this.pending.push({
      id: voice.id,
      epoch: voice.epoch,
      type,
      label,
      snapshot: this.snapshot(voice.id),
    })
  }
  private create(id: number, settings: SoundSettings, kind: SoundKind = 'wave'): Voice {
    if (!this.voices.has(id) && this.voices.size >= 256)
      throw new Error('Audio voice budget exceeded')
    const { volume, volume2, pan, frequency, looping, paused, position, waveConversion, waveExpandQuad } = settings
    if (waveConversion !== undefined && waveConversion !== 'i16' && waveConversion !== 'i16m')
      throw new Error('Invalid Wave output conversion')
    if (waveExpandQuad !== undefined && typeof waveExpandQuad !== 'boolean') throw new Error('Invalid Wave quad expansion')
    const voice: Voice = {
      id,
      kind,
      epoch: this.nextEpoch++,
      settings: { volume, volume2, pan, frequency, looping, paused, position,
        ...(kind === 'wave' && waveConversion ? { waveConversion } : {}),
        ...(kind === 'wave' && waveExpandQuad ? { waveExpandQuad: true } : {}) },
      status: 'unload',
      clock: 0,
      flags: Array(16).fill(0),
      labelIndex: 0,
      linkDirty: true,
    }
    this.voices.set(id, voice)
    return voice
  }
  /** Validate/reserve the complete replacement before touching the active voice. */
  private filters(
    id: number,
    asset: AudioAsset,
    filters: readonly PhaseVocoderFilter[],
    activeWindows: readonly number[] = [],
    conversion = false,
    decodeUnitFrames?: number,
  ): PhaseVocoderFilter[] {
    if (filters.length > 4) throw new Error('Audio filter chain exceeds four stages')
    if (filters.length && asset.kind === 'midi') throw new Error('Audio filters require PCM audio')
    const identities = new Set<number>()
    const next = filters.map((filter, index) => {
      if (
        filter.type !== 'phase-vocoder' ||
        !Number.isSafeInteger(filter.id) ||
        filter.id <= 0 ||
        identities.has(filter.id)
      )
        throw new Error('Invalid or duplicate audio filter identity')
      identities.add(filter.id)
      const parameters = validatePhaseVocoderParameters(filter)
      if (activeWindows[index] !== undefined)
        validatePhaseVocoderParameters({ ...parameters, window: activeWindows[index]! })
      return { ...filter, ...parameters }
    })
    let count = next.length,
      bytes = 0
    const reserve = (
      channels: number,
      items: readonly PhaseVocoderFilter[],
      windows: readonly number[],
      smooth: boolean,
      unitFrames?: number,
    ) => {
      for (let index = 0; index < items.length; index++) {
        const window = Math.max(items[index]!.window, windows[index] ?? 0)
        bytes += phaseVocoderMemoryBytes(channels, window) + channels * window * 20
      }
      if (items.length || smooth) bytes += audioFilterChainMemoryBytes(channels, unitFrames)
    }
    const smooth = asset.kind !== 'midi' && asset.loops.links.some((link) => link.smooth)
    reserve(asset.channels, next, activeWindows, smooth || conversion || !!decodeUnitFrames, decodeUnitFrames)
    if ((next.length || smooth) && asset.kind !== 'midi') bytes += filteredWaveSourceMemoryBytes(asset)
    for (const voice of this.voices.values()) {
      if (voice.id === id || !voice.asset) continue
      const connected = voice.filters ?? []
      for (const filter of connected)
        if (identities.has(filter.id))
          throw new Error('Audio filter is already connected to a voice')
      count += connected.length
      const otherSmooth = voice.asset.kind !== 'midi' && voice.asset.loops.links.some((link) => link.smooth)
      reserve(voice.asset.channels, connected, voice.filterChain?.windows() ?? [],
        otherSmooth || !!voice.settings.waveConversion || !!voice.decodeUnitFrames, voice.decodeUnitFrames)
      if ((connected.length || otherSmooth) && voice.asset.kind !== 'midi')
        bytes += filteredWaveSourceMemoryBytes(voice.asset)
    }
    if (count > 16 || bytes > 64 * 1024 * 1024)
      throw new Error('Audio filter session budget exceeded')
    return next
  }
  command(command: MixerCommand): AudioResult {
    const start = this.pending.length
    if (command.op === 'streamData') {
      this.voices.get(command.request.id)?.stream?.accept(command.request, command.data, command.error)
      return { events: [] }
    }
    if (command.op === 'shutdown') {
      this.voices.clear()
      this.liveMidi.reset()
      this.midiPending = []
      this.midiPendingIndex = 0
      this.midiDelayUntil = undefined
      this.pending = []
      return { events: [] }
    }
    if (command.op === 'pauseAll') {
      this.paused = command.paused
      return { events: [] }
    }
    if (command.op === 'globalVolume') {
      this.globalVolume = clamp(command.volume, 0, 100000)
      return { events: [] }
    }
    if (command.op === 'waveMuted') {
      const volume = command.volume ?? 0
      if (!Number.isInteger(volume) || volume < 0 || volume > 100000)
        throw new Error('Invalid Wave background volume')
      this.waveMuted = command.muted
      this.waveMuteVolume = volume
      return { events: [] }
    }
    if (command.op === 'midiOut') {
      this.midiOut(command.data)
      return { events: [] }
    }
    if (command.op === 'midiMessage') {
      this.deliverMidi(command.message)
      return { events: [] }
    }
    const id = command.id
    if (command.op === 'create') {
      if (!this.voices.has(id)) this.create(id, command.settings, command.kind)
    } else if (command.op === 'load') {
      const { asset, settings } = command
      if (!Number.isSafeInteger(asset.sampleCount) || asset.sampleCount < 1 ||
          (asset.reportedSampleCount !== undefined && (!Number.isSafeInteger(asset.reportedSampleCount) ||
            asset.reportedSampleCount < asset.sampleCount)) ||
          !Number.isInteger(asset.sampleRate) || asset.sampleRate < 1000 || asset.sampleRate > 384000 ||
          !Number.isInteger(asset.channels) || asset.channels < 1 || asset.channels > 8)
        throw new Error('Invalid decoded audio')
      if (
        asset.kind === 'pcm' &&
        (asset.channels !== asset.data.length ||
          asset.data.some((channel) => channel.length !== asset.sampleCount))
      )
        throw new Error('PCM channel length mismatch')
      if (asset.pcmEncoding !== undefined && (!['u8', 's16', 's24', 's32', 'f32', 'f64'].includes(asset.pcmEncoding) ||
          !Number.isInteger(asset.bits) || asset.bits < 8 || asset.bits > Number(asset.pcmEncoding.slice(1)) ||
          (asset.pcmEncoding.startsWith('f') && asset.bits !== Number(asset.pcmEncoding.slice(1)))))
        throw new Error('Invalid PCM storage encoding')
      const speakerMix = asset.kind === 'midi' ? undefined : waveSpeakerMix(asset.channels, asset.speakerMask)
      let bytes =
        asset.kind === 'pcm' ? asset.data.reduce((sum, data) => sum + data.byteLength, 0)
          : asset.kind === 'stream' ? streamPcmReservation(asset.channels) : 0
      for (const other of this.voices.values())
        if (other.id !== id && other.asset)
          bytes += other.asset.kind === 'pcm' ? other.asset.data.reduce((sum, data) => sum + data.byteLength, 0)
            : other.asset.kind === 'stream' ? streamPcmReservation(other.asset.channels) : 0
      if (bytes > 128 * 1024 * 1024) throw new Error('Decoded audio exceeds 128 MiB session budget')
      for (const link of asset.loops.links)
        if (
          link.from > asset.sampleCount ||
          link.to >= asset.sampleCount ||
          link.from < 0 ||
          link.to < 0
        )
          throw new Error('SLI link is outside the decoded audio')
      const kind = command.kind ?? (asset.kind === 'midi' ? 'midi' : 'wave'), previous = this.voices.get(id),
        retained = previous?.kind === kind && previous.unloaded ? previous : undefined
      const decodeUnitFrames = conditionalDecodeFrames(kind, asset, command.filters ?? []),
        filters = this.filters(id, asset, command.filters ?? [], [], kind === 'wave' && !!(retained?.settings ?? settings).waveConversion, decodeUnitFrames)
      const stream = asset.kind === 'stream' ? new StreamPcm(id, asset) : undefined
      const voice = this.create(
        id,
        retained?.settings ?? settings,
        kind,
      )
      if (retained) { voice.fade = retained.fade; voice.clock = retained.clock }
      voice.asset = stream ? stream.asset : asset
      voice.speakerMix = speakerMix
      voice.expandedQuad = kind === 'wave' && !!voice.settings.waveExpandQuad &&
        voice.settings.waveConversion !== 'i16m' && asset.kind !== 'midi' &&
        !asset.speakerMask && asset.channels <= 2
      voice.stream = stream
      voice.filters = filters
      voice.decodeUnitFrames = decodeUnitFrames
      voice.sourcePipeline = asset.kind !== 'midi' && (filters.length > 0 || asset.loops.links.some((link) => link.smooth) || !!voice.settings.waveConversion || !!decodeUnitFrames)
      voice.status = 'stop'
      voice.settings.frequency = asset.sampleRate
      voice.settings.position = 0
      voice.settings.paused = false
      if (asset.kind === 'midi') voice.synth = new MidiSynth(asset)
    } else if (command.op === 'unload') {
      const previous = this.voices.get(id)
      if (command.status !== undefined && command.status !== 'unload' && command.status !== 'stop')
        throw new Error('Invalid unloaded sound status')
      if (!previous || (!previous.fade && !previous.unloaded && command.status !== 'stop')) {
        this.voices.delete(id)
        return { events: [] }
      }
      // Create a control-only replacement: no old PCM, stream pages, filter
      // chain, synth, label cursor or loop state survives this boundary.
      const voice = this.create(id, { ...previous.settings, frequency: 0, position: 0, paused: false }, previous.kind)
      // There is no replacement media yet. Keep its control-event identity
      // while decoder cleanup awaits; source replies are independently fenced
      // by streamId, and SoundService cancels events on actual status changes.
      voice.epoch = previous.epoch
      voice.clock = previous.clock
      voice.fade = previous.fade
      voice.unloaded = true
      voice.status = command.status ?? 'unload'
    } else if (command.op === 'close') {
      this.voices.delete(id)
      return { events: [] }
    } else {
      const voice = this.get(id),
        settings = voice.settings
      if (command.op === 'play' && voice.asset && (voice.status !== 'play' || voice.bufferReleased)) {
        voice.bufferReleased = false
        if (voice.ended || settings.position >= voice.asset.sampleCount) this.seek(voice, 0, true)
        else this.resetFilters(voice)
        this.prefetchStream(voice, true)
        voice.status = 'play'
        voice.epoch = this.nextEpoch++
      } else if (command.op === 'stop') {
        if (voice.asset) voice.status = 'stop'
        voice.epoch = this.nextEpoch++
        this.seek(voice, 0, true)
      } else if (command.op === 'releaseWaveBuffer') {
        if (voice.kind !== 'wave') throw new Error('Only Wave voices have secondary sound buffers')
        // Stop's native rewind occurs after its synchronous status callback.
        this.seek(voice, 0, true)
        voice.bufferReleased = true
        voice.stream?.releaseBuffer()
      } else if (command.op === 'filters') {
        if (!voice.asset) throw new Error('Audio filters require an open voice')
        const previous = voice.filters ?? []
        if (
          previous.length !== command.filters.length ||
          previous.some(
            (filter, index) =>
              filter.id !== command.filters[index]!.id ||
              filter.type !== command.filters[index]!.type,
          )
        )
          throw new Error('Connected audio filter order cannot change before reopen')
        const filters = this.filters(id, voice.asset, command.filters, voice.filterChain?.windows(), !!voice.settings.waveConversion, voice.decodeUnitFrames)
        voice.filterChain?.configure(filters)
        voice.filters = filters
      } else if (command.op === 'seekSource') {
        if (!voice.stream || voice.stream.asset.streamId !== command.streamId)
          throw new Error('Audio source seek belongs to a retired stream')
        const position = command.position
        if (!Number.isFinite(position) || position < 0 || position > voice.asset!.sampleCount)
          throw new Error('Sound position is outside the stream')
        // Match the unfiltered consumer's first sample/advance lookahead,
        // including a physical neighbor when the target is a page's last
        // frame. Do not wait for the three-page background prefetch horizon.
        const step = (voice.kind === 'wave' && settings.frequency === 0
          ? voice.asset!.sampleRate : settings.frequency) / this.sampleRate
        if (!voice.bufferReleased && !voice.stream.ready(Math.floor(position), Math.ceil(step) + 2))
          return { snapshot: this.snapshot(id), events: this.pending.splice(start), sourceReady: false }
        this.seek(voice, position)
        if (!voice.bufferReleased) this.prefetchStream(voice, true)
        voice.epoch = this.nextEpoch++
        return { snapshot: this.snapshot(id), events: this.pending.splice(start), sourceReady: true }
      } else if (command.op === 'set') {
        const { property, value } = command
        if (property === 'looping' || property === 'paused') {
          settings[property] = !!value
          voice.linkDirty = true
        } else {
          const number = Number(value)
          if (!Number.isFinite(number)) throw new Error('Invalid sound setting')
          if (property === 'volume' || property === 'volume2')
            settings[property] = clamp(Math.trunc(number), 0, 100000)
          else if (property === 'pan') settings.pan = clamp(Math.trunc(number), -100000, 100000)
          else if (property === 'position') {
            if (number < 0 || number > (voice.asset?.sampleCount ?? 0))
              throw new Error('Sound position is outside the stream')
            this.seek(voice, number)
            // Request a public seek's destination before the next output
            // block, including while paused/stopped. Internal SLI traversal
            // keeps its own atomic range preflight instead of prefetching.
            if (!voice.bufferReleased) this.prefetchStream(voice, true)
            voice.epoch = this.nextEpoch++
          } else if (property === 'frequency') {
            // WaveImpl forwards zero as DirectSound's DSBFREQUENCY_ORIGINAL.
            // Keep that requested value in the public snapshot; only the
            // render step substitutes this voice's current source rate.
            if (!(voice.kind === 'wave' && number === 0) && (number < 100 || number > 384000))
              throw new Error('Playback frequency is outside range')
            settings.frequency = number
          }
        }
      } else if (command.op === 'flag') {
        if (command.index < 0 || command.index >= 16 || !Number.isInteger(command.index))
          throw new Error('Invalid wave flag')
        voice.flags[command.index] = clamp(Math.trunc(command.value), 0, 9999)
        voice.linkDirty = true
      } else if (command.op === 'resetFlags') {
        // ClearFlags holds FlagsCS once. Do not expose sixteen intermediate
        // combinations to a playing SLI branch, or replace the array borrowed
        // by a live filtered source. Already decoded PCM stays queued.
        voice.flags.fill(0)
        voice.linkDirty = true
      } else if (command.op === 'fade') {
        if (command.time <= 0 || command.delay < 0)
          throw new Error('Fade requires positive time and non-negative delay')
        // Native Fade keeps the signed target for its delta; SetVolume clamps
        // only each actual update and the eventual target assignment.
        const target = command.target
        voice.fade = {
          target,
          delta: Math.trunc(((target - settings.volume) * 60) / command.time),
          count: Math.floor(command.time / 60),
          delay: command.delay,
          next: voice.clock + 0.06,
        }
        if (command.time < 60 && command.delay === 0) this.finishFade(voice, true)
      } else if (command.op === 'stopFade') this.finishFade(voice, command.finish)
    }
    return { snapshot: this.snapshot(id), events: this.pending.splice(start) }
  }
  private finishFade(voice: Voice, finish: boolean): void {
    if (!voice.fade) return
    if (finish) voice.settings.volume = clamp(voice.fade.target, 0, 100000)
    voice.fade = undefined
    this.event(voice, 'fade')
  }
  private seek(voice: Voice, position: number, rewind = false): void {
    voice.ended = false
    voice.settings.position = position
    voice.labelIndex = lowerBound(
      voice.asset?.loops.labels ?? [],
      position,
      (label) => label.position,
    )
    voice.linkDirty = true
    if (voice.synth) {
      const time = position / voice.asset!.sampleRate
      if (rewind) voice.synth.rewind(time)
      else voice.synth.seek(time)
    }
    this.resetFilters(voice)
  }
  private resetFilters(voice: Voice): void {
    voice.filterChain = undefined
    voice.filterSource = undefined
  }
  private filtered(voice: Voice, budget: AudioFilterBudget): AudioFilterChain {
    voice.filterBudget = budget
    if (!voice.filterChain) {
      voice.filterSource = new FilteredWaveSource(
        voice.asset as WaveAsset,
        voice.settings.position,
        voice.flags,
        () => voice.settings.looping,
        () => voice.filterBudget!,
        voice.stream,
        !!voice.decodeUnitFrames,
      )
      voice.filterChain = new AudioFilterChain(
        voice.asset!.channels,
        voice.filters ?? [],
        voice.filterSource,
        voice.settings.waveConversion ? (data, frames) => convertWaveOutput(data, frames,
          voice.settings.waveConversion!, voice.filters?.length ? 'f32' : voice.asset!.pcmEncoding) : undefined,
        voice.decodeUnitFrames,
      )
    }
    voice.filterChain.setBudget(budget)
    return voice.filterChain
  }
  private match(voice: Voice, link: LoopLink): boolean {
    if (link.whenLooping && !voice.settings.looping) return false
    const value = voice.flags[link.variable] ?? 0,
      reference = link.reference
    if (link.variable === -1) return true
    switch (link.condition) {
      case 'no':
        return true
      case 'eq':
        return value === reference
      case 'ne':
        return value !== reference
      case 'gt':
        return value > reference
      case 'ge':
        return value >= reference
      case 'lt':
        return value < reference
      case 'le':
        return value <= reference
    }
  }
  private link(voice: Voice): LoopLink | undefined {
    if (voice.linkDirty) {
      voice.linkDirty = false
      voice.link = undefined
      const links = voice.asset?.loops.links ?? []
      for (
        let i = lowerBound(links, voice.settings.position, (link) => link.from);
        i < links.length;
        i++
      ) {
        if (this.match(voice, links[i]!)) {
          voice.link = links[i]
          break
        }
      }
    }
    return voice.link
  }
  private expression(voice: Voice, name: string): boolean {
    if (!applySliExpression(voice.flags, name)) return false
    voice.linkDirty = true
    return true
  }
  private prepareSample(voice: Voice): boolean {
    const asset = voice.asset!,
      settings = voice.settings
    let visited: Set<number> | undefined
    for (let guard = 0; guard < 4096; guard++) {
      const link = this.link(voice)
      if (link && settings.position >= link.from) {
        if (visited?.has(settings.position)) break
        ;(visited ??= new Set()).add(settings.position)
        const overshoot = settings.position - link.from
        this.seek(voice, link.to + overshoot)
        continue
      }
      if (settings.position >= asset.sampleCount) {
        // A MIDI ProgramChange on the same tick as EOT still reaches the
        // device. Settle only this score's due messages, without rendering an
        // extra sample or applying future events during manual Stop/seek.
        voice.synth?.advanceEvents(asset.sampleCount / asset.sampleRate)
        // WaveLoopManager queues labels before the decoder reports its short
        // final read; WaveImpl flushes those events before natural stop. An
        // explicit link at EOF still wins above, and manual seek/stop never
        // enter this playback boundary.
        this.labelsThrough(voice, asset.sampleCount)
        if (settings.looping) {
          this.seek(voice, settings.position % asset.sampleCount, true)
          continue
        }
        // WaveImpl flushes endpoint labels, then ResetSamplePositions and
        // LoopManager::SetPosition(0), before its asynchronous stop callback.
        // Match the filtered path without restarting labels or decoding here.
        if (voice.kind === 'wave') {
          settings.position = 0
          voice.ended = true
        } else settings.position = asset.sampleCount
        voice.status = 'stop'
        this.event(voice, 'ended')
        return false
      }
      this.labelsThrough(voice, settings.position)
      return true
    }
    voice.status = 'stop'
    voice.fade = undefined
    this.pending.push({
      type: 'error',
      message: `Audio voice ${voice.id}: loop makes no forward progress or exceeds the per-sample link budget`,
    })
    return false
  }
  private labelsThrough(voice: Voice, position: number): void {
    const labels = voice.asset!.loops.labels
    while (voice.labelIndex < labels.length && labels[voice.labelIndex]!.position <= position) {
      const label = labels[voice.labelIndex++]!
      this.expression(voice, label.name)
      this.event(voice, 'label', label.name)
    }
  }
  /** WaveLoopManager concatenates link targets before device resampling. At
   * a fractional position just before a hard jump, the right-hand sample is
   * therefore from that logical output, not the abandoned physical file tail.
   * Preview the existing control walk without publishing labels, flags or EOF.
   * Integer samples and ordinary sequential runs allocate no preview state. */
  private interpolationNeighbor(voice: Voice): number | undefined {
    const position = voice.settings.position, next = Math.ceil(position), asset = voice.asset!
    if (voice.kind !== 'wave' || next === position || voice.sourcePipeline ||
        next < Math.min(this.link(voice)?.from ?? asset.sampleCount, asset.sampleCount)) return
    // Reuse one tiny snapshot even for deliberately very short looping tones.
    // Streaming's outer preflight has a separate snapshot, so nesting is safe.
    const saved: NonNullable<Voice['interpolationPreview']> = voice.interpolationPreview ??= { position: 0, labelIndex: 0, linkDirty: false,
      flags: Array(16).fill(0), status: 'unload' }, pending = this.pending.length
    saved.position = position; saved.labelIndex = voice.labelIndex; saved.linkDirty = voice.linkDirty
    saved.link = voice.link; saved.ended = voice.ended; saved.status = voice.status
    saved.fade = voice.fade; saved.filterChain = voice.filterChain; saved.filterSource = voice.filterSource
    for (let i = 0; i < voice.flags.length; i++) saved.flags[i] = voice.flags[i]!
    try {
      // The real device-rate accumulator can land a few ULPs below an integer.
      // advance() intentionally drops sub-nanoframe remainders; the interpolation
      // neighbor is nevertheless that exact integer sample, not floor(position).
      if (next - position <= 1e-9) voice.settings.position = next
      else this.advance(voice, next - position)
      if (voice.status === 'play' && this.prepareSample(voice)) return Math.floor(voice.settings.position)
      // A genuinely non-looping EOF retains the existing endpoint hold.
      // Previewing it must neither end the voice nor flush its audible labels.
      return
    } finally {
      voice.settings.position = saved.position
      voice.labelIndex = saved.labelIndex
      voice.linkDirty = saved.linkDirty
      voice.link = saved.link
      for (let i = 0; i < voice.flags.length; i++) voice.flags[i] = saved.flags[i]!
      voice.ended = saved.ended
      voice.status = saved.status
      voice.fade = saved.fade
      voice.filterChain = saved.filterChain
      voice.filterSource = saved.filterSource
      this.pending.length = pending
    }
  }
  private pcm(voice: Voice, channel: number, position: number, neighbor?: number): number {
    if (voice.stream) {
      if (neighbor === undefined) return voice.stream.sample(channel, position)
      const index = Math.floor(position), fraction = position - index
      return voice.stream.sample(channel, index) * (1 - fraction) + voice.stream.sample(channel, neighbor) * fraction
    }
    const asset = voice.asset as PcmAsset
    const data = asset.data[channel]
    if (!data || position < 0 || position >= asset.sampleCount) return 0
    const index = Math.floor(position),
      fraction = position - index
    return data[index]! * (1 - fraction) + (data[neighbor ?? index + 1] ?? data[index]!) * fraction
  }
  private advance(voice: Voice, remaining: number, preflight = false): boolean {
    const asset = voice.asset!,
      settings = voice.settings
    let ready = true
    // Visit source boundaries before skipping over them during resampling.
    // Otherwise short loops and flag-changing labels vanish at high rates.
    for (let guard = 0; remaining > 1e-9 && guard < 4096; guard++) {
      const boundary = Math.min(
        this.link(voice)?.from ?? asset.sampleCount,
        asset.loops.labels[voice.labelIndex]?.position ?? asset.sampleCount,
        asset.sampleCount,
      )
      const step = Math.min(remaining, Math.max(0, boundary - settings.position))
      settings.position += step
      remaining -= step
      if (remaining <= 1e-9) return !preflight || (this.streamReady(voice) && ready)
      if (!this.prepareSample(voice)) return ready
      // A miss cannot stop control preflight: later jumps may exceed the
      // entire cache even when the four pending request slots are already full.
      if (preflight) ready = this.streamReady(voice) && ready
    }
    if (remaining > 1e-9) {
      voice.status = 'stop'
      voice.fade = undefined
      this.pending.push({
        type: 'error',
        message: `Audio voice ${voice.id}: too many source boundaries in one output sample`,
      })
    }
    return !preflight || ((voice.status !== 'play' || this.streamReady(voice)) && ready)
  }
  private streamRangeReady(stream: StreamPcm, start: number, end: number): boolean {
    return stream.ready(Math.floor(start), Math.floor(end) - Math.floor(start) + 2)
  }
  private streamReady(voice: Voice, advance = 0): boolean {
    const position = voice.settings.position
    return this.streamRangeReady(voice.stream!, position, position + advance)
  }
  private streamInterpolationReady(voice: Voice): boolean {
    const neighbor = this.interpolationNeighbor(voice)
    return neighbor === undefined || voice.stream!.ready(neighbor, 1)
  }
  private prefetchStream(voice: Voice, initial = false): void {
    const stream = voice.stream
    if (!stream) return
    if (voice.sourcePipeline) {
      // Its filter/source queue already reserves complete Decode units. Keep
      // that existing initial reservation and its subsequent lookahead.
      if (initial) stream.ready(Math.floor(voice.settings.position), 2)
      else stream.prefetch(voice.settings.position)
      return
    }
    const position = Math.floor(voice.settings.position),
      first = Math.floor(position / streamPageFrames) * streamPageFrames,
      end = Math.min(stream.asset.sampleCount, first + 3 * streamPageFrames)
    // A public seek near a page end needs its following PCM before the first
    // output quantum, not only after that quantum has already starved. Keep
    // the existing three-page horizon and four outstanding-request limit.
    // Filtered sources own their decode-ahead/control boundaries separately.
    const link = this.link(voice),
      boundary = link?.from ?? stream.asset.sampleCount,
      target = link?.to ?? (voice.settings.looping ? 0 : undefined)
    stream.ready(position, Math.max(0, Math.min(end, Math.floor(boundary) + 2) - position))
    if (target !== undefined && boundary >= position && boundary <= end) {
      // Only an already selected jump is warmed. No flag expression, label,
      // audible cursor or event is executed ahead of time. Avoid filling the
      // abandoned source tail instead of the next phrase at a hard SLI link.
      const targetPage = Math.floor(target / streamPageFrames) * streamPageFrames
      stream.ready(targetPage, 2 * streamPageFrames)
    }
  }
  private prepareStreamSample(voice: Voice, step: number): boolean | 'waiting' {
    const position = voice.settings.position, link = this.link(voice),
      boundary = Math.min(link?.from ?? voice.asset!.sampleCount,
        voice.asset!.loops.labels[voice.labelIndex]?.position ?? Infinity,
        voice.asset!.sampleCount)
    // Straight runs need only a bounded current/interpolation/advance range.
    if (position + step < boundary) {
      const current = this.streamReady(voice, step), neighbor = this.streamInterpolationReady(voice)
      return current && neighbor ? true : 'waiting'
    }
    // Preflight the complete output sample, including all skipped labels and
    // SLI jumps at high playback rates. Neither the initial prepare nor advance
    // may publish control changes when any required page is still missing.
    const saved = { position, labelIndex: voice.labelIndex, linkDirty: voice.linkDirty,
      link: voice.link, flags: [...voice.flags],
      ended: voice.ended, status: voice.status, fade: voice.fade,
      filterChain: voice.filterChain, filterSource: voice.filterSource }, pending = this.pending.length
    let terminal = false
    voice.stream!.beginPreflight()
    try {
      // EOF/error at the current position already has its original semantics.
      if (!this.prepareSample(voice)) { terminal = true; return false }
      const current = this.streamReady(voice), neighbor = this.streamInterpolationReady(voice), ready = current && neighbor
      if (!this.advance(voice, step, true) || !ready) return 'waiting'
    } finally {
      voice.stream!.endPreflight()
      if (!terminal) {
        voice.settings.position = saved.position
        voice.labelIndex = saved.labelIndex
        voice.linkDirty = saved.linkDirty
        voice.link = saved.link
        voice.flags.splice(0, voice.flags.length, ...saved.flags)
        voice.ended = saved.ended
        voice.status = saved.status
        voice.fade = saved.fade
        voice.filterChain = saved.filterChain
        voice.filterSource = saved.filterSource
        this.pending.length = pending
      }
    }
    // The restored control path is deterministic and all pages are resident;
    // commit prepare now, then render and commit advance exactly once.
    return this.prepareSample(voice)
  }
  render(left: Float32Array, right: Float32Array): AudioEvent[] {
    if (left.length !== right.length) throw new Error('Audio output lengths differ')
    left.fill(0)
    right.fill(0)
    this.peak = 0
    if (this.paused) return []
    const dt = 1 / this.sampleRate,
      filterBudget = newAudioFilterBudget(left.length)
    for (const voice of this.voices.values()) {
      const settings = voice.settings,
        asset = voice.asset
      if (voice.bufferReleased && voice.status === 'play') {
        // A Stop callback may itself have called play. Native subsequently
        // destroys that buffer; its next TimerBeat observes !BufferPlaying.
        // Do not publish an extra synchronous status callback from release.
        voice.status = 'stop'
        this.event(voice, 'ended')
      }
      let gains = voice.kind === 'wave' ? this.waveGains(voice) : undefined
      if (voice.synth) voice.synth.setBufferVolume(midiBufferVolume(settings.volume, settings.volume2))
      let chain: AudioFilterChain | undefined, neighbor: number | undefined, waiting = false
      const label = (name: string, position: number) => {
        settings.position = position
        this.event(voice, 'label', name)
      }
      const sample = (channel: number) =>
        chain ? chain.sample(channel) : this.pcm(voice, channel, settings.position, neighbor)
      for (let frame = 0; frame < left.length; frame++) {
        voice.clock += dt
        if (voice.fade && voice.clock + 1e-10 >= voice.fade.next) {
          const previousVolume = settings.volume
          voice.fade.next += 0.06
          if (voice.fade.delay > 0) voice.fade.delay = Math.max(0, voice.fade.delay - 60)
          else if (voice.fade.count === 1) this.finishFade(voice, true)
          else if (voice.fade.count > 1) {
            voice.fade.count--
            settings.volume = clamp(settings.volume + voice.fade.delta, 0, 100000)
          }
          if (gains && settings.volume !== previousVolume) gains = this.waveGains(voice)
          if (voice.synth && settings.volume !== previousVolume)
            voice.synth.setBufferVolume(midiBufferVolume(settings.volume, settings.volume2))
        }
        if (!asset || settings.paused || voice.status !== 'play' || waiting) continue
        try {
          const step = (voice.kind === 'wave' && settings.frequency === 0
            ? asset.sampleRate : settings.frequency) / this.sampleRate
          chain = voice.sourcePipeline ? this.filtered(voice, filterBudget) : undefined
          if (chain) {
            if (!chain.canAdvance(step)) { waiting = true; continue }
            if (!chain.prepare(label)) {
              voice.status = 'stop'
              // Original natural EOF rewinds LoopManager independently of the
              // last audible segment position. Replay must start at the source start.
              voice.ended = true
              settings.position = 0
              this.resetFilters(voice)
              this.event(voice, 'ended')
              continue
            }
            settings.position = chain.sourcePosition()
          } else if (voice.stream) {
            const ready = this.prepareStreamSample(voice, step)
            if (ready === 'waiting') { waiting = true; continue }
            if (!ready) continue
          } else if (!this.prepareSample(voice)) continue
          neighbor = asset.kind === 'midi' || chain ? undefined : this.interpolationNeighbor(voice)
          let l: number, r: number
          if (asset.kind === 'midi') {
            voice.synth!.render(settings.position / asset.sampleRate, step / asset.sampleRate)
            l = voice.synth!.left
            r = voice.synth!.right
          } else if (voice.expandedQuad) {
            // WaveImpl copies mono to FL/FR/BL/BR, or stereo to L/R/L/R,
            // after source filtering and forced bit-depth conversion. Keep
            // its source-frame clock and apply our existing quad-to-stereo
            // coefficients without allocating duplicate streaming planes.
            const frontLeft = sample(0), frontRight = asset.channels === 1 ? frontLeft : sample(1)
            l = frontLeft + frontLeft * 0.70710678
            r = frontRight + frontRight * 0.70710678
          } else if (voice.speakerMix && settings.waveConversion !== 'i16m') {
            l = r = 0
            for (let channel = 0; channel < voice.speakerMix.length; channel++) {
              const gains = voice.speakerMix[channel]!, value = sample(channel)
              l += value * gains[0]
              r += value * gains[1]
            }
          } else {
            l = sample(0)
            const channels = settings.waveConversion === 'i16m' ? 1 : asset.channels
            r = channels === 1 ? l : sample(1)
            if (channels === 4) {
              l += sample(2) * 0.70710678
              r += sample(3) * 0.70710678
            } else if (channels >= 3) {
              const center = sample(2) * 0.70710678
              l += center
              r += center
              if (channels >= 5) l += sample(4) * 0.70710678
              if (channels >= 6) r += sample(5) * 0.70710678
              if (channels >= 7) l += sample(6) * 0.5
              if (channels >= 8) r += sample(7) * 0.5
            }
          }
          const gain = asset.kind === 'midi' ? 1 : ((settings.volume / 100000) * settings.volume2) / 100000,
            pan = settings.pan / 100000
          left[frame] += l * (gains?.left ?? gain * (pan > 0 ? 1 - pan : 1))
          right[frame] += r * (gains?.right ?? gain * (pan < 0 ? 1 + pan : 1))
          if (chain) {
            chain.advance(step, label)
            settings.position = chain.sourcePosition()
          } else this.advance(voice, step)
          if (voice.stream && frame === left.length - 1) this.prefetchStream(voice)
        } catch (error) {
          voice.status = 'stop'
          voice.fade = undefined
          this.resetFilters(voice)
          this.pending.push({
            type: 'error',
            message: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }
    for (let frame = 0; frame < left.length; frame++) {
      while (this.midiPendingIndex < this.midiPending.length && this.midiPending[this.midiPendingIndex]!.at <= this.time + 1e-10)
        this.deliverMidi(this.midiPending[this.midiPendingIndex++]!.message)
      if (this.midiPending.length && this.midiPendingIndex === this.midiPending.length) {
        this.midiPending = []; this.midiPendingIndex = 0
      }
      this.liveMidi.render(this.time, dt)
      this.time += dt
      left[frame] = clamp(left[frame]! + this.liveMidi.left, -1, 1)
      right[frame] = clamp(right[frame]! + this.liveMidi.right, -1, 1)
      this.peak = Math.max(this.peak, Math.abs(left[frame]!), Math.abs(right[frame]!))
    }
    this.frames += left.length
    return this.pending.splice(0)
  }
  private midiOut(bytes: Uint8Array): void {
    // Direct low-level mixer callers have a synchronous API. Keep their
    // delays on the sample clock; public TJS uses MidiOutputExecutor and
    // awaits the host deadline before sending already parsed midiMessage.
    for (const step of midiOutputSteps(bytes)) {
      if (step.kind === 'delay') this.midiDelayUntil = Math.max(this.time, this.midiPending.at(-1)?.at ?? this.time) + 0.05
      else {
        const at = Math.max(this.time, this.midiDelayUntil ?? this.time,
          this.midiPending.at(-1)?.at ?? this.time)
        if (at > this.time) {
          if (this.midiPending.length >= 65536) throw new Error('MIDI pending message budget exceeded')
          this.midiPending.push({ at, message: step })
        } else this.deliverMidi(step)
        this.midiDelayUntil = undefined
      }
    }
  }
  private deliverMidi(message: MidiOutputMessage): void {
    const event = message.kind === 'short' ? { status: message.status, data: message.data }
      : { status: 0xf7, data: Array.from(message.data) }
    this.liveMidi.rawMessage(event)
    // Raw note-on belongs to the shared output, not one new note per loaded
    // MIDI file. Global note-off/controllers/resets still affect those voices.
    if ((event.status & 0xf0) !== 0x90 || (event.data[1] ?? 0) === 0)
      for (const voice of this.voices.values()) voice.synth?.rawMessage(event)
  }
}

export const freshVoiceSettings = defaultSoundSettings
