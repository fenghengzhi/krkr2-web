import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { masterPacket, masterPlain, masterScore, masterTail } from '../helpers/midi-master-volume.ts'

const rate = 44100, half = (8192 / 16383) ** 2, fine = (8193 / 16383) ** 2
function player(bytes: Uint8Array, loop = false) {
  const mixer = new AudioMixer(rate)
  mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(bytes), settings: { ...defaultSoundSettings(), looping: loop } })
  mixer.command({ op: 'play', id: 1 }); return mixer
}
function render(mixer: AudioMixer, frames: number) {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  assert(!events.some((event) => event.type === 'error')); assert.deepEqual(left, right)
  return left
}
/** Baseline contains no master messages. The independent gain schedule is
 * applied to its unrounded procedural samples, before the real float32 sink. */
function masterReference(frames: number, gain: (frame: number) => number) {
  const synth = new MidiSynth(decodeMidi(masterPlain())), output = new Float32Array(frames)
  for (let at = 0; at < frames; at++) { synth.render(at / rate, 1 / rate); output[at] = synth.left * gain(at) }
  return output
}

test('ordinary SMF master volume changes the complete held music at EOX, including split F7 and the low seven bits', () => {
  for (const device of [0, 0x10, 0x7f]) for (const split of [false, true]) {
    const bytes = masterScore(split, device), asset = decodeMidi(bytes), mixer = player(bytes)
    try {
      assert.equal(asset.sampleCount, 22050); assert(asset.events.every((event) => event.outputTime === undefined))
      const heard = render(mixer, 22050), expected = masterReference(22050,
        (frame) => frame < (split ? 6615 : 4410) ? 1 : frame < 8820 ? half : frame < 13230 ? 0 : frame < 17640 ? fine : 1)
      assert.deepEqual(heard, expected)
      assert(heard.subarray(8820, 13230).every((value) => value === 0))
      assert(heard.subarray(13230).some((value) => value !== 0), 'Silence must advance note phase and allow the same note to return')
    } finally { mixer.command({ op: 'shutdown' }) }
  }
})

test('raw master volume affects active channels without changing their controllers; CC121 is not a module reset', () => {
  for (const channel of [0, 7, 9]) {
    const actual = new MidiSynth(), reference = new MidiSynth(), send = (data: number[]) => actual.rawMessage({ status: 0xf7, data })
    for (const synth of [actual, reference]) {
      synth.rawMessage({ status: 0xc0 + channel, data: [80] })
      synth.rawMessage({ status: 0x90 + channel, data: [channel === 9 ? 35 : 69, 100] })
    }
    send([0xf0, ...masterPacket(8192, 0)])
    for (let frame = 0; frame < 882; frame++) {
      actual.render(frame / rate, 1 / rate); reference.render(frame / rate, 1 / rate)
      assert.equal(actual.left, reference.left * half)
    }
    actual.rawMessage({ status: 0xb0 + channel, data: [121, 0] })
    reference.rawMessage({ status: 0xb0 + channel, data: [121, 0] })
    send([0xf0, 0x7f, 0x7f, 4, 1, 0, 0x40]) // no EOX: keep the previous gain
    actual.render(.02, 1 / rate); reference.render(.02, 1 / rate)
    assert.equal(actual.left, reference.left * half)
    send([0xf0, ...masterPacket(0)])
    actual.render(.021, 1 / rate); reference.render(.021, 1 / rate); assert.equal(actual.left, 0)
    send([0xf0, 0x7e, 0x10, 9, 1, 0xf7])
    reference.rawMessage({ status: 0xf7, data: [0xf0, 0x7e, 0x10, 9, 1, 0xf7] })
    for (const synth of [actual, reference]) synth.rawMessage({ status: 0x90 + channel, data: [69, 100] })
    actual.render(.04, 1 / rate); reference.render(.04, 1 / rate)
    assert.equal(actual.left, reference.left, 'GM reset restores full master volume on its addressed module')
  }
})

test('end-tick mute survives loops and same-song replay, while seek, a new score and GM reset retain their separate lifetimes', () => {
  const mixer = player(masterTail(), true), expected = masterReference(22050, () => 1)
  try {
    assert.deepEqual(render(mixer, 22050), expected)
    assert(render(mixer, 22050).every((value) => value === 0))
    mixer.command({ op: 'stop', id: 1 }); mixer.command({ op: 'play', id: 1 })
    assert(render(mixer, 22050).every((value) => value === 0))
    mixer.command({ op: 'set', id: 1, property: 'position', value: 0 })
    assert.deepEqual(render(mixer, 22050), expected)
    mixer.command({ op: 'set', id: 1, property: 'looping', value: false })
    render(mixer, 1); assert.equal(mixer.snapshot(1).status, 'stop')
    mixer.command({ op: 'play', id: 1 }); assert(render(mixer, 882).every((value) => value === 0))
    mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(masterTail()), settings: defaultSoundSettings() })
    mixer.command({ op: 'play', id: 1 }); assert.deepEqual(render(mixer, 4410), expected.subarray(0, 4410))
    mixer.command({ op: 'stop', id: 1 }); mixer.command({ op: 'play', id: 1 })
    assert.deepEqual(render(mixer, 22050), expected, 'Early Stop cannot execute the future final-tick mute')
    render(mixer, 1)
    mixer.command({ op: 'midiOut', data: new Uint8Array([0xf0, 0x7e, 0x7f, 9, 1, 0xf7]) })
    mixer.command({ op: 'play', id: 1 }); assert.deepEqual(render(mixer, 22050), expected)
  } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
})
