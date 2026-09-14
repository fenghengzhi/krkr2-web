import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { decodeMidi } from '../../src/formats/audio/midi.ts'
import { parseSli } from '../../src/formats/audio/sli.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { wave, midi } from '../helpers/audio.ts'
import { encodedSampleRate } from '../../src/formats/audio/encoded-rate.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { readFileSync } from 'node:fs'

test('WAVE decoder retains original sample rate, PCM channel order and bounded chunk reads', () => {
  const source = wave([-0.5, 0.25, 1, -1], 44100, 2),
    wrapped = new Uint8Array(source.length + 17)
  wrapped.set(source, 9)
  const pcm = decodeWav(wrapped.subarray(9, 9 + source.length))!
  assert.equal(pcm.sampleRate, 44100)
  assert.equal(pcm.channels, 2)
  assert.equal(pcm.sampleCount, 2)
  assert.deepEqual(Array.from(pcm.data[0]!), [-0.5, 32767 / 32768])
  assert.deepEqual(Array.from(pcm.data[1]!), [0.25, -1])
  assert.throws(() => decodeWav(source.subarray(0, source.length - 1)), /Truncated/)
})

test('delegated decoders use the encoded source clock, including the fixed Opus clock', () => {
  const ogg = (packet: Uint8Array, serial = 7) => {
    const bytes = new Uint8Array(28 + packet.length)
    bytes.set([79, 103, 103, 83, 0, 2])
    new DataView(bytes.buffer).setUint32(14, serial, true)
    bytes[26] = 1
    bytes[27] = packet.length
    bytes.set(packet, 28)
    return bytes
  }
  const vorbis = new Uint8Array(30)
  vorbis.set([1, 118, 111, 114, 98, 105, 115])
  vorbis[11] = 2
  vorbis[29] = 1
  new DataView(vorbis.buffer).setUint32(12, 44100, true)
  const encoded = ogg(vorbis),
    wrapped = new Uint8Array(encoded.length + 17)
  wrapped.set(encoded, 9)
  assert.equal(encodedSampleRate(wrapped.subarray(9, 9 + encoded.length)), 44100)
  const opus = new Uint8Array(19)
  opus.set([79, 112, 117, 115, 72, 101, 97, 100, 1, 2])
  new DataView(opus.buffer).setUint32(12, 22050, true)
  assert.equal(encodedSampleRate(ogg(opus)), 48000)
  assert.equal(encodedSampleRate(wave([0, 0], 32000)), 32000)
  assert.equal(encodedSampleRate(new Uint8Array([0xff, 0xfb, 0x90, 0x64])), 44100)
  assert.equal(encodedSampleRate(new Uint8Array([0xff, 0xf3, 0x98, 0x64])), 16000)
  assert.throws(() => encodedSampleRate(encoded.subarray(0, encoded.length - 1)), /Truncated/)
  assert.throws(() => encodedSampleRate(new Uint8Array([...encoded, ...ogg(vorbis, 8)])), /Chained/)
})

test('portable Vorbis decoding preserves the last samples and refuses incomplete or excessive streams', async () => {
  const bytes = readFileSync(new URL('../fixtures/audio/tone.ogg', import.meta.url))
  const asset = await decodePortableAudio(bytes, 'wave')
  assert.equal(asset?.kind, 'pcm')
  assert.equal(asset.sampleRate, 44100)
  assert.equal(asset.sampleCount, 11025)
  if (asset.kind !== 'pcm') throw new Error('Expected PCM')
  assert.ok(Math.abs(asset.data[0]![0]! + 0.00201121368) < 1e-6)
  assert.ok(
    asset.data.every((channel) => channel.length === 11025 && channel.every(Number.isFinite)),
  )
  await assert.rejects(
    decodePortableAudio(bytes.subarray(0, bytes.length - 1), 'wave'),
    /Truncated/,
  )
  const excessive = Uint8Array.from(bytes),
    view = new DataView(excessive.buffer)
  for (let at = 0; at < excessive.length;) {
    const count = excessive[at + 26]!
    let length = 0
    for (let i = 0; i < count; i++) length += excessive[at + 27 + i]!
    if (excessive[at + 5]! & 4) view.setBigUint64(at + 6, 1000000000n, true)
    at += 27 + count + length
  }
  await assert.rejects(decodePortableAudio(excessive, 'wave'), /budget/)
})

