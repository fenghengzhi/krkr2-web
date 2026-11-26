import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { speakerWave, waveSpeakerCases } from '../helpers/wave-speakers.ts'

test('ordinary six-channel integer and float WAVE applies the fixed native permutation before stereo mixing', () => {
  for (const bits of [8, 16, 24, 32] as const) for (const floating of bits === 32 ? [false, true] : [false]) {
    const bytes = speakerWave(waveSpeakerCases.map((row) => row.legacy), { bits, floating }), before = bytes.slice(), asset = decodeWav(bytes)!
    assert.equal(asset.channels, 6); assert.equal(asset.sampleCount, 6)
    for (let frame = 0; frame < 6; frame++)
      assert.deepEqual(asset.data.map((plane) => plane[frame]), waveSpeakerCases[frame]!.masked)
    const mixer = new AudioMixer(1000)
    mixer.command({ op: 'load', id: 1, asset, kind: 'wave', settings: defaultSoundSettings() }); mixer.command({ op: 'play', id: 1 })
    const left = new Float32Array(6), right = new Float32Array(6)
    mixer.render(left, right)
    assert.deepEqual([...left], waveSpeakerCases.map((row) => Math.fround(row.stereo[0])))
    assert.deepEqual([...right], waveSpeakerCases.map((row) => Math.fround(row.stereo[1])))
    assert.deepEqual(bytes, before)
    mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0)
    const signed = speakerWave([[0.5, -0.25, 0.125, -0.0625, 0.03125, -0.015625]], { bits, floating }),
      offset = new Uint8Array(signed.length + 10)
    offset.set(signed, 7)
    assert.deepEqual(decodeWav(offset.subarray(7, 7 + signed.length))!.data.map((plane) => plane[0]),
      [0.5, 0.125, -0.25, -0.015625, -0.0625, 0.03125])
  }
})

test('a nonzero extensible speaker mask keeps its physical order, while a zero mask takes the native legacy route', () => {
  for (const floating of [false, true]) {
    const options = { bits: 32 as const, floating }, rows = waveSpeakerCases.map((row) => row.legacy),
      zero = decodeWav(speakerWave(rows, { ...options, mask: 0 }))!,
      explicit = decodeWav(speakerWave(rows, { ...options, mask: 0x3f }))!,
      reference = decodeWav(speakerWave(waveSpeakerCases.map((row) => row.masked), { ...options, mask: 0x3f }))!
    assert.deepEqual(zero.data, reference.data)
    for (let frame = 0; frame < rows.length; frame++) assert.deepEqual(explicit.data.map((plane) => plane[frame]), rows[frame])
    assert.notDeepEqual(explicit.data, zero.data, 'A mask is not merely decorative metadata')
  }
  for (const channels of [1, 2, 4]) {
    const rows = [[0.5, -0.25, 0.125, -0.0625].slice(0, channels)], asset = decodeWav(speakerWave(rows))!
    assert.deepEqual(asset.data.map((plane) => [...plane]), rows[0]!.map((value) => [value]))
  }
})

test('streaming six-channel reads preserve native planes across page seeks, EOF and independent output ownership', async () => {
  for (const mask of [undefined, 0, 0x3f]) {
    const rows = waveSpeakerCases.map((row) => mask ? row.masked : row.legacy),
      bytes = speakerWave(rows, { frames: 8203, bits: 24, mask }), reads: [number, number][] = [],
      source = await openPortablePcmSource({ size: bytes.length, async read(at, count) {
        reads.push([at, count]); return bytes.subarray(at, at + count)
      } })
    assert(source)
    try {
      for (const [at, count] of [[4094, 7], [8199, 20], [0, 6]] as const) {
        const output = await source.read(at, count), length = Math.min(count, 8203 - at)
        for (let channel = 0; channel < 6; channel++) {
          assert.deepEqual([...output[channel]!], Array.from({ length }, (_, index) => waveSpeakerCases[(at + index) % 6]!.masked[channel]))
          assert.equal(output[channel]!.byteOffset, 0)
        }
        output[0]!.fill(99)
      }
      assert(reads.every(([, size]) => size <= 65536))
      assert.deepEqual((await source.read(8203, 1)).map((plane) => plane.length), [0, 0, 0, 0, 0, 0])
    } finally { await source.close() }
  }
})
