import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import CodecParser, { type OggPage } from 'codec-parser'
import { openPortablePcmSource, pcmSourceLimits, type PcmSource } from '../../src/backends/audio/pcm-source.ts'
import { decodePortableAudio } from '../../src/backends/audio/decode.ts'
import type { ByteSource } from '../../src/engine/ports/storage.ts'
import { wave } from '../helpers/audio.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const memory = (bytes: Uint8Array): ByteSource => ({ size: bytes.length,
  async read(offset, length) { return bytes.subarray(offset, offset + length) } })
const view = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
const text = (value: string) => new TextEncoder().encode(value)
const concat = (...parts: Uint8Array[]) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) { result.set(part, offset); offset += part.length }
  return result
}
const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
async function opened(bytes: Uint8Array): Promise<PcmSource> {
  const source = await openPortablePcmSource(memory(bytes))
  assert.ok(source)
  return source
}
function chunk(name: string, body: Uint8Array): Uint8Array {
  const header = new Uint8Array(8)
  header.set(text(name)); view(header).setUint32(4, body.length, true)
  return concat(header, body, new Uint8Array(body.length & 1))
}
function riff(...chunks: Uint8Array[]): Uint8Array {
  const body = concat(text('WAVE'), ...chunks), header = new Uint8Array(8)
  header.set(text('RIFF')); view(header).setUint32(4, body.length, true)
  return concat(header, body)
}
function format(bits: number, floating = false, extensible = false, channels = 1): Uint8Array {
  const bytes = new Uint8Array(extensible ? 40 : 16), data = view(bytes), code = floating ? 3 : 1
  data.setUint16(0, extensible ? 0xfffe : code, true); data.setUint16(2, channels, true)
  data.setUint32(4, 48000, true); data.setUint32(8, 48000 * channels * bits / 8, true)
  data.setUint16(12, channels * bits / 8, true); data.setUint16(14, bits, true)
  if (extensible) {
    data.setUint16(16, 22, true); data.setUint16(18, bits, true)
    data.setUint32(20, channels === 2 ? 3 : 4, true)
    bytes.set([code, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 24)
  }
  return chunk('fmt ', bytes)
}

test('range PCM reads preserve frame units, original rate, EOF and independent channel/output ownership', async () => {
  const bytes = wave([0.25, -0.5, 0.75, -1, 0, 0.5], 12000, 2), source = await opened(bytes)
  try {
    assert.deepEqual({ ...source.info, loops: undefined },
      { sampleRate: 12000, sampleCount: 3, channels: 2, bits: 16, loops: undefined })
    const block = await source.read(1, 10)
    assert.deepEqual(block.map((channel) => [...channel]), [[0.75, 0], [-1, 0.5]])
    assert.equal(block[0]!.byteOffset, 0); assert.equal(block[0]!.buffer.byteLength, 8)
    assert.notEqual(block[0]!.buffer, block[1]!.buffer)
    block[0]![0] = 99
    assert.deepEqual([...(await source.read(1, 1))[0]!], [0.75])
    assert.deepEqual((await source.read(3, 1)).map((channel) => channel.length), [0, 0])
    assert.deepEqual((await source.read(0, 0)).map((channel) => channel.length), [0, 0])
  } finally { await source.close() }
})

for (const bits of [8, 16, 24, 32]) test(`range PCM preserves signed ${bits}-bit integer conversion`, async () => {
  const bytes = new Uint8Array(3 * bits / 8), data = view(bytes)
  if (bits === 8) bytes.set([0, 128, 192])
  else if (bits === 16) { data.setInt16(0, -32768, true); data.setInt16(4, 16384, true) }
  else if (bits === 24) bytes.set([0, 0, 128, 0, 0, 0, 0, 0, 64])
  else { data.setInt32(0, -2147483648, true); data.setInt32(8, 1073741824, true) }
  const source = await opened(riff(format(bits), chunk('data', bytes)))
  try { assert.deepEqual([...(await source.read(0, 3))[0]!], [-1, 0, 0.5]) }
  finally { await source.close() }
})

for (const bits of [32, 64]) test(`range PCM preserves extensible ${bits}-bit float and smpl loops after data`, async () => {
  const bytes = new Uint8Array(3 * bits / 8), data = view(bytes), loop = new Uint8Array(60)
  for (let index = 0; index < 3; index++) {
    const value = [-0.75, 0, 0.25][index]!
    if (bits === 32) data.setFloat32(index * 4, value, true)
    else data.setFloat64(index * 8, value, true)
  }
  view(loop).setUint32(28, 1, true); view(loop).setUint32(44, 1, true); view(loop).setUint32(48, 2, true)
  const source = await opened(riff(format(bits, true, true), chunk('JUNK', new Uint8Array([42])),
    chunk('data', bytes), chunk('smpl', loop)))
  try {
    assert.deepEqual([...(await source.read(0, 3))[0]!], [-0.75, 0, 0.25])
    assert.deepEqual(source.info.loops, { links: [{ from: 3, to: 1, smooth: false,
      condition: 'no', variable: 0, reference: 0, whenLooping: true }], labels: [] })
  } finally { await source.close() }
})

test('a sparse 512 MiB WAVE opens by headers and reads only the requested bounded ranges', async () => {
  const dataBytes = 512 * 1024 * 1024, header = wave([], 48000), reads: Array<[number, number]> = []
  view(header).setUint32(4, 36 + dataBytes, true); view(header).setUint32(40, dataBytes, true)
  const source = await openPortablePcmSource({ size: 44 + dataBytes, async read(offset, length) {
    reads.push([offset, length])
    assert.ok(length <= 65536)
    const result = new Uint8Array(length)
    if (offset < header.length) result.set(header.subarray(offset, Math.min(header.length, offset + length)))
    return result
  } })
  assert.ok(source)
  try {
    assert.equal(source.info.sampleCount, dataBytes / 2)
    assert.ok(reads.every(([offset, length]) => offset + length <= 44))
    reads.length = 0
    const result = await source.read(dataBytes / 2 - 65536, 65536)
    assert.equal(result[0]!.length, 65536)
    assert.deepEqual(reads, [[44 + dataBytes - 131072, 65536], [44 + dataBytes - 65536, 65536]])
  } finally { await source.close() }
})

test('PCM input and read budgets reject malformed ranges before any PCM allocation or I/O', async () => {
  const source = await opened(wave([0.25]))
  try {
    for (const [position, frames] of [[-1, 1], [2, 0], [0.5, 1], [0, -1], [0, 1.5], [0, 65537], [NaN, 1]])
      await assert.rejects(source.read(position!, frames!), /sample range|frame budget/)
  } finally { await source.close() }
  await assert.rejects(openPortablePcmSource({ size: Infinity, async read() { throw new Error('must not read') } }), /source size/)
  const truncated = wave([0.25]).subarray(0, 44)
  await assert.rejects(openPortablePcmSource(memory(truncated)), /Truncated WAVE/)
  const badAlign = wave([0.25]); view(badAlign).setUint16(32, 3, true)
  await assert.rejects(openPortablePcmSource(memory(badAlign)), /alignment/)
})

test('recognized non-finite WAVE data fails on its requested range without poisoning earlier reads', async () => {
  const bytes = new Uint8Array(8)
  view(bytes).setFloat32(0, 0.25, true); view(bytes).setFloat32(4, NaN, true)
  const source = await opened(riff(format(32, true), chunk('data', bytes)))
  try {
    assert.deepEqual([...(await source.read(0, 1))[0]!], [0.25])
    await assert.rejects(source.read(1, 1), /non-finite/)
    assert.deepEqual([...(await source.read(0, 1))[0]!], [0.25])
  } finally { await source.close() }
})

test('unsupported formats leave a borrowed ByteSource usable for the bounded fallback', async () => {
  const bytes = new Uint8Array([0x49, 0x44, 0x33, 0, 0, 0]), resource = memory(bytes)
  assert.equal(await openPortablePcmSource(resource), undefined)
  assert.deepEqual(await resource.read(0, bytes.length), bytes)
  const compressed = wave([0.25]); view(compressed).setUint16(20, 6, true)
  assert.equal(await openPortablePcmSource(memory(compressed)), undefined)
})

test('PCM request reservations bound queued work and recover after the in-flight range completes', async () => {
  const bytes = wave([0.25]), gate = deferred(), entered = deferred()
  let blocking = true
  const source = await openPortablePcmSource({ size: bytes.length, async read(offset, length) {
    if (offset >= 44 && blocking) { entered.resolve(); await gate.promise }
    return bytes.subarray(offset, offset + length)
  } })
  assert.ok(source)
  try {
    const pending = Array.from({ length: pcmSourceLimits.pendingReads }, () => source.read(0, 1))
    const all = Promise.all(pending)
    await entered.promise
    await assert.rejects(source.read(0, 1), /pending read budget/)
    blocking = false; gate.resolve()
    assert.equal((await all).length, 8)
    assert.deepEqual([...(await source.read(0, 1))[0]!], [0.25])
  } finally { gate.resolve(); await source.close() }
})

test('close expires in-flight/queued reads, ignores late bytes, and never closes the borrowed resource', async () => {
  const bytes = wave([0.25]), gate = deferred<Uint8Array>(), entered = deferred()
  let rangeCalls = 0
  const resource: ByteSource = { size: bytes.length, async read(offset, length) {
    if (offset >= 44) { rangeCalls++; entered.resolve(); return gate.promise }
    return bytes.subarray(offset, offset + length)
  } }
  const source = await openPortablePcmSource(resource)
  assert.ok(source)
  const first = source.read(0, 1), second = source.read(0, 1), rejected = Promise.all([
    assert.rejects(first, /closed/), assert.rejects(second, /closed/),
  ])
  await entered.promise
  const close = source.close()
  assert.equal(source.close(), close)
  await close; await rejected
  assert.equal(rangeCalls, 1)
  gate.resolve(bytes.subarray(44)); await Promise.resolve()
  await assert.rejects(source.read(0, 1), /closed/)
  assert.deepEqual(await resource.read(0, 4), text('RIFF'))
})

test('a suspended checkpoint can be closed without starting the queued source read', async () => {
  const bytes = wave([0.25]), gate = deferred(), entered = deferred()
  let pause = false, rangeCalls = 0
  const source = await openPortablePcmSource({ size: bytes.length, async read(offset, length) {
    if (offset >= 44) rangeCalls++
    return bytes.subarray(offset, offset + length)
  } }, { checkpoint() { if (pause) { entered.resolve(); return gate.promise } } })
  assert.ok(source); pause = true
  const rejected = assert.rejects(source.read(0, 1), /closed/)
  await entered.promise; await source.close(); await rejected
  gate.resolve(); await Promise.resolve()
  assert.equal(rangeCalls, 0)
})

test('short byte ranges and excessive loop metadata reject explicitly', async () => {
  const bytes = wave([0.25]), source = await openPortablePcmSource({ size: bytes.length,
    async read(offset, length) { return bytes.subarray(offset, offset + length - (offset >= 44 ? 1 : 0)) } })
  assert.ok(source)
  try { await assert.rejects(source.read(0, 1), /Truncated audio source read/) }
  finally { await source.close() }
  const loops = new Uint8Array(36 + 4097 * 24)
  view(loops).setUint32(28, 4097, true)
  await assert.rejects(openPortablePcmSource(memory(riff(format(16), chunk('data', new Uint8Array(2)),
    chunk('smpl', loops)))), /loop metadata budget/)
})

test('large metadata scans admit a control task and observe its cancellation before reading the entire index', async () => {
  const bytes = riff(format(16), ...Array.from({ length: 300 }, () => chunk('JUNK', new Uint8Array())),
    chunk('data', new Uint8Array(2)))
  let taskRan = false
  const task = new Promise<void>((resolve) => { setTimeout(() => { taskRan = true; resolve() }, 0) })
  const source = await opened(bytes)
  try { assert.equal(taskRan, true, 'the metadata scan must yield a macrotask') }
  finally { await source.close(); await task }
  let cancelled = false, reads = 0
  const cancel = new Promise<void>((resolve) => { setTimeout(() => { cancelled = true; resolve() }, 0) })
  await assert.rejects(openPortablePcmSource({ size: bytes.length, async read(offset, length) {
    reads++; return bytes.subarray(offset, offset + length)
  } }, { checkpoint() { if (cancelled) throw new Error('metadata scan cancelled') } }), /metadata scan cancelled/)
  await cancel
  assert.ok(reads < 300, 'cancellation must prevent the remainder of the metadata scan')
})

test('close is admitted during a long in-memory PCM read rather than after a microtask-only decode', async () => {
  const frames = 65536, bytes = frames * 8 * 8, header = riff(format(64, true, false, 8), chunk('data', new Uint8Array()))
  view(header).setUint32(4, bytes + 36, true); view(header).setUint32(40, bytes, true)
  let ranges = 0
  const source = await openPortablePcmSource({ size: header.length + bytes, async read(offset, length) {
    if (offset >= header.length) { ranges++; return new Uint8Array(length) }
    return header.subarray(offset, offset + length)
  } })
  assert.ok(source)
  const closed = new Promise<void>((resolve, reject) => {
    setTimeout(() => { void source.close().then(resolve, reject) }, 0)
  })
  await assert.rejects(source.read(0, frames), /closed/)
  await closed
  assert.ok(ranges < bytes / 65536, 'the source must retire before all PCM ranges decode')
})

test('AbortSignal cancels the factory before its first range returns and does not consume late source bytes', async () => {
  const bytes = wave([0.25]), gate = deferred<Uint8Array>(), entered = deferred(), controller = new AbortController()
  let reads = 0
  const resource: ByteSource = { size: bytes.length, async read(offset, length) {
    if (++reads === 1) { entered.resolve(); return gate.promise }
    return bytes.subarray(offset, offset + length)
  } }
  const opening = openPortablePcmSource(resource, { signal: controller.signal }), rejected = assert.rejects(opening, /closed/)
  await entered.promise
  controller.abort()
  await rejected
  gate.resolve(bytes.subarray(0, 12)); await Promise.resolve()
  assert.equal(reads, 1)
  await assert.rejects(openPortablePcmSource(resource, { signal: controller.signal }), /closed/)
  assert.equal(reads, 1)
  assert.deepEqual(await resource.read(0, 4), text('RIFF'))
})

const tone = () => new Uint8Array(readFileSync(new URL('../fixtures/audio/tone.ogg', import.meta.url)))
function oggPages(bytes: Uint8Array): Array<{ start: number; body: number; end: number }> {
  const result: Array<{ start: number; body: number; end: number }> = []
  for (let at = 0; at < bytes.length;) {
    const body = at + 27 + bytes[at + 26]!
    let end = body
    for (let lace = at + 27; lace < body; lace++) end += bytes[lace]!
    result.push({ start: at, body, end }); at = end
  }
  return result
}
function checksum(bytes: Uint8Array, start: number, end: number): void {
  view(bytes).setUint32(start + 22, 0, true)
  let crc = 0
  for (let at = start; at < end; at++) {
    crc ^= bytes[at]! << 24
    for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0)
  }
  view(bytes).setUint32(start + 22, crc >>> 0, true)
}
function oggPage(sequence: number, flags: number, granule: bigint, laces: number[], body: Uint8Array): Uint8Array {
  assert.ok(laces.length <= 255)
  assert.equal(laces.reduce((sum, length) => sum + length, 0), body.length)
  const header = new Uint8Array(27 + laces.length)
  header.set(text('OggS')); header[5] = flags
  view(header).setBigUint64(6, granule, true); view(header).setUint32(14, 12345, true)
  view(header).setUint32(18, sequence, true); header[26] = laces.length; header.set(laces, 27)
  const result = concat(header, body)
  checksum(result, 0, result.length)
  return result
}
function packetLaces(length: number): number[] {
  return [...Array<number>(Math.floor(length / 255)).fill(255), length % 255]
}
function packets(bytes: Uint8Array): Uint8Array[] {
  const result: Uint8Array[] = []
  let parts: Uint8Array[] = []
  for (const page of oggPages(bytes)) {
    let offset = page.body
    for (let at = page.start + 27; at < page.body; at++) {
      const length = bytes[at]!
      parts.push(bytes.subarray(offset, offset + length)); offset += length
      if (length < 255) { result.push(concat(...parts)); parts = [] }
    }
  }
  assert.equal(parts.length, 0)
  return result
}
function nextLink(bytes: Uint8Array, rate?: number): Uint8Array {
  const result = new Uint8Array(bytes)
  for (const [index, page] of oggPages(result).entries()) {
    view(result).setUint32(page.start + 14, (view(result).getUint32(page.start + 14, true) + 1) >>> 0, true)
    if (!index && rate !== undefined) view(result).setUint32(page.body + 12, rate, true)
    checksum(result, page.start, page.end)
  }
  return result
}
function compareBlock(actual: Float32Array[], expected: Float32Array[], position: number, count: number): void {
  assert.equal(actual.length, expected.length)
  for (let channel = 0; channel < actual.length; channel++)
    assert.deepEqual(actual[channel], expected[channel]!.slice(position, position + count))
}

