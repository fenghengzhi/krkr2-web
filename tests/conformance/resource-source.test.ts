import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { crc32 as nativeCrc32 } from 'node:zlib'
import { MAX_RESOURCE_BYTES, type ByteSource, type Resource } from '../../src/engine/ports/storage.ts'
import { openResourceSource } from '../../src/engine/storage/resource-source.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { importResources, importSources } from '../../src/backends/files/import-resources.ts'
import { BlobSource, inflate } from '../../src/backends/files/blob-source.ts'
import { readXp3 } from '../../src/formats/xp3/archive.ts'
import { readZip } from '../../src/formats/zip/archive.ts'
import { crc32 } from '../../src/formats/binary/crc32.ts'
import { centralRecords, zipCodecs, zipFixture } from '../helpers/zip-fixtures.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const checkpoint = async () => {}
function sparseSource(size: number, zones: { at: number; bytes: Uint8Array }[]) {
  const reads: [number, number][] = []
  const source: ByteSource = { size, read: async (offset, length) => {
    assert(Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 &&
      offset <= size && length <= size - offset)
    assert(length <= MAX_RESOURCE_BYTES, 'No underlying whole-file allocation is allowed')
    reads.push([offset, length])
    const bytes = new Uint8Array(length)
    for (const zone of zones) {
      const start = Math.max(offset, zone.at), end = Math.min(offset + length, zone.at + zone.bytes.length)
      if (end > start) bytes.set(zone.bytes.subarray(start - zone.at, end - zone.at), start - offset)
    }
    return bytes
  } }
  return { source, reads }
}
function u64(value: number) { const bytes = Buffer.alloc(8); bytes.writeBigUInt64LE(BigInt(value)); return bytes }
function u32(value: number) { const bytes = Buffer.alloc(4); bytes.writeUInt32LE(value); return bytes }
function chunk(tag: string, bytes: Uint8Array) { return Buffer.concat([Buffer.from(tag), u64(bytes.length), bytes]) }
function largeXp3(compressed = false) {
  const middle = MAX_RESOURCE_BYTES + 10, sizes = [3, middle, 5], offsets = [64, 128, 128 + middle + 17],
    size = sizes.reduce((sum, value) => sum + value, 0), name = Buffer.from('long.wav', 'utf16le'),
    nameLength = Buffer.alloc(2)
  nameLength.writeUInt16LE(name.length / 2)
  const index = chunk('File', Buffer.concat([
    chunk('info', Buffer.concat([u32(0), u64(size), u64(size), nameLength, name])),
    chunk('segm', Buffer.concat(sizes.map((length, i) => Buffer.concat([
      u32(compressed && i === 1 ? 1 : 0), u64(offsets[i]!), u64(length), u64(length),
    ])))),
  ])), indexAt = offsets[2]! + 5,
    ending = Buffer.concat([Buffer.from([0]), u64(index.length), index]),
    header = Buffer.concat([Buffer.from([88, 80, 51, 13, 10, 32, 10, 26, 139, 103, 1]), u64(indexAt)]),
    sparse = sparseSource(indexAt + ending.length, [
      { at: 0, bytes: header }, { at: indexAt, bytes: ending },
      { at: offsets[0]!, bytes: Uint8Array.of(1, 2, 3) },
      { at: offsets[1]!, bytes: Uint8Array.of(4, 5, 6) },
      { at: offsets[1]! + middle - 2, bytes: Uint8Array.of(7, 8) },
      { at: offsets[2]!, bytes: Uint8Array.of(9, 10, 11, 12, 13) },
    ])
  return { ...sparse, size, offsets, middle }
}
function largeStoredZip() {
  const size = MAX_RESOURCE_BYTES + 3, block = 1024 * 1024, name = Buffer.from('long.wav'),
    local = Buffer.alloc(30 + name.length), central = Buffer.alloc(46 + name.length), end = Buffer.alloc(22)
  let expected = 0
  // Independent Node/zlib CRC, never the production streaming implementation.
  for (let at = 0; at < size; at += block) {
    const bytes = Buffer.alloc(Math.min(block, size - at))
    if (at === 0) bytes.set([82, 73, 70, 70])
    if (at + bytes.length === size) bytes[bytes.length - 1] = 0x33
    expected = nativeCrc32(bytes, expected)
  }
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4)
  local.writeUInt32LE(expected, 14); local.writeUInt32LE(size, 18); local.writeUInt32LE(size, 22)
  local.writeUInt16LE(name.length, 26); name.copy(local, 30)
  central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6)
  central.writeUInt32LE(expected, 16); central.writeUInt32LE(size, 20); central.writeUInt32LE(size, 24)
  central.writeUInt16LE(name.length, 28); name.copy(central, 46)
  const payload = local.length, centralAt = payload + size
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10)
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(centralAt, 16)
  return { size, payload, block, ...sparseSource(centralAt + central.length + end.length, [
    { at: 0, bytes: local }, { at: payload, bytes: Uint8Array.of(82, 73, 70, 70) },
    { at: payload + size - 1, bytes: Uint8Array.of(0x33) },
    { at: centralAt, bytes: central }, { at: centralAt + central.length, bytes: end },
  ]) }
}

