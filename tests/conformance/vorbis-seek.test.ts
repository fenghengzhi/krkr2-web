import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdirSync, writeFileSync } from 'node:fs'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { longVorbisBytes, longVorbisRate as rate, longVorbisSamples as samples } from '../helpers/long-vorbis.ts'

async function baseline(bytes: Uint8Array) {
  const result = await decodePortableAudio(bytes, 'wave')
  assert(result?.kind === 'pcm'); assert.equal(result.sampleCount, samples)
  return result.data
}
function same(actual: Float32Array[], expected: Float32Array[], at: number, count: number) {
  assert.equal(actual.length, 2)
  actual.forEach((plane, channel) => assert.deepEqual(plane, expected[channel]!.slice(at, at + count)))
}
const deferred = <T = void>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

test('long Vorbis far/backward seeks preserve every PCM sample while reading only local pages and genuine setup', { timeout: 120000 }, async () => {
  const bytes = longVorbisBytes(), expected = await baseline(bytes), reads: Array<[number, number]> = [],
    source = await openPortablePcmSource({ size: bytes.length, async read(at, count) {
      reads.push([at, count]); return bytes.subarray(at, at + count)
    } })
  assert(source)
  const observations: unknown[] = []
  try {
    assert.equal(source.info.sampleCount, samples); assert.equal(source.info.sampleRate, rate)
    for (const at of [85 * rate + 17, 48 * rate + 31, 85 * rate + 129, 4 * rate + 7, samples - 5000, 0]) {
      reads.length = 0
      const count = Math.min(10007, samples - at)
      same(await source.read(at, count), expected, at, count)
      const total = reads.reduce((n, read) => n + read[1], 0)
      observations.push({ at, count, total, ranges: [...reads] })
      assert(total < bytes.length / 4, `seek ${at} reread ${total}/${bytes.length} encoded bytes`)
      assert(reads.every(([, length]) => length <= 65536))
    }
    // Concurrent callers still have isolated exact output and serialized WASM
    // ownership even when their respective seek directions alternate.
    const requests = [70 * rate + 3, 12 * rate + 9, 90 * rate + 11]
    const blocks = await Promise.all(requests.map((at) => source.read(at, 4099)))
    blocks.forEach((block, index) => same(block, expected, requests[index]!, 4099))
  } finally {
    await source.close()
    mkdirSync('out/ci/vorbis-seek', { recursive: true })
    writeFileSync('out/ci/vorbis-seek/ranges.json', JSON.stringify({ encodedBytes: bytes.length, observations }, null, 2))
  }
})

test('sparse Vorbis seeks preserve chained-link origins and the exact EOS-to-next-link sample boundary', { timeout: 120000 }, async () => {
  const bytes = longVorbisBytes(), expected = await baseline(bytes), chain = new Uint8Array(bytes.length * 2)
  chain.set(bytes); chain.set(bytes, bytes.length)
  const source = await openPortablePcmSource({ size: chain.length, async read(at, count) { return chain.subarray(at, at + count) } })
  assert(source)
  try {
    assert.equal(source.info.sampleCount, samples * 2)
    same(await source.read(samples + 85 * rate + 17, 4103), expected, 85 * rate + 17, 4103)
    const crossing = await source.read(samples - 31, 103)
    crossing.forEach((plane, channel) => assert.deepEqual([...plane], [...expected[channel]!.slice(-31), ...expected[channel]!.slice(0, 72)]))
    same(await source.read(48 * rate + 13, 4097), expected, 48 * rate + 13, 4097)
  } finally { await source.close() }
})

test('actual seek pages retain CRC checks and closing a held remote page retires the decoder without waiting for that source', { timeout: 120000 }, async () => {
  const bytes = longVorbisBytes(), reads: Array<[number, number]> = [],
    source = await openPortablePcmSource({ size: bytes.length, async read(at, count) {
      reads.push([at, count]); return bytes.subarray(at, at + count)
    } })
  assert(source)
  try {
    reads.length = 0; await source.read(85 * rate, 4096)
    const anchor = reads.find(([at, count]) => at > bytes.length / 2 && count > 256)
    assert(anchor, 'a real late audio page must have been consumed')
    await source.read(0, 1)
    const corrupt = anchor[0] + anchor[1] - 1, saved = bytes[corrupt]!
    bytes[corrupt] = saved ^ 1
    await assert.rejects(source.read(85 * rate, 1), /Ogg page checksum mismatch/)
    bytes[corrupt] = saved
    assert.equal((await source.read(85 * rate, 1))[0]!.length, 1)
  } finally { await source.close() }

  const gate = deferred<Uint8Array>(), entered = deferred(), controller = new AbortController()
  let hold = false, held: [number, number] | undefined, borrowerCloses = 0
  const resource = { size: bytes.length, async read(at: number, count: number) {
    if (hold && at > bytes.length / 2 && count > 256) { held = [at, count]; entered.resolve(); return gate.promise }
    return bytes.subarray(at, at + count)
  }, close() { borrowerCloses++ } }
  const reader = await openPortablePcmSource(resource, { signal: controller.signal })
  assert(reader)
  hold = true
  const pending = reader.read(85 * rate, 4096), rejected = assert.rejects(pending, /closed/)
  await entered.promise; controller.abort(); await reader.close(); await rejected
  assert.equal(borrowerCloses, 0)
  assert(held); gate.resolve(bytes.subarray(held[0], held[0] + held[1]))
  await assert.rejects(reader.read(0, 1), /closed/)
})
