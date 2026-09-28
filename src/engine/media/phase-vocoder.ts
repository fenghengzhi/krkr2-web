/**
 * Adapted algorithm from KRKR2 2.32stable / Risa PhaseVocoderDSP and Filter.
 * Copyright (C) 2000 W.Dee <dee@kikyou.info> and contributors.
 * Fixed source: krkrz/krkr2 dec49af97e174d31059c3ccd7efc700ba3c6b788.
 * Distributed under the Kirikiri original license: public/licenses/phase-vocoder/.
 *
 * This is a TypeScript adaptation, not the original x86 implementation. It uses
 * project-owned complex FFT and Math trig instead of the NAS approximate core,
 * bounded phases/storage and checked finite execution parameters. It does not
 * promise bit-identical native samples. See third_party/phase-vocoder/README.md.
 */
import { Radix2Fft } from './fft.ts'

export interface PhaseVocoderParameters {
  window: number
  overlap: number
  pitch: number
  /** Output duration / input duration, not playback speed. */
  time: number
}

export interface PhaseVocoderHop {
  /** Borrowed arrays, overwritten by the next nonempty process call. */
  readonly data: readonly Float32Array[]
  readonly frames: number
  /** Dequeue this many input-segment frames and scale them to frames. */
  readonly inputFrames: number
}

const TAU = 2 * Math.PI

function effectiveOverlap(overlap: number, time: number) {
  return overlap || (time <= 0.2 ? 2 : time <= 1.2 ? 4 : 8)
}

function hops(parameters: PhaseVocoderParameters, window = parameters.window) {
  const overlap = effectiveOverlap(parameters.overlap, parameters.time),
    input = window / overlap,
    output = Math.floor((input * parameters.time) / 2) * 2
  return { overlap, input, output }
}

/**
 * Web execution domain, stricter than the original unchecked float setters.
 * Validation allocates no FFT/ring buffers and returns a private float32 copy.
 */
export function validatePhaseVocoderParameters(
  value: PhaseVocoderParameters,
): PhaseVocoderParameters {
  if (
    !Number.isInteger(value.window) ||
    value.window < 64 ||
    value.window > 32768 ||
    (value.window & (value.window - 1)) !== 0
  ) {
    throw new RangeError('PhaseVocoder window must be a power of two from 64 to 32768')
  }
  if (![0, 2, 4, 8, 16, 32].includes(value.overlap)) {
    throw new RangeError('PhaseVocoder overlap must be 0, 2, 4, 8, 16 or 32')
  }
  const pitch = Math.fround(value.pitch),
    time = Math.fround(value.time)
  if (!Number.isFinite(pitch) || pitch <= 0 || !Number.isFinite(time) || time <= 0) {
    throw new RangeError('PhaseVocoder pitch and time must be finite positive float32 values')
  }
  const parameters = { window: value.window, overlap: value.overlap, pitch, time },
    { output } = hops(parameters)
  if (!Number.isSafeInteger(output) || output < 2 || output > value.window) {
    throw new RangeError('PhaseVocoder output hop must be between 2 and its window size')
  }
  return parameters
}

/** Conservative live DSP bytes; the caller separately budgets its PCM/metadata staging. */
export function phaseVocoderMemoryBytes(channels: number, window: number) {
  if (!Number.isInteger(channels) || channels < 1 || channels > 8) {
    throw new RangeError('PhaseVocoder supports 1 to 8 PCM channels')
  }
  if (!Number.isInteger(window) || window < 64 || window > 32768 || window & (window - 1)) {
    throw new RangeError('PhaseVocoder window must be a power of two from 64 to 32768')
  }
  return (56 * channels + 24) * window + 4096
}

/**
 * Native even-quotient reduction has signed half-turn ties: +PI -> -PI,
 * -PI -> +PI. Remainder keeps those ties while avoiding an overflowing integer
 * quotient for large (but finite) synthesis advances. Do not replace it with a
 * floor-based [-PI, PI) wrap, which changes the negative tie before time scaling.
 */
export function principalPhase(angle: number) {
  const reduced = angle % TAU
  if (reduced >= Math.PI) return reduced - TAU
  if (reduced <= -Math.PI) return reduced + TAU
  return reduced
}

interface ChannelWork {
  input: Float32Array
  output: Float32Array
  overlap: Float64Array
  real: Float64Array
  imaginary: Float64Array
  previousAnalysis: Float64Array
  previousSynthesis: Float64Array
  magnitude: Float64Array
  frequency: Float64Array
}

