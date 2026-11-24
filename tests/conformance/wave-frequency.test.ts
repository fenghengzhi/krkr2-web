import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset } from '../../src/engine/ports/audio.ts'

test('original-frequency Wave sentinel reaches resident PCM and a connected phase-vocoder without changing other sound kinds', () => {
  const asset: PcmAsset = { kind: 'pcm', channels: 1, bits: 16, sampleRate: 8000, sampleCount: 4096,
    data: [Float32Array.from({ length: 4096 }, (_, i) => [0.125, -0.25, 0.375, -0.5][i % 4]!)],
    loops: { labels: [], links: [] } }
  for (const filtered of [false, true]) {
    const control = new AudioMixer(8000), reset = new AudioMixer(8000),
      filters = filtered ? [{ type: 'phase-vocoder' as const, id: 1, window: 256, overlap: 4, pitch: 1, time: 1 }] : []
    for (const [mixer, frequency] of [[control, 8000], [reset, 0]] as const) {
      mixer.command({ op: 'load', id: 1, kind: 'wave', asset, settings: defaultSoundSettings(), filters })
      mixer.command({ op: 'set', id: 1, property: 'frequency', value: 16000 })
      mixer.command({ op: 'set', id: 1, property: 'frequency', value: frequency })
      mixer.command({ op: 'play', id: 1 })
    }
    const expected = new Float32Array(2048), expectedRight = new Float32Array(2048),
      actual = new Float32Array(2048), actualRight = new Float32Array(2048)
    assert.deepEqual(reset.render(actual, actualRight), control.render(expected, expectedRight))
    assert.deepEqual(actual, expected); assert.deepEqual(actualRight, expectedRight)
    if (!filtered) assert.deepEqual([...actual], Array.from({ length: 2048 }, (_, i) => [0.125, -0.25, 0.375, -0.5][i % 4]!))
    assert(actual.some((value) => value !== 0))
    assert.equal(reset.snapshot(1).frequency, 0)
    assert.equal(reset.snapshot(1).position, control.snapshot(1).position)
    assert(reset.snapshot(1).position > 1000)
    for (const mixer of [control, reset]) { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
  }
  const mixer = new AudioMixer(8000)
  for (const kind of ['midi', 'cdda'] as const) {
    mixer.command({ op: 'create', id: 1, kind, settings: defaultSoundSettings() })
    assert.throws(() => mixer.command({ op: 'set', id: 1, property: 'frequency', value: 0 }), /Playback frequency is outside range/)
    mixer.command({ op: 'close', id: 1 })
  }
})
