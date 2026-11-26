import assert from 'node:assert/strict'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { createXp3SegmentPool } from '../../src/backends/files/xp3-inflater.ts'
import { createLongCompressedXp3 } from '../helpers/xp3-segment-fixtures.ts'
import { inflate } from '../../src/backends/files/blob-source.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { readXp3 } from '../../src/formats/xp3/archive.ts'
import { Xp3SegmentPool, type Xp3Segment } from '../../src/formats/xp3/segments.ts'
import type { ByteSource, Resource } from '../../src/engine/ports/storage.ts'
import { openResourceSource } from '../../src/engine/storage/resource-source.ts'

const checkpoint = async () => {}
const u64 = (n: number) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(n)); return bytes }
const u32 = (n: number) => { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(n); return bytes }
const chunk = (name: string, bytes: Buffer) => Buffer.concat([Buffer.from(name), u64(bytes.length), bytes])
const MiB = 1024 * 1024

// Four segments with gaps, including an empty compressed segment. Index and
// data offsets are relative to the archive mark inside an optional executable.
function packageFixture(embedded = false) {
  const segments = [
    { plain: Buffer.from('begin-'), compressed: false }, { plain: Buffer.from('compressed-middle'), compressed: true },
    { plain: Buffer.alloc(0), compressed: true }, { plain: Buffer.from('-end'), compressed: false },
  ]
  const records: Buffer[] = [], payload: Buffer[] = [], locations: number[] = [], packedSizes: number[] = []
  let at = 19
  for (const { plain, compressed } of segments) {
    const stored = compressed ? deflateSync(plain) : plain
    records.push(Buffer.concat([u32(Number(compressed)), u64(at), u64(plain.length), u64(stored.length)]))
    locations.push(at); packedSizes.push(stored.length)
    payload.push(stored, Buffer.alloc(7, 0xcc))
    at += stored.length + 7
  }
  const name = 'voices/dialog.bin', nameSize = Buffer.alloc(2)
  nameSize.writeUInt16LE(name.length)
  const plain = Buffer.concat(segments.map((segment) => segment.plain))
  const info = chunk('info', Buffer.concat([u32(0), u64(plain.length), u64(packedSizes.reduce((a, b) => a + b, 0)), nameSize,
    Buffer.from(name, 'utf16le')]))
  const reference = deflateSync(plain)
  const index = chunk('File', Buffer.concat([info, chunk('segm', Buffer.concat(records)),
    chunk('adlr', u32(reference.readUInt32BE(reference.length - 4)))]))
  const mark = Buffer.from([88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1])
  const prefix = Buffer.alloc(embedded ? 64 : 0)
  if (embedded) prefix.write('MZ')
  const file = Buffer.concat([prefix, mark, u64(at), ...payload, Buffer.from([0]), u64(index.length), index])
  const reads: [number, number][] = []
  const source: ByteSource = { size: file.length, async read(offset, length) {
    reads.push([offset, length]); return file.subarray(offset, offset + length)
  } }
  const resource: Resource = { name: embedded ? 'game.exe' : 'data.xp3', size: file.length, source, async read() {
    throw new Error('The archive must stay ranged')
  } }
  return { file, source, resource, name, reads, plain, locations: locations.map((n) => n + prefix.length), packedSizes }
}

