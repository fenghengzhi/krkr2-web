import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeWav } from '../../src/formats/audio/wav.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { AudioMixer } from '../../src/engine/media/mixer.ts'
import { defaultSoundSettings } from '../../src/engine/ports/audio.ts'
import { waveMaskCases, waveMaskFiles } from '../helpers/wave-speaker-mask.ts'
import { speakerWave } from '../helpers/wave-speakers.ts'

test('declared WAVE speaker identities select the stereo planes independently of channel count and storage width', () => {
  for (const bits of [8, 16, 24, 32] as const) for (const floating of bits === 32 ? [false, true] : [false]) {
    for (const entry of waveMaskCases) {
      const bytes = speakerWave([entry.row], { bits, floating, mask: entry.mask, frames: 20 }),
        asset = decodeWav(bytes)!, mixer = new AudioMixer(1000)
      assert.equal(asset.speakerMask, entry.mask); assert.equal(asset.channels, entry.row.length)
      assert.deepEqual(asset.data.map((plane) => plane[0]), entry.row, 'Declared planes are not permuted or discarded by decoding')
      mixer.command({ op: 'load', id: 1, asset, kind: 'wave', settings: defaultSoundSettings() })
      mixer.command({ op: 'play', id: 1 })
      const left = new Float32Array(20), right = new Float32Array(20)
      mixer.render(left, right)
      assert.deepEqual([...left], Array(20).fill(Math.fround(entry.stereo[0])))
      assert.deepEqual([...right], Array(20).fill(Math.fround(entry.stereo[1])))
      mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0)
    }
  }
  for (const mask of [undefined, 0]) {
    const asset = decodeWav(speakerWave([[0, 0, .5, 0]], { mask }))!, mixer = new AudioMixer(1000)
    assert.equal(asset.speakerMask, undefined)
    mixer.command({ op: 'load', id: 2, asset, settings: defaultSoundSettings() }); mixer.command({ op: 'play', id: 2 })
    const left = new Float32Array(1), right = new Float32Array(1); mixer.render(left, right)
    assert.deepEqual([...left, ...right], [Math.fround(.35355339), 0], 'Unspecified four-channel audio remains the original quad path')
    mixer.command({ op: 'shutdown' })
  }
})

test('range WAVE keeps the mask and original interleaved samples across distant reads and partial EOF', async () => {
  const files = waveMaskFiles()
  for (const entry of waveMaskCases) {
    const bytes = files[`mask-${entry.name}.wav`] as Uint8Array, reads: number[] = [],
      source = await openPortablePcmSource({ size: bytes.length, async read(at, count) {
        reads.push(count); return bytes.subarray(at, at + count)
      } }, { waveNativeRiff: true })
    assert(source)
    try {
      assert.equal(source.info.speakerMask, entry.mask)
      for (const [at, count] of [[8190, 8], [31996, 20], [0, 8]] as const) {
        const output = await source.read(at, count), length = Math.min(count, 32000 - at)
        assert.deepEqual(output.map((plane) => [...plane]), entry.row.map((value) =>
          Array.from({ length }, (_, frame) => value === 0 ? 0 : (at + frame) % 8 < 4 ? value : -value)))
      }
      assert(reads.every((count) => count <= 65536))
    } finally { await source.close() }
  }
})

test('a valid height-speaker WAVE retains its former eight-channel playback while preserving its declared layout', () => {
  // FL FR FC LFE SL SR TFL TFR: a real 5.1.2 header, outside the new
  // horizontal map. Its previous count-based output must remain playable.
  const asset = decodeWav(speakerWave([[0, 0, 0, 0, 0, 0, .5, 0]], { mask: 0x560f, frames: 20 }))!,
    mixer = new AudioMixer(1000)
  assert.equal(asset.speakerMask, 0x560f); assert.equal(asset.channels, 8)
  mixer.command({ op: 'load', id: 1, asset, settings: defaultSoundSettings() }); mixer.command({ op: 'play', id: 1 })
  const left = new Float32Array(20), right = new Float32Array(20); mixer.render(left, right)
  assert.deepEqual([...left], Array(20).fill(.25)); assert.deepEqual([...right], Array(20).fill(0))
  mixer.command({ op: 'shutdown' })
})

test('forced mono conversion averages physical WAVE planes before speaker routing, and replacement cannot retain the previous mask', () => {
  const mixer = new AudioMixer(1000), asset = decodeWav(speakerWave([[0, 0, .5]], { mask: 0xb, frames: 20 }))!,
    output = () => { const left = new Float32Array(20), right = new Float32Array(20); mixer.render(left, right); return [[...left], [...right]] }
  mixer.command({ op: 'load', id: 1, asset, kind: 'wave', settings: { ...defaultSoundSettings(), waveConversion: 'i16m' } })
  mixer.command({ op: 'play', id: 1 })
  // Stock integer average: trunc(16384 / 3) = 5461, then normalize to i16.
  assert.deepEqual(output(), [Array(20).fill(5461 / 32768), Array(20).fill(5461 / 32768)])
  const normal = decodeWav(speakerWave([[.25, -.5]], { frames: 20 }))!
  mixer.command({ op: 'load', id: 1, asset: normal, kind: 'wave', settings: defaultSoundSettings() })
  mixer.command({ op: 'play', id: 1 })
  assert.deepEqual(output(), [Array(20).fill(.25), Array(20).fill(-.5)])
  mixer.command({ op: 'shutdown' }); assert.equal(mixer.inspect().voices, 0)
})
