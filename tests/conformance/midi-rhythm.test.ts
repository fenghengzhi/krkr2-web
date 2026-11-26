import assert from 'node:assert/strict'
import test from 'node:test'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midi } from '../helpers/audio.ts'
import { gsPartPacket, gsResetPacket, rhythmScore } from '../helpers/midi-rhythm.ts'

const rate = 44100
function render(synth: MidiSynth, start = 0, frames = 44100): Float32Array {
  const output = new Float32Array(frames)
  for (let at = 0; at < frames; at++) {
    synth.render((start + at) / rate, 1 / rate)
    assert.equal(synth.left, synth.right); output[at] = synth.left
  }
  return output
}
const raw = (synth: MidiSynth, status: number, data: number[]) => synth.rawMessage({ status, data })
const note = (synth: MidiSynth, id: number) => { raw(synth, 0xc0 + id, [80]); raw(synth, 0x90 + id, [36, 100]) }

test('GS scores route normal part boundaries and device IDs to the same actual PCM as ordinary GM reference channels', () => {
  const drum = render(new MidiSynth(decodeMidi(rhythmScore({ channel: 9 })))),
    melody = render(new MidiSynth(decodeMidi(rhythmScore({ channel: 0 }))))
  assert.notDeepEqual(drum, melody); assert(drum.subarray(27000).every((value) => value === 0))
  assert(melody.subarray(27000, 39000).some((value) => value !== 0))
  for (const device of [0, 0x10, 0x7f]) for (const [part, channel] of [[0, 9], [1, 0], [9, 8], [10, 10], [15, 15]] as const)
    for (const split of [false, true]) for (const value of [0, 1, 2]) {
      const asset = decodeMidi(rhythmScore({ channel, part, device, split, value }))
      assert.equal(asset.sampleCount, rate)
      assert.deepEqual(render(new MidiSynth(asset)), value ? drum : melody, `${device}/${part}/${split}/${value}`)
    }
  assert.deepEqual(render(new MidiSynth(decodeMidi(rhythmScore({ channel: 0, part: 1, reset: false })))), melody,
    'GS part assignments before GS Reset must not change a normal GM file')
})

test('GS part messages act only at EOX and on future notes; controller reset preserves routing while module reset restores GM defaults', () => {
  const actual = new MidiSynth(), reference = new MidiSynth()
  for (const synth of [actual, reference]) { raw(synth, 0xf0, gsResetPacket()); note(synth, 0) }
  assert.deepEqual(render(actual, 0, 4410), render(reference, 0, 4410))
  const packet = gsPartPacket(1, 1, 0x7f)
  raw(actual, 0xf0, packet.slice(0, 5)); raw(actual, 0xf7, packet.slice(5))
  assert.deepEqual(render(actual, 4410, 4410), render(reference, 4410, 4410), 'A held melodic voice keeps its instrument')
  for (const synth of [actual, reference]) raw(synth, 0xb0, [120, 0])
  raw(actual, 0xb0, [121, 0]); note(actual, 0); note(reference, 9)
  assert.deepEqual(render(actual, 8820, 8820), render(reference, 8820, 8820))
  for (const id of [1, 9]) {
    const synth = new MidiSynth(), expected = new MidiSynth()
    raw(synth, 0xf0, gsResetPacket()); raw(synth, 0xf0, packet)
    note(synth, id); note(expected, id)
    assert.deepEqual(render(synth, 0, 8820), render(expected, 0, 8820), `Unaddressed channel ${id}`)
  }
  {
    const synth = new MidiSynth(), expected = new MidiSynth()
    raw(synth, 0xf0, gsResetPacket()); note(synth, 9); note(expected, 9)
    assert.deepEqual(render(synth, 0, 4410), render(expected, 0, 4410))
    raw(synth, 0xf0, gsPartPacket(0, 0))
    assert.deepEqual(render(synth, 4410, 4410), render(expected, 4410, 4410), 'A sounding drum also keeps its note-on instrument')
  }

  // Complete F7 escape, interrupted F0, and incomplete F7 are distinct normal
  // wire paths. Only the EOX of an uninterrupted packet changes the next note.
  for (const mode of ['complete', 'partial', 'interrupted'] as const) {
    const synth = new MidiSynth(), expected = new MidiSynth()
    raw(synth, 0xf7, [0xf0, ...gsResetPacket(0)])
    if (mode === 'complete') raw(synth, 0xf7, [0xf0, ...packet])
    else {
      raw(synth, 0xf0, packet.slice(0, 5))
      if (mode === 'interrupted') { raw(synth, 0xb0, [10, 64]); raw(synth, 0xf7, packet.slice(5)) }
    }
    note(synth, 0); note(expected, mode === 'complete' ? 9 : 0)
    assert.deepEqual(render(synth, 0, 8820), render(expected, 0, 8820), mode)
  }
  for (const reset of [[0x7e, 0x7f, 9, 1, 0xf7], [0x7e, 0x10, 9, 3, 0xf7], [0x43, 0x10, 0x4c, 0, 0, 0x7e, 0, 0xf7]]) for (const id of [0, 9]) {
    const synth = new MidiSynth(), expected = new MidiSynth()
    const assignment = gsPartPacket(id === 0 ? 1 : 0, id === 0 ? 1 : 0)
    raw(synth, 0xf0, gsResetPacket()); raw(synth, 0xf0, assignment); raw(synth, 0xf0, reset)
    raw(synth, 0xf0, assignment); note(synth, id); note(expected, id)
    assert.deepEqual(render(synth, 0, 8820), render(expected, 0, 8820), 'GM/XG disables later GS part commands until another GS Reset')
  }
  // Module recognition is not KRKR's additional complete-F0 volume rewrite.
  // Already-used channel CC80 survives in the owner's memory for F7/another
  // device; canonical F0 resets owner CC100 and sends floor(100*63/127)=49.
  for (const mode of ['native-f0', 'other-device', 'split-f7', 'escape-f7'] as const) {
    const synth = new MidiSynth(), expected = new MidiSynth(), bytes = gsResetPacket(mode === 'other-device' ? 0x7f : 0x10)
    synth.setBufferVolume(63); synth.message({ status: 0xb0, data: [7, 80] })
    if (mode === 'split-f7') {
      synth.message({ status: 0xf0, data: bytes.slice(0, 5) }); synth.message({ status: 0xf7, data: bytes.slice(5) })
    } else synth.message({ status: mode === 'escape-f7' ? 0xf7 : 0xf0,
      data: mode === 'escape-f7' ? [0xf0, ...bytes] : bytes })
    synth.message({ status: 0xc0, data: [80] }); synth.message({ status: 0x90, data: [36, 100] })
    note(expected, 0); raw(expected, 0xb0, [7, mode === 'native-f0' ? 49 : 100])
    assert.deepEqual(render(synth, 0, 4410), render(expected, 0, 4410), mode)
    synth.setBufferVolume(28); raw(expected, 0xb0, [7, mode === 'native-f0' ? 22 : 17])
    assert.deepEqual(render(synth, 4410, 4410), render(expected, 4410, 4410), `${mode}:owner CC7`)
  }
})