test('MIDI tempo maps merge tracks and running status without changing event order', () => {
  const asset = decodeMidi(
    midi([
      [
        0, 0xff, 0x51, 3, 0x0f, 0x42, 0x40, 0x81, 0x70, 0xff, 0x51, 3, 7, 0xa1, 0x20, 0x81, 0x70,
        0xff, 0x2f, 0,
      ],
      [
        0, 0xc0, 4, 0, 0x90, 60, 100, 0x81, 0x70, 64, 80, 0x81, 0x70, 0x80, 60, 0, 0, 64, 0, 0,
        0xff, 0x2f, 0,
      ],
    ]),
  )
  assert.deepEqual(
    asset.events.map((event) => [event.time, event.status, event.data[0]]),
    [
      [0, 0xc0, 4],
      [0, 0x90, 60],
      [0.5, 0x90, 64],
      [0.75, 0x80, 60],
      [0.75, 0x80, 64],
    ],
  )
  assert.equal(asset.sampleCount, 33075)
  assert.throws(() => decodeMidi(midi([[0, 60, 100, 0, 0xff, 0x2f, 0]])), /running status/)
})

test('SLI conditional links and label expressions are resolved at source sample positions', () => {
  const asset = decodeWav(wave([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]))!
  asset.loops = parseSli(
    '#2.00\nLink {From=6;To=2;Smooth=False;Condition=eq;RefValue=0;CondVar=0;}\nLabel {Position=3;Name=\":[0]++\";}\nLabel {Position=4;Name=\"mark\";}',
  )
  const mixer = new AudioMixer(1000)
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  const left = new Float32Array(10),
    right = new Float32Array(10),
    events = mixer.render(left, right)
  assert.equal(mixer.snapshot(1).flags[0], 1)
  assert.deepEqual(
    events.map((event) => (event.type === 'label' ? event.label : event.type)),
    [':[0]++', 'mark', 'ended'],
  )
  assert.equal(mixer.snapshot(1).status, 'stop')
  assert.ok(Math.abs(left[7]! - 0.7) < 0.001)
})

test('mixer playback, seek, pause, pan and EOF loop preserve independent voice state', () => {
  const asset = decodeWav(wave([0.25, 0.5, 0.75, 1]))!,
    mixer = new AudioMixer(1000),
    settings = defaultSoundSettings()
  mixer.command({ op: 'load', id: 1, asset, settings })
  mixer.command({ op: 'set', id: 1, property: 'pan', value: -100000 })
  mixer.command({ op: 'set', id: 1, property: 'looping', value: true })
  mixer.command({ op: 'play', id: 1 })
  const left = new Float32Array(6),
    right = new Float32Array(6)
  mixer.render(left, right)
  assert.deepEqual(Array.from(left), [0.25, 0.5, 0.75, 32767 / 32768, 0.25, 0.5])
  assert.ok(right.every((sample) => sample === 0))
  mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
  mixer.render(left, right)
  assert.equal(mixer.snapshot(1).position, 2)
  assert.ok(left.every((sample) => sample === 0))
  mixer.command({ op: 'set', id: 1, property: 'position', value: 1 })
  mixer.command({ op: 'set', id: 1, property: 'paused', value: false })
  mixer.render(left, right)
  assert.equal(left[0], 0.5)
  mixer.command({ op: 'stop', id: 1 })
  assert.equal(mixer.snapshot(1).position, 0)
})

test('resampling visits conditional labels and short loops even between output samples', () => {
  const mixer = new AudioMixer(1000),
    asset = decodeWav(wave([0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7]))!
  asset.loops = parseSli(
    '#2.00\nLink {From=4;To=2;Condition=lt;RefValue=3;CondVar=0;}\nLabel {Position=1;Name=\":[0]=0\";}\nLabel {Position=3;Name=\":[0]++\";}',
  )
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
  mixer.command({ op: 'set', id: 1, property: 'frequency', value: 10000 })
  mixer.command({ op: 'play', id: 1 })
  const left = new Float32Array(3),
    right = new Float32Array(3),
    events = mixer.render(left, right)
  assert.equal(mixer.snapshot(1).flags[0], 3)
  assert.deepEqual(
    events.map((event) => (event.type === 'label' ? event.label : event.type)),
    [':[0]=0', ':[0]++', ':[0]++', ':[0]++', 'ended'],
  )
  assert.ok(Math.abs(left[1]! - 0.6) < 0.001)
  assert.equal(mixer.snapshot(1).status, 'stop')
})