test('resource source borrowing is lazy, bounds every read and returns compact independent ranges', async () => {
  const size = MAX_RESOURCE_BYTES + 9, calls: [number, number][] = [], backing = new Uint8Array(1024),
    resource: Resource = { name: 'long.wav', size, read: async () => { throw new Error('whole read forbidden') },
      source: { size, read: async (offset, length) => {
        calls.push([offset, length]); return backing.subarray(17, 17 + length)
      } } }, opened = await openResourceSource(resource, { fallbackLimit: 0 })
  assert.equal(opened.mode, 'range'); assert.equal(opened.bufferedBytes, 0); assert.deepEqual(calls, [])
  const bytes = await opened.source.read(size - 4, 4)
  assert.deepEqual(calls, [[size - 4, 4]])
  assert.equal(bytes.buffer.byteLength, 4)
  bytes[0] = 99
  assert.equal(backing[17], 0)
  for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [size, 1], [0, MAX_RESOURCE_BYTES + 1]])
    await assert.rejects(opened.source.read(offset!, length!), /range|budget/)
  assert.equal(calls.length, 1)
})

test('resource fallback reads exactly once within its declared budget and snapshots bytes', async () => {
  const original = Uint8Array.of(1, 2, 3, 4)
  let reads = 0
  const opened = await openResourceSource({ name: 'small.wav', size: 4,
    read: async () => { reads++; return original } }, { fallbackLimit: 4 })
  assert.equal(opened.mode, 'buffered'); assert.equal(opened.bufferedBytes, 4)
  original.fill(0)
  const a = await opened.source.read(1, 2); a[0] = 99
  assert.deepEqual([...await opened.source.read(1, 2)], [2, 3])
  assert.equal(reads, 1)
  const oversized = { name: 'large.bin', size: MAX_RESOURCE_BYTES + 1, read: async () => { reads++; return original } }
  await assert.rejects(openResourceSource(oversized), /fallback budget/)
  await assert.rejects(openResourceSource({ ...oversized, size: 4 }, { fallbackLimit: 3 }), /fallback budget/)
  await assert.rejects(openResourceSource(oversized, { fallbackLimit: MAX_RESOURCE_BYTES + 1 }), /Invalid.*budget/)
  assert.equal(reads, 1)
})

test('resource sources reject invalid returned lengths and checkpoints discard late reads', async () => {
  const resource: Resource = { name: 'x', size: 4, read: async () => new Uint8Array(3) }
  await assert.rejects(openResourceSource(resource), /size mismatch/)
  await assert.rejects(openResourceSource({ ...resource, source: { size: 3, read: async () => new Uint8Array() } }), /source size/)
  const opened = await openResourceSource({ ...resource, source: { size: 4, read: async () => new Uint8Array(3) } })
  await assert.rejects(opened.source.read(0, 4), /invalid range/)
  let cancelled = false, reads = 0
  const failure = new Error('source cancelled'), pending = await openResourceSource({ ...resource,
    source: { size: 4, read: async () => { reads++; cancelled = true; return new Uint8Array(4) } },
  }, { checkpoint: () => { if (cancelled) throw failure } })
  await assert.rejects(pending.source.read(0, 4), (error) => error === failure)
  await assert.rejects(pending.source.read(0, 4), (error) => error === failure)
  assert.equal(reads, 1)
})