class PhaseVocoderCore {
  readonly fft: Radix2Fft
  readonly inputWindow: Float32Array
  readonly outputWindow: Float32Array
  readonly work: ChannelWork[]
  readonly output: Float32Array[]
  inputStart = 0
  inputCount = 0
  private windowPitch = Number.NaN
  private windowTime = Number.NaN
  private windowOverlap = 0

  constructor(
    readonly size: number,
    channels: number,
  ) {
    this.fft = new Radix2Fft(size)
    this.inputWindow = new Float32Array(size)
    this.outputWindow = new Float32Array(size)
    for (let i = 0; i < size; i++) {
      const sine = Math.sin((Math.PI * (i + 0.5)) / size)
      this.inputWindow[i] = Math.sin((Math.PI / 2) * sine * sine)
    }
    this.work = Array.from({ length: channels }, () => ({
      input: new Float32Array(2 * size),
      output: new Float32Array(size),
      overlap: new Float64Array(size),
      real: new Float64Array(size),
      imaginary: new Float64Array(size),
      previousAnalysis: new Float64Array(size / 2),
      previousSynthesis: new Float64Array(size / 2),
      magnitude: new Float64Array(size / 2),
      frequency: new Float64Array(size / 2),
    }))
    this.output = this.work.map((channel) => channel.output)
  }

  rebuildWindows(parameters: PhaseVocoderParameters, overlap: number) {
    if (
      parameters.pitch === this.windowPitch &&
      parameters.time === this.windowTime &&
      overlap === this.windowOverlap
    )
      return
    const volume = (4 * parameters.time) / (this.size * Math.sqrt(parameters.pitch) * overlap)
    for (let i = 0; i < this.size; i++) {
      const sine = Math.sin((Math.PI * (i + 0.5)) / this.size),
        window = Math.sin((Math.PI / 2) * sine * sine)
      this.outputWindow[i] = window * volume
    }
    this.windowPitch = parameters.pitch
    this.windowTime = parameters.time
    this.windowOverlap = overlap
  }
}

/**
 * One bounded streaming stage. Feed exactly one requested input hop per call;
 * the final nonzero short hop is padded, but a zero read ends input immediately.
 * There is no extra EOF flush: this follows Filter::Decode's stop-before-Process
 * behavior. Before the first FFT it pre-reads N input frames without publishing
 * source progress. Every returned block consumes inputFrames of segment metadata.
 */
export class PhaseVocoderDsp {
  private parameters: PhaseVocoderParameters
  private core: PhaseVocoderCore | undefined
  private complete = false
  private readonly result: { data: readonly Float32Array[]; frames: number; inputFrames: number } =
    {
      data: [],
      frames: 0,
      inputFrames: 0,
    }

  constructor(
    readonly channels: number,
    parameters: PhaseVocoderParameters,
  ) {
    this.parameters = validatePhaseVocoderParameters(parameters)
    phaseVocoderMemoryBytes(channels, parameters.window)
  }

  get initialized() {
    return this.core !== undefined
  }
  get ended() {
    return this.complete
  }
  get bufferedFrames() {
    return this.core?.inputCount ?? 0
  }
  /** Active N if initialized, otherwise the N to use for the first nonzero input. */
  get window() {
    return this.core?.size ?? this.parameters.window
  }
  get inputHop() {
    return this.window / effectiveOverlap(this.parameters.overlap, this.parameters.time)
  }
  get outputHop() {
    return Math.floor((this.inputHop * this.parameters.time) / 2) * 2
  }

  configure(parameters: PhaseVocoderParameters) {
    const next = validatePhaseVocoderParameters(parameters)
    // Window changes are pending until Reset; the currently active N must also
    // admit the new live pitch/time/overlap before any part of an update commits.
    if (this.core) validatePhaseVocoderParameters({ ...next, window: this.core.size })
    this.parameters = next
  }

  reset() {
    this.core = undefined
    this.complete = false
    this.result.data = []
    this.result.frames = 0
    this.result.inputFrames = 0
  }

