import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midiProgramReplayFile } from '../helpers/midi-program-replay.ts'

function player(initialProgram?: number, looping = false, reset = false, programAtEnd = false) {
  const mixer = new AudioMixer(44100)
  mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(midiProgramReplayFile(initialProgram, reset, programAtEnd)),
    settings: { ...defaultSoundSettings(), looping } })
  mixer.command({ op: 'play', id: 1 })
  return mixer
}
function render(mixer: AudioMixer, count = 8820) {
  const left = new Float32Array(count), right = new Float32Array(count), events = mixer.render(left, right)
  assert.deepEqual(right, left); assert(left.every(Number.isFinite))
  return { left, events }
}
function close(...mixers: AudioMixer[]) {
  for (const mixer of mixers) { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
}

test('MIDI whole-song loops retain a late ProgramChange while replacing all old notes', () => {
  for (const programAtEnd of [false, true]) {
    const actual = player(undefined, true, false, programAtEnd), reference = player(48, true)
    try {
      const first = render(actual), explicit = render(reference)
      assert.notDeepEqual(first.left, explicit.left, 'The first authored note is piano; changing program later does not retimbre it')
      assert(first.left.some((sample) => sample !== 0)); assert(explicit.left.some((sample) => sample !== 0))
      for (let cycle = 0; cycle < 4; cycle++) {
        assert.deepEqual(render(actual), render(reference), `Full stereo PCM on loop ${cycle + 2}`)
        assert.equal(actual.snapshot(1).status, 'play'); assert.equal(actual.snapshot(1).position, 8820)
      }
      actual.command({ op: 'set', id: 1, property: 'paused', value: true })
      const paused = actual.snapshot(1).position
      assert(render(actual, 100).left.every((sample) => sample === 0)); assert.equal(actual.snapshot(1).position, paused)
      actual.command({ op: 'set', id: 1, property: 'paused', value: false })
      assert.deepEqual(render(actual), render(reference))
    } finally { close(actual, reference) }
  }
})

test('manual and natural MIDI replay keep the selected instrument, but explicit module reset still restores piano', () => {
  const actual = player(), reference = player(48, true), piano = player(), atEnd = player(undefined, false, false, true),
    earlyReference = player()
  try {
    render(actual, 6615) // 150 ms: the original first note is still sounding; program 48 has arrived.
    actual.command({ op: 'stop', id: 1 }); actual.command({ op: 'stop', id: 1 })
    assert.equal(actual.snapshot(1).status, 'stop'); assert.equal(actual.snapshot(1).position, 0)
    assert(render(actual, 200).left.every((sample) => sample === 0))
    actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual).left, render(reference).left)
    const ended = render(actual, 1)
    assert.equal(ended.events.filter((event) => event.type === 'ended').length, 1)
    assert.equal(actual.snapshot(1).status, 'stop')
    actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual).left, render(reference).left)
    actual.command({ op: 'stop', id: 1 })
    actual.command({ op: 'midiMessage', message: { kind: 'long', data: new Uint8Array([0xf0, 0x7e, 0x7f, 9, 1, 0xf7]) } })
    actual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(actual).left, render(piano).left, 'A real raw GM reset is not a transport rewind')

    render(atEnd, 6615); atEnd.command({ op: 'stop', id: 1 }); atEnd.command({ op: 'play', id: 1 })
    assert.deepEqual(render(atEnd).left, render(earlyReference).left, 'Manual Stop must not send the still-future end-tick ProgramChange')
    const tail = render(atEnd, 1)
    assert.deepEqual([...tail.left], [0]); assert.equal(tail.events.filter((event) => event.type === 'ended').length, 1)
    atEnd.command({ op: 'play', id: 1 })
    assert.deepEqual(render(atEnd).left, render(reference).left, 'Natural EOF consumes the end-tick ProgramChange without an extra audible sample')
  } finally { close(actual, reference, piano, atEnd, earlyReference) }
})

test('explicit MIDI seek and new assets retain deterministic score reconstruction; in-score resets remain effective on every loop', () => {
  const actual = player(undefined, true), fresh = player(), reset = player(undefined, true, true), resetReference = player(undefined, false, true)
  try {
    render(actual, 6615)
    actual.command({ op: 'set', id: 1, property: 'position', value: 0 })
    assert.deepEqual(render(actual).left, render(fresh).left)
    actual.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(midiProgramReplayFile()), settings: defaultSoundSettings() })
    actual.command({ op: 'play', id: 1 }); fresh.command({ op: 'set', id: 1, property: 'position', value: 0 })
    assert.deepEqual(render(actual).left, render(fresh).left, 'A new per-voice synth is not the shared Windows device')
    const expected = render(resetReference).left
    assert(expected.subarray(0, 2205).every((sample) => sample === 0))
    for (let cycle = 0; cycle < 3; cycle++) assert.deepEqual(render(reset).left, expected)
  } finally { close(actual, fresh, reset, resetReference) }
})