test('normal XP3 and combined-EXE readers resolve mixed compressed segments, aliases and zero-length seeks', async () => {
  for (const embedded of [false, true]) {
    const f = packageFixture(embedded), reader = createSessionArchiveReader()
    try {
      const entry = (await reader.open(f.resource, checkpoint))!.entries[0]!
      const opened = await openResourceSource(entry, { fallbackLimit: 0 })
      assert.equal(opened.mode, 'range')
      f.reads.length = 0
      assert.deepEqual([...(await opened.source.read(1, 2))], [...f.plain.subarray(1, 3)])
      assert.deepEqual(f.reads, [[f.locations[0]! + 1, 2]])
      f.reads.length = 0
      assert.equal((await opened.source.read(10, 0)).length, 0)
      assert.equal((await opened.source.read(entry.size, 0)).length, 0)
      assert.equal(f.reads.length, 0)
      const [a, b] = await Promise.all([opened.source.read(3, entry.size - 4), opened.source.read(8, 9)])
      assert.deepEqual([...a], [...f.plain.subarray(3, -1)]); assert.deepEqual([...b], [...f.plain.subarray(8, 17)])
      assert.equal(f.reads.filter(([offset]) => offset === f.locations[1]).length, 1)
      assert(f.reads.some(([offset]) => offset === f.locations[2]), 'A crossed empty compressed stream must also open cleanly')
      b.fill(0)
      assert.deepEqual([...(await opened.source.read(8, 9))], [...f.plain.subarray(8, 17)])
      assert.deepEqual([...(await entry.read())], [...f.plain])
      await assert.rejects(opened.source.read(entry.size, 1), /range/)
      reader.compact()
      f.reads.length = 0
      assert.equal((await opened.source.read(7, 2)).length, 2)
      assert.equal(f.reads.filter(([offset]) => offset === f.locations[1]).length, 1)
      const imported = await importSources([{ path: f.resource.name, source: f.source }], checkpoint)
      const alias = imported.find((r) => r.name === f.name)!, canonical = imported.find((r) => r.name.endsWith('>' + f.name))!
      assert(alias.source); assert.equal(alias.source, canonical.source)
      assert.deepEqual([...(await alias.source.read(5, 5))], [...f.plain.subarray(5, 10)])
      const verified = (await readXp3(f.source, inflate, { verifyAdler32: true, compressedSegments: createXp3SegmentPool() }))[0]!
      assert.equal(verified.source, undefined)
      assert.deepEqual([...(await verified.read())], [...f.plain])
    } finally { reader.dispose() }
  }
})

test('a touched XP3 segment verifies its zlib trailer before returning any range and retries failed input', async () => {
  const f = packageFixture(), reader = createSessionArchiveReader()
  let simulateIO = false
  const ioError = new Error('XP3 input lease expired'), borrowed = f.source.read
  f.source.read = async (start, length) => {
    if (simulateIO && start === f.locations[1]) throw ioError
    return borrowed(start, length)
  }
  const trailer = f.locations[1]! + f.packedSizes[1]! - 1, original = f.file[trailer]!
  try {
    const entry = (await reader.open(f.resource, checkpoint))!.entries[0]!
    f.file[trailer] = original ^ 0xff
    assert.equal(Buffer.from(await entry.source!.read(0, 5)).toString(), 'begin')
    await assert.rejects(entry.source!.read(6, 1), (err) => err instanceof TvpError && err.tvpMessage.id === 'TVPUncompressionFailed')
    f.file[trailer] = original
    assert.equal(Buffer.from(await entry.source!.read(6, 1)).toString(), 'c')
    reader.compact()
    simulateIO = true
    await assert.rejects(entry.source!.read(6, 1), (error) => error === ioError)
  } finally { reader.dispose() }
})

test('large XP3 cursor continues across read-ahead windows and restarts on a backward seek', async () => {
  const size = 5 * MiB, block = 64 * 1024
  const segment: Xp3Segment = { logical: 0, compressed: true, offset: 0, stored: 1, size }
  const source: ByteSource = { size: 1, async read() { throw new Error('Unexpected physical read') } }
  let opens = 0, chunks = 0, closes = 0
  const pool = new Xp3SegmentPool(async function* () {
    opens++
    try {
      for (let at = 0; at < size; at += block) { chunks++; yield new Uint8Array(block).fill(at / block) }
    } finally { closes++ }
  }, true)
  const read = async (at: number) => {
    const bytes = new Uint8Array(1)
    await pool.read(source, segment, at, bytes)
    assert.equal(bytes[0], Math.floor(at / block))
  }
  try {
    await read(0); assert.equal(chunks, 80); assert.equal(closes, 1)
    await read(block); assert.equal(opens, 1)
    await read(MiB); assert.equal(opens, 2); assert.equal(closes, 1)
    const previous = chunks
    await read(2 * MiB); assert.equal(chunks - previous, MiB / block); assert.equal(opens, 2)
    await read(0); assert.equal(opens, 3); assert.equal(closes, 2)
    pool.compact()
    await read(3 * MiB); assert.equal(opens, 4); assert.equal(closes, 4)
  } finally { pool.dispose() }
  await assert.rejects(read(0), /disposed/)
  assert.equal(closes, opens)
})

