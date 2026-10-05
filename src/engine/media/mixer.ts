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
} from '../ports/audio.ts'
import { MidiSynth } from './midi-synth.ts'
import {
  AudioFilterChain,
  audioFilterChainMemoryBytes,
  newAudioFilterBudget,
  type AudioFilterBudget,
} from './audio-filter-chain.ts'
import { FilteredWaveSource, filteredWaveSourceMemoryBytes } from './filtered-wave-source.ts'
import { phaseVocoderMemoryBytes, validatePhaseVocoderParameters } from './phase-vocoder.ts'
import { StreamPcm, streamPcmReservation } from './stream-pcm.ts'
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
  flags: number[]
  labelIndex: number
  linkDirty: boolean
  link?: LoopLink
  synth?: MidiSynth
  tail?: { source: number; progress: number; total: number }
  filters?: PhaseVocoderFilter[]
  filterChain?: AudioFilterChain
  filterSource?: FilteredWaveSource
  filterBudget?: AudioFilterBudget
  ended?: boolean
  stream?: StreamPcm
}
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))
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
  private pending: AudioEvent[] = []
  private liveMidi = new MidiSynth()
  private time = 0
  frames = 0
  peak = 0
  constructor(readonly sampleRate: number) {
    if (sampleRate < 1000 || sampleRate > 384000) throw new Error('Invalid output sample rate')
  }
  get hasClockWork(): boolean {
    if (this.paused) return false
    if (this.liveMidi.activeNotes) return true
    for (const voice of this.voices.values())
      if (voice.fade || (voice.asset && voice.status === 'play' && !voice.settings.paused))
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
  snapshot(id: number): SoundSnapshot {
    const voice = this.get(id),
      asset = voice.asset
    return {
      ...voice.settings,
      id,
      epoch: voice.epoch,
      position: Math.floor(voice.settings.position),
      status: voice.status,
      fading: !!voice.fade,
      flags: [...voice.flags],
      sampleRate: asset?.sampleRate ?? 0,
      sampleCount: asset?.sampleCount ?? 0,
      channels: asset?.channels ?? 0,
      bits: voice.filters?.length ? 32 : (asset?.bits ?? 0),
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
    const { volume, volume2, pan, frequency, looping, paused, position } = settings
    const voice: Voice = {
      id,
      kind,
      epoch: this.nextEpoch++,
      settings: { volume, volume2, pan, frequency, looping, paused, position },
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
    ) => {
      for (let index = 0; index < items.length; index++) {
        const window = Math.max(items[index]!.window, windows[index] ?? 0)
        bytes += phaseVocoderMemoryBytes(channels, window) + channels * window * 20
      }
      if (items.length) bytes += audioFilterChainMemoryBytes(channels)
    }
    reserve(asset.channels, next, activeWindows)
    if (next.length && asset.kind !== 'midi') bytes += filteredWaveSourceMemoryBytes(asset)
    for (const voice of this.voices.values()) {
      if (voice.id === id || !voice.asset) continue
      const connected = voice.filters ?? []
      for (const filter of connected)
        if (identities.has(filter.id))
          throw new Error('Audio filter is already connected to a voice')
      count += connected.length
      reserve(voice.asset.channels, connected, voice.filterChain?.windows() ?? [])
      if (connected.length && voice.asset.kind !== 'midi')
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
      this.waveMuted = command.muted
      return { events: [] }
    }
    if (command.op === 'midiOut') {
      this.midiOut(command.data)
      return { events: [] }
    }
    const id = command.id
    if (command.op === 'create') {
      if (!this.voices.has(id)) this.create(id, command.settings, command.kind)
    } else if (command.op === 'load') {
      const { asset, settings } = command
      if (!Number.isSafeInteger(asset.sampleCount) || asset.sampleCount < 1 ||
          !Number.isInteger(asset.sampleRate) || asset.sampleRate < 1000 || asset.sampleRate > 384000 ||
          !Number.isInteger(asset.channels) || asset.channels < 1 || asset.channels > 8)
        throw new Error('Invalid decoded audio')
      if (
        asset.kind === 'pcm' &&
        (asset.channels !== asset.data.length ||
          asset.data.some((channel) => channel.length !== asset.sampleCount))
      )
        throw new Error('PCM channel length mismatch')
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
      const filters = this.filters(id, asset, command.filters ?? [])
      const stream = asset.kind === 'stream' ? new StreamPcm(id, asset) : undefined
      const voice = this.create(
        id,
        settings,
        command.kind ?? (asset.kind === 'midi' ? 'midi' : 'wave'),
      )
      voice.asset = stream ? stream.asset : asset
      voice.stream = stream
      voice.filters = filters
      voice.status = 'stop'
      voice.settings.frequency = asset.sampleRate
      voice.settings.position = 0
      voice.settings.paused = false
      if (asset.kind === 'midi') voice.synth = new MidiSynth(asset)
    } else if (command.op === 'close') {
      this.voices.delete(id)
      return { events: [] }
    } else {
      const voice = this.get(id),
        settings = voice.settings
      if (command.op === 'play' && voice.asset && voice.status !== 'play') {
        if (voice.ended || settings.position >= voice.asset.sampleCount) this.seek(voice, 0)
        else this.resetFilters(voice)
        voice.status = 'play'
        voice.epoch = this.nextEpoch++
      } else if (command.op === 'stop') {
        if (voice.asset) voice.status = 'stop'
        voice.epoch = this.nextEpoch++
        this.seek(voice, 0)
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
        const filters = this.filters(id, voice.asset, command.filters, voice.filterChain?.windows())
        voice.filterChain?.configure(filters)
        voice.filters = filters
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
            voice.epoch = this.nextEpoch++
          } else if (property === 'frequency') {
            if (number < 100 || number > 384000)
              throw new Error('Playback frequency is outside range')
            settings.frequency = number
          }
        }
      } else if (command.op === 'flag') {
        if (command.index < 0 || command.index >= 16 || !Number.isInteger(command.index))
          throw new Error('Invalid wave flag')
        voice.flags[command.index] = clamp(Math.trunc(command.value), 0, 9999)
        voice.linkDirty = true
      } else if (command.op === 'fade') {
        if (command.time <= 0 || command.delay < 0)
          throw new Error('Fade requires positive time and non-negative delay')
        const target = clamp(command.target, 0, 100000)
        voice.fade = {
          target,
          delta: Math.trunc(((target - settings.volume) * 60) / command.time),
          count: Math.max(1, Math.floor(command.time / 60)),
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
    if (finish) voice.settings.volume = voice.fade.target
    voice.fade = undefined
    this.event(voice, 'fade')
  }
  private seek(voice: Voice, position: number): void {
    voice.ended = false
    voice.settings.position = position
    voice.labelIndex = lowerBound(
      voice.asset?.loops.labels ?? [],
      position,
      (label) => label.position,
    )
    voice.linkDirty = true
    voice.tail = undefined
    voice.synth?.seek(position / (voice.asset?.sampleRate ?? 44100))
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
      )
      voice.filterChain = new AudioFilterChain(
        voice.asset!.channels,
        voice.filters!,
        voice.filterSource,
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
    const match =
      /^:\s*\[\s*(\d+)\s*\]\s*(\+\+|--|\+=|-=|=)\s*(?:(-?\d+)|\[\s*(\d+)\s*\])?\s*$/.exec(name)
    if (!match) return false
    const index = Number(match[1]),
      operator = match[2]!,
      indirect = match[4] === undefined ? undefined : Number(match[4])
    if (
      index >= 16 ||
      (indirect !== undefined && indirect >= 16) ||
      (!['++', '--'].includes(operator) && match[3] === undefined && indirect === undefined)
    )
      return false
    const previous = voice.flags[index]!,
      operand = indirect === undefined ? Number(match[3] ?? 1) : voice.flags[indirect]!
    voice.flags[index] = clamp(
      operator === '='
        ? operand
        : operator === '+=' || operator === '++'
          ? previous + operand
          : previous - operand,
      0,
      9999,
    )
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
        const overshoot = settings.position - link.from,
          before = Math.min(Math.floor(asset.sampleRate * 0.025), link.from, link.to),
          after = Math.min(
            Math.floor(asset.sampleRate * 0.025),
            asset.sampleCount - link.from,
            asset.sampleCount - link.to,
          )
        this.seek(voice, link.to + overshoot)
        if (link.smooth && after > 0)
          voice.tail = {
            source: link.from + overshoot,
            progress: before + overshoot,
            total: before + after,
          }
        continue
      }
      if (settings.position >= asset.sampleCount) {
        if (settings.looping) {
          this.seek(voice, settings.position % asset.sampleCount)
          continue
        }
        settings.position = asset.sampleCount
        voice.status = 'stop'
        this.event(voice, 'ended')
        return false
      }
      const labels = asset.loops.labels
      while (
        voice.labelIndex < labels.length &&
        labels[voice.labelIndex]!.position <= settings.position
      ) {
        const label = labels[voice.labelIndex++]!
        this.expression(voice, label.name)
        this.event(voice, 'label', label.name)
      }
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
  private pcm(voice: Voice, channel: number, position: number): number {
    if (voice.stream) return voice.stream.sample(channel, position)
    const asset = voice.asset as PcmAsset
    const data = asset.data[channel]
    if (!data || position < 0 || position >= asset.sampleCount) return 0
    const index = Math.floor(position),
      fraction = position - index
    return data[index]! * (1 - fraction) + (data[index + 1] ?? data[index]!) * fraction
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
      if (voice.tail) {
        voice.tail.source += step
        voice.tail.progress += step
        if (voice.tail.progress >= voice.tail.total) voice.tail = undefined
      }
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
  private sample(voice: Voice, channel: number): number {
    const asset = voice.asset as WaveAsset,
      position = voice.settings.position
    if (voice.tail) {
      const t = voice.tail.progress / voice.tail.total
      return (
        this.pcm(voice, channel, voice.tail.source) * (1 - t) +
        this.pcm(voice, channel, position) * t
      )
    }
    const link = this.link(voice)
    if (link?.smooth) {
      const before = Math.min(Math.floor(asset.sampleRate * 0.025), link.from, link.to),
        after = Math.min(
          Math.floor(asset.sampleRate * 0.025),
          asset.sampleCount - link.from,
          asset.sampleCount - link.to,
        )
      if (before && position >= link.from - before) {
        const t = (position - (link.from - before)) / (before + after)
        return (
          this.pcm(voice, channel, position) * (1 - t) +
          this.pcm(voice, channel, link.to + (position - link.from)) * t
        )
      }
    }
    return this.pcm(voice, channel, position)
  }
  private streamRangeReady(stream: StreamPcm, start: number, end: number): boolean {
    return stream.ready(Math.floor(start), Math.floor(end) - Math.floor(start) + 2)
  }
  private streamReady(voice: Voice, advance = 0): boolean {
    const stream = voice.stream!, asset = voice.asset!, position = voice.settings.position
    let ready = this.streamRangeReady(stream, position, position + advance)
    if (voice.tail) ready = this.streamRangeReady(stream, voice.tail.source, voice.tail.source + advance) && ready
    else {
      const link = this.link(voice)
      if (link?.smooth) {
        const before = Math.min(Math.floor(asset.sampleRate * 0.025), link.from, link.to)
        if (before && position + advance >= link.from - before)
          ready = this.streamRangeReady(stream, link.to + Math.max(position, link.from - before) - link.from,
            link.to + position + advance - link.from) && ready
      }
    }
    return ready
  }
  private prepareStreamSample(voice: Voice, step: number): boolean | 'waiting' {
    const position = voice.settings.position, link = this.link(voice),
      boundary = Math.min(link?.from ?? voice.asset!.sampleCount,
        voice.asset!.loops.labels[voice.labelIndex]?.position ?? Infinity,
        voice.asset!.sampleCount)
    // Straight runs need only a bounded current/interpolation/advance range.
    if (position + step < boundary) return this.streamReady(voice, step) ? true : 'waiting'
    // Preflight the complete output sample, including all skipped labels and
    // SLI jumps at high playback rates. Neither the initial prepare nor advance
    // may publish control changes when any required page is still missing.
    const saved = { position, labelIndex: voice.labelIndex, linkDirty: voice.linkDirty,
      link: voice.link, tail: voice.tail && { ...voice.tail }, flags: [...voice.flags],
      ended: voice.ended, status: voice.status, fade: voice.fade,
      filterChain: voice.filterChain, filterSource: voice.filterSource }, pending = this.pending.length
    let terminal = false
    voice.stream!.beginPreflight()
    try {
      // EOF/error at the current position already has its original semantics.
      if (!this.prepareSample(voice)) { terminal = true; return false }
      const ready = this.streamReady(voice)
      if (!this.advance(voice, step, true) || !ready) return 'waiting'
    } finally {
      voice.stream!.endPreflight()
      if (!terminal) {
        voice.settings.position = saved.position
        voice.labelIndex = saved.labelIndex
        voice.linkDirty = saved.linkDirty
        voice.link = saved.link
        voice.tail = saved.tail
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
      const master = voice.kind === 'wave' ? (this.waveMuted ? 0 : this.globalVolume / 100000) : 1
      let chain: AudioFilterChain | undefined, waiting = false
      const label = (name: string, position: number) => {
        settings.position = position
        this.event(voice, 'label', name)
      }
      const sample = (channel: number) =>
        chain ? chain.sample(channel) : this.sample(voice, channel)
      for (let frame = 0; frame < left.length; frame++) {
        voice.clock += dt
        if (voice.fade && voice.clock + 1e-10 >= voice.fade.next) {
          voice.fade.next += 0.06
          if (voice.fade.delay > 0) voice.fade.delay = Math.max(0, voice.fade.delay - 60)
          else if (voice.fade.count <= 1) this.finishFade(voice, true)
          else {
            voice.fade.count--
            settings.volume = clamp(settings.volume + voice.fade.delta, 0, 100000)
          }
        }
        if (!asset || settings.paused || voice.status !== 'play' || waiting) continue
        try {
          const step = settings.frequency / this.sampleRate
          chain = voice.filters?.length ? this.filtered(voice, filterBudget) : undefined
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
          let l: number, r: number
          if (asset.kind === 'midi') {
            voice.synth!.render(settings.position / asset.sampleRate, step / asset.sampleRate)
            l = voice.synth!.left
            r = voice.synth!.right
          } else {
            l = sample(0)
            r = asset.channels === 1 ? l : sample(1)
            if (asset.channels === 4) {
              l += sample(2) * 0.70710678
              r += sample(3) * 0.70710678
            } else if (asset.channels >= 3) {
              const center = sample(2) * 0.70710678
              l += center
              r += center
              if (asset.channels >= 5) l += sample(4) * 0.70710678
              if (asset.channels >= 6) r += sample(5) * 0.70710678
              if (asset.channels >= 7) l += sample(6) * 0.5
              if (asset.channels >= 8) r += sample(7) * 0.5
            }
          }
          const gain = (((settings.volume / 100000) * settings.volume2) / 100000) * master,
            pan = settings.pan / 100000
          left[frame] += l * gain * (pan > 0 ? 1 - pan : 1)
          right[frame] += r * gain * (pan < 0 ? 1 + pan : 1)
          if (chain) {
            chain.advance(step, label)
            settings.position = chain.sourcePosition()
          } else this.advance(voice, step)
          if (voice.stream && frame === left.length - 1) voice.stream.prefetch(settings.position)
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
    let status = 0
    for (let at = 0; at < bytes.length;) {
      const byte = bytes[at]!
      if (byte >= 0xf8) {
        at++
        continue
      }
      if (byte & 128) {
        status = byte
        at++
      } else if (!status) throw new Error('MIDI output has invalid running status')
      let data: number[]
      if (status === 0xf0) {
        const start = at
        while (at < bytes.length && bytes[at] !== 0xf7) at++
        if (at === bytes.length) throw new Error('Unterminated MIDI system-exclusive message')
        data = Array.from(bytes.subarray(start, ++at))
      } else if (status < 0xf0) {
        const count = (status & 0xf0) === 0xc0 || (status & 0xf0) === 0xd0 ? 1 : 2
        data = Array.from(bytes.subarray(at, at + count))
        if (data.length !== count || data.some((value) => value > 127))
          throw new Error('Malformed MIDI output')
        at += count
      } else throw new Error('Unsupported MIDI system message')
      this.liveMidi.message({ status, data })
      for (const voice of this.voices.values()) voice.synth?.message({ status, data })
      if (status >= 0xf0) status = 0
    }
  }
}

export const freshVoiceSettings = defaultSoundSettings
