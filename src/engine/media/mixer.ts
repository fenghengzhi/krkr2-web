import {
  defaultSoundSettings,
  type AudioAsset,
  type AudioResult,
  type AudioEvent,
  type LoopLink,
  type MixerCommand,
  type PcmAsset,
  type SoundEvent,
  type SoundKind,
  type SoundSettings,
  type SoundSnapshot,
  type PhaseVocoderFilter,
} from '../ports/audio.ts'
import { MidiSynth } from './midi-synth.ts'
import {
  AudioFilterChain,
  newAudioFilterBudget,
  type AudioFilterBudget,
} from './audio-filter-chain.ts'
import { FilteredWaveSource, filteredWaveSourceMemoryBytes } from './filtered-wave-source.ts'
import { phaseVocoderMemoryBytes, validatePhaseVocoderParameters } from './phase-vocoder.ts'
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
    if (filters.length && asset.kind !== 'pcm') throw new Error('Audio filters require PCM audio')
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
      if (items.length) bytes += channels * 512 * 4
    }
    reserve(asset.channels, next, activeWindows)
    if (next.length && asset.kind === 'pcm') bytes += filteredWaveSourceMemoryBytes(asset)
    for (const voice of this.voices.values()) {
      if (voice.id === id || !voice.asset) continue
      const connected = voice.filters ?? []
      for (const filter of connected)
        if (identities.has(filter.id))
          throw new Error('Audio filter is already connected to a voice')
      count += connected.length
      reserve(voice.asset.channels, connected, voice.filterChain?.windows() ?? [])
      if (connected.length && voice.asset.kind === 'pcm')
        bytes += filteredWaveSourceMemoryBytes(voice.asset)
    }
    if (count > 16 || bytes > 64 * 1024 * 1024)
      throw new Error('Audio filter session budget exceeded')
    return next
  }
  command(command: MixerCommand): AudioResult {
    const start = this.pending.length
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
      if (asset.sampleCount < 1 || asset.sampleRate < 1000 || asset.sampleRate > 384000)
        throw new Error('Invalid decoded audio')
      if (
        asset.kind === 'pcm' &&
        (asset.channels !== asset.data.length ||
          asset.data.some((channel) => channel.length !== asset.sampleCount))
      )
        throw new Error('PCM channel length mismatch')
      let bytes =
        asset.kind === 'pcm' ? asset.data.reduce((sum, data) => sum + data.byteLength, 0) : 0
      for (const other of this.voices.values())
        if (other.id !== id && other.asset?.kind === 'pcm')
          bytes += other.asset.data.reduce((sum, data) => sum + data.byteLength, 0)
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
      const voice = this.create(
        id,
        settings,
        command.kind ?? (asset.kind === 'midi' ? 'midi' : 'wave'),
      )
      voice.asset = asset
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
        voice.asset as PcmAsset,
        voice.settings.position,
        voice.flags,
        () => voice.settings.looping,
        () => voice.filterBudget!,
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
  private pcm(asset: PcmAsset, channel: number, position: number): number {
    const data = asset.data[channel]
    if (!data || position < 0 || position >= asset.sampleCount) return 0
    const index = Math.floor(position),
      fraction = position - index
    return data[index]! * (1 - fraction) + (data[index + 1] ?? data[index]!) * fraction
  }
  private advance(voice: Voice, remaining: number): void {
    const asset = voice.asset!,
      settings = voice.settings
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
      if (remaining <= 1e-9) return
      if (!this.prepareSample(voice)) return
    }
    if (remaining > 1e-9) {
      voice.status = 'stop'
      voice.fade = undefined
      this.pending.push({
        type: 'error',
        message: `Audio voice ${voice.id}: too many source boundaries in one output sample`,
      })
    }
  }
  private sample(voice: Voice, channel: number): number {
    const asset = voice.asset as PcmAsset,
      position = voice.settings.position
    if (voice.tail) {
      const t = voice.tail.progress / voice.tail.total
      return (
        this.pcm(asset, channel, voice.tail.source) * (1 - t) +
        this.pcm(asset, channel, position) * t
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
          this.pcm(asset, channel, position) * (1 - t) +
          this.pcm(asset, channel, link.to + (position - link.from)) * t
        )
      }
    }
    return this.pcm(asset, channel, position)
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
      let chain: AudioFilterChain | undefined
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
        if (!asset || settings.paused || voice.status !== 'play') continue
        try {
          chain = voice.filters?.length ? this.filtered(voice, filterBudget) : undefined
          if (chain) {
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
          } else if (!this.prepareSample(voice)) continue
          const step = settings.frequency / this.sampleRate
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