test('stopping an XP3 reader wakes queued requests and releases a suspended provider when it returns', async () => {
  let release!: () => void, began!: () => void, closed!: () => void
  const gate = new Promise<void>((ok) => { release = ok }), started = new Promise<void>((ok) => { began = ok }),
    finished = new Promise<void>((ok) => { closed = ok })
  const pool = new Xp3SegmentPool(async function* () {
    try { began(); await gate; yield Uint8Array.of(73) } finally { closed() }
  }, true)
  const segment = { size: 1, stored: 1, logical: 0, offset: 0, compressed: true }
  const source: ByteSource = { size: 1, async read() { return Uint8Array.of(0) } }
  const a = pool.read(source, segment, 0, new Uint8Array(1)), b = pool.read(source, segment, 0, new Uint8Array(1))
  try {
    await started
    pool.dispose()
    await Promise.all([assert.rejects(a, /disposed/), assert.rejects(b, /disposed/)])
  } finally { release(); pool.dispose() }
  await finished

  const cleanup = new Error('Provider cleanup'), broken = new Xp3SegmentPool(async function* () {
    try { yield Uint8Array.of(1, 2) } finally { throw cleanup }
  }, true)
  try {
    await assert.rejects(broken.read(source, segment, 0, new Uint8Array(1)), (error) =>
      error instanceof AggregateError && error.cause === error.errors[0] &&
      error.errors[1] === cleanup && /declared size/.test(String(error.cause)))
  } finally { broken.dispose() }
})

test('one compressed 72 MiB Wave member supports private range reads beyond the complete-file budget', { timeout: 90000 }, async () => {
  const fixture = await createLongCompressedXp3(), reader = createSessionArchiveReader()
  const reads: number[] = []
  const source: ByteSource = { size: fixture.bytes.length, async read(offset, length) {
    reads.push(length); return fixture.bytes.subarray(offset, offset + length)
  } }
  try {
    const index = await reader.open({ name: 'voices.xp3', source, size: source.size, async read() {
      throw new Error('Whole archive read')
    } }, checkpoint)
    const entry = index!.entries.find((r) => r.name === fixture.waveName)!
    assert.equal(entry.size, fixture.wave.size); assert(entry.size > 64 * MiB)
    await assert.rejects(entry.read(), /64 MiB/)
    const opened = await openResourceSource(entry, { fallbackLimit: 0 })
    assert.equal(opened.bufferedBytes, 0); assert.equal(opened.mode, 'range')
    reads.length = 0
    for (const [start, count] of [[0, 44], [entry.size - 513, 513], [2 * MiB - 3, 8192], [2 * MiB + 8177, 37]]) {
      const actual = await opened.source.read(start, count)
      assert.equal(actual.buffer.byteLength, count)
      assert.deepEqual(Buffer.from(actual), fixture.wave.read(start, count))
      actual.fill(0xff)
    }
    assert(reads.length > 0 && reads.every((length) => length <= 64 * 1024))
  } finally { reader.dispose() }
})

test('music and speech share bounded XP3 segment caches while retaining independent forward positions', async () => {
  const size = 6 * MiB, opened: number[] = [], retired: number[] = []
  const pool = new Xp3SegmentPool(async function* (_source, start) {
    opened[start] = (opened[start] ?? 0) + 1
    try {
      const page = new Uint8Array(64 * 1024).fill(start)
      for (let at = 0; at < size; at += page.length) yield page
    } finally { retired[start] = (retired[start] ?? 0) + 1 }
  }, true)
  const source: ByteSource = { size: 8, async read() { throw new Error('Unexpected physical read') } }
  const segments = Array.from({ length: 5 }, (_, offset) => ({ size, offset, logical: 0, stored: 1, compressed: true }))
  const read = async (file: number, at: number) => {
    const target = new Uint8Array(2)
    await pool.read(source, segments[file]!, at, target)
    assert.deepEqual([...target], [file, file])
  }
  try {
    for (const at of [0, MiB, 2 * MiB]) await Promise.all([read(0, at), read(1, at)])
    assert.deepEqual(opened, [2, 2]); assert.deepEqual(retired, [1, 1])
    for (const file of [2, 3, 4]) await read(file, 0)
    assert.equal(retired[0], 2); assert.equal(retired[1], 1)
    await read(1, 3 * MiB)
    assert.equal(opened[1], 2)
  } finally { pool.dispose() }
  // The TS cursor is released immediately; the provider's async finally may
  // settle after dispose returns. No timer, file or Worker is involved here.
  await Promise.resolve()
  assert.deepEqual(retired, opened)
})