test('real Vorbis ranges, sequential packet boundaries and backward replay equal the established full decode', async () => {
  const bytes = tone(), baseline = await decodePortableAudio(bytes, 'wave')
  assert.ok(baseline?.kind === 'pcm')
  const reads: Array<[number, number]> = [], source = await openPortablePcmSource({ size: bytes.length,
    async read(offset, length) { reads.push([offset, length]); return bytes.subarray(offset, offset + length) } })
  assert.ok(source)
  try {
    assert.deepEqual({ ...source.info }, { sampleRate: 44100, sampleCount: 11025, channels: 2, bits: 16, loops: { links: [], labels: [] } })
    assert.ok(reads.every(([, length]) => length <= 65536), 'origin calibration reads bounded setup/first audio pages')
    assert.ok(reads.some(([, length]) => length > 255), 'packet spans require real setup and audio bytes')
    assert.ok(Math.abs((await source.read(0, 1))[0]![0]! + 0.00201121368) < 1e-6)
    for (let at = 0; at < baseline.sampleCount; at += 997) {
      const count = Math.min(997, baseline.sampleCount - at)
      compareBlock(await source.read(at, count), baseline.data, at, count)
    }
    for (const [at, count] of [[7000, 211], [37, 1201], [10000, 1025], [0, 11025]])
      compareBlock(await source.read(at!, count!), baseline.data, at!, count!)
    assert.ok(reads.every(([, length]) => length <= 65536))
  } finally { await source.close() }
})

