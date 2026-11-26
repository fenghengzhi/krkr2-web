import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { HeadlessAudioBackend } from '../../src/backends/audio/headless.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { convertWaveOutput, waveConversionOption } from '../../src/engine/media/wave-output.ts'
import { defaultSoundSettings, type PcmAsset, type StreamingPcmAsset, type WaveConversion } from '../../src/engine/ports/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { outputFrames, outputMono, outputS32Wave, waveOutputFiles } from '../helpers/wave-output.ts'
import { AudioClock, settleAudioPages } from '../helpers/audio.ts'

test('forced Wave output follows integer narrow-before-average and scalar float clipping/rounding', () => {
  const integers = outputFrames[0].map((_, channel) => Float32Array.from(outputFrames, (frame) => frame[channel]! / 32768))
  convertWaveOutput(integers, 4, 'i16m', 's16')
  assert.deepEqual([...integers[0]!], outputMono.map((value) => value / 32768))
  const s24 = [Float32Array.from([255, -1, 511, -257], (value) => value / 8388608), new Float32Array(4)]
  convertWaveOutput(s24, 4, 'i16m', 's24')
  assert.deepEqual([...s24[0]!], [0, 0, 0, -1 / 32768])
  const floats = [Float32Array.from([1.5, -1.5, .5 / 32768, -.5 / 32768])]
  convertWaveOutput(floats, 4, 'i16', 'f32')
  assert.deepEqual([...floats[0]!], [32767 / 32768, -1, 1 / 32768, -1 / 32768])
  const mix = [Float32Array.from([1, 1, 1 / 32768, -1 / 32768]), Float32Array.from([-1, 1, 0, 0])]
  convertWaveOutput(mix, 4, 'i16m', 'f32')
  assert.deepEqual([...mix[0]!], [0, 32767 / 32768, 1 / 32768, -1 / 32768])
  assert.equal(waveConversionOption('i16'), 'i16'); assert.equal(waveConversionOption('i16m'), 'i16m')
  for (const value of [undefined, '', 'I16M', 'i16m ', 'none']) assert.equal(waveConversionOption(value), undefined)
})

function player(asset: PcmAsset | StreamingPcmAsset, mode?: WaveConversion, filtered = false) {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, kind: 'wave', asset, settings: { ...defaultSoundSettings(), ...(mode ? { waveConversion: mode } : {}) },
    filters: filtered ? [{ type: 'phase-vocoder', id: 4, window: 256, overlap: 4, pitch: 1.25, time: 1 }] : [] })
  return mixer
}
const render = (mixer: AudioMixer, frames: number) => {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  assert(left.every(Number.isFinite)); assert(right.every(Number.isFinite)); return { left, right, events }
}

test('full and streamed Wave mono conversion preserve the source-frame SLI loop, pause and seeked tail', () => {
  const files = waveOutputFiles(), decoded = decodeWav(files['output.wav'])!
  decoded.loops = parseSliBytes(files['output.wav.sli'])
  const stream: StreamingPcmAsset = { ...decoded, kind: 'stream', streamId: 3,
    initial: [{ position: 0, data: decoded.data.map((plane) => plane.slice(0, 4096)) },
      { position: 4096, data: decoded.data.map((plane) => plane.slice(4096, 8192)) },
      { position: 8192, data: decoded.data.map((plane) => plane.slice(8192)) }] }
  for (const asset of [decoded, stream]) {
    const mixer = player(asset, 'i16m')
    try {
      mixer.command({ op: 'set', id: 1, property: 'position', value: 4088 }); mixer.command({ op: 'play', id: 1 })
      const heard = render(mixer, 40), expected = Float32Array.from({ length: 40 }, (_, at) => outputMono[at % 4]! / 32768)
      assert.deepEqual(heard.left, expected); assert.deepEqual(heard.right, expected)
      assert.equal(mixer.snapshot(1).channels, 1); assert.equal(mixer.snapshot(1).bits, 16)
      assert.equal(mixer.snapshot(1).position, 4096)
      assert.deepEqual(heard.events.filter((event) => event.type === 'label').map((event) => event.type === 'label' ? event.label : ''), ['loop', 'loop'])
      mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
      assert(render(mixer, 20).left.every((value) => value === 0)); assert.equal(mixer.snapshot(1).position, 4096)
      mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
      mixer.command({ op: 'set', id: 1, property: 'position', value: 8200 })
      const tail = render(mixer, 20)
      assert.deepEqual([...tail.left], [...expected.slice(0, 8), ...Array(12).fill(0)])
      assert.deepEqual(tail.right, tail.left); assert.equal(mixer.snapshot(1).status, 'stop')
    } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
  }
})

