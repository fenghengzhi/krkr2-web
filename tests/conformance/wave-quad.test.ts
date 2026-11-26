import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { waveExpandQuadOption } from '../../src/engine/media/wave-output.ts'
import { defaultSoundSettings, type StreamingPcmAsset, type WaveConversion } from '../../src/engine/ports/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { quadFiles, quadRows, quadGain } from '../helpers/wave-quad.ts'
import { speakerWave } from '../helpers/wave-speakers.ts'
import { midi } from '../helpers/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'

test('quad startup uses exact yes and the original 3D option suppression; ordinary defaults remain disabled', () => {
  for (const option of [undefined, '', 'no', 'YES', 'yes ', 'true']) assert.equal(waveExpandQuadOption(option, undefined), false)
  assert.equal(waveExpandQuadOption('yes', undefined), true)
  assert.equal(waveExpandQuadOption('yes', 'no'), true)
  for (const use3d of ['', 'yes', 'NO', 'false']) assert.equal(waveExpandQuadOption('yes', use3d), false)
})

test('full and streamed mono/stereo expand after conversion without changing SLI source frames, pause or the seeked tail', () => {
  const files = quadFiles()
  for (const channels of [1, 2]) for (const streamed of [false, true]) for (const conversion of [undefined, 'i16', 'i16m'] as const) {
    const pcm = decodeWav(files[channels === 1 ? 'quad-mono.wav' : 'quad-stereo.wav'])!
    pcm.loops = parseSliBytes(files['quad-stereo.wav.sli'])
    const stream: StreamingPcmAsset = { ...pcm, kind: 'stream', streamId: 1,
      initial: [0, 4096, 8192].map((position) => ({ position, data: pcm.data.map((plane) => plane.slice(position, position + 4096)) })) },
      mixer = new AudioMixer(1000), left = new Float32Array(40), right = new Float32Array(40),
      settings = { ...defaultSoundSettings(), waveExpandQuad: true, ...(conversion ? { waveConversion: conversion as WaveConversion } : {}) }
    try {
      mixer.command({ op: 'load', id: 1, kind: 'wave', settings, asset: streamed ? stream : pcm })
      mixer.command({ op: 'set', id: 1, property: 'position', value: 8188 }); mixer.command({ op: 'play', id: 1 })
      const events = mixer.render(left, right), mono = conversion === 'i16m',
        expected = [0, 1].map((channel) => Float32Array.from({ length: 40 }, (_, at) => {
          const row = quadRows[(8188 + at) % 8]!, value = mono ? channels === 1 ? row[0] : (row[0] + row[1]) / 2
            : row[channels === 1 ? 0 : channel]!
          return value === 0 ? 0 : value * (mono ? 1 : quadGain)
        }))
      assert.deepEqual(left, expected[0]); assert.deepEqual(right, expected[1])
      assert.equal(mixer.snapshot(1).channels, mono ? 1 : 4); assert.equal(mixer.snapshot(1).position, 8196)
      assert.deepEqual(events.flatMap((event) => event.type === 'label' ? [event.label] : []), ['phrase', 'phrase', 'phrase'])
      mixer.command({ op: 'set', id: 1, property: 'paused', value: true }); mixer.render(left, right)
      assert(left.every((value) => value === 0)); assert(right.every((value) => value === 0)); assert.equal(mixer.snapshot(1).position, 8196)
      mixer.command({ op: 'set', id: 1, property: 'position', value: 8204 })
      mixer.command({ op: 'set', id: 1, property: 'paused', value: false }); mixer.render(left, right)
      assert.deepEqual([...left], [...expected[0]!.slice(0, 4), ...Array(36).fill(0)])
      assert.deepEqual([...right], [...expected[1]!.slice(0, 4), ...Array(36).fill(0)])
      assert.equal(mixer.snapshot(1).status, 'stop'); assert.equal(mixer.snapshot(1).position, 0)
    } finally { mixer.command({ op: 'shutdown' }) }
  }
  // Independent four-plane input: running the same per-channel filter on
  // L/R/L/R must match duplication after the ordinary stereo filter output.
  const source = decodeWav(files['quad-stereo.wav'])!, ordinary = new AudioMixer(1000), expanded = new AudioMixer(1000),
    four = { ...source, channels: 4, speakerMask: 0x33,
      data: [source.data[0]!, source.data[1]!, source.data[0]!, source.data[1]!] },
    filtered: Float32Array[][] = []
  try {
    for (const [mixer, asset, option] of [[ordinary, four, false], [expanded, source, true]] as const) {
      mixer.command({ op: 'load', id: 1, kind: 'wave', asset, settings: { ...defaultSoundSettings(), waveExpandQuad: option },
        filters: [{ type: 'phase-vocoder', id: 1, window: 256, overlap: 4, pitch: 1.25, time: 1 }] })
      mixer.command({ op: 'play', id: 1 })
      const left = new Float32Array(1000), right = new Float32Array(1000), events = mixer.render(left, right)
      assert(!events.some((event) => event.type === 'error')); assert(left.some((value) => value !== 0))
      filtered.push([left, right])
    }
    assert.deepEqual(filtered[1], filtered[0])
    assert.equal(expanded.snapshot(1).position, ordinary.snapshot(1).position)
  } finally { ordinary.command({ op: 'shutdown' }); expanded.command({ op: 'shutdown' }) }
})

test('explicit WAVE layouts, ordinary multichannel sound and CDDA keep their declared routing under the quad option', () => {
  for (const [kind, rows, mask, expected] of [
    ['wave', [[.125, -.25]], 3, [.125, -.25]],
    ['wave', [[.125]], 4, [.125, .125]],
    ['wave', [[.125, -.25, .25, -.125]], undefined, [.125 + .25 * .70710678, -.25 - .125 * .70710678]],
    ['cdda', [[.125, -.25]], undefined, [.125, -.25]],
  ] as const) {
    const asset = decodeWav(speakerWave(rows, { frames: 32, ...(mask === undefined ? {} : { mask }) }))!, mixer = new AudioMixer(1000),
      left = new Float32Array(20), right = new Float32Array(20)
    try {
      mixer.command({ op: 'load', id: 1, kind, asset, settings: { ...defaultSoundSettings(), waveExpandQuad: true } })
      mixer.command({ op: 'play', id: 1 }); mixer.render(left, right)
      assert.deepEqual(left, new Float32Array(20).fill(expected[0])); assert.deepEqual(right, new Float32Array(20).fill(expected[1]))
      assert.equal(mixer.snapshot(1).channels, rows[0].length)
    } finally { mixer.command({ op: 'shutdown' }) }
  }
  const baseline = new AudioMixer(44100), expanded = new AudioMixer(44100),
    score = decodeMidi(midi([[0, 0x90, 69, 100, 100, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100)),
    outputs: Float32Array[] = []
  try {
    for (const [mixer, option] of [[baseline, false], [expanded, true]] as const) {
      mixer.command({ op: 'load', id: 1, kind: 'midi', asset: score, settings: { ...defaultSoundSettings(), waveExpandQuad: option } })
      mixer.command({ op: 'play', id: 1 })
      const left = new Float32Array(4410), right = new Float32Array(4410); mixer.render(left, right)
      assert.deepEqual(left, right); assert(left.some((value) => value !== 0)); outputs.push(left)
      assert.equal(mixer.snapshot(1).channels, 2)
    }
    assert.deepEqual(outputs[1], outputs[0], 'Wave expansion never changes a MIDI voice')
  } finally { baseline.command({ op: 'shutdown' }); expanded.command({ op: 'shutdown' }) }
})
