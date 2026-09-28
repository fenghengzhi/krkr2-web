import assert from 'node:assert/strict'
import test from 'node:test'
import { Radix2Fft } from '../../src/engine/media/fft.ts'
import {
  PhaseVocoderDsp,
  principalPhase,
  validatePhaseVocoderParameters,
  type PhaseVocoderParameters,
} from '../../src/engine/media/phase-vocoder.ts'

// These mathematical checks do not claim bit identity with the native scalar/SSE cores.
const sampleRate = 48000
const parameters = (changes: Partial<PhaseVocoderParameters> = {}): PhaseVocoderParameters => ({
  window: 1024,
  overlap: 4,
  pitch: 1,
  time: 1,
  ...changes,
})

function near(actual: number, expected: number, tolerance: number, context: string) {
  assert.ok(Number.isFinite(actual), `${context}: non-finite ${actual}`)
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${context}: expected ${expected} ± ${tolerance}, got ${actual}`,
  )
}

// Intentionally quadratic and independent of the production radix-2 butterflies.
function dft(real: Float64Array, imag: Float64Array, inverse: boolean) {
  const size = real.length,
    outputReal = new Float64Array(size),
    outputImag = new Float64Array(size),
    direction = inverse ? -1 : 1,
    scale = inverse ? 1 / size : 1
  for (let k = 0; k < size; k++) {
    let re = 0,
      im = 0
    for (let n = 0; n < size; n++) {
      const angle = (direction * 2 * Math.PI * k * n) / size,
        cosine = Math.cos(angle),
        sine = Math.sin(angle)
      re += real[n]! * cosine - imag[n]! * sine
      im += real[n]! * sine + imag[n]! * cosine
    }
    outputReal[k] = re * scale
    outputImag[k] = im * scale
  }
  return { real: outputReal, imag: outputImag }
}

function tone(frames: number, frequency: number, phase = 0) {
  return Float32Array.from(
    { length: frames },
    (_, frame) => 0.2 * Math.sin((2 * Math.PI * frequency * frame) / sampleRate + phase),
  )
}

function collect(dsp: PhaseVocoderDsp, input: readonly Float32Array[]) {
  const sourceFrames = input[0]!.length,
    chunks: Float32Array[][] = input.map(() => [])
  assert.ok(input.every((channel) => channel.length === sourceFrames))
  let frames = 0,
    hops = 0
  for (let cursor = 0; cursor < sourceFrames;) {
    const inputHop = dsp.inputHop,
      count = Math.min(inputHop, sourceFrames - cursor),
      hop = dsp.process(
        input.map((channel) => channel.subarray(cursor, cursor + count)),
        count,
      )
    cursor += count
    if (!hop) continue
    assert.equal(hop.inputFrames, inputHop)
    assert.equal(hop.frames, dsp.outputHop)
    assert.equal(hop.data.length, input.length)
    for (let channel = 0; channel < input.length; channel++) {
      assert.ok(hop.data[channel]!.length >= hop.frames)
      // Results are borrowed; consume/copy each hop before the next process call.
      chunks[channel]!.push(hop.data[channel]!.slice(0, hop.frames))
    }
    frames += hop.frames
    hops++
  }
  assert.equal(
    dsp.process(
      input.map(() => new Float32Array(0)),
      0,
    ),
    null,
  )
  assert.equal(dsp.ended, true)
  return {
    frames,
    hops,
    data: chunks.map((channel) => {
      const samples = new Float32Array(frames)
      let cursor = 0
      for (const chunk of channel) {
        samples.set(chunk, cursor)
        cursor += chunk.length
      }
      return samples
    }),
  }
}

function rms(samples: Float32Array) {
  let energy = 0
  for (const sample of samples) {
    assert.ok(Number.isFinite(sample), `non-finite PCM ${sample}`)
    energy += sample * sample
  }
  return Math.sqrt(energy / samples.length)
}

// A Goertzel spectrum gives an independent frequency oracle, without invoking Radix2Fft.
function dominantFrequency(samples: Float32Array, skip = 2048) {
  const size = 8192
  assert.ok(samples.length >= skip + size, 'enough steady-state PCM for a resolved spectrum')
  const windowed = new Float64Array(size)
  for (let n = 0; n < size; n++)
    windowed[n] = samples[skip + n]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (size - 1)))
  let maximum = -Infinity,
    bestBin = 0
  // Covers both requested peaks and likely erroneous p/time resampling peaks.
  for (let bin = 1; bin <= 512; bin++) {
    const coefficient = 2 * Math.cos((2 * Math.PI * bin) / size)
    let previous = 0,
      beforePrevious = 0
    for (const sample of windowed) {
      const next = sample + coefficient * previous - beforePrevious
      beforePrevious = previous
      previous = next
    }
    const power =
      previous * previous +
      beforePrevious * beforePrevious -
      coefficient * previous * beforePrevious
    if (power > maximum) {
      maximum = power
      bestBin = bin
    }
  }
  assert.ok(maximum > 1, 'a silent or negligible signal cannot satisfy a frequency check')
  return (bestBin * sampleRate) / size
}

test('radix-2 FFT agrees with an independent complex DFT in each direction', () => {
  for (const size of [2, 4, 8, 16, 32, 64]) {
    const sourceReal = Float64Array.from({ length: size }, (_, i) => Math.sin(i * 0.31) + i / size),
      sourceImag = Float64Array.from({ length: size }, (_, i) => Math.cos(i * 0.47) - 0.25),
      fft = new Radix2Fft(size)
    for (const inverse of [false, true]) {
      const expected = dft(sourceReal, sourceImag, inverse),
        real = sourceReal.slice(),
        imag = sourceImag.slice()
      fft.transform(real, imag, inverse)
      for (let bin = 0; bin < size; bin++) {
        near(
          real[bin]!,
          expected.real[bin]!,
          size * 1e-11,
          `N=${size}, inverse=${inverse}, re[${bin}]`,
        )
        near(
          imag[bin]!,
          expected.imag[bin]!,
          size * 1e-11,
          `N=${size}, inverse=${inverse}, im[${bin}]`,
        )
      }
    }
    const real = sourceReal.slice(),
      imag = sourceImag.slice()
    fft.transform(real, imag)
    fft.transform(real, imag, true)
    for (let n = 0; n < size; n++) {
      near(real[n]!, sourceReal[n]!, 1e-10, `roundtrip re[${n}]`)
      near(imag[n]!, sourceImag[n]!, 1e-10, `roundtrip im[${n}]`)
    }
  }
})

test('FFT impulse spectra and phase ties fix transform signs and native half-turn reduction', () => {
  const size = 16,
    fft = new Radix2Fft(size)
  for (const inverse of [false, true]) {
    const real = new Float64Array(size),
      imag = new Float64Array(size)
    real[1] = 1
    fft.transform(real, imag, inverse)
    for (let k = 0; k < size; k++) {
      const angle = (2 * Math.PI * k) / size,
        scale = inverse ? 1 / size : 1
      near(real[k]!, Math.cos(angle) * scale, 1e-12, `impulse re[${k}]`)
      near(imag[k]!, Math.sin(angle) * scale * (inverse ? -1 : 1), 1e-12, `impulse im[${k}]`)
    }
  }
  for (const invalid of [0, -2, 3, 12, 16.5, NaN, Infinity])
    assert.throws(() => new Radix2Fft(invalid), `invalid FFT size ${invalid}`)
  assert.equal(principalPhase(Math.PI), -Math.PI)
  assert.equal(principalPhase(-Math.PI), Math.PI)
  assert.equal(principalPhase(3 * Math.PI), -Math.PI)
  assert.equal(principalPhase(-3 * Math.PI), Math.PI)
  const epsilon = 1e-12
  near(principalPhase(Math.PI - epsilon), Math.PI - epsilon, 1e-15, 'below positive half-turn')
  near(principalPhase(Math.PI + epsilon), -Math.PI + epsilon, 1e-15, 'above positive half-turn')
  near(principalPhase(-Math.PI + epsilon), -Math.PI + epsilon, 1e-15, 'above negative half-turn')
  near(principalPhase(-Math.PI - epsilon), Math.PI - epsilon, 1e-15, 'below negative half-turn')
  // A half-duration synthesis advance exposes a wrong tie sign as opposite
  // quadrature, rather than merely two phases that differ by a full turn.
  near(-principalPhase(-Math.PI) * 0.5, -Math.PI / 2, 0, 'negative tie at half duration')
  near(-principalPhase(Math.PI) * 0.5, Math.PI / 2, 0, 'positive tie at half duration')
  assert.throws(() => fft.transform(new Float64Array(size - 1), new Float64Array(size)))
  assert.throws(() => fft.transform(new Float64Array(size), new Float64Array(size + 1)))
  const aliased = new Float64Array(size)
  assert.throws(() => fft.transform(aliased, aliased))
})

test('phase vocoder validates its safe domain and stores pitch/time as float32 copies', () => {
  const source = parameters({ pitch: 1.0594630943593, time: 1.3 }),
    validated = validatePhaseVocoderParameters(source)
  assert.notEqual(validated, source)
  assert.equal(validated.pitch, Math.fround(source.pitch))
  assert.equal(validated.time, Math.fround(source.time))
  assert.equal(source.pitch, 1.0594630943593)
  assert.equal(source.time, 1.3)
  for (const window of [64, 128, 256, 512, 1024, 2048, 4096, 8192, 16384, 32768])
    assert.equal(validatePhaseVocoderParameters(parameters({ window })).window, window)
  for (const overlap of [0, 2, 4, 8, 16, 32])
    assert.equal(validatePhaseVocoderParameters(parameters({ overlap })).overlap, overlap)
  for (const window of [0, 63, 65, 1000, 32769, 65536, 64.5, NaN, Infinity])
    assert.throws(() => validatePhaseVocoderParameters(parameters({ window })))
  for (const overlap of [-1, 1, 3, 64, 2.5, NaN, Infinity])
    assert.throws(() => validatePhaseVocoderParameters(parameters({ overlap })))
  for (const value of [0, -1, NaN, Infinity, -Infinity, Number.MIN_VALUE, Number.MAX_VALUE]) {
    assert.throws(() => validatePhaseVocoderParameters(parameters({ pitch: value })))
    assert.throws(() => validatePhaseVocoderParameters(parameters({ time: value })))
  }
  assert.throws(
    () => validatePhaseVocoderParameters(parameters({ time: 0.001 })),
    'zero output hop',
  )
  assert.throws(() => validatePhaseVocoderParameters(parameters({ time: 5 })), 'hop exceeds window')
  for (const channels of [0, -1, 1.5, NaN, Infinity])
    assert.throws(() => new PhaseVocoderDsp(channels, parameters()))
})

test('automatic overlap and even output hops determine the actual time scale', () => {
  for (const [time, overlap] of [
    [0.199, 2],
    [0.201, 4],
    [1.199, 4],
    [1.201, 8],
  ]) {
    const dsp = new PhaseVocoderDsp(1, parameters({ overlap: 0, time }))
    assert.equal(dsp.inputHop, 1024 / overlap!)
    assert.equal(dsp.outputHop, 2 * Math.floor((dsp.inputHop * Math.fround(time!)) / 2))
    assert.equal(dsp.outputHop % 2, 0)
  }
  const quantized = new PhaseVocoderDsp(1, parameters({ window: 64, time: 1.3 }))
  assert.equal(quantized.inputHop, 16)
  assert.equal(quantized.outputHop, 20)
  assert.notEqual(quantized.outputHop / quantized.inputHop, Math.fround(1.3))
})

test('phase vocoder pitch and time change independent measured frequency and output duration', () => {
  const source = tone(32768, 750)
  for (const [pitch, time] of [
    [1, 1],
    [2, 1],
    [0.5, 1],
    [1, 0.5],
    [1, 1.5],
    [2, 1.5],
  ]) {
    const dsp = new PhaseVocoderDsp(1, parameters({ pitch, time })),
      inputHop = dsp.inputHop,
      outputHop = dsp.outputHop,
      output = collect(dsp, [source]),
      expectedFrames = (Math.ceil(source.length / inputHop) - 4 + 1) * outputHop,
      measured = dominantFrequency(output.data[0]!)
    assert.equal(output.frames, expectedFrames, `pitch=${pitch}, time=${time}`)
    near(measured, 750 * pitch!, 750 * pitch! * 0.01, `pitch=${pitch}, time=${time}`)
    const level = rms(output.data[0]!.subarray(2048, 10240))
    assert.ok(level > 0.01 && level < 1, `bounded nonzero steady-state level ${level}`)
  }
  // Off-bin input exercises instantaneous-frequency phase unwrapping, not just bin relocation.
  const offBin = collect(new PhaseVocoderDsp(1, parameters({ pitch: 1.5, time: 1.3 })), [
    tone(32768, 731.25, 0.37),
  ])
  near(dominantFrequency(offBin.data[0]!), 1096.875, 10.96875, 'off-bin pitch/time')
})

test('EOF stops after complete available hops without flushing overlap tails', () => {
  for (const overlap of [2, 4, 8, 16, 32]) {
    for (const time of [0.75, 1, 1.3]) {
      const config = parameters({ window: 256, overlap, time }),
        inputHop = 256 / overlap,
        outputHop = 2 * Math.floor((inputHop * Math.fround(time)) / 2)
      for (const length of [
        0,
        1,
        inputHop - 1,
        inputHop,
        256 - inputHop,
        256 - inputHop + 1,
        256,
        777,
      ]) {
        const dsp = new PhaseVocoderDsp(1, config),
          output = collect(dsp, [tone(length, 750)]),
          expectedHops = Math.max(0, Math.ceil(length / inputHop) - overlap + 1)
        assert.equal(output.hops, expectedHops, `O=${overlap}, t=${time}, length=${length}`)
        assert.equal(output.frames, expectedHops * outputHop)
        assert.equal(dsp.process([new Float32Array(0)], 0), null)
        assert.throws(() => dsp.process([new Float32Array(inputHop)], inputHop))
      }
    }
  }
})

test('short nonzero input is zero padded to a hop without changing caller samples', () => {
  const config = parameters({ window: 64 }),
    short = new PhaseVocoderDsp(1, config),
    padded = new PhaseVocoderDsp(1, config),
    inputHop = short.inputHop
  for (let call = 0; call < 12; call++) {
    const count = call === 3 || call === 8 ? 1 : inputHop,
      input = tone(count, 900, call * 0.3),
      original = input.slice(),
      full = new Float32Array(inputHop)
    full.set(input)
    const a = short.process([input], count),
      b = padded.process([full], inputHop)
    assert.deepEqual(input, original)
    assert.equal(a === null, b === null)
    assert.equal(a === null, call < 3)
    if (a && b) {
      assert.equal(a.frames, b.frames)
      assert.deepEqual(a.data[0]!.slice(0, a.frames), b.data[0]!.slice(0, b.frames))
    }
  }
})

test('unit pitch and time still apply the Vorbis-I window and discard the Nyquist bin', () => {
  const size = 64,
    config = parameters({ window: size }),
    impulse = new Float32Array(size)
  impulse[0] = 1
  const output = collect(new PhaseVocoderDsp(1, config), [impulse]).data[0]!,
    window = (n: number) => Math.sin((Math.PI / 2) * Math.sin((Math.PI * (n + 0.5)) / size) ** 2),
    firstWindow = window(0)
  assert.equal(output.length, 16)
  for (let n = 0; n < output.length; n++) {
    // Removing the Nyquist component from a windowed impulse leaves this analytic inverse.
    const inverse = firstWindow * ((n === 0 ? 1 : 0) - (n % 2 ? -1 : 1) / size),
      expected = inverse * window(n) * (2 / config.overlap)
    near(output[n]!, expected, 1e-10, `windowed impulse[${n}]`)
  }
  assert.ok(output[0]! > 0 && output[0]! < 0.001, 'unit parameters do not bypass the DSP')
})

test('channels have independent phase histories and no silent-channel crosstalk', () => {
  const config = parameters({ pitch: 1.5, time: 1.3 }),
    left = tone(16384, 750),
    right = tone(16384, 1200, 0.8),
    stereo = collect(new PhaseVocoderDsp(2, config), [left, right]),
    monoLeft = collect(new PhaseVocoderDsp(1, config), [left]),
    monoRight = collect(new PhaseVocoderDsp(1, config), [right]),
    isolated = collect(new PhaseVocoderDsp(2, config), [left, new Float32Array(left.length)])
  assert.deepEqual(stereo.data[0], monoLeft.data[0])
  assert.deepEqual(stereo.data[1], monoRight.data[0])
  assert.deepEqual(isolated.data[0], monoLeft.data[0])
  assert.ok(isolated.data[1]!.every((sample) => sample === 0))
  near(dominantFrequency(stereo.data[0]!), 1125, 11.25, 'left spectrum')
  near(dominantFrequency(stereo.data[1]!), 1800, 18, 'right spectrum')
})

test('window changes remain pending until lazy initialization or reset', () => {
  const dsp = new PhaseVocoderDsp(1, parameters({ window: 64 }))
  assert.equal(dsp.initialized, false)
  assert.equal(dsp.ended, false)
  dsp.configure(parameters({ window: 128 }))
  assert.equal(dsp.window, 128)
  const firstHop = dsp.inputHop
  assert.equal(firstHop, 32)
  assert.equal(dsp.process([new Float32Array(firstHop)], firstHop), null)
  assert.equal(dsp.initialized, true)
  dsp.configure(parameters({ window: 256 }))
  assert.equal(dsp.window, 128)
  assert.equal(dsp.inputHop, firstHop)
  dsp.reset()
  assert.equal(dsp.initialized, false)
  assert.equal(dsp.ended, false)
  assert.equal(dsp.window, 256)
  assert.equal(dsp.inputHop, 64)
  const input = tone(4096, 1200),
    resetOutput = collect(dsp, [input]),
    freshOutput = collect(new PhaseVocoderDsp(1, parameters({ window: 256 })), [input])
  assert.deepEqual(resetOutput.data, freshOutput.data)
  dsp.reset()
  assert.equal(dsp.ended, false)
  assert.deepEqual(
    collect(dsp, [input]).data,
    freshOutput.data,
    'EOF reset clears phase and overlap',
  )
})

test('live pitch/time/overlap updates change subsequent hops without rebuilding the window', () => {
  const dsp = new PhaseVocoderDsp(1, parameters()),
    original = tone(16384, 750)
  for (let cursor = 0; cursor < original.length; cursor += dsp.inputHop)
    dsp.process([original.subarray(cursor, cursor + dsp.inputHop)], dsp.inputHop)
  dsp.configure(parameters({ window: 2048, overlap: 8, pitch: 2, time: 1.5 }))
  assert.equal(dsp.initialized, true)
  assert.equal(dsp.window, 1024)
  assert.equal(dsp.inputHop, 128)
  assert.equal(dsp.outputHop, 192)
  const changed = collect(dsp, [tone(32768, 750)])
  near(dominantFrequency(changed.data[0]!, 4096), 1500, 15, 'updated pitch at updated time')
  // 768 buffered frames + 256 new input hops: one priming call, then 255 output hops.
  assert.equal(changed.hops, 255)
  assert.equal(changed.frames, 48960)
  dsp.reset()
  assert.equal(dsp.window, 2048)
  assert.equal(dsp.inputHop, 256)
  assert.equal(dsp.outputHop, 384)
})

test('increasing the live output hop clears its whole newly exposed overlap tail', () => {
  const config = parameters({ window: 64, overlap: 4, pitch: 1, time: 1 }),
    dsp = new PhaseVocoderDsp(1, config),
    first = new Float32Array(16),
    silence = new Float32Array(16)
  // The first analysis window has support only in the first input hop. Its
  // Nyquist removal leaves an overlap tail even after that hop is consumed.
  first[15] = 1
  assert.equal(dsp.process([first], 16), null)
  assert.equal(dsp.process([silence], 16), null)
  assert.equal(dsp.process([silence], 16), null)
  const initial = dsp.process([silence], 16)
  assert.ok(initial)
  assert.equal(initial.frames, 16)
  assert.ok(initial.data[0]!.subarray(0, initial.frames).some((sample) => Math.abs(sample) > 0.01))

  dsp.configure({ ...config, time: 4 })
  assert.equal(dsp.inputHop, 16)
  assert.equal(dsp.outputHop, 64)
  const expanded = dsp.process([silence], 16)
  assert.ok(expanded)
  assert.equal(expanded.frames, 64)
  // The next analysis window contains only zeros, while Ho=N exposes the full
  // output window. Native Process clears that entire interval before adding the
  // zero reconstruction, so no previous-window residual may remain.
  assert.ok(expanded.data[0]!.subarray(0, expanded.frames).every((sample) => sample === 0))
})

test('bounded repeated processing remains finite for silence, DC, Nyquist and impulses', () => {
  const config = parameters({ window: 64, overlap: 4, pitch: 0.75, time: 1.3 }),
    dsp = new PhaseVocoderDsp(4, config),
    input = [
      new Float32Array(16),
      new Float32Array(16).fill(0.1),
      new Float32Array(16),
      new Float32Array(16),
    ]
  for (let i = 0; i < 16; i++) input[2]![i] = i % 2 ? -0.1 : 0.1
  input[3]![0] = 0.2
  let produced = 0,
    borrowed: Float32Array[] | undefined
  for (let call = 0; call < 8192; call++) {
    const hop = dsp.process(input, 16)
    assert.equal(dsp.bufferedFrames, Math.min((call + 1) * 16, config.window - 16))
    if (!hop) continue
    assert.equal(hop.frames, 20)
    assert.equal(hop.inputFrames, 16)
    if (borrowed) {
      for (let channel = 0; channel < 4; channel++)
        assert.equal(hop.data[channel], borrowed[channel], 'the same output arrays are borrowed')
    }
    borrowed ??= [...hop.data]
    for (let channel = 0; channel < 4; channel++) {
      assert.ok(hop.data[channel]!.length <= config.window)
      for (const sample of hop.data[channel]!.subarray(0, hop.frames))
        assert.ok(Number.isFinite(sample) && Math.abs(sample) < 2, `bounded PCM ${sample}`)
    }
    assert.ok(hop.data[0]!.subarray(0, hop.frames).every((sample) => sample === 0))
    produced++
  }
  assert.equal(produced, 8192 - 4 + 1)
  assert.equal(dsp.process(input, 0), null)
})

test('invalid processing shapes and failed parameter updates cannot corrupt a live DSP', () => {
  const config = parameters({ window: 64 }),
    dsp = new PhaseVocoderDsp(1, config),
    pristine = new PhaseVocoderDsp(1, config),
    input = tone(16, 750)
  for (let i = 0; i < 8; i++) {
    const actual = dsp.process([input], 16),
      expected = pristine.process([input], 16)
    assert.equal(actual === null, expected === null)
    if (actual && expected)
      assert.deepEqual(
        actual.data[0]!.slice(0, actual.frames),
        expected.data[0]!.slice(0, expected.frames),
      )
  }
  assert.throws(() => dsp.process([input], -1))
  assert.throws(() => dsp.process([input], 1.5))
  assert.throws(() => dsp.process([input], NaN))
  assert.throws(() => dsp.process([input], Infinity))
  assert.throws(() => dsp.process([new Float32Array(17)], 17))
  assert.throws(() => dsp.process([], 16))
  assert.throws(() => dsp.process([input, input], 16))
  assert.throws(() => dsp.process([new Float32Array(15)], 16))
  for (const invalid of [NaN, Infinity, -Infinity]) {
    const nonfinite = input.slice()
    nonfinite[15] = invalid
    assert.throws(() => dsp.process([nonfinite], 16))
  }
  assert.throws(() => dsp.configure(parameters({ window: 65 })))
  assert.throws(() => dsp.configure(parameters({ window: 64, pitch: 0 })))
  // A pending larger N admits this time, but the current N would produce a zero hop.
  assert.throws(() => dsp.configure(parameters({ window: 1024, time: 0.01 })))
  assert.equal(dsp.window, 64)
  assert.equal(dsp.inputHop, 16)
  assert.equal(dsp.outputHop, 16)
  const source = tone(2048, 750),
    actual = collect(dsp, [source]),
    expected = collect(pristine, [source])
  assert.deepEqual(actual.data, expected.data)
})
