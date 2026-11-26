import assert from 'node:assert/strict'
import test from 'node:test'
import { MidiSynth } from '../../src/engine/media/midi-synth.ts'
import { midiBufferVolume } from '../../src/engine/media/midi-volume.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { midiVolumeCases, midiVolumeFile } from '../helpers/midi-volume.ts'
import { midi } from '../helpers/audio.ts'

test('MIDI public volume pairs use the two original integer quantization stages', () => {
  for (const entry of midiVolumeCases)
    assert.equal(midiBufferVolume(entry.volume, entry.volume2), entry.buffer, entry.name)
})

test('SMF notes and channel resets produce the same complete PCM as literal rewritten CC7 controls', () => {
  const send = (synth: MidiSynth, status: number, ...data: number[]) => synth.message({ status, data })
  for (const entry of midiVolumeCases) {
    const actual = new MidiSynth(), reference = new MidiSynth()
    actual.setBufferVolume(entry.buffer)
    for (const synth of [actual, reference]) { send(synth, 0xc0, 48); send(synth, 0x90, 69, 100) }
    send(actual, 0xb0, 7, entry.channel); send(reference, 0xb0, 7, entry.output)
    const compare = (start: number) => {
      for (let frame = start; frame < start + 100; frame++) {
        actual.render(frame / 1000, 0.001); reference.render(frame / 1000, 0.001)
        assert.deepEqual([actual.left, actual.right], [reference.left, reference.right], `${entry.name}:${frame}`)
      }
    }
    compare(0)
    send(actual, 0xb0, 121, 0); send(reference, 0xb0, 121, 0)
    const resetVolumes: Record<number, number> = { 127: 100, 126: 99, 63: 49, 28: 22, 2: 1, 1: 0 }
    send(reference, 0xb0, 7, resetVolumes[entry.buffer]!)
    compare(100)
    for (const synth of [actual, reference]) {
      send(synth, 0xf0, 0x7e, 0x7f, 9, 1, 0xf7)
      send(synth, 0xc0, 48); send(synth, 0x90, 69, 100)
    }
    send(reference, 0xb0, 7, resetVolumes[entry.buffer]!)
    compare(200)
    actual.rawMessage({ status: 0xb0, data: [7, 127] }); send(reference, 0xb0, 7, 127)
    actual.setBufferVolume(entry.buffer)
    compare(300)
    // Raw CC7 bypasses this buffer but must not overwrite the original SMF
    // channel100 remembered for the next actual buffer-volume change.
    actual.setBufferVolume(entry.buffer === 63 ? 28 : 63)
    send(reference, 0xb0, 7, entry.buffer === 63 ? 22 : 49)
    compare(400)
  }
  // No file CC7 precedes this delayed first note. Raw output before that note
  // must yield to the original sequencer's first-use CC100 -> CC49 resend.
  const delayed = new MidiSynth(decodeMidi(midi([[0, 0xc0, 48, 96, 0x90, 69, 100,
    96, 0x80, 69, 0, 0, 0xff, 0x2f, 0]]))),
    delayedReference = new MidiSynth(decodeMidi(midi([[0, 0xc0, 48, 96, 0xb0, 7, 49,
      0, 0x90, 69, 100, 96, 0x80, 69, 0, 0, 0xff, 0x2f, 0]])))
  delayed.setBufferVolume(63)
  for (let frame = 0; frame < 160; frame++) {
    if (frame === 50) delayed.rawMessage({ status: 0xb0, data: [7, 127] })
    delayed.render(frame / 1000, 0.001); delayedReference.render(frame / 1000, 0.001)
    assert.deepEqual([delayed.left, delayed.right], [delayedReference.left, delayedReference.right], `delayed-first-note:${frame}`)
  }
  assert.notEqual(delayed.left, 0, 'The delayed first note must actually become audible')
})

test('MIDI fade updates the channel volume at its real beat, with no second final-PCM gain', () => {
  const mixer = new AudioMixer(1000), reference = new MidiSynth(decodeMidi(midiVolumeFile(100))),
    actualL = new Float32Array(120), actualR = new Float32Array(120), expectedL = new Float32Array(120), expectedR = new Float32Array(120)
  mixer.command({ op: 'load', id: 1, kind: 'midi', asset: decodeMidi(midiVolumeFile(100)), settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 }); mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 0 })
  // The existing fade clock updates before samples 59 and 119. These reference
  // events contain authored output CC7 bytes, never a computed buffer gain.
  let position = 0
  for (let frame = 0; frame < 120; frame++) {
    if (frame === 59 || frame === 119) reference.message({ status: 0xb0, data: [7, frame === 59 ? 49 : 0] })
    reference.render(position / 44100, 44.1 / 44100)
    expectedL[frame] = 0 + reference.left; expectedR[frame] = 0 + reference.right
    position += 44.1
  }
  const events = mixer.render(actualL, actualR)
  assert.deepEqual(actualL, expectedL); assert.deepEqual(actualR, expectedR)
  assert.equal(events.filter((event) => event.type === 'fade').length, 1)
  assert.equal(mixer.snapshot(1).volume, 0)
  mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0)
  const isolated = new AudioMixer(1000), rawReference = new AudioMixer(1000)
  isolated.command({ op: 'load', id: 2, kind: 'midi', asset: decodeMidi(midiVolumeFile()),
    settings: { ...defaultSoundSettings(), volume: 0 } })
  isolated.command({ op: 'play', id: 2 })
  for (const target of [isolated, rawReference]) target.command({ op: 'midiOut', data: new Uint8Array([0x90, 69, 100]) })
  isolated.render(actualL, actualR); rawReference.render(expectedL, expectedR)
  assert.deepEqual(actualL, expectedL); assert.deepEqual(actualR, expectedR)
  assert(actualL.some((sample) => sample !== 0), 'A silent SMF buffer must not mute independent raw MIDI output')
  isolated.command({ op: 'shutdown' }); rawReference.command({ op: 'shutdown' })
})