test('import and resolver retain a large underlying range source without reading the whole file', async () => {
  const file = sparseSource(MAX_RESOURCE_BYTES + 17, [{ at: 5, bytes: Uint8Array.of(11, 22, 33) }]),
    resources = await importSources([{ path: 'audio/long.wav', source: file.source }], checkpoint), resolver = new StorageResolver()
  resolver.mount(resources)
  const opened = await openResourceSource(resolver.resolve('AUDIO/LONG.WAV'))
  assert.equal(opened.mode, 'range')
  assert.deepEqual([...await opened.source.read(5, 3)], [11, 22, 33])
  assert.deepEqual(file.reads, [[0, 11], [5, 3]])
  await assert.rejects(resources[0]!.read(), /decode budget/)
  const slices: (number | undefined)[][] = []
  const blob = new class extends Blob {
    override slice(start?: number, end?: number, contentType?: string): Blob {
      slices.push([start, end])
      return super.slice(start, end, contentType)
    }
    override async arrayBuffer(): Promise<ArrayBuffer> { throw new Error('The complete original Blob must not be materialized') }
  }([Uint8Array.from({ length: 64 }, (_, index) => index)])
  const local = (await importResources([{ path: 'local.wav', blob }], checkpoint))[0]!,
    localSource = await openResourceSource(local)
  assert.deepEqual([...await localSource.source.read(20, 3)], [20, 21, 22])
  assert.deepEqual(slices, [[0, 11], [20, 23]], 'Local File/Blob input reaches the actual slice operation')
})

test('save overlay range readers retain the immutable version they opened', async () => {
  const saves = new SaveOverlay(new MemorySaveStore())
  saves.write('savedata/audio.wav', Uint8Array.of(1, 2, 3, 4))
  const first = await openResourceSource(saves.resource('savedata/audio.wav')!)
  saves.write('savedata/audio.wav', Uint8Array.of(5, 6, 7))
  const second = await openResourceSource(saves.resource('savedata/audio.wav')!)
  assert.deepEqual([...await first.source.read(1, 2)], [2, 3])
  assert.deepEqual([...await second.source.read(1, 2)], [6, 7])
  assert.equal(first.bufferedBytes + second.bufferedBytes, 0)
  const bytes = await first.source.read(0, 4); bytes.fill(0)
  assert.deepEqual([...await first.source.read(0, 4)], [1, 2, 3, 4])
  saves.close()
})

test('raw XP3 ranges cross logical segments without reading gaps or the complete large resource', async () => {
  const archive = largeXp3(), files = await readXp3(archive.source, inflate), resource = files[0]!
  const opened = await openResourceSource(resource)
  archive.reads.length = 0
  assert.deepEqual([...await opened.source.read(1, 5)], [2, 3, 4, 5, 6])
  assert.deepEqual(archive.reads, [[65, 2], [128, 3]])
  archive.reads.length = 0
  assert.deepEqual([...await opened.source.read(archive.size - 7, 7)], [7, 8, 9, 10, 11, 12, 13])
  assert.deepEqual(archive.reads, [[128 + archive.middle - 2, 2], [archive.offsets[2], 5]])
  await assert.rejects(resource.read(), /decode budget/)
  const mounted = await importSources([{ path: 'data.xp3', source: archive.source }], checkpoint), resolver = new StorageResolver()
  resolver.mount(mounted)
  assert(resolver.resolve('data.xp3>long.wav').source)
  assert(resolver.resolve('long.wav').source)
  assert.equal(resolver.resolve('data.xp3>long.wav').source, resolver.resolve('long.wav').source)
})

test('compressed XP3 and explicit Adler verification never masquerade as random access', async () => {
  for (const [archive, verifyAdler32] of [[largeXp3(true), false], [largeXp3(), true]] as const) {
    const resource = (await readXp3(archive.source, inflate, { verifyAdler32 }))[0]!
    assert.equal(resource.source, undefined)
    archive.reads.length = 0
    await assert.rejects(openResourceSource(resource), /fallback budget/)
    assert.deepEqual(archive.reads, [])
  }
})

