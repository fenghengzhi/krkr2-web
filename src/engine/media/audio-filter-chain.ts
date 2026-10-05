/**
 * Streaming wrapper adapted from KRKR2 2.32stable PhaseVocoderFilter.
 * Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors.
 * Kirikiri original license: public/licenses/phase-vocoder/.
 * This TypeScript implementation adds explicit budgets and a Web output cursor.
 */
import type { PhaseVocoderFilter } from '../ports/audio.ts'
import { PhaseVocoderDsp, validatePhaseVocoderParameters } from './phase-vocoder.ts'
import { WaveSegmentQueue } from './audio-segments.ts'

export interface AudioFilterBudget {
  calls: number
  sourceFrames: number
  sourceSteps: number
  fftCost: number
}
export const newAudioFilterBudget = (frames: number): AudioFilterBudget => ({
  calls: 256 * Math.ceil(frames / 128),
  sourceFrames: 262144 * Math.ceil(frames / 128),
  sourceSteps: 524288 * Math.ceil(frames / 128),
  fftCost: 16 * 1024 * 1024 * Math.ceil(frames / 128),
})
export interface FilterPcmSource {
  /** The last short read waits for data; false/absent means genuine EOF. */
  readonly starved?: boolean
  read(destination: readonly Float32Array[], frames: number, segments: WaveSegmentQueue): number
}
export interface FilterInputRead {
  /** Physical destination offset, including only committed EOF padding. */
  offset: number
  /** Real PCM frames across both native Decode fragments. */
  decoded: number
}

/** Preserve the native 4N ring's two Decode fragments. Retain `pending` when
 * offset < frames; the return value is cumulative real PCM, not EOF padding. */
export function readFilterInput(
  source: FilterPcmSource,
  destination: readonly Float32Array[],
  frames: number,
  writePosition: number,
  ringFrames: number,
  segments: WaveSegmentQueue,
  pending: FilterInputRead = { offset: 0, decoded: 0 },
): number {
  const first = Math.min(frames, ringFrames - writePosition)
  while (pending.offset < frames) {
    const start = pending.offset, end = start < first ? first : frames,
      destinationFragment = destination.map((channel) => channel.subarray(start, end)),
      written = source.read(destinationFragment, end - start, segments)
    if (!Number.isInteger(written) || written < 0 || written > end - start)
      throw new Error('Audio filter source returned an invalid frame count')
    pending.offset += written
    pending.decoded += written
    if (written < end - start && source.starved) return pending.decoded
    // Only genuine EOF pads a fragment. The second Decode still occurs even
    // after a short first fragment: its EOF label may have enabled a link.
    for (const channel of destination) channel.fill(0, pending.offset, end)
    pending.offset = end
  }
  return pending.decoded
}