test('fade delay and 60ms ticks continue while individually paused and freeze with the session', () => {
  const mixer = new AudioMixer(1000),
    asset = decodeWav(wave(Array(500).fill(0.5)))!
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  mixer.command({ op: 'set', id: 1, property: 'paused', value: true })
  mixer.command({ op: 'fade', id: 1, target: 0, time: 120, delay: 60 })
  mixer.render(new Float32Array(120), new Float32Array(120))
  assert.equal(mixer.snapshot(1).volume, 50000)
  mixer.command({ op: 'pauseAll', paused: true })
  mixer.render(new Float32Array(1000), new Float32Array(1000))
  assert.equal(mixer.snapshot(1).volume, 50000)
  mixer.command({ op: 'pauseAll', paused: false })
  const events = mixer.render(new Float32Array(60), new Float32Array(60))
  assert.equal(mixer.snapshot(1).volume, 0)
  assert.equal(events[0]?.type, 'fade')
  mixer.command({ op: 'fade', id: 1, target: 100000, time: 1000, delay: 0 })
  const stopped = mixer.command({ op: 'stopFade', id: 1, finish: true })
  assert.equal(stopped.snapshot!.volume, 100000)
  assert.equal(stopped.events[0]?.type, 'fade')
})

test('MIDI synthesis produces PCM and controller all-sound-off silences live notes', () => {
  const mixer = new AudioMixer(48000),
    left = new Float32Array(2048),
    right = new Float32Array(2048)
  mixer.command({ op: 'midiOut', data: new Uint8Array([0x90, 69, 100]) })
  mixer.render(left, right)
  assert.ok(left.some((sample) => Math.abs(sample) > 0.01))
  mixer.command({ op: 'midiOut', data: new Uint8Array([0xb0, 120, 0]) })
  mixer.render(left, right)
  assert.ok(left.every((sample) => sample === 0))
  const asset = decodeMidi(midi([[0, 0x90, 60, 100, 0x83, 0x60, 0x80, 60, 0, 0, 0xff, 0x2f, 0]]))
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  mixer.render(left, right)
  assert.ok(mixer.peak > 0.01)
})

test('cyclic SLI links stop the affected voice and report failure without killing the mixer', () => {
  const mixer = new AudioMixer(1000),
    broken = decodeWav(wave([0.1, 0.2, 0.3, 0.4]))!,
    healthy = decodeWav(wave([0.5, 0.5, 0.5, 0.5]))!
  broken.loops = parseSli('#2.00\nLink {From=0;To=0;Smooth=False;}')
  mixer.command({ op: 'load', id: 1, asset: broken, settings: defaultSoundSettings() })
  mixer.command({ op: 'load', id: 2, asset: healthy, settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  mixer.command({ op: 'play', id: 2 })
  const left = new Float32Array(4),
    right = new Float32Array(4),
    events = mixer.render(left, right)
  assert.equal(events.length, 1)
  assert.equal(events[0]!.type, 'error')
  assert.equal(mixer.snapshot(1).status, 'stop')
  assert.deepEqual(Array.from(left), [0.5, 0.5, 0.5, 0.5])
  assert.doesNotThrow(() => mixer.command({ op: 'inspect', id: 2 }))
})

test('Wave global gain and focus mute leave MIDI and CDDA voices on their own gain controls', () => {
  const mixer = new AudioMixer(1000),
    asset = decodeWav(wave([0.5, 0.5, 0.5, 0.5]))!
  mixer.command({ op: 'load', id: 1, asset, kind: 'wave', settings: defaultSoundSettings() })
  mixer.command({ op: 'load', id: 2, asset, kind: 'cdda', settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  mixer.command({ op: 'play', id: 2 })
  mixer.command({ op: 'globalVolume', volume: 0 })
  const left = new Float32Array(2),
    right = new Float32Array(2)
  mixer.render(left, right)
  assert.deepEqual(Array.from(left), [0.5, 0.5])
  mixer.command({ op: 'globalVolume', volume: 100000 })
  mixer.command({ op: 'waveMuted', muted: true })
  mixer.render(left, right)
  assert.deepEqual(Array.from(left), [0.5, 0.5])
  assert.equal(mixer.snapshot(1).position, 4)
})
