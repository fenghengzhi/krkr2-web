import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { waveUse3dOption, waveSpatialGains } from '../../src/engine/media/wave-spatial.ts'
import { defaultSoundSettings, type StreamingPcmAsset } from '../../src/engine/ports/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midi } from '../helpers/audio.ts'
import { speakerWave } from '../helpers/wave-speakers.ts'
import { spatialFiles, spatialRows } from '../helpers/wave-spatial.ts'

test('native 3D option and default listener distances have explicit stereo direction and attenuation', () => {
  assert.equal(waveUse3dOption(undefined), false); assert.equal(waveUse3dOption('no'), false)
  for (const option of ['yes', '', 'NO', 'false']) assert.equal(waveUse3dOption(option), true)
  const center = Math.SQRT1_2
  for (const [position, expected] of [
    [[0, 0, 0], [center, center]], [[-1, 0, 0], [1, 0]], [[1, 0, 0], [0, 1]],
    [[0, 0, 1], [center, center]], [[0, 0, -1], [center, center]],
    [[0, 2, 0], [center / 2, center / 2]], [[0, 0, 4], [center / 4, center / 4]],
    [[2e9, 0, 0], [0, 1e-9]],
  ] as const) assert.deepEqual(waveSpatialGains(position), expected)
  const high = waveSpatialGains([1, 1, 0])
  assert(Math.abs(high[0] - Math.sqrt(.25) / Math.SQRT2) < 1e-15)
  assert(Math.abs(high[1] - Math.sqrt(.75) / Math.SQRT2) < 1e-15)
})

test('full and streamed spatial Wave keeps audible SLI frames while positions, pause, stereo fallback and replay change output', () => {
  const files = spatialFiles()
  for (const channels of [1, 2]) for (const streamed of [false, true]) {
    const pcm = decodeWav(files[channels === 1 ? 'spatial-mono.wav' : 'spatial-stereo.wav'])!
    pcm.loops = parseSliBytes(files['spatial-mono.wav.sli'])
    const stream: StreamingPcmAsset = { ...pcm, kind: 'stream', streamId: 1,
      initial: [0, 4096, 8192].map((position) => ({ position, data: pcm.data.map((plane) => plane.slice(position, position + 4096)) })) },
      mixer = new AudioMixer(1000), left = new Float32Array(40), right = new Float32Array(40),
      settings = { ...defaultSoundSettings(), waveUse3d: true }
    try {
      mixer.command({ op: 'load', id: 1, kind: 'wave', settings, asset: streamed ? stream : pcm })
      mixer.command({ op: 'set', id: 1, property: 'position', value: 8188 }); mixer.command({ op: 'play', id: 1 })
      const before = mixer.snapshot(1)
      for (const [position, gains] of [[[-1, 0, 0], [1, 0]], [[1, 0, 0], [0, 1]],
        [[0, 0, 4], [Math.SQRT1_2 / 4, Math.SQRT1_2 / 4]]] as const) {
        const at = mixer.snapshot(1).position
        mixer.command({ op: 'wavePosition', id: 1, position })
        assert.equal(mixer.snapshot(1).position, at); assert.equal(mixer.snapshot(1).epoch, before.epoch)
        const events = mixer.render(left, right), expected = gains.map((gain) => Float32Array.from({ length: 40 }, (_, frame) => {
          const row = spatialRows[(at + frame) % 4]!, mono = channels === 1 ? row[0] : (row[0] + row[1]) / 2
          return gain ? mono * gain : 0
        }))
        assert.deepEqual(left, expected[0]); assert.deepEqual(right, expected[1])
        assert(events.some((event) => event.type === 'label' && event.label === 'phrase'))
        assert(!events.some((event) => event.type === 'error'))
      }
      assert.equal(mixer.snapshot(1).channels, 1); assert.equal(mixer.snapshot(1).bits, 16)
      mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
      const paused = mixer.snapshot(1).position
      mixer.command({ op: 'wavePosition', id: 1, position: [-1, 0, 0] }); mixer.render(left, right)
      assert(left.every((value) => value === 0)); assert(right.every((value) => value === 0))
      assert.equal(mixer.snapshot(1).position, paused)
      mixer.command({ op: 'set', id: 1, property: 'position', value: 8204 })
      mixer.command({ op: 'set', id: 1, property: 'paused', value: false }); mixer.render(left, right)
      assert.deepEqual([...left], [...spatialRows.map((row) => channels === 1 ? row[0] : (row[0] + row[1]) / 2), ...Array(36).fill(0)])
      assert(right.every((value) => value === 0)); assert.equal(mixer.snapshot(1).status, 'stop')
      mixer.command({ op: 'play', id: 1 }); mixer.render(left, right)
      assert.equal(mixer.snapshot(1).position, 40); assert(left.some((value) => value !== 0))
      assert(right.every((value) => value === 0))
    } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspectStreams().bytes, 0) }
  }
})

