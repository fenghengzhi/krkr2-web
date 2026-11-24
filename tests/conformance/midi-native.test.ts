import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { TjsError } from '../../src/engine/system/tjs-error.ts'
import { midi } from '../helpers/audio.ts'
import { midiOpenCases } from '../helpers/midi-contract.ts'

test('MIDISoundBuffer header IDs and short native stream reads have separate message holders', () => {
  for (const entry of midiOpenCases()) {
    if (entry.expected === 'opened') assert.equal(decodeMidi(entry.bytes).events.length, 2)
    else assert.throws(() => decodeMidi(entry.bytes), (err: unknown) => {
      if (entry.expected === 'read-short') return err instanceof TjsError && err.tjsMessage.id === 'TJSReadError'
      return err instanceof TvpError && err.tvpMessage.id === 'TVPInvalidSMF' &&
        err.tvpMessage.args.length === 1 && `smf:<${err.tvpMessage.args[0]}>` === entry.expected
    }, entry.id)
  }
})

test('SMF tempo folds into a DWORD, resets on zero, and short system messages consume their own operands', () => {
  const asset = decodeMidi(midi([[
    0, 0xff, 0x51, 5, 9, 0, 0x0f, 0x42, 0x40, // low DWORD = 1 second per quarter
    0, 0xf1, 24, 0, 25, 0, 0xf2, 1, 2, 0, 0xf3, 5, 0, 0xf6, 0, 0xf8,
    0x83, 0x60, 0x90, 60, 95, 0, 0xff, 0x51, 3, 0, 0, 0,
    0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0,
  ]]))
  assert.deepEqual(asset.events.map((event) => [event.time, event.status, ...event.data]), [
    [0, 0xf1, 24], [0, 0xf1, 25], [0, 0xf2, 1, 2], [0, 0xf3, 5], [0, 0xf6], [0, 0xf8],
    [1, 0x90, 60, 95], [1.5, 0x80, 60, 0],
  ])
  assert.equal(asset.sampleCount, 66150)
})

test('GM, GS and XG module resets silence active notes and restore channels at the end of a packet', () => {
  const send = (synth: MidiSynth, status: number, ...data: number[]) => synth.message({ status, data })
  for (const payload of [
    [0x7e, 0x7f, 9, 1], [0x7e, 0x7f, 9, 3], [0x41, 0x10, 0x42, 0x12, 0x40, 0, 0x7f, 0, 0x41],
    [0x41, 0x10, 0x42, 0x12, 0, 0, 0x7f, 0, 1], [0x43, 0x10, 0x4c, 0, 0, 0x7e, 0],
  ]) {
    const synth = new MidiSynth()
    send(synth, 0xb0, 7, 0); send(synth, 0x90, 60, 100)
    send(synth, 0xf0, ...payload.slice(0, 3))
    assert.equal(synth.activeNotes, 1)
    send(synth, 0xf8)
    send(synth, 0xf7, ...payload.slice(3), 0xf7)
    assert.equal(synth.activeNotes, 0)
    send(synth, 0x90, 69, 100)
    synth.render(0.02, 1 / 44100)
    assert.notEqual(synth.left, 0)
  }
  const synth = new MidiSynth()
  send(synth, 0x90, 60, 100)
  send(synth, 0xf0, 0x43, 0x10, 0x4c, 0, 0, 0x7e, 1, 0xf7)
  assert.equal(synth.activeNotes, 1)
  send(synth, 0xf0, 0x7e, 0x7f); send(synth, 0xb0, 10, 64); send(synth, 0xf7, 9, 1, 0xf7)
  assert.equal(synth.activeNotes, 1)
  send(synth, 0xf7, 0xf0, 0x7e, 0x7f, 9, 1, 0xf7)
  assert.equal(synth.activeNotes, 0)
})
