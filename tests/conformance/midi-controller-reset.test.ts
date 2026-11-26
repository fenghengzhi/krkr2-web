import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midi } from '../helpers/audio.ts'
import { midiControllerResetFile, midiLatePanFile } from '../helpers/midi-controller-reset.ts'

function player(bytes?: Uint8Array, looping = false) {
  const mixer = new AudioMixer(44100)
  if (bytes) {
    mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(bytes), settings: { ...defaultSoundSettings(), looping } })
    mixer.command({ op: 'play', id: 1 })
  }
  return mixer
}
function render(mixer: AudioMixer, count = 8820) {
  const left = new Float32Array(count), right = new Float32Array(count), events = mixer.render(left, right)
  assert(left.every(Number.isFinite)); assert(right.every(Number.isFinite))
  assert(!events.some((event) => event.type === 'error'))
  return { left, right, events }
}
const raw = (mixer: AudioMixer, bytes: number[]) => mixer.command({ op: 'midiOut', data: new Uint8Array(bytes) })
const close = (...mixers: AudioMixer[]) => {
  for (const mixer of mixers) { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
}

test('SMF CC121 distinguishes zero and nonzero pan reset while KRKR resends its own CC7 on either path', () => {
  for (const channel of [0, 7]) for (const value of [0, 1] as const) {
    const actual = player(midiControllerResetFile(value, false, channel)),
      reference = player(midiControllerResetFile(value, true, channel))
    try {
      const heard = render(actual), expected = render(reference)
      assert.deepEqual(heard, expected)
      assert(heard.left.some((sample) => sample !== 0))
      assert(heard.right.subarray(0, 4410).every((sample) => sample === 0))
      if (value === 0) assert(heard.right.every((sample) => sample === 0))
      else assert.deepEqual(heard.left.subarray(4410), heard.right.subarray(4410))
      for (const mixer of [actual, reference]) mixer.command({ op: 'set', id: 1, property: 'position', value: 6615 })
      assert.deepEqual(render(actual, 2205), render(reference, 2205), 'Seek rebuilds the in-score reset and its preserved pan')
    } finally { close(actual, reference) }
  }
  const track = (bytes: Uint8Array) => [...bytes.subarray(22)],
    actual = player(midi([track(midiControllerResetFile(0, false, 0)), track(midiControllerResetFile(1, false, 7))], 100)),
    reference = player(midi([track(midiControllerResetFile(0, true, 0)), track(midiControllerResetFile(1, true, 7))], 100))
  try { assert.deepEqual(render(actual), render(reference), 'Reset acts only on its addressed channel') }
  finally { close(actual, reference) }
})

test('actual raw MIDI zero reset preserves volume/pan, releases sustain and restores expression without an SMF CC7 resend', () => {
  const actual = player(), reference = player(), setup = [0xc0, 80, 0xb0, 7, 32, 0xb0, 10, 0, 0xb0, 11, 32, 0x90, 69, 100]
  try {
    for (const mixer of [actual, reference]) raw(mixer, setup)
    assert.deepEqual(render(actual, 4410), render(reference, 4410))
    raw(actual, [0xb0, 121, 0]); raw(reference, [0xb0, 11, 127])
    const zero = render(actual, 4410)
    assert.deepEqual(zero, render(reference, 4410)); assert(zero.right.every((sample) => sample === 0))
    assert(zero.left.some((sample) => sample !== 0))
    raw(actual, [0xb0, 121, 1]); raw(reference, [0xb0, 7, 100, 0xb0, 10, 64, 0xb0, 11, 127])
    const one = render(actual, 4410)
    assert.deepEqual(one, render(reference, 4410)); assert.deepEqual(one.left, one.right)
    for (const mixer of [actual, reference]) raw(mixer, [0xb0, 7, 32, 0xb0, 10, 0, 0xb0, 64, 127, 0x80, 69, 0])
    assert.deepEqual(render(actual, 4410), render(reference, 4410))
    raw(actual, [0xb0, 121, 0]); raw(reference, [0xb0, 64, 0, 0xb0, 11, 127])
    const released = render(actual, 44100)
    assert.deepEqual(released, render(reference, 44100))
    assert(released.left.subarray(40000).every((sample) => sample === 0))
  } finally { close(actual, reference) }
})

test('late-score pan survives same-song loops and Stop/Play, while early Stop, explicit seek, new files and module reset stay distinct', () => {
  const actual = player(midiLatePanFile(), true), reference = player(midiLatePanFile(0), true),
    fresh = player(midiLatePanFile(), true), early = player(midiLatePanFile())
  try {
    const center = render(actual), left = render(reference)
    assert.deepEqual(center.left, center.right); assert(left.right.every((sample) => sample === 0))
    assert.deepEqual(center.left, left.left)
    for (let cycle = 0; cycle < 3; cycle++) assert.deepEqual(render(actual), render(reference))
    actual.command({ op: 'stop', id: 1 }); actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual), render(reference))
    actual.command({ op: 'set', id: 1, property: 'looping', value: false })
    render(actual, 1); assert.equal(actual.snapshot(1).status, 'stop')
    actual.command({ op: 'play', id: 1 }); assert.deepEqual(render(actual), render(reference))
    actual.command({ op: 'set', id: 1, property: 'position', value: 0 })
    assert.deepEqual(render(actual), render(fresh), 'Explicit seek reconstructs from the score, not the previous device pan')
    render(early, 4410); early.command({ op: 'stop', id: 1 }); early.command({ op: 'play', id: 1 })
    assert.deepEqual(render(early).right, center.right, 'Stopping early must not process the future end-tick pan')
    early.command({ op: 'stop', id: 1 })
    raw(actual, [0xf0, 0x7e, 0x7f, 9, 1, 0xf7]); actual.command({ op: 'stop', id: 1 }); actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual).right, center.right, 'GM reset explicitly restores centered pan')
    actual.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(midiLatePanFile()), settings: defaultSoundSettings() })
    actual.command({ op: 'play', id: 1 }); assert.deepEqual(render(actual).right, center.right)
  } finally { close(actual, reference, fresh, early) }
})
