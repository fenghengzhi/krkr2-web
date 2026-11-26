import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import type { ByteSource } from '../../src/engine/ports/storage.ts'
import { mp3Reference } from '../helpers/cdda-mp3.ts'

const hash = (planes: readonly Float32Array[]) => planes.map((plane) => createHash('sha256')
  .update(new Uint8Array(plane.buffer, plane.byteOffset, plane.byteLength)).digest('hex'))
const deferred = <T>() => { let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done }); return { promise, resolve } }

test('CUE MP3 CBR/VBR uses one gapless PCM timeline for sequential reads, independent FFmpeg windows and backward/forward seeks', { timeout: 180000 }, async () => {
  const { manifest, files, windows } = mp3Reference(), directory = resolve('out/ci/cdda-mp3'), observations: unknown[] = []
  mkdirSync(directory, { recursive: true })
  try {
    for (const variant of manifest.variants) {
      const bytes = files.get(variant.file)!, reads: { at: number; length: number }[] = [],
        input: ByteSource = { size: bytes.length, async read(at, length) { reads.push({ at, length }); return bytes.subarray(at, at + length) } }
      assert.equal(await openPortablePcmSource(input), undefined, 'ordinary Wave has no new automatic codec fallback')
      reads.length = 0
      const source = await openPortablePcmSource(input, { cddaFile: true })
      assert(source)
      const baseline = new Map(variant.windows.map((window) => [window.file,
        [new Float32Array(window.frames), new Float32Array(window.frames)]])), maxima = new Map<string, number>()
      try {
        assert.deepEqual({ ...source.info, loops: undefined }, { sampleRate: 44100, channels: 2, bits: 32,
          pcmEncoding: 'f32', sampleCount: 5292137, loops: undefined })
        assert(reads.every((read) => read.length <= 65536))
        assert(reads.reduce((sum, read) => sum + read.length, 0) <= bytes.length + 4 * 65536, 'metadata scan uses bounded read windows')
        for (let start = 0; start < variant.frames; start += 4096) {
          const count = Math.min(4096, variant.frames - start), actual = await source.read(start, count)
          for (const plane of actual) { assert.equal(plane.length, count); assert(plane.every(Number.isFinite)) }
          for (const window of variant.windows) {
            const first = Math.max(start, window.start), end = Math.min(start + count, window.start + window.frames)
            if (end <= first) continue
            const reference = windows.get(window.file)!, saved = baseline.get(window.file)!
            for (let channel = 0; channel < 2; channel++) for (let frame = first; frame < end; frame++) {
              const value = actual[channel]![frame - start]!, expected = reference[channel]![frame - window.start]!, error = Math.abs(value - expected)
              if (!Number.isFinite(error) || error > .00003)
                throw new Error(`${variant.name}/${window.name} PCM ${frame}, channel ${channel}: ${value} != ${expected}, error ${error}`)
              maxima.set(window.name, Math.max(maxima.get(window.name) ?? 0, error)); saved[channel]![frame - window.start] = value
            }
          }
        }
        for (const window of [...variant.windows].reverse()) for (const offset of [0, 37, 4093, window.frames - 4096]) {
          const count = Math.min(4096, window.frames - offset), actual = await source.read(window.start + offset, count)
          assert.deepEqual(actual, baseline.get(window.file)!.map((plane) => plane.slice(offset, offset + count)),
            `${variant.name}/${window.name}: seek restores every decoded sample, including the bit reservoir`)
        }
        assert.deepEqual((await source.read(variant.frames, 64)).map((plane) => plane.length), [0, 0])
        observations.push({ name: variant.name, info: source.info, encodedSha256: variant.sha256,
          independentFullPcmSha256: variant.fullPcmSha256, reads: reads.length, maximumReadBytes: Math.max(...reads.map((read) => read.length)),
          windows: variant.windows.map((window) => ({ name: window.name, start: window.start, frames: window.frames,
            maximumReferenceError: maxima.get(window.name), pcmSha256: hash(baseline.get(window.file)!) })) })
      } finally { await source.close() }
    }
    writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify({ complete: true, observations }, null, 2))
  } catch (error) { writeFileSync(resolve(directory, 'comparison.json'), JSON.stringify({ complete: false, observations, error: String(error) }, null, 2)); throw error }
})

test('long MP3 metadata and sparse independent seek frames stay bounded without allocating an encoded song or whole PCM track', { timeout: 60000 }, async () => {
  // Ordinary silent MPEG-1 Layer III frames: zero side information has no
  // reservoir dependency and zero spectral values. No decoder is involved
  // in discovering the 8 MiB source or its 522-second PCM duration.
  const frameBytes = 417, frames = 20000, prefix = [255, 251, 144, 0], reads: number[] = [],
    input: ByteSource = { size: frameBytes * frames, async read(at, length) {
      reads.push(length)
      return Uint8Array.from({ length }, (_, i) => prefix[(at + i) % frameBytes] ?? 0)
    } }, source = await openPortablePcmSource(input, { cddaFile: true })
  assert(source)
  try {
    assert.equal(source.info.sampleCount, frames * 1152); assert.equal(source.info.sampleRate, 44100)
    assert(reads.length < 256); assert(Math.max(...reads) <= 65536)
    const count = reads.length, actual = await source.read(source.info.sampleCount - 128, 128)
    assert(actual.every((plane) => plane.length === 128 && plane.every((value) => value === 0)))
    assert(reads.length - count < 8, 'a late independent-frame seek reads its preroll, not the whole song')
  } finally { await source.close() }
})

test('ordinary MP3 source cancellation closes a held read and leaves the borrowed immutable media reusable', { timeout: 60000 }, async () => {
  const { files } = mp3Reference(), bytes = files.get('cbr.mp3')!, held = deferred<Uint8Array>(), entered = deferred<void>()
  let hold = false, late: { at: number; length: number } | undefined
  const input: ByteSource = { size: bytes.length, async read(at, length) {
    if (hold) { late = { at, length }; entered.resolve(); return held.promise }
    return bytes.subarray(at, at + length)
  } }, source = await openPortablePcmSource(input, { cddaFile: true })
  assert(source); hold = true
  const reading = source.read(4410000, 4096), observed = reading.then((value) => ({ value }), (error: unknown) => ({ error }))
  try {
    await Promise.race([entered.promise, observed.then((result) => {
      throw 'error' in result ? result.error : new Error('MP3 read finished before its held source was reached')
    })])
    await source.close()
    const cancelled = await observed
    assert('error' in cancelled); assert.match(String(cancelled.error), /closed/)
    assert(late); held.resolve(bytes.subarray(late.at, late.at + late.length)); hold = false
    const reopened = await openPortablePcmSource(input, { cddaFile: true })
    assert(reopened)
    try { assert((await reopened.read(0, 128)).some((plane) => plane.some((value) => value !== 0))) }
    finally { await reopened.close() }
  } finally { hold = false; held.resolve(new Uint8Array()); await source.close(); await observed }
})