test('same-format chained Vorbis resets overlap, concatenates exact samples and supports crossing/backward seeks', async () => {
  const bytes = tone(), baseline = await decodePortableAudio(bytes, 'wave')
  assert.ok(baseline?.kind === 'pcm')
  const source = await opened(concat(bytes, nextLink(bytes))), count = baseline.sampleCount
  try {
    assert.equal(source.info.sampleCount, count * 2)
    const expected = baseline.data.map((channel) => {
      const output = new Float32Array(count * 2)
      output.set(channel); output.set(channel, count); return output
    })
    for (const [at, frames] of [[count - 9, 23], [count + 3, 117], [5, 200], [0, count * 2]])
      compareBlock(await source.read(at!, frames!), expected, at!, frames!)
  } finally { await source.close() }
})

test('format-changing Vorbis chains are rejected instead of silently ignoring the second stream', async () => {
  const bytes = tone()
  await assert.rejects(openPortablePcmSource(memory(concat(bytes, nextLink(bytes, 22050)))), /preserve sample rate and channels/)
})

test('Vorbis pre-scan rejects missing EOS, truncation, sequence gaps and unknown final positions', async () => {
  const bytes = tone(), pages = oggPages(bytes), last = pages[pages.length - 1]!
  const noEnd = new Uint8Array(bytes); noEnd[last.start + 5]! &= ~4
  await assert.rejects(openPortablePcmSource(memory(noEnd)), /no end-of-stream/)
  await assert.rejects(openPortablePcmSource(memory(bytes.subarray(0, bytes.length - 1))), /Truncated Ogg/)
  const gap = new Uint8Array(bytes); view(gap).setUint32(last.start + 18, 999, true)
  await assert.rejects(openPortablePcmSource(memory(gap)), /sequence/)
  const unknown = new Uint8Array(bytes); view(unknown).setBigUint64(last.start + 6, 0xffffffffffffffffn, true)
  await assert.rejects(openPortablePcmSource(memory(unknown)), /end-of-stream position/)
})

