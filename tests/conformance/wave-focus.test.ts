import assert from 'node:assert/strict'
import test from 'node:test'
import { readWaveFocusOptions } from '../../src/engine/media/wave-focus.ts'
import { waveCombinedVolume } from '../../src/engine/media/wave-audio.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type PcmAsset } from '../../src/engine/ports/audio.ts'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { parseSliBytes } from '../../src/formats/audio/sli.ts'
import { midi } from '../helpers/audio.ts'
import { waveFocusAttenuation, waveFocusFiles } from '../helpers/wave-focus.ts'

test('Wave background options use native mode names and the converted signed32 percentage', () => {
  for (const [option, mode] of [[undefined, 0], ['no', 0], ['never', 0], ['minimize', 1], ['yes', 2], ['deactive', 2],
    ['YES', 0], ['deactive ', 0], ['unknown', 0], ['yes\0never', 2]] as const) {
    assert.deepEqual(readWaveFocusOptions(option, 25), { mode, volume: 25000 })
  }
  for (const [converted, volume] of [[0, 0], [100, 100000], [-1, 0], [101, 0], [-0x80000000, 0], [0x7fffffff, 0]])
    assert.deepEqual(readWaveFocusOptions('input', converted), { mode: 0, volume })
  assert.deepEqual(readWaveFocusOptions(undefined, undefined), { mode: 0, volume: 0 })
  for (const invalid of [NaN, .5, Infinity, 0x80000000])
    assert.throws(() => readWaveFocusOptions('yes', invalid), /native startup integer result/)
})

test('background Wave attenuation preserves SLI progression and other media while legacy hard mute remains silent', () => {
  const files = waveFocusFiles(), pcm = decodeWav(files['focus.wav'])!
  pcm.loops = parseSliBytes(files['focus.wav.sli'])
  const mixer = new AudioMixer(1000), gain = 10 ** (waveFocusAttenuation / 2000),
    render = (frames: number) => {
      const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
      return { left: [...left], right: [...right], events }
    }
  try {
    assert.equal(waveCombinedVolume(100000, 100000, 100000, true, 25000), 25000)
    assert.equal(waveCombinedVolume(80009, 75009, 50009, true, 25000), 7500)
    mixer.command({ op: 'load', id: 1, kind: 'wave', asset: pcm, settings: defaultSoundSettings() })
    mixer.command({ op: 'set', id: 1, property: 'position', value: 4088 }); mixer.command({ op: 'play', id: 1 })
    mixer.command({ op: 'waveMuted', muted: true, volume: 25000 })
    const quiet = render(20)
    assert.deepEqual(quiet.left, Array(20).fill(Math.fround(.5 * gain)))
    assert.deepEqual(quiet.right, Array(20).fill(Math.fround(-.25 * gain)))
    assert.equal(mixer.snapshot(1).position, 4108)
    assert.deepEqual(quiet.events.filter((event) => event.type === 'label').map((event) => event.type === 'label' ? event.label : ''), ['heard'])
    mixer.command({ op: 'waveMuted', muted: false, volume: 25000 })
    assert.deepEqual(render(20).left, Array(20).fill(.5))
    mixer.command({ op: 'waveMuted', muted: true })
    assert.deepEqual(render(20).left, Array(20).fill(0))
    assert.equal(mixer.snapshot(1).position, 4148)
    mixer.command({ op: 'close', id: 1 })
    // The focus control belongs to Wave, not the device output or every voice.
    const constant: PcmAsset = { ...pcm, loops: { links: [], labels: [] } }
    mixer.command({ op: 'load', id: 2, kind: 'cdda', asset: constant, settings: defaultSoundSettings() })
    mixer.command({ op: 'waveMuted', muted: true, volume: 25000 }); mixer.command({ op: 'play', id: 2 })
    assert.deepEqual(render(20).left, Array(20).fill(.5)); mixer.command({ op: 'close', id: 2 })
  } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }

  const song = decodeMidi(midi([[0, 0xc0, 80, 0, 0x90, 69, 100, 0x83, 0x60, 0x80, 69, 0, 0, 0xff, 0x2f, 0]])),
    music = [new AudioMixer(1000), new AudioMixer(1000)], heard: Float32Array[][] = []
  try {
    for (const [index, player] of music.entries()) {
      player.command({ op: 'load', id: 1, kind: 'midi', asset: song, settings: defaultSoundSettings() })
      player.command({ op: 'waveMuted', muted: index === 1, volume: 25000 }); player.command({ op: 'play', id: 1 })
      const left = new Float32Array(50), right = new Float32Array(50)
      assert.deepEqual(player.render(left, right), []); heard.push([left, right])
    }
    assert(heard[0]![0]!.some((sample) => sample !== 0)); assert.deepEqual(heard[1], heard[0])
  } finally { for (const player of music) player.command({ op: 'shutdown' }) }
})
