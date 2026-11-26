import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings, type MidiAsset } from '../../src/engine/ports/audio.ts'
import { midi } from '../helpers/audio.ts'
import { midiResetPackets, midiResetDelayFile, midiResetReferenceFile } from '../helpers/midi-reset-delay.ts'

function render(asset: MidiAsset, frames: number, position = 0, looping = false) {
  const mixer = new AudioMixer(44100)
  mixer.command({ op: 'load', id: 1, kind: 'midi', asset, settings: { ...defaultSoundSettings(), looping } })
  if (position) mixer.command({ op: 'set', id: 1, property: 'position', value: position })
  mixer.command({ op: 'play', id: 1 })
  const left = new Float32Array(frames), right = new Float32Array(frames), events = mixer.render(left, right), snapshot = mixer.snapshot(1)
  mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0)
  return { left, right, events, snapshot }
}

test('SMF complete reset prefixes wait 50 ms without rewriting nominal score times or later notes', () => {
  for (const kind of Object.keys(midiResetPackets) as (keyof typeof midiResetPackets)[]) {
    const asset = decodeMidi(midiResetDelayFile(kind))
    assert.deepEqual(asset.events.map((event) => event.time), [0, 0, 0, 0, 0.2])
    assert.deepEqual(asset.events.map((event) => event.outputTime ?? event.time), [0, 0.05, 0.05, 0.05, 0.2])
    assert.equal(asset.sampleCount, 8820)
    const actual = render(asset, 8821), reference = render(decodeMidi(midiResetReferenceFile(10)), 8821)
    assert.deepEqual(actual, reference)
    assert(actual.left.subarray(0, 2205).every((sample) => sample === 0))
    assert(actual.left.subarray(2205, 4410).some((sample) => sample !== 0))
  }
  const later = decodeMidi(midiResetDelayFile('gm', 1, 30))
  assert.equal(later.events.find((event) => event.status === 0x90)!.time, 0.15)
  assert.equal(later.events.find((event) => event.status === 0x90)!.outputTime, undefined)
})

test('repeated module initialization is serial, preserves tick order, and extends only a blocked physical EOF', () => {
  const repeated = decodeMidi(midiResetDelayFile('gm', 3))
  assert.deepEqual(repeated.events.map((event) => event.outputTime ?? event.time), [0, .05, .1, .15, .15, .15, .2])
  assert.deepEqual(render(repeated, 8821), render(decodeMidi(midiResetReferenceFile(30)), 8821))
  const packet = midiResetPackets.gm, tailBytes = midi([[0, 0xf0, packet.length, ...packet, 0, 0xff, 0x2f, 0]], 100), tail = decodeMidi(tailBytes)
  assert.deepEqual([...tailBytes.subarray(-4)], [0, 0xff, 0x2f, 0], 'The authored score ends at tick zero')
  assert.equal(tail.sampleCount, 2205)
  const silent = render(tail, 2206)
  assert(silent.left.every((sample) => sample === 0)); assert.equal(silent.events.filter((event) => event.type === 'ended').length, 1)
  const tracks = decodeMidi(midi([[0, 0xf0, packet.length, ...packet, 40, 0xff, 0x2f, 0],
    [0, 0xc0, 48, 0, 0x90, 69, 100, 40, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100))
  assert.equal(tracks.events.find((event) => event.status === 0x90)!.outputTime, .05)
})

test('F7 continuation, alternate GM mode and another device ID do not invent the original F0 volume-resend wait', () => {
  const packets = [
    [0, 0xf0, 2, 0x7e, 0x7f, 0, 0xf7, 3, 9, 1, 0xf7],
    [0, 0xf7, 6, 0xf0, 0x7e, 0x7f, 9, 1, 0xf7],
    [0, 0xf0, 5, 0x7e, 0x7f, 9, 3, 0xf7],
    [0, 0xf0, 5, 0x7e, 0x10, 9, 1, 0xf7],
  ]
  for (const packet of packets) {
    const asset = decodeMidi(midi([[...packet, 0, 0x90, 69, 100, 40, 0x80, 69, 0, 0, 0xff, 0x2f, 0]], 100))
    assert(asset.events.every((event) => event.outputTime === undefined))
    assert.equal(asset.sampleCount, 8820)
  }
})

test('looping and seeking replay the same physical reset schedule, while legacy MIDI assets remain valid', () => {
  for (const [repeats, noteTick] of [[1, 10], [2, 20]] as const) for (const position of [0, 1764, 4851]) {
    const actual = decodeMidi(midiResetDelayFile('gm', repeats)), reference = decodeMidi(midiResetReferenceFile(noteTick))
    assert.deepEqual(render(actual, 17640, position, true), render(reference, 17640, position, true))
  }
  const legacy = decodeMidi(midiResetReferenceFile(0))
  assert(legacy.events.every((event) => event.outputTime === undefined))
  const output = render(legacy, 100)
  assert(output.left.some((sample) => sample !== 0)); assert.deepEqual(output.left, output.right)
})