test('incremental CRC matches the independent implementation across empty and arbitrary blocks', async () => {
  const data = Buffer.from('123456789: complete ZIP integrity before the first returned range')
  let previous = 0
  for (const bytes of [data.subarray(0, 4), data.subarray(4, 4), data.subarray(4, 13), data.subarray(13)]) {
    const work = crc32(bytes, previous)
    for (;;) { const next = work.next(); if (next.done) { previous = next.value; break } }
  }
  assert.equal(previous, nativeCrc32(data))
})

test('large stored ZIP verifies the entire payload once in bounded blocks before shared range reads', async () => {
  const archive = largeStoredZip(), resource = (await readZip(archive.source, zipCodecs))[0]!,
    opened = await openResourceSource(resource)
  archive.reads.length = 0
  assert.equal(opened.mode, 'range'); assert.equal(opened.bufferedBytes, 0)
  assert.deepEqual(archive.reads, [], 'Opening a capability must not falsely report payload verification')
  const [head, tail] = await Promise.all([opened.source.read(0, 4), opened.source.read(archive.size - 1, 1)])
  assert.deepEqual([...head], [82, 73, 70, 70]); assert.deepEqual([...tail], [0x33])
  for (let offset = 0; offset < archive.size; offset += archive.block) {
    const at = archive.payload + offset, length = Math.min(archive.block, archive.size - offset)
    assert.equal(archive.reads.filter(([where, count]) => where === at && count === length).length, 1)
  }
  assert(archive.reads.every(([, length]) => length <= archive.block))
  archive.reads.length = 0
  await opened.source.read(5, 7)
  assert.deepEqual(archive.reads, [[archive.payload + 5, 7]], 'A verified item subsequently reads only its requested payload range')
  await assert.rejects(resource.read(), /decode budget/)
})

test('ZIP range startup rejects corrupt payload and local metadata instead of returning an unchecked prefix', async () => {
  for (const damage of ['payload', 'local'] as const) {
    const bytes = zipFixture('0-stream0-local640-zip640.zip'),
      entry = centralRecords(bytes).records.find((record) => record.name === 'startup.tjs')!
    if (damage === 'payload') bytes[entry.data] ^= 1
    else bytes[entry.local + 30] ^= 1
    const resource = (await readZip(new BlobSource(new Blob([bytes])), zipCodecs)).find((file) => file.name === 'startup.tjs')!
    assert(resource.source)
    const opened = await openResourceSource(resource)
    await assert.rejects(opened.source.read(0, 1), damage === 'payload' ? /CRC32 mismatch/ : /filename mismatch/)
    await assert.rejects(opened.source.read(0, 1), damage === 'payload' ? /CRC32 mismatch/ : /filename mismatch/)
  }
})

test('stored ZIP descriptor variants preserve range results and deflate stays an explicit bounded fallback', async () => {
  for (const name of ['0-stream1-local640-zip640.zip', '0-stream1-local641-zip641.zip', '8-stream0-local640-zip640.zip']) {
    const files = await readZip(new BlobSource(new Blob([zipFixture(name)])), zipCodecs),
      resource = files.find((file) => file.name === 'startup.tjs')!, opened = await openResourceSource(resource),
      whole = await resource.read()
    assert.equal(opened.mode, name.startsWith('0-') ? 'range' : 'buffered')
    assert.equal(opened.bufferedBytes, name.startsWith('0-') ? 0 : resource.size)
    assert.deepEqual(await opened.source.read(1, 4), whole.subarray(1, 5))
  }
})

test('ZIP verification checkpoints cancel before any requested prefix is returned', async () => {
  const bytes = zipFixture('0-stream0-local640-zip640.zip'), raw = new BlobSource(new Blob([bytes])),
    entry = centralRecords(bytes).records.find((record) => record.name === 'startup.tjs')!,
    failure = new Error('cancel ZIP verification')
  let cancelled = false, armed = false
  const resources = await readZip({ size: raw.size, read: async (offset, length) => {
    const result = await raw.read(offset, length)
    if (armed && offset === entry.data) cancelled = true
    return result
  } }, { ...zipCodecs, checkpoint: async () => { if (cancelled) throw failure } }),
    resource = resources.find((file) => file.name === 'startup.tjs')!
  armed = true
  await assert.rejects(resource.source!.read(0, 1), (error) => error === failure)
})