/** Pull one bounded hop at a time. No stage pre-processes the asset or drains an EOF tail. */
class FilterStage implements FilterPcmSource {
  readonly dsp: PhaseVocoderDsp
  readonly inputSegments = new WaveSegmentQueue()
  readonly outputSegments = new WaveSegmentQueue()
  private readonly scratchSegments = new WaveSegmentQueue()
  private readonly readSegments = new WaveSegmentQueue()
  private input: Float32Array[]
  private output: Float32Array[]
  private available = 0
  private outputStart = 0
  private ended = false
  private inputWritePosition = 0
  private pendingInput?: { frames: number; writePosition: number; ringFrames: number; read: FilterInputRead }
  private deferredConfiguration?: PhaseVocoderFilter
  starved = false
  constructor(
    readonly channels: number,
    readonly upstream: FilterPcmSource,
    filter: PhaseVocoderFilter,
    private readonly budget: () => AudioFilterBudget,
  ) {
    this.dsp = new PhaseVocoderDsp(channels, filter)
    // Window may change on reset; a stage is rebuilt then, so this is bounded by its current N.
    this.input = Array.from({ length: channels }, () => new Float32Array(filter.window))
    this.output = Array.from({ length: channels }, () => new Float32Array(filter.window * 4))
  }
  prepareConfiguration(filter: PhaseVocoderFilter): () => void {
    const parameters = validatePhaseVocoderParameters(filter)
    if (this.pendingInput) {
      // A suspended Decode belongs to the hop/FFT settings that requested it.
      // Apply a live update at the next completed-hop boundary, not halfway
      // through an already consumed input request.
      validatePhaseVocoderParameters({ ...parameters, window: this.dsp.window })
      return () => { this.deferredConfiguration = { ...filter, ...parameters } }
    }
    const window = this.dsp.initialized ? this.dsp.window : parameters.window
    if (this.dsp.initialized) validatePhaseVocoderParameters({ ...parameters, window })
    // Allocate every replacement before any stage commits. A failed scratch
    // allocation must not update an earlier stage or this DSP's parameters.
    const changedWindow = this.input[0]!.length !== window
    const input = changedWindow
      ? Array.from({ length: this.channels }, () => new Float32Array(window))
      : this.input
    const output = changedWindow
      ? Array.from({ length: this.channels }, () => new Float32Array(window * 4))
      : this.output
    return () => {
      this.dsp.configure(parameters)
      this.input = input
      this.output = output
      if (changedWindow) this.inputWritePosition = 0
    }
  }
  get window(): number {
    return this.dsp.window
  }
  private fill(): boolean {
    if (this.ended) return false
    while (true) {
      const budget = this.budget()
      if (--budget.calls < 0 || budget.fftCost < 0)
        throw new Error('Audio filter processing budget exceeded')
      if (!this.pendingInput) {
        this.readSegments.clear()
        this.pendingInput = { frames: this.dsp.inputHop, writePosition: this.inputWritePosition,
          ringFrames: this.dsp.window * 4, read: { offset: 0, decoded: 0 } }
      }
      const pending = this.pendingInput
      const frames = readFilterInput(
        this.upstream,
        this.input,
        pending.frames,
        pending.writePosition,
        pending.ringFrames,
        this.readSegments,
        pending.read,
      )
      if (pending.read.offset < pending.frames) {
        this.starved = true
        return false
      }
      this.pendingInput = undefined
      this.inputWritePosition = (pending.writePosition + pending.frames) % pending.ringFrames
      this.inputSegments.append(this.readSegments)
      if (!frames) {
        this.ended = true
        // Deliberately no generic zero-padding drain after source EOF.
        this.dsp.process(this.input, 0)
        return false
      }
      const cost =
        this.dsp.bufferedFrames + this.dsp.inputHop >= this.dsp.window
          ? this.channels * this.dsp.window * Math.log2(this.dsp.window)
          : 0
      if (cost > budget.fftCost) throw new Error('Audio filter FFT budget exceeded')
      budget.fftCost -= cost
      // The wrapper's real count decides only EOF. Every fragment was padded in
      // place: a short first fragment may be followed by real PCM after an EOF
      // label enables a link, so its total is not a contiguous valid prefix.
      const hop = this.dsp.process(this.input, pending.frames)
      if (this.deferredConfiguration) {
        const configuration = this.deferredConfiguration
        this.deferredConfiguration = undefined
        this.prepareConfiguration(configuration)()
      }
      if (!hop) continue
      this.inputSegments.take(hop.inputFrames, this.scratchSegments)
      this.scratchSegments.scale(hop.frames)
      this.outputSegments.append(this.scratchSegments)
      const capacity = this.output[0]!.length,
        start = (this.outputStart + this.available) % capacity
      if (this.available + hop.frames > capacity)
        throw new Error('Audio filter output buffer exceeded')
      for (let channel = 0; channel < this.channels; channel++) {
        const count = Math.min(hop.frames, capacity - start)
        this.output[channel]!.set(hop.data[channel]!.subarray(0, count), start)
        if (count < hop.frames)
          this.output[channel]!.set(hop.data[channel]!.subarray(count, hop.frames), 0)
      }
      this.available += hop.frames
      return true
    }
  }
  read(destination: readonly Float32Array[], frames: number, segments: WaveSegmentQueue): number {
    this.starved = false
    let written = 0
    while (written < frames) {
      while (this.available < this.dsp.outputHop && !this.ended)
        if (!this.fill()) break
      // The original wrapper does not release a final sub-hop remainder at EOF.
      if (this.available < this.dsp.outputHop) break
      const count = Math.min(frames - written, this.dsp.outputHop),
        capacity = this.output[0]!.length,
        first = Math.min(count, capacity - this.outputStart)
      for (let channel = 0; channel < this.channels; channel++) {
        destination[channel]!.set(
          this.output[channel]!.subarray(this.outputStart, this.outputStart + first),
          written,
        )
        if (first < count)
          destination[channel]!.set(
            this.output[channel]!.subarray(0, count - first),
            written + first,
          )
      }
      this.outputSegments.take(count, this.scratchSegments)
      segments.append(this.scratchSegments)
      this.outputStart = (this.outputStart + count) % capacity
      this.available -= count
      written += count
    }
    return written
  }
}
interface PlaybackBlock {
  data: Float32Array[]
  segments: WaveSegmentQueue
  frames: number
  complete: boolean
}
const playbackBlockFrames = 256, playbackBlocks = 4
/** Playback lookahead only; per-stage scratch/DSP and source fades are separate. */
export const audioFilterChainMemoryBytes = (channels: number): number =>
  channels * playbackBlockFrames * playbackBlocks * Float32Array.BYTES_PER_ELEMENT