test('spatial mode preserves explicit layouts, legacy defaults, MIDI/CDDA and the existing filtered source pipeline', () => {
  for (const [kind, rows, mask] of [
    ['wave', [[.125, .375]], 3], ['wave', [[.125]], 4],
    ['wave', [[.125, .25, .375, -.125]], undefined], ['cdda', [[.125, .375]], undefined],
  ] as const) {
    const asset = decodeWav(speakerWave(rows, { frames: 32, ...(mask === undefined ? {} : { mask }) }))!, outputs = []
    for (const option of [false, true]) {
      const mixer = new AudioMixer(1000), left = new Float32Array(20), right = new Float32Array(20)
      try {
        mixer.command({ op: 'load', id: 1, kind, asset, settings: { ...defaultSoundSettings(), waveUse3d: option, wavePosition: [-4, 0, 0] } })
        mixer.command({ op: 'play', id: 1 }); mixer.render(left, right)
        assert.equal(mixer.snapshot(1).waveSpatial, undefined); outputs.push([left, right])
      } finally { mixer.command({ op: 'shutdown' }) }
    }
    assert.deepEqual(outputs[1], outputs[0])
  }
  const score = decodeMidi(midi([[0, 0x90, 69, 100, 100, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100)), outputs = []
  for (const option of [false, true]) {
    const mixer = new AudioMixer(44100), left = new Float32Array(4410), right = new Float32Array(4410)
    try {
      mixer.command({ op: 'load', id: 1, kind: 'midi', asset: score, settings: { ...defaultSoundSettings(), waveUse3d: option } })
      mixer.command({ op: 'play', id: 1 }); mixer.render(left, right); outputs.push([left, right])
    } finally { mixer.command({ op: 'shutdown' }) }
  }
  assert.deepEqual(outputs[1], outputs[0])
  const pcm = decodeWav(spatialFiles()['spatial-mono.wav'])!, filtered = []
  for (const option of [false, true]) {
    const mixer = new AudioMixer(1000), left = new Float32Array(1000), right = new Float32Array(1000)
    try {
      mixer.command({ op: 'load', id: 1, kind: 'wave', asset: pcm,
        settings: { ...defaultSoundSettings(), waveUse3d: option, wavePosition: [-1, 0, 0] },
        filters: [{ type: 'phase-vocoder', id: 1, window: 256, overlap: 4, pitch: 1.25, time: 1 }] })
      mixer.command({ op: 'play', id: 1 }); const events = mixer.render(left, right)
      assert(!events.some((event) => event.type === 'error')); assert(left.some((value) => value !== 0))
      if (option) assert(right.every((value) => value === 0))
      filtered.push(left)
    } finally { mixer.command({ op: 'shutdown' }) }
  }
  assert.deepEqual(filtered[1], filtered[0], 'spatial output follows the same filtered mono PCM')
})
