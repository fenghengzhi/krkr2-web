import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midi } from '../helpers/audio.ts'
import { midiChannelModeFile, midiLateMonoFile, midiOverlappingFile } from '../helpers/midi-channel-mode.ts'

function player(bytes?: Uint8Array, looping = false) {
  const mixer = new AudioMixer(44100)
  if (bytes) {
    mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(bytes), settings: { ...defaultSoundSettings(), looping } })
    mixer.command({ op: 'play', id: 1 })
  }
  return mixer
}
function render(mixer: AudioMixer, frames: number) {
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
  assert(left.every(Number.isFinite)); assert(right.every(Number.isFinite))
  assert(!events.some((event) => event.type === 'error'))
  return { left, right, events }
}
const raw = (mixer: AudioMixer, bytes: number[]) => mixer.command({ op: 'midiOut', data: new Uint8Array(bytes) })
const close = (...mixers: AudioMixer[]) => {
  for (const mixer of mixers) {
    mixer.command({ op: 'shutdown' })
    assert.equal(mixer.inspect().voices, 0); assert.equal(mixer.inspect().liveMidiNotes, 0)
    assert.equal(mixer.inspect().clockWork, false)
  }
}

test('SMF mono mode releases only the addressed melodic channel, including damper-held notes, with exact PCM and seek reconstruction', () => {
  for (const mode of ['poly', 'mono', 'sustain', 'restored'] as const) for (const channel of [0, 7]) {
    const actual = player(midiChannelModeFile(mode, false, channel)),
      reference = player(midiChannelModeFile(mode, true, channel))
    try {
      const heard = render(actual, 44100)
      assert.deepEqual(heard, render(reference, 44100))
      assert(heard.left.subarray(33075).some((sample) => sample !== 0))
      assert.deepEqual(heard.left, heard.right)
      for (const mixer of [actual, reference]) mixer.command({ op: 'set', id: 1, property: 'position', value: 11025 })
      const sought = render(actual, 22050)
      assert.deepEqual(sought, render(reference, 22050))
      // Existing seek phase reconstruction must still reproduce a complete
      // musical period; exact live/reference PCM above includes release tails.
      assert(sought.left.some((sample) => sample !== 0))
    } finally { close(actual, reference) }
  }
  const track = (bytes: Uint8Array) => [...bytes.subarray(22)],
    actual = player(midi([track(midiChannelModeFile('mono')), track(midiChannelModeFile('poly', false, 7))], 100)),
    reference = player(midi([track(midiChannelModeFile('mono', true)), track(midiChannelModeFile('poly', true, 7))], 100))
  try { assert.deepEqual(render(actual, 44100), render(reference, 44100)) }
  finally { close(actual, reference) }
  for (const damper of [false, true]) {
    const actual = player(midiOverlappingFile(damper), true), reference = player(midiOverlappingFile(damper, true), true)
    try {
      const heard = render(actual, 52920)
      assert.deepEqual(heard, render(reference, 52920), 'One note-off must release both overlapping A4s')
      assert(heard.left.subarray(50000).some((sample) => sample !== 0))
      for (const mixer of [actual, reference]) mixer.command({ op: 'set', id: 1, property: 'position', value: 11025 })
      assert.deepEqual(render(actual, 44100), render(reference, 44100), 'Seek reconstructs every matching released/damper-held note')
      for (const mixer of [actual, reference]) { mixer.command({ op: 'stop', id: 1 }); mixer.command({ op: 'play', id: 1 }) }
      assert.deepEqual(render(actual, 176400), render(reference, 176400), 'Loop and replay start without held notes from the prior phrase')
    } finally { close(actual, reference) }
  }
})