/** Keeps device/audible time separate from source lookahead and every stage's hop queues. */
export class AudioFilterChain {
  private readonly stages: FilterStage[]
  private readonly final: FilterPcmSource
  private readonly blocks: PlaybackBlock[]
  private current = 0
  private queued = 1
  private position = 0
  private lastSourcePosition = 0
  private budget!: AudioFilterBudget
  starved = false
  constructor(channels: number, filters: readonly PhaseVocoderFilter[], source: FilterPcmSource) {
    this.stages = []
    let upstream = source
    for (const filter of filters) {
      const stage = new FilterStage(channels, upstream, filter, () => this.budget)
      this.stages.push(stage)
      upstream = stage
    }
    this.final = upstream
    const block = (): PlaybackBlock => ({
      data: Array.from({ length: channels }, () => new Float32Array(playbackBlockFrames)),
      segments: new WaveSegmentQueue(),
      frames: 0,
      complete: false,
    })
    this.blocks = Array.from({ length: playbackBlocks }, block)
  }
  setBudget(budget: AudioFilterBudget): void {
    this.budget = budget
  }
  windows(): number[] {
    return this.stages.map((stage) => stage.window)
  }
  configure(filters: readonly PhaseVocoderFilter[]): void {
    const commit = this.stages.map((stage, index) => stage.prepareConfiguration(filters[index]!))
    for (const apply of commit) apply()
  }
  private fill(block: PlaybackBlock): void {
    if (block.complete) return
    const available = playbackBlockFrames - block.frames,
      destination = block.data.map((channel) => channel.subarray(block.frames)),
      read = this.final.read(destination, available, block.segments)
    if (!Number.isInteger(read) || read < 0 || read > available)
      throw new Error('Audio filter source returned an invalid playback frame count')
    block.frames += read
    block.complete = block.frames === playbackBlockFrames || !this.final.starved
  }
  private block(offset: number): PlaybackBlock {
    if (offset >= playbackBlocks) throw new Error('Audio filter playback lookahead exceeded')
    const block = this.blocks[(this.current + offset) % playbackBlocks]!
    if (offset >= this.queued) {
      block.frames = 0
      block.complete = false
      block.segments.clear()
      this.queued = offset + 1
    }
    return block
  }
  /**
   * Preflight one output sample and its subsequent source-frame advance.
   * May decode/execute source flag labels as lookahead, but never emits audible
   * labels or changes the playback position. False means starvation only;
   * genuine EOF returns true, followed by prepare() returning false at its end.
   * After success, prepare/sample/advance(step) require no additional PCM.
   */
  canAdvance(step: number): boolean {
    if (!Number.isFinite(step) || step < 0 || step > 384)
      throw new RangeError('Audio filter advance is outside its bounded sample step')
    this.starved = false
    // A fractional sample needs the next PCM point, even if step is smaller.
    // An unfinished block ending exactly at a source jump must resolve its
    // next segment before advance commits sourcePosition(). A complete block
    // retains the original boundary: do not predecode another whole block just
    // for an integer advance ending there (live filter updates may intervene).
    let required = Math.max(Math.floor(this.position) + (this.position % 1 ? 2 : 1),
      this.position + step)
    for (let offset = 0; ; offset++) {
      const block = this.block(offset)
      if (required >= block.frames && !block.complete) this.fill(block)
      if (required <= block.frames && (required !== block.frames || block.complete)) return true
      if (!block.complete) {
        this.starved = true
        return false
      }
      if (!block.frames) return true
      required -= block.frames
    }
  }
  prepare(emit: (name: string, position: number) => void): boolean {
    if (!this.canAdvance(0)) return false
    let block = this.blocks[this.current]!
    while (block.frames && this.position >= block.frames) {
      this.lastSourcePosition = block.segments.positionAt(block.frames)
      this.position -= block.frames
      this.current = (this.current + 1) % playbackBlocks
      this.queued--
      block = this.blocks[this.current]!
    }
    if (!block.frames) return false
    this.lastSourcePosition = block.segments.positionAt(this.position)
    block.segments.emitThrough(this.position, true, (label) =>
      emit(label.name, block.segments.positionAt(label.offset)),
    )
    return true
  }
  sourcePosition(): number {
    // Appending lookahead metadata can resolve a future jump at a partial
    // block's end. Only prepare/advance commit the audible source position.
    return this.lastSourcePosition
  }
  sample(channel: number): number {
    const block = this.blocks[this.current]!,
      index = Math.floor(this.position),
      fraction = this.position - index,
      first = block.data[channel]![index]!
    if (!fraction) return first
    const second =
      index + 1 < block.frames
        ? block.data[channel]![index + 1]!
        : this.block(1).frames
          ? this.block(1).data[channel]![0]!
          : first
    return first * (1 - fraction) + second * fraction
  }
  advance(frames: number, emit: (name: string, position: number) => void): void {
    if (!this.canAdvance(frames)) return
    let remaining = frames
    // frequency is bounded by 384000 and output sample rate by 1000, so a single
    // output sample cannot traverse an unbounded number of 256-frame blocks.
    while (remaining > 1e-9) {
      const block = this.blocks[this.current]!
      if (!block.frames) return
      const count = Math.min(remaining, block.frames - this.position)
      this.position += count
      this.lastSourcePosition = block.segments.positionAt(this.position)
      remaining -= count
      block.segments.emitThrough(this.position, false, (label) =>
        emit(label.name, block.segments.positionAt(label.offset)),
      )
      if (remaining > 1e-9 && !this.prepare(emit)) return
    }
  }
}