test('Vorbis verifies calibration CRC and closes its actual decoder after a later provider failure', async () => {
  const bytes = tone(), pages = oggPages(bytes), last = pages[pages.length - 1]!
  bytes[last.end - 1]! ^= 0x10
  await assert.rejects(openPortablePcmSource(memory(bytes)), /checksum mismatch/)
  const healthy = tone()
  let fail = false
  const source = await openPortablePcmSource({ size: healthy.length, async read(offset, length) {
    if (fail) throw new Error('late audio provider failure')
    return healthy.subarray(offset, offset + length)
  } })
  assert.ok(source); fail = true
  try { await assert.rejects(source.read(0, 11025), /late audio provider failure/) }
  finally { await source.close() }
  await assert.rejects(source.read(0, 1), /closed/)
})

test('serialized concurrent Vorbis seeks keep each independently owned result exact', async () => {
  const bytes = tone(), baseline = await decodePortableAudio(bytes, 'wave')
  assert.ok(baseline?.kind === 'pcm')
  const source = await opened(bytes)
  try {
    const requests = [[9000, 99], [17, 311], [10500, 525], [0, 8]]
    const results = await Promise.all(requests.map(([at, count]) => source.read(at!, count!)))
    results.forEach((result, index) => compareBlock(result, baseline.data, requests[index]![0]!, requests[index]![1]!))
    results[0]![0]![0] = 99
    assert.notEqual(results[1]![0]![0], 99)
  } finally { await source.close() }
})

