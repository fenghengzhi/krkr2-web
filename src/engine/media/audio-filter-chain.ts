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
  read(destination: readonly Float32Array[], frames: number, segments: WaveSegmentQueue): number
}

/** Preserve the two Source.Decode calls made when the native 4N input ring wraps. */
export function readFilterInput(
  source: FilterPcmSource,
  destination: readonly Float32Array[],
  frames: number,
  writePosition: number,
  ringFrames: number,
  segments: WaveSegmentQueue,
): number {
  const first = Math.min(frames, ringFrames - writePosition)
  let written = source.read(destination, first, segments)
  for (const channel of destination) channel.fill(0, written, first)
  if (first < frames) {
    // Each fragment is a distinct source request. An EOF label can make the
    // second fragment nonempty; keep its physical position after first-fragment padding.
    const tail = destination.map((channel) => channel.subarray(first))
    const secondWritten = source.read(tail, frames - first, segments)
    for (const channel of tail) channel.fill(0, secondWritten, frames - first)
    written += secondWritten
  }
  return written
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
      this.readSegments.clear()
      const ringFrames = this.dsp.window * 4,
        writePosition = this.inputWritePosition
      this.inputWritePosition = (writePosition + this.dsp.inputHop) % ringFrames
      const frames = readFilterInput(
        this.upstream,
        this.input,
        this.dsp.inputHop,
        writePosition,
        ringFrames,
        this.readSegments,
      )
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
      const hop = this.dsp.process(this.input, this.dsp.inputHop)
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
    let written = 0
    while (written < frames) {
      while (this.available < this.dsp.outputHop && !this.ended) this.fill()
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
}

/** Keeps device/audible time separate from source lookahead and every stage's hop queues. */
export class AudioFilterChain {
  private readonly stages: FilterStage[]
  private readonly final: FilterPcmSource
  private readonly blocks: [PlaybackBlock, PlaybackBlock]
  private current = 0
  private position = 0
  private initialized = false
  private nextReady = false
  private lastSourcePosition = 0
  private budget!: AudioFilterBudget
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
      data: Array.from({ length: channels }, () => new Float32Array(256)),
      segments: new WaveSegmentQueue(),
      frames: 0,
    })
    this.blocks = [block(), block()]
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
    block.segments.clear()
    block.frames = this.final.read(block.data, 256, block.segments)
  }
  private next(): PlaybackBlock {
    const block = this.blocks[1 - this.current]!
    if (!this.nextReady) {
      this.fill(block)
      this.nextReady = true
    }
    return block
  }
  prepare(emit: (name: string, position: number) => void): boolean {
    if (!this.initialized) {
      this.fill(this.blocks[this.current]!)
      this.initialized = true
    }
    let block = this.blocks[this.current]!
    while (block.frames && this.position >= block.frames) {
      this.lastSourcePosition = block.segments.positionAt(block.frames)
      this.position -= block.frames
      this.next()
      this.current = 1 - this.current
      this.nextReady = false
      block = this.blocks[this.current]!
    }
    if (!block.frames) return false
    block.segments.emitThrough(this.position, true, (label) =>
      emit(label.name, block.segments.positionAt(label.offset)),
    )
    return true
  }
  sourcePosition(): number {
    const block = this.blocks[this.current]!
    return block.frames ? block.segments.positionAt(this.position) : this.lastSourcePosition
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
        : this.next().frames
          ? this.next().data[channel]![0]!
          : first
    return first * (1 - fraction) + second * fraction
  }
  advance(frames: number, emit: (name: string, position: number) => void): void {
    let remaining = frames
    // frequency is bounded by 384000 and output sample rate by 1000, so a single
    // output sample cannot traverse an unbounded number of 256-frame blocks.
    while (remaining > 1e-9) {
      const block = this.blocks[this.current]!
      if (!block.frames) return
      const count = Math.min(remaining, block.frames - this.position)
      this.position += count
      remaining -= count
      block.segments.emitThrough(this.position, false, (label) =>
        emit(label.name, block.segments.positionAt(label.offset)),
      )
      if (remaining > 1e-9 && !this.prepare(emit)) return
    }
  }
}
