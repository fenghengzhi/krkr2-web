import test from 'node:test'
import assert from 'node:assert/strict'
import { waveCombinedVolume, waveAudioGains } from '../../src/engine/media/wave-audio.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, emptyLoops, type PcmAsset } from '../../src/engine/ports/audio.ts'
import { waveGainCases, waveGainSamples } from '../helpers/wave-gain.ts'

const pcm: PcmAsset = { kind: 'pcm', sampleRate: 1000, sampleCount: 1000, channels: 2, bits: 16,
  loops: emptyLoops(), data: [new Float32Array(1000).fill(0.5), new Float32Array(1000).fill(-0.25)] }
const render = (mixer: AudioMixer, count: number) => {
  const left = new Float32Array(count), right = new Float32Array(count), events = mixer.render(left, right)
  return { left: [...left], right: [...right], events }
}

test('Wave volume combines native truncated integers before the one-percent attenuation lookup', () => {
  assert.equal(waveCombinedVolume(100000, 100000, 100000), 100000)
  assert.equal(waveCombinedVolume(80009, 75009, 50009), 30000)
  assert.equal(waveCombinedVolume(2009, 99999, 100000), 1990)
  assert.equal(waveCombinedVolume(50009, 99999, 40009), 19990)
  assert.equal(waveCombinedVolume(99999, 99999, 99999), 99970)
  assert.equal(waveCombinedVolume(100000, 100000, 100000, true), 0)
  assert.deepEqual(waveAudioGains(2009, 99999, 100000, 0), { left: 0, right: 0 })
})

test('actual Wave PCM uses literal native attenuation on each channel for volume, pan and global controls', () => {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, kind: 'wave', asset: pcm, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  for (const row of waveGainCases) {
    const [volume, volume2, globalVolume, pan] = row.stored ?? [row.volume, row.volume2, row.globalVolume, row.pan]
    mixer.command({ op: 'set', id: 1, property: 'volume', value: volume! })
    mixer.command({ op: 'set', id: 1, property: 'volume2', value: volume2! })
    mixer.command({ op: 'set', id: 1, property: 'pan', value: pan! })
    mixer.command({ op: 'globalVolume', volume: globalVolume! })
    const output = render(mixer, 7), expected = waveGainSamples(row)
    assert.deepEqual(output.left, Array(7).fill(expected[0]), row.name)
    assert.deepEqual(output.right, Array(7).fill(expected[1]), row.name)
    assert.deepEqual(output.events, [])
  }
  mixer.command({ op: 'close', id: 1 }); assert.equal(mixer.inspect().voices, 0)
})

test('Wave attenuation updates on the exact fade sample and focus mute does not stop its source clock', () => {
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, asset: pcm, settings: defaultSoundSettings(), kind: 'wave' })
  mixer.command({ op: 'play', id: 1 }); mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
  const output = render(mixer, 120), gain = 10 ** (-1505 / 2000)
  assert.deepEqual(output.left, [...Array(59).fill(0.5), ...Array(60).fill(Math.fround(0.5 * gain)), 0])
  assert.deepEqual(output.right, [...Array(59).fill(-0.25), ...Array(60).fill(Math.fround(-0.25 * gain)), 0])
  assert.equal(output.events.length, 1); assert.equal(output.events[0]?.type, 'fade')
  mixer.command({ op: 'set', id: 1, property: 'volume', value: 100000 })
  mixer.command({ op: 'waveMuted', muted: true })
  assert.deepEqual(render(mixer, 20).left, Array(20).fill(0))
  assert.equal(mixer.snapshot(1).position, 140)
  mixer.command({ op: 'waveMuted', muted: false })
  assert.deepEqual(render(mixer, 20).right, Array(20).fill(-0.25))
  mixer.command({ op: 'close', id: 1 })
})

test('Wave global attenuation leaves CDDA and MIDI-class output on their own established gain paths', () => {
  for (const kind of ['cdda', 'midi'] as const) {
    const mixer = new AudioMixer(1000)
    mixer.command({ op: 'load', id: 1, asset: pcm, settings: { ...defaultSoundSettings(), volume: 50000, pan: 50000 }, kind })
    mixer.command({ op: 'globalVolume', volume: 2000 }); mixer.command({ op: 'waveMuted', muted: true })
    mixer.command({ op: 'play', id: 1 })
    const output = render(mixer, 10)
    assert.deepEqual(output.left, Array(10).fill(0.125), kind)
    assert.deepEqual(output.right, Array(10).fill(-0.125), kind)
    mixer.command({ op: 'close', id: 1 })
  }
})