test('real Vorbis setup after a continued comment packet retains exact packet priming and EOS trim', async () => {
  const bytes = tone(), original = packets(bytes), baseline = await decodePortableAudio(bytes, 'wave')
  assert.ok(baseline?.kind === 'pcm')
  const comment = new Uint8Array(70016)
  comment.set([3, ...text('vorbis')]); view(comment).setUint32(7, 70000, true)
  comment.fill(97, 11, 70011); view(comment).setUint32(70011, 0, true); comment[70015] = 1
  const audio = original.slice(3), encoded = concat(
    oggPage(0, 2, 0n, packetLaces(original[0]!.length), original[0]!),
    oggPage(1, 0, 0xffffffffffffffffn, Array<number>(255).fill(255), comment.subarray(0, 65025)),
    oggPage(2, 1, 0n, packetLaces(comment.length - 65025), comment.subarray(65025)),
    oggPage(3, 0, 0n, packetLaces(original[2]!.length), original[2]!),
    oggPage(4, 4, BigInt(baseline.sampleCount), audio.flatMap((packet) => packetLaces(packet.length)), concat(...audio)),
  ), source = await opened(encoded)
  try {
    compareBlock(await source.read(0, baseline.sampleCount), baseline.data, 0, baseline.sampleCount)
    compareBlock(await source.read(51, 703), baseline.data, 51, 703)
  } finally { await source.close() }
})