test('16-bit output conversion happens after the real phase vocoder and before fractional playback interpolation', () => {
  const asset = decodeWav(waveOutputFiles()['output-float.wav'])!, ordinary = player(asset, undefined, true), converted = player(asset, 'i16', true)
  try {
    ordinary.command({ op: 'play', id: 1 }); converted.command({ op: 'play', id: 1 })
    const raw = render(ordinary, 5000), actual = render(converted, 5000)
    for (const [input, output] of [[raw.left, actual.left], [raw.right, actual.right]] as const) {
      const expected = Float32Array.from(input, (value) => {
        const integer = Math.trunc(value * 32768 + (value > 0 ? .5 : -.5))
        return integer === 0 ? 0 : integer / 32768
      })
      assert.notDeepEqual(input, expected); assert.deepEqual(output, expected)
    }
    assert.equal(converted.snapshot(1).bits, 16); assert.equal(ordinary.snapshot(1).bits, 32)
  } finally { ordinary.command({ op: 'shutdown' }); converted.command({ op: 'shutdown' }) }

  const asset2: PcmAsset = { kind: 'pcm', channels: 1, sampleCount: 4, sampleRate: 1000, bits: 32, pcmEncoding: 'f32',
    loops: { links: [], labels: [] }, data: [Float32Array.from([.4, 1.4, 2.4, 3.4], (value) => value / 32768)] }, mixer = player(asset2, 'i16')
  try {
    mixer.command({ op: 'set', id: 1, property: 'frequency', value: 500 }); mixer.command({ op: 'play', id: 1 })
    assert.deepEqual([...render(mixer, 6).left], [0, .5, 1, 1.5, 2, 2.5].map((value) => value / 32768))
  } finally { mixer.command({ op: 'shutdown' }) }
})

test('forced buffered and range WAV output preserves signed 32-bit high words before Float32 normalization', async () => {
  const bytes = outputS32Wave(), source = { size: bytes.length, read: async (at: number, length: number) => bytes.slice(at, at + length) },
    highWords = [16384, -16385, 32767, -1], mono = [8192, -8192, 16383, 0]
  // Default readers retain their existing full Float32 precision; the explicit
  // direct-output policy fixes exactly the adjacent-i16-bin rounding loss.
  const ordinary = decodeWav(bytes)!, narrowed = decodeWav(bytes, { narrowS32: true })!
  assert.equal(ordinary.data[0]![0], Math.fround(0x4000ffff / 2147483648))
  assert.equal(ordinary.data[0]![1], -.5)
  assert.notEqual(ordinary.data[0]![0], narrowed.data[0]![0])
  assert.notEqual(ordinary.data[0]![1], narrowed.data[0]![1])
  const reader = await openPortablePcmSource(source)
  assert(reader)
  try { assert.deepEqual((await reader.read(4094, 8))[0], ordinary.data[0]!.slice(4094, 4102)) }
  finally { await reader.close() }
  for (const streamed of [false, true]) for (const mode of ['i16', 'i16m'] as const) {
    const clock = new AudioClock(), output: number[][] = [[], []], failures: unknown[] = [],
      audio = new HeadlessAudioBackend({ now: () => clock.now, schedule: clock.schedule },
        (l, r) => { output[0]!.push(...l); output[1]!.push(...r) }, 1000), settings = { ...defaultSoundSettings(), waveConversion: mode }
    let released = 0
    try {
      const common = { id: 1, kind: 'wave' as const, loops: { links: [], labels: [] }, settings }
      await audio.command(streamed ? { ...common, op: 'openSource', source, bufferedBytes: 0, releaseSource: () => { released++ } }
        : { ...common, op: 'open', bytes })
      await audio.command({ op: 'set', id: 1, property: 'position', value: 4092 })
      await audio.command({ op: 'play', id: 1 }); await settleAudioPages(audio); clock.advance(20)
      await audio.command({ op: 'inspect', id: 1 })
      const left = Array.from({ length: 20 }, (_, at) => (mode === 'i16m' ? mono : highWords)[at % 4]! / 32768)
      assert.deepEqual(output, [left, mode === 'i16m' ? left : Array(20).fill(0)])
    } catch (error) { failures.push(error) }
    try { await audio.close(); assert.equal(released, streamed ? 1 : 0); assert.equal(clock.tasks.size, 0) }
    catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 's32 Wave conversion or cleanup failed', { cause: failures[0] })
  }
})
