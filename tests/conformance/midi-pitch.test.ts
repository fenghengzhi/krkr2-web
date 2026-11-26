import assert from 'node:assert/strict'
import test from 'node:test'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midi } from '../helpers/audio.ts'
import { midiPitchCases, midiPitchFile, midiPitchLate, midiPitchLong, midiPitchReference } from '../helpers/midi-pitch.ts'

function player(bytes: Uint8Array, looping = false) {
  const mixer = new AudioMixer(44100)
  mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(bytes), settings: { ...defaultSoundSettings(), looping } })
  mixer.command({ op: 'play', id: 1 })
  return mixer
}
function render(mixer: AudioMixer, count = 8820) {
  const left = new Float32Array(count), right = new Float32Array(count)
  mixer.render(left, right)
  assert.deepEqual(right, left); assert(left.every(Number.isFinite))
  return left
}
function close(...mixers: AudioMixer[]) {
  for (const mixer of mixers) { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
}
function fixture(name: typeof midiPitchCases[number]['name']) {
  const entry = midiPitchCases.find((candidate) => candidate.name === name)
  assert(entry, `Missing authored pitch fixture ${name}`)
  return entry
}

test('GS melodic RPN tuning produces the complete PCM of independently transposed and wheel-tuned scores', () => {
  for (const channel of [0, 7]) for (const entry of midiPitchCases) {
    const actual = player(midiPitchFile(entry.messages, 69, channel)),
      reference = player(midiPitchReference(entry.key, entry.bend, channel))
    try {
      const pcm = render(actual), expected = render(reference)
      assert(pcm.some((sample) => sample !== 0), entry.name)
      assert.deepEqual(pcm, expected, `${entry.name}, channel ${channel}`)
    } finally { close(actual, reference) }
  }
})

test('MIDI tuning and parameter selection are isolated per channel; explicit module resets clear both', () => {
  // Each independently authored track contains its own channel messages.
  const track = (bytes: Uint8Array) => [...bytes.subarray(22)],
    actual = player(midi([
      track(midiPitchFile(fixture('octave').messages, 69, 0)),
      track(midiPitchFile(fixture('lower').messages, 69, 7)),
    ], 100)), reference = player(midi([
      track(midiPitchReference(81, 8192, 0)), track(midiPitchReference(57, 8192, 7)),
    ], 100))
  try { assert.deepEqual(render(actual), render(reference)) } finally { close(actual, reference) }
  for (const reset of [
    [0xf0, 0x7e, 0x7f, 9, 1, 0xf7],
    [0xf0, 0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41, 0xf7],
    [0xf0, 0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7],
  ]) {
    const tuned = player(midiPitchLong()), neutral = player(midiPitchLong())
    try {
      render(tuned, 4410)
      for (const message of fixture('combined').messages)
        tuned.command({ op: 'midiMessage', message: { kind: 'short', status: message[0]!, data: [...message.slice(1)] } })
      tuned.command({ op: 'stop', id: 1 })
      tuned.command({ op: 'midiMessage', message: { kind: 'long', data: new Uint8Array(reset) } })
      tuned.command({ op: 'play', id: 1 })
      assert.deepEqual(render(tuned), render(neutral), 'Module reset clears tuning, range, bend and active notes')
    } finally { close(tuned, neutral) }
  }
})

test('held notes retain note-on tuning while loop and replay retain parameters; explicit seek and new scores reconstruct them', () => {
  const actual = player(midiPitchLate(), true), base = player(midiPitchReference(69), true),
    octave = player(midiPitchReference(81), true), manual = player(midiPitchLate()), early = player(midiPitchLate())
  try {
    const ordinary = render(base), raised = render(octave)
    assert.notDeepEqual(ordinary, raised)
    assert.deepEqual(render(actual), ordinary, 'The 105 ms tuning change must not retune the held note')
    for (let pass = 0; pass < 3; pass++) assert.deepEqual(render(actual), raised)
    actual.command({ op: 'set', id: 1, property: 'position', value: 0 })
    assert.deepEqual(render(actual), ordinary, 'Explicit seek rebuilds the score from its initial state')
    actual.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(midiPitchReference(69)), settings: defaultSoundSettings() })
    actual.command({ op: 'play', id: 1 }); assert.deepEqual(render(actual), ordinary)

    render(manual, 6615) // 150 ms: tuning arrived, but the first note remains A4.
    manual.command({ op: 'stop', id: 1 }); manual.command({ op: 'play', id: 1 })
    assert.deepEqual(render(manual), raised)
    render(manual, 1); assert.equal(manual.snapshot(1).status, 'stop')
    manual.command({ op: 'play', id: 1 }); assert.deepEqual(render(manual), raised)
    render(early, 4410) // Stop before the still-future tuning event.
    early.command({ op: 'stop', id: 1 }); early.command({ op: 'play', id: 1 })
    assert.deepEqual(render(early), ordinary)
  } finally { close(actual, base, octave, manual, early) }
})

test('MIDI seek integrates pitch-wheel intervals and snapshots each note tuning instead of applying final pitch to its whole age', () => {
  // Division 100 / default tempo: 5 ms per tick. At 155 ms the first
  // score has accumulated .105*440 + .05*880 = 90.2 cycles, not .155*880.
  const bend = midi([[
    0, 0xc0, 48, 0, 0xb0, 101, 0, 0, 0xb0, 100, 0, 0, 0xb0, 6, 24,
    0, 0x90, 69, 100, 21, 0xe0, 0, 96, 19, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
  ]], 100), later = midi([[
    0, 0xc0, 48, 21, 0xb0, 101, 0, 0, 0xb0, 100, 2, 0, 0xb0, 6, 76,
    1, 0x90, 69, 100, 18, 0x80, 69, 0, 0, 0xff, 0x2f, 0,
  ]], 100)
  for (const entry of [
    { bytes: bend, at: .155, referenceKey: 81, referenceAt: .1025 },
    { bytes: later, at: .155, referenceKey: 81, referenceAt: .045 },
    { bytes: midiPitchLate(), at: .155, referenceKey: 69, referenceAt: .155 },
  ]) {
    const actual = new MidiSynth(decodeMidi(entry.bytes)), reference = new MidiSynth(decodeMidi(midiPitchLong(entry.referenceKey)))
    actual.seek(entry.at); reference.seek(entry.referenceAt)
    let maximum = 0, peak = 0
    for (let sample = 0; sample < 882; sample++) {
      actual.render(entry.at + sample / 44100, 1 / 44100)
      reference.render(entry.referenceAt + sample / 44100, 1 / 44100)
      assert.equal(actual.left, actual.right); assert.equal(reference.left, reference.right)
      maximum = Math.max(maximum, Math.abs(actual.left - reference.left))
      peak = Math.max(peak, Math.abs(actual.left))
    }
    assert(peak > .001)
    // Only double-precision accumulation differs between these equivalent
    // interval integrals; this does not compare device timbre or vibrato.
    assert(maximum < 1e-9, `Equivalent pitch integrals differed by ${maximum}`)
  }
})
