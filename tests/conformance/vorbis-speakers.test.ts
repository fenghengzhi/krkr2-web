import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { vorbisLayout } from '../../src/formats/audio/vorbis-layout.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { loadVorbisSpeakers, mixVorbisReference, vorbisSpeakerCases } from '../helpers/vorbis-speakers.ts'

test('Vorbis standard channels retain their declared identity and mono/stereo keep their previous layout', () => {
  const orders = [[0], [0, 1], [0, 2, 1], [0, 1, 2, 3], [0, 2, 1, 3, 4], [0, 2, 1, 5, 3, 4],
    [0, 2, 1, 6, 5, 3, 4], [0, 2, 1, 7, 5, 6, 3, 4]], masks = [undefined, undefined, 7, 0x33, 0x37, 0x3f, 0x70f, 0x63f]
  for (let count = 1; count <= 8; count++) {
    const layout = vorbisLayout(count)
    assert.deepEqual(layout.order ?? Array.from({ length: count }, (_, i) => i), orders[count - 1])
    assert.equal(layout.speakerMask, masks[count - 1])
  }
})

test('real 5.0, 6.1 and 7.1 Vorbis full/streamed PCM and audible stereo match independently named FFmpeg planes', { timeout: 120000 }, async () => {
  const directory = resolve('out/ci/vorbis-speakers'), observations: unknown[] = []
  mkdirSync(directory, { recursive: true })
  const compare = (actual: readonly Float32Array[], expected: readonly Float32Array[], bound: number) => {
    assert.equal(actual.length, expected.length)
    let maximum = 0
    for (let channel = 0; channel < actual.length; channel++) {
      assert.equal(actual[channel]!.length, expected[channel]!.length)
      for (let at = 0; at < actual[channel]!.length; at++) {
        const error = Math.abs(actual[channel]![at]! - expected[channel]![at]!)
        if (!Number.isFinite(error) || error > bound) throw new Error(`Vorbis PCM channel ${channel}, sample ${at}: ${actual[channel]![at]}, ${expected[channel]![at]}, error=${error}`)
        maximum = Math.max(maximum, error)
      }
    }
    return maximum
  }
  try {
    for (const entry of vorbisSpeakerCases) {
      const reference = loadVorbisSpeakers(entry), asset = await decodePortableAudio(reference.bytes, 'wave')
      assert(asset?.kind === 'pcm'); assert.equal(asset.speakerMask, entry.mask); assert.equal(asset.sampleCount, 96000)
      const maximumPlaneError = compare(asset.data.map((plane) => plane.subarray(reference.decodedStart)), reference.canonical, .00003),
        source = await openPortablePcmSource({ size: reference.bytes.length, async read(at, length) { return reference.bytes.slice(at, at + length) } })
      assert(source); assert.equal(source.info.speakerMask, entry.mask)
      try {
        for (let start = 0; start < 96000; start += 4096) {
          const frames = Math.min(4096, 96000 - start)
          assert.deepEqual(await source.read(start, frames), asset.data.map((plane) => plane.slice(start, start + frames)), `${entry.name}:sequential:${start}`)
        }
        for (const start of [0, 4091, 70000, 24000, 91904]) {
          const frames = Math.min(4096, 96000 - start), actual = await source.read(start, frames)
          assert.deepEqual(actual, asset.data.map((plane) => plane.slice(start, start + frames)), `${entry.name}:${start}`)
        }
      } finally { await source.close() }
      const mixer = new AudioMixer(48000), left = new Float32Array(96000), right = new Float32Array(96000)
      try {
        mixer.command({ op: 'load', id: 1, kind: 'wave', asset, settings: defaultSoundSettings() }); mixer.command({ op: 'play', id: 1 })
        assert.deepEqual(mixer.render(left, right), [])
        assert.deepEqual([left, right], mixVorbisReference(entry, asset.data), 'Web arithmetic and declared planes stay exact')
        const maximumStereoError = compare([left, right].map((plane) => plane.subarray(reference.decodedStart)), reference.stereo, .0001)
        observations.push({ name: entry.name, channels: entry.channels, mask: asset.speakerMask, maximumPlaneError, maximumStereoError,
          independentDecodedStart: reference.decodedStart, independentDecodedFrames: reference.decodedFrames,
          pcmSha256: [left, right].map((plane) => createHash('sha256').update(new Uint8Array(plane.buffer)).digest('hex')) })
      } finally { mixer.command({ op: 'shutdown' }) }
    }
    writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify({ complete: true, observations,
      scope: 'Independent FFmpeg float decoder/downmix comparison; production full vs streaming and mixer arithmetic use exact equality.' }, null, 2))
  } catch (error) {
    writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify({ complete: false, observations, error: String(error) }, null, 2)); throw error
  }
})