test('GS assignment survives same-song looping and Stop/Play, while explicit position and a new score rebuild their own routing', () => {
  // An independently timed GS assignment at the final tick changes the next
  // pass, not the first note. Both final messages are drained before rewind.
  const reset = gsResetPacket(), part = gsPartPacket(1, 1), bytes = midi([[
    20, 0xc0, 80, 0, 0x90, 36, 100, 0x81, 0x20, 0x80, 36, 0,
    20, 0xf0, reset.length, ...reset, 0, 0xf0, part.length, ...part, 0, 0xff, 0x2f, 0,
  ]], 100), asset = decodeMidi(bytes), mixer = new AudioMixer(rate),
    melody = render(new MidiSynth(decodeMidi(rhythmScore({ channel: 0 })))),
    drum = render(new MidiSynth(decodeMidi(rhythmScore({ channel: 9 }))))
  // Canonical complete GS Reset adds 50 ms before the final assignment/EOF.
  assert.equal(asset.sampleCount, 46305)
  const take = (frames: number) => {
    const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right)
    assert(!events.some((event) => event.type === 'error')); assert.deepEqual(left, right); return left
  }
  const begin = () => mixer.command({ op: 'play', id: 1 })
  try {
    mixer.command({ op: 'load', id: 1, kind: 'midi', asset, settings: { ...defaultSoundSettings(), looping: true } }); begin()
    assert.deepEqual(take(rate), melody); take(2205)
    assert.deepEqual(take(rate), drum)
    mixer.command({ op: 'stop', id: 1 }); begin(); assert.deepEqual(take(rate), drum)
    mixer.command({ op: 'set', id: 1, property: 'position', value: 0 }); assert.deepEqual(take(rate), melody)
    mixer.command({ op: 'stop', id: 1 }); begin(); assert.deepEqual(take(rate), melody, 'Early Stop must not send the future assignment')
    mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(rhythmScore({ channel: 0 })), settings: defaultSoundSettings() })
    begin(); assert.deepEqual(take(rate), melody)
    const selected = new MidiSynth(decodeMidi(rhythmScore({ channel: 0, part: 1 }))), plain = new MidiSynth(decodeMidi(rhythmScore({ channel: 9 })))
    selected.seek(.2); plain.seek(.2); assert.deepEqual(render(selected, 8820, 8820), render(plain, 8820, 8820))
  } finally { mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0) }
})