test('raw mono/poly messages hush one channel, retain the selected mode across CC121 and do not restart prior release tails', () => {
  for (const value of [0, 1, 127]) {
    const actual = player(), reference = player()
    try {
      const setup = [0xc0, 80, 0xc1, 80, 0x90, 69, 100, 0x91, 60, 90]
      for (const mixer of [actual, reference]) raw(mixer, setup)
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      raw(actual, [0xb0, 126, value]); raw(reference, [0xb0, 120, 0])
      assert.deepEqual(render(actual, 4410), render(reference, 4410), 'Mode change silences only channel zero')
      for (const mixer of [actual, reference]) raw(mixer, [0xb0, 64, 127, 0x90, 69, 100, 0x80, 69, 0])
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      raw(actual, [0x90, 76, 100]); raw(reference, [0xb0, 64, 0, 0xb0, 64, 127, 0x90, 76, 100])
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      // A new voice must not restart note69's already running release.
      raw(actual, [0x90, 81, 100]); raw(reference, [0xb0, 64, 0, 0x80, 76, 0, 0xb0, 64, 127, 0x90, 81, 100])
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      for (const mixer of [actual, reference]) raw(mixer, [0xb0, 121, value])
      raw(actual, [0x90, 69, 100]); raw(reference, [0x80, 81, 0, 0x90, 69, 100])
      assert.deepEqual(render(actual, 4410), render(reference, 4410), 'CC121 retains mono mode')
      raw(actual, [0xb0, 127, value]); raw(reference, [0xb0, 120, 0])
      for (const mixer of [actual, reference]) raw(mixer, [0x90, 69, 100, 0x90, 76, 100])
      assert.deepEqual(render(actual, 44100), render(reference, 44100), 'Poly restores a simultaneous chord')
    } finally { close(actual, reference) }
  }
  for (const damper of [false, true]) {
    const actual = player(), reference = player()
    try {
      const setup = [0xc0, 80, 0xc1, 80, 0xc2, 80,
        ...(damper ? [0xb0, 64, 127, 0xb1, 64, 127] : []),
        0x90, 69, 80, 0x90, 76, 100, 0x92, 69, 70]
      for (const mixer of [actual, reference]) raw(mixer, setup)
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      raw(actual, [0x90, 69, 40]); raw(reference, [0x91, 69, 40])
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      raw(actual, [0x90, 69, 0]); raw(reference, [0x80, 69, 0, 0x81, 69, 0])
      assert.deepEqual(render(actual, 4410), render(reference, 4410), 'Velocity zero releases both A4s on channel zero, not channel two')
      raw(actual, [0xb0, 123, 0]); raw(reference, [0x80, 76, 0])
      assert.deepEqual(render(actual, 4410), render(reference, 4410), 'All Notes Off releases only the remaining held E5')
      for (const mixer of [actual, reference]) raw(mixer, [0xb0, 64, 0, 0xb1, 64, 0])
      assert.deepEqual(render(actual, 4410), render(reference, 4410))
      raw(actual, [0xb0, 123, 0, 0x80, 69, 0, 0xb0, 121, 0])
      const tail = render(actual, 44100)
      assert.deepEqual(tail, render(reference, 44100), 'Repeated off messages must not restart existing release envelopes')
      assert.equal(actual.inspect().liveMidiNotes, 1, 'Same-pitch notes on another channel remain sounding')
      assert(tail.left.subarray(40000).some((sample) => sample !== 0))
    } finally { close(actual, reference) }
  }
})

test('last-tick mono mode survives loops and same-song replay, while early Stop, explicit seek, new songs and module reset stay distinct', () => {
  const actual = player(midiLateMonoFile(), true), reference = player(midiLateMonoFile(true), true),
    fresh = player(midiLateMonoFile(), true), early = player(midiLateMonoFile())
  try {
    const first = render(actual, 8820), mono = render(reference, 8820)
    assert.notDeepEqual(first.left, mono.left)
    for (let cycle = 0; cycle < 3; cycle++) assert.deepEqual(render(actual, 8820), render(reference, 8820))
    actual.command({ op: 'stop', id: 1 }); actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual, 8820), render(reference, 8820))
    actual.command({ op: 'set', id: 1, property: 'looping', value: false })
    render(actual, 1); assert.equal(actual.snapshot(1).status, 'stop')
    actual.command({ op: 'play', id: 1 }); assert.deepEqual(render(actual, 8820), mono)
    actual.command({ op: 'set', id: 1, property: 'position', value: 0 })
    assert.deepEqual(render(actual, 8820), render(fresh, 8820))
    render(early, 4410); early.command({ op: 'stop', id: 1 }); early.command({ op: 'play', id: 1 })
    assert.deepEqual(render(early, 8820), first, 'Early Stop must not send the future mode message')
    raw(actual, [0xf0, 0x7e, 0x7f, 9, 1, 0xf7]); actual.command({ op: 'stop', id: 1 }); actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual, 8820), first)
    actual.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(midiLateMonoFile()), settings: defaultSoundSettings() })
    actual.command({ op: 'play', id: 1 }); assert.deepEqual(render(actual, 8820), first)
  } finally { close(actual, reference, fresh, early) }
})