test('Vorbis packet bounds apply across continuation pages before decoder setup allocates', async () => {
  const first = packets(tone())[0]!, block = new Uint8Array(65025)
  block.set([3, ...text('vorbis')])
  const encoded = concat(oggPage(0, 2, 0n, packetLaces(first.length), first),
    oggPage(1, 0, 0xffffffffffffffffn, Array<number>(255).fill(255), block),
    oggPage(2, 1, 0xffffffffffffffffn, Array<number>(255).fill(255), block),
    oggPage(3, 1, 0xffffffffffffffffn, Array<number>(255).fill(255), block))
  await assert.rejects(openPortablePcmSource(memory(encoded)), /packet exceeds input budget/)
})

test('a different initial Ogg codec remains available to fallback without instantiating Vorbis', async () => {
  const header = concat(text('OpusHead'), new Uint8Array(11)), encoded = oggPage(0, 2, 0n, [header.length], header)
  assert.equal(await openPortablePcmSource(memory(encoded)), undefined)
})

function repagedOrigin(bytes: Uint8Array, origin: number, leadingPackets = 2, splitPriming = false): Uint8Array {
  const original = packets(bytes), audio = original.slice(3),
    metadata = new CodecParser<OggPage>('audio/ogg', { enableLogging: false, enableFrameCRC32: false }).parseAll(bytes),
    codecFrames = metadata.flatMap((page) => page.codecFrames),
    // Used only to write the fixture's page timing. Expected output below is an
    // independent literal slice/length transformation of the pre-existing file.
    span = codecFrames.slice(0, leadingPackets).reduce((sum, frame) => sum + frame.samples, 0),
    sourcePages = oggPages(bytes), last = sourcePages[sourcePages.length - 1]!,
    end = view(bytes).getBigUint64(last.start + 6, true),
    first = audio.slice(0, leadingPackets), remaining = audio.slice(leadingPackets)
  assert.ok(span + origin >= 0 && remaining.length > 0)
  return concat(
    oggPage(0, 2, 0n, packetLaces(original[0]!.length), original[0]!),
    oggPage(1, 0, 0n, packetLaces(original[1]!.length), original[1]!),
    oggPage(2, 0, 0n, packetLaces(original[2]!.length), original[2]!),
    ...(splitPriming ? [
      oggPage(3, 0, 0n, packetLaces(first[0]!.length), first[0]!),
      oggPage(4, 0, BigInt(span + origin), first.slice(1).flatMap((packet) => packetLaces(packet.length)), concat(...first.slice(1))),
    ] : [oggPage(3, 0, BigInt(span + origin), first.flatMap((packet) => packetLaces(packet.length)), concat(...first))]),
    oggPage(splitPriming ? 5 : 4, 4, end + BigInt(origin), remaining.flatMap((packet) => packetLaces(packet.length)), concat(...remaining)),
  )
}

for (const origin of [-17, 50000]) for (const splitPriming of [false, true]) test(
  `Vorbis ${origin} origin (separate priming page=${splitPriming}) preserves exact edited PCM and normalized duration after replay`, async () => {
  const bytes = tone(), baseline = await decodePortableAudio(bytes, 'wave')
  assert.ok(baseline?.kind === 'pcm')
  const skip = Math.max(0, -origin), expected = baseline.data.map((channel) => channel.slice(skip)),
    source = await opened(repagedOrigin(bytes, origin, 2, splitPriming))
  try {
    assert.equal(source.info.sampleCount, 11025 - skip)
    compareBlock(await source.read(0, source.info.sampleCount), expected, 0, source.info.sampleCount)
    compareBlock(await source.read(101, 513), expected, 101, 513)
    compareBlock(await source.read(0, 41), expected, 0, 41)
  } finally { await source.close() }
})

test('nonzero Vorbis origins reject a page that failed to flush its second audio packet', async () => {
  await assert.rejects(openPortablePcmSource(memory(repagedOrigin(tone(), -17, 3))), /second packet page/)
})