  process(input: readonly Float32Array[], frames: number): PhaseVocoderHop | null {
    const size = this.window,
      overlap = effectiveOverlap(this.parameters.overlap, this.parameters.time),
      inputHop = size / overlap,
      outputHop = Math.floor((inputHop * this.parameters.time) / 2) * 2
    if (!Number.isInteger(frames) || frames < 0 || frames > inputHop) {
      throw new RangeError('PhaseVocoder input must contain at most one input hop')
    }
    if (frames === 0) {
      this.complete = true
      return null
    }
    if (this.complete) throw new Error('PhaseVocoder input ended; reset before reusing it')
    if (input.length !== this.channels) {
      throw new RangeError('PhaseVocoder input channel lengths do not match')
    }
    // Check the entire accepted input before changing state, including channels
    // that would otherwise be seen after a partial ring write.
    for (const channel of input) {
      if (channel.length < frames) {
        throw new RangeError('PhaseVocoder input channel lengths do not match')
      }
      for (let i = 0; i < frames; i++) {
        if (!Number.isFinite(channel[i])) throw new RangeError('PhaseVocoder requires finite PCM')
      }
    }
    const core = (this.core ??= new PhaseVocoderCore(size, this.channels)),
      ringSize = size * 2,
      writeStart = (core.inputStart + core.inputCount) % ringSize
    for (let channel = 0; channel < this.channels; channel++) {
      const ring = core.work[channel]!.input,
        source = input[channel]!
      for (let i = 0; i < inputHop; i++)
        ring[(writeStart + i) % ringSize] = i < frames ? source[i]! : 0
    }
    core.inputCount += inputHop
    if (core.inputCount < size) return null
    core.rebuildWindows(this.parameters, overlap)
    const omega = TAU / overlap,
      exactTime = outputHop / inputHop,
      pitch = this.parameters.pitch,
      half = size / 2
    for (const work of core.work) {
      const { real, imaginary, magnitude, frequency, previousAnalysis, previousSynthesis } = work
      // Process clears the current hop's newly exposed tail before overlap-add.
      // The preceding hop may have been shorter, so its post-output shift alone
      // does not clear all of [N-Ho, N) after a live time/overlap increase.
      work.overlap.fill(0, size - outputHop)
      for (let i = 0; i < size; i++) {
        real[i] = Math.fround(work.input[(core.inputStart + i) % ringSize]! * core.inputWindow[i]!)
      }
      imaginary.fill(0)
      core.fft.transform(real, imaginary)
      // Original real-FFT slot 1 is Nyquist, forcibly zeroed before both cores.
      // Our explicit complex layout instead excludes bin N/2 from reconstruction.
      imaginary[0] = 0
      for (let bin = 0; bin < half; bin++) {
        const phase = Math.atan2(imaginary[bin]!, real[bin]!),
          delta = principalPhase(previousAnalysis[bin]! - phase - bin * omega)
        previousAnalysis[bin] = phase
        magnitude[bin] = Math.hypot(real[bin]!, imaginary[bin]!)
        // Hz divided by Fs/N. The common factor cancels in the gather/synthesis;
        // this preserves the source algorithm without depending on device rate.
        frequency[bin] = bin + delta / omega
      }
      real.fill(0)
      imaginary.fill(0)
      for (let bin = 0; bin < half; bin++) {
        const position = bin / pitch,
          lower = Math.floor(position),
          fraction = position - lower
        let amplitude = 0,
          binFrequency = 0
        if (pitch === 1) {
          amplitude = magnitude[bin]!
          binFrequency = frequency[bin]!
        } else if (lower < half) {
          const upper = Math.min(lower + 1, half - 1)
          amplitude = magnitude[lower]! + (magnitude[upper]! - magnitude[lower]!) * fraction
          binFrequency =
            (frequency[lower]! + (frequency[upper]! - frequency[lower]!) * fraction) * pitch
        }
        const phase = principalPhase(previousSynthesis[bin]! - binFrequency * omega * exactTime),
          r = amplitude * Math.cos(phase),
          im = bin === 0 ? 0 : amplitude * Math.sin(phase)
        previousSynthesis[bin] = phase
        real[bin] = r
        imaginary[bin] = im
        if (bin !== 0) {
          real[size - bin] = r
          imaginary[size - bin] = -im
        }
      }
      core.fft.transform(real, imaginary, true)
      for (let i = 0; i < size; i++) {
        // Native inverse RDFT returns N/2 times the samples, whereas our complex
        // inverse normalizes by N. Keep the original rounded output window.
        work.overlap[i] = work.overlap[i]! + real[i]! * half * core.outputWindow[i]!
      }
      for (let i = 0; i < outputHop; i++) {
        work.output[i] = work.overlap[i]!
        if (!Number.isFinite(work.output[i])) throw new RangeError('PhaseVocoder PCM overflow')
      }
      work.overlap.copyWithin(0, outputHop)
      work.overlap.fill(0, size - outputHop)
    }
    core.inputStart = (core.inputStart + inputHop) % ringSize
    core.inputCount -= inputHop
    this.result.data = core.output
    this.result.frames = outputHop
    this.result.inputFrames = inputHop
    return this.result
  }
}
