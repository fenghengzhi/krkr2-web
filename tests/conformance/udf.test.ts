import assert from 'node:assert/strict'
import test from 'node:test'
import type { ByteSource, ImmutableBlob } from '../../src/engine/ports/storage.ts'
import { openDiscFilesystem } from '../../src/formats/disc/filesystem.ts'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { readDiscVolumeLabel, type DiscVolumeTrack } from '../../src/formats/disc/volume-label.ts'

// Independent author bytes: ECMA-167 3/7.2, 3/10, 4/12, 4/14; OSTA UDF
// 1.02 2.1.1 (CS0). No production descriptor/writer or parsing helper is used.
// https://ecma-international.org/wp-content/uploads/ECMA-167_2nd_edition_december_1994.pdf
// https://ecma-international.org/wp-content/uploads/ECMA_TR-112-7_1st_edition_december_2023.pdf
const blockSize = 2048, partitionStart = 320,
  ascii = (value: string) => Uint8Array.from(value, (char) => char.charCodeAt(0)),
  dataView = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
  track = (first = 0, bytes = 2048, payload = 0): DiscVolumeTrack => ({ file: 'story.udf', first, layout: { bytes, payload } })

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) { result.set(part, at); at += part.length }
  return result
}
function cs0(value: string, wide = false): Uint8Array {
  const bytes = new Uint8Array(1 + value.length * (wide ? 2 : 1)); bytes[0] = wide ? 16 : 8
  for (let i = 0; i < value.length; i++) {
    if (wide) dataView(bytes).setUint16(1 + i * 2, value.charCodeAt(i))
    else bytes[1 + i] = value.charCodeAt(i)
  }
  return bytes
}
function dstring(bytes: Uint8Array, at: number, length: number, text: string, wide = false) {
  const value = cs0(text, wide); assert(value.length < length)
  bytes.set(value, at); bytes[at + length - 1] = value.length
}
function charset(bytes: Uint8Array, at: number) { bytes.set(ascii('OSTA Compressed Unicode'), at + 1) }
function entity(bytes: Uint8Array, at: number, value: string) { bytes.set(ascii(value), at + 1) }
function timestamp(bytes: Uint8Array, at: number) {
  const view = dataView(bytes)
  view.setUint16(at, 0x1000, true); view.setUint16(at + 2, 2020, true); bytes[at + 4] = 1; bytes[at + 5] = 1
}
function descriptor(id: number, location: number, bytes: Uint8Array, version = 2): Uint8Array {
  const view = dataView(bytes)
  view.setUint16(0, id, true); view.setUint16(2, version, true); view.setUint16(6, 1, true)
  view.setUint16(10, bytes.length - 16, true); view.setUint32(12, location, true)
  let crc = 0
  for (let i = 16; i < bytes.length; i++) {
    crc ^= bytes[i]! << 8
    for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ ((crc & 0x8000) ? 0x1021 : 0)) & 65535
  }
  view.setUint16(8, crc, true)
  bytes[4] = 0
  for (let i = 0; i < 16; i++) if (i !== 4) bytes[4] = (bytes[4]! + bytes[i]!) & 255
  return bytes
}
function longAd(length: number, block: number, kind = 0, partition = 0): Uint8Array {
  const bytes = new Uint8Array(16), view = dataView(bytes)
  view.setUint32(0, length + kind * 0x40000000, true); view.setUint32(4, block, true); view.setUint16(8, partition, true)
  return bytes
}
function shortAd(length: number, block: number, kind = 0): Uint8Array {
  return longAd(length, block, kind).slice(0, 8)
}
function fileEntry(block: number, size: number, allocations: Uint8Array, format: 0 | 1 | 3, directory = false, links = 1,
  recordedBlocks = format === 3 ? 0 : Math.ceil(size / blockSize)): Uint8Array {
  const bytes = new Uint8Array(176 + allocations.length), view = dataView(bytes)
  assert(bytes.length <= blockSize)
  view.setUint16(20, 4, true); view.setUint16(24, 1, true); bytes[27] = directory ? 4 : 5
  view.setUint16(34, format, true); view.setUint32(36, 0xffffffff, true); view.setUint32(40, 0xffffffff, true)
  view.setUint32(44, 0x14a5, true); view.setUint16(48, links, true); view.setBigUint64(56, BigInt(size), true)
  view.setBigUint64(64, BigInt(recordedBlocks), true)
  for (const at of [72, 84, 96]) timestamp(bytes, at)
  view.setUint32(108, 1, true); entity(bytes, 128, '*KRKR authored fixture')
  view.setBigUint64(160, BigInt(block + 16), true); view.setUint32(172, allocations.length, true)
  bytes.set(allocations, 176)
  return descriptor(261, block, bytes)
}
// ECMA-167 third edition 4/14.17 adds Object Size and Creation Date before
// the allocation fields. It is not the 176-byte File Entry layout.
function extendedEntry(block: number, size: number, allocations: Uint8Array, format: 1 | 3, directory = false): Uint8Array {
  const bytes = new Uint8Array(216 + allocations.length), view = dataView(bytes)
  view.setUint16(20, 4, true); view.setUint16(24, 1, true); bytes[27] = directory ? 4 : 5
  view.setUint16(34, format, true); view.setUint32(36, 0xffffffff, true); view.setUint32(40, 0xffffffff, true)
  view.setUint32(44, 0x14a5, true); view.setUint16(48, 1, true)
  view.setBigUint64(56, BigInt(size), true); view.setBigUint64(64, BigInt(size), true)
  view.setBigUint64(72, BigInt(format === 3 ? 0 : Math.ceil(size / blockSize)), true)
  for (const at of [80, 92, 104, 116]) timestamp(bytes, at)
  view.setUint32(128, 1, true); entity(bytes, 168, '*KRKR authored fixture')
  view.setBigUint64(200, BigInt(block + 16), true); view.setUint32(212, allocations.length, true)
  bytes.set(allocations, 216)
  return descriptor(266, block, bytes, 3)
}
interface Entry { name: string; icb: number; directory?: boolean; wide?: boolean; deleted?: boolean; version?: number }
function directoryBytes(block: number, parent: number, entries: readonly Entry[], inline = false): Uint8Array {
  const parts: Uint8Array[] = []
  let offset = inline ? 176 : 0
  for (const entry of [{ name: '', icb: parent, directory: true }, ...entries]) {
    const name = entry.name ? cs0(entry.name, entry.wide) : new Uint8Array(),
      bytes = new Uint8Array(Math.ceil((38 + name.length) / 4) * 4), view = dataView(bytes)
    view.setUint16(16, entry.version ?? 1, true)
    bytes[18] = (entry.directory ? 2 : 0) | (!entry.name ? 8 : 0) | (entry.deleted ? 4 : 0)
    bytes[19] = name.length; bytes.set(longAd(blockSize, entry.icb), 20); bytes.set(name, 38)
    parts.push(descriptor(257, block + Math.floor(offset / blockSize), bytes)); offset += bytes.length
  }
  return concat(parts)
}

function image(blocks = 1024, label = 'STORY_DISC', wideLabel = false) {
  const regions = new Map<number, Uint8Array>(), reads: [number, number][] = [],
    put = (block: number, bytes: Uint8Array) => { regions.set(block * blockSize, bytes) },
    putFile = (block: number, bytes: Uint8Array) => put(partitionStart + block, bytes)
  for (const [block, id] of [[16, 'BEA01'], [17, 'NSR02'], [18, 'TEA01']] as const) {
    const bytes = new Uint8Array(blockSize); bytes.set(ascii(id), 1); bytes[6] = 1; put(block, bytes)
  }
  for (const block of [256, blocks - 257, blocks - 1]) {
    const bytes = new Uint8Array(512), view = dataView(bytes)
    view.setUint32(16, 4 * blockSize, true); view.setUint32(20, 257, true)
    view.setUint32(24, 4 * blockSize, true); view.setUint32(28, 270, true)
    put(block, descriptor(2, block, bytes))
  }
  for (const base of [257, 270]) {
    const primary = new Uint8Array(512), pv = dataView(primary)
    pv.setUint32(16, 1, true); dstring(primary, 24, 32, 'STORY_DISC'); pv.setUint16(56, 1, true); pv.setUint16(58, 1, true)
    pv.setUint16(60, 2, true); pv.setUint16(62, 3, true); pv.setUint32(64, 1, true); pv.setUint32(68, 1, true)
    dstring(primary, 72, 128, '0000000000000001STORY'); charset(primary, 200); charset(primary, 264)
    timestamp(primary, 376); entity(primary, 388, '*KRKR authored fixture')
    put(base, descriptor(1, base, primary))
    const partition = new Uint8Array(512), pd = dataView(partition)
    pd.setUint32(16, 2, true); pd.setUint16(20, 1, true); pd.setUint16(22, 7, true)
    entity(partition, 24, '+NSR02'); pd.setUint32(184, 1, true)
    pd.setUint32(188, partitionStart, true); pd.setUint32(192, blocks - partitionStart - 300, true)
    entity(partition, 196, '*KRKR authored fixture'); put(base + 1, descriptor(5, base + 1, partition))
    const logical = new Uint8Array(446), lv = dataView(logical)
    lv.setUint32(16, 3, true); charset(logical, 20); dstring(logical, 84, 128, label, wideLabel)
    lv.setUint32(212, blockSize, true); entity(logical, 216, '*OSTA UDF Compliant'); lv.setUint16(240, 0x102, true)
    logical.set(longAd(blockSize, 0), 248); lv.setUint32(264, 6, true); lv.setUint32(268, 1, true)
    entity(logical, 272, '*KRKR authored fixture'); lv.setUint32(432, 2 * blockSize, true); lv.setUint32(436, 280, true)
    logical.set(Uint8Array.of(1, 6, 1, 0, 7, 0), 440); put(base + 2, descriptor(6, base + 2, logical))
    put(base + 3, descriptor(8, base + 3, new Uint8Array(512)))
  }
  const integrity = new Uint8Array(134), iv = dataView(integrity)
  timestamp(integrity, 16); iv.setUint32(28, 1, true); iv.setBigUint64(40, 256n, true)
  iv.setUint32(72, 1, true); iv.setUint32(76, 46, true); iv.setUint32(80, 0, true)
  iv.setUint32(84, blocks - partitionStart - 300, true); entity(integrity, 88, '*KRKR authored fixture')
  iv.setUint16(128, 0x102, true); iv.setUint16(130, 0x102, true); iv.setUint16(132, 0x102, true)
  put(280, descriptor(9, 280, integrity)); put(281, descriptor(8, 281, new Uint8Array(512)))
  const fileSet = new Uint8Array(512), fv = dataView(fileSet)
  timestamp(fileSet, 16); fv.setUint16(28, 3, true); fv.setUint16(30, 3, true)
  fv.setUint32(32, 1, true); fv.setUint32(36, 1, true); charset(fileSet, 48); charset(fileSet, 240)
  dstring(fileSet, 112, 128, label, wideLabel); dstring(fileSet, 304, 32, 'STORY')
  fileSet.set(longAd(blockSize, 1), 400); entity(fileSet, 416, '*OSTA UDF Compliant'); fv.setUint16(440, 0x102, true)
  putFile(0, descriptor(256, 0, fileSet))
  const source: ByteSource = { size: blocks * blockSize, async read(offset, length) {
    assert(offset >= 0 && length >= 0 && offset + length <= blocks * blockSize)
    assert(length <= 65536, 'The source is read in bounded sector batches')
    reads.push([offset, length]); const bytes = new Uint8Array(length)
    for (const [start, region] of regions) {
      const from = Math.max(start, offset), to = Math.min(start + region.length, offset + length)
      if (from < to) bytes.set(region.subarray(from - start, to - start), from - offset)
    }
    return bytes
  } }
  function root(entries: readonly Entry[]) {
    const bytes = directoryBytes(1, 1, entries, true)
    putFile(1, fileEntry(1, bytes.length, bytes, 3, true))
  }
  return { source, reads, regions, put, putFile, root }
}

async function contents(file: ByteSource | undefined) { assert(file); return file.read(0, file.size) }

test('UDF inline directories preserve CS0 names, relative paths, empty entries and cached file identity', async () => {
  const authored = image(1024, '物語DISC', true), story = Uint8Array.of(255, 254, 54, 0, 42, 0, 55, 0)
  authored.root([{ name: 'Routes', icb: 2, directory: true }, { name: 'Empty.dat', icb: 4 },
    { name: 'Empty', icb: 5, directory: true }, { name: 'Unused', icb: 6, directory: true }])
  const routes = directoryBytes(2, 1, [{ name: '開幕.tjs', icb: 3, wide: true }], true), empty = directoryBytes(5, 1, [], true)
  authored.putFile(2, fileEntry(2, routes.length, routes, 3, true)); authored.putFile(3, fileEntry(3, story.length, story, 3))
  authored.putFile(4, fileEntry(4, 0, new Uint8Array(), 3)); authored.putFile(5, fileEntry(5, empty.length, empty, 3, true))
  // Unused is a real directory, but its body need not be fetched to list root.
  authored.putFile(6, fileEntry(6, 40, shortAd(40, 90), 0, true)); authored.putFile(90, directoryBytes(90, 1, []))
  assert.equal(await readDiscVolumeLabel(authored.source, track()), '物語DISC')
  const fs = await openDiscFilesystem(authored.source, track()); assert(fs)
  assert.deepEqual((await fs.list(''))?.map(({ name, directory }) => [name, directory]),
    [['Routes', true], ['Empty.dat', false], ['Empty', true], ['Unused', true]])
  assert(!authored.reads.some(([at, length]) => at <= (partitionStart + 90) * blockSize && at + length > (partitionStart + 90) * blockSize))
  const file = await fs.file('routes/開幕.TJS'); assert(file)
  assert.deepEqual(await contents(file), story)
  assert.equal(await fs.file('./Routes/../Routes\\開幕.tjs'), file)
  assert.equal(await fs.file('Routes'), undefined); assert.equal(await fs.list('Routes/開幕.tjs'), undefined)
  assert.equal(await fs.list('missing'), undefined); assert.deepEqual(await fs.list('Empty'), [])
  assert.deepEqual(await contents(await fs.file('EMPTY.DAT')), new Uint8Array())
  const before = authored.reads.length
  await fs.list('routes'); assert.equal(await fs.file('Routes/開幕.tjs'), file)
  assert.equal(authored.reads.length, before, 'Cached directory and ICB metadata do not reread the image')
  const mutable = await file.read(0, file.size); mutable.fill(0)
  assert.deepEqual(await contents(file), story, 'Read buffers do not mutate cached inline file bytes')
})

test('UDF short and long allocation descriptors join recorded extents and zero-fill both sparse forms', async () => {
  const authored = image(), shortSize = 3 * blockSize + 7, longSize = blockSize + 5
  authored.root([{ name: 'Short.bin', icb: 2 }, { name: 'Long.bin', icb: 3 }])
  authored.putFile(2, fileEntry(2, shortSize, concat([shortAd(blockSize, 70), shortAd(blockSize, 71, 1),
    shortAd(blockSize, 0, 2), shortAd(7, 72)]), 0, false, 1, 2))
  authored.putFile(3, fileEntry(3, longSize, concat([longAd(blockSize, 73), longAd(5, 74)]), 1))
  authored.putFile(70, new Uint8Array(blockSize).fill(17)); authored.putFile(71, new Uint8Array(blockSize).fill(99))
  authored.putFile(72, Uint8Array.of(1, 2, 3, 4, 5, 6, 7)); authored.putFile(73, new Uint8Array(blockSize).fill(34))
  authored.putFile(74, Uint8Array.of(41, 42, 43, 44, 45))
  const fs = await openDiscFilesystem(authored.source, track()); assert(fs)
  const short = await fs.file('SHORT.BIN'), long = await fs.file('long.bin'); assert(short); assert(long)
  assert.equal(short.size, shortSize); assert.equal(long.size, longSize)
  assert.deepEqual(await short.read(blockSize - 2, 6), Uint8Array.of(17, 17, 0, 0, 0, 0))
  const before = authored.reads.length
  assert.deepEqual(await short.read(blockSize, 2 * blockSize), new Uint8Array(2 * blockSize))
  assert.equal(authored.reads.length, before, 'Unrecorded extents never read stale physical bytes')
  assert.deepEqual(await short.read(3 * blockSize - 2, 9), Uint8Array.of(0, 0, 1, 2, 3, 4, 5, 6, 7))
  assert.deepEqual(await long.read(blockSize - 2, 7), Uint8Array.of(34, 34, 41, 42, 43, 44, 45))
  assert.deepEqual(await short.read(short.size, 0), new Uint8Array())
})

test('UDF allocation continuation descriptors preserve file order for short and long lists', async () => {
  for (const format of [0, 1] as const) {
    const authored = image(), ad = format === 0 ? shortAd : longAd, tail = concat([ad(blockSize, 0, 2), ad(5, 74)]),
      continuation = new Uint8Array(24 + tail.length), cv = dataView(continuation)
    authored.root([{ name: 'Scene.bin', icb: 2 }])
    authored.putFile(2, fileEntry(2, 2 * blockSize + 5, concat([ad(blockSize, 70), ad(blockSize, 20, 3)]), format, false, 1, 2))
    cv.setUint32(16, 0, true); cv.setUint32(20, tail.length, true); continuation.set(tail, 24)
    authored.putFile(20, descriptor(258, 20, continuation))
    authored.putFile(70, new Uint8Array(blockSize).fill(19)); authored.putFile(74, Uint8Array.of(7, 8, 9, 10, 11))
    const fs = await openDiscFilesystem(authored.source, track()); assert(fs)
    const file = await fs.file('scene.bin'); assert(file)
    assert.equal(file.size, 2 * blockSize + 5)
    assert.deepEqual(await file.read(blockSize - 1, blockSize + 6), concat([Uint8Array.of(19), new Uint8Array(blockSize), Uint8Array.of(7, 8, 9, 10, 11)]))
    assert.equal(file.borrowBlob, undefined)
  }
})

test('UDF directory records may cross blocks and deleted/parent identifiers are omitted', async () => {
  const authored = image(), names = Array.from({ length: 28 }, (_, i) => String(i).padStart(3, '0') + '-'.repeat(22)),
    crossing = 'chapter-' + 'x'.repeat(173), entries: Entry[] = names.map((name) => ({ name, icb: 2 })),
    directory = directoryBytes(30, 1, [...entries, { name: crossing, icb: 2 }, { name: 'Deleted.tjs', icb: 2, deleted: true }, { name: 'Last.tjs', icb: 3 }])
  // Parent = 40 bytes, then 28 * 64 bytes: the 220-byte name record begins
  // at 1832 and ends at 2052, across the first directory block boundary.
  assert.equal(crossing.length, 181)
  authored.putFile(1, fileEntry(1, directory.length, longAd(directory.length, 30), 1, true))
  authored.putFile(30, directory); authored.putFile(2, fileEntry(2, 1, Uint8Array.of(42), 3, false, 29))
  authored.putFile(3, fileEntry(3, 2, Uint8Array.of(7, 9), 3))
  const fs = await openDiscFilesystem(authored.source, track()); assert(fs)
  assert.deepEqual((await fs.list(''))?.map((entry) => entry.name), [...names, crossing, 'Last.tjs'])
  assert.deepEqual(await contents(await fs.file(crossing.toUpperCase())), Uint8Array.of(42))
  assert.deepEqual(await contents(await fs.file('last.tjs')), Uint8Array.of(7, 9))
  assert.equal(await fs.file('Deleted.tjs'), undefined)
})

test('UDF sparse files retain 64-bit lengths and distant physical range reads', async () => {
  const authored = image(3_000_000), hole = 0x3ffff800, beforeTail = 4 * hole, tailBlock = 2_500_000,
    ads = concat([shortAd(hole, 0, 2), shortAd(hole, 0, 2), shortAd(hole, 0, 2), shortAd(hole, 0, 2), shortAd(16384, tailBlock)])
  authored.root([{ name: 'Movie.bin', icb: 2 }]); authored.putFile(2, fileEntry(2, beforeTail + 16384, ads, 0, false, 1, 8))
  authored.putFile(tailBlock, Uint8Array.of(11, 22, 33, 44))
  const fs = await openDiscFilesystem(authored.source, track()); assert(fs)
  const file = await fs.file('movie.bin'); assert(file); assert(file.size > 0xffffffff)
  const before = authored.reads.length
  assert.deepEqual(await file.read(beforeTail - 100, 6), new Uint8Array(6))
  assert.equal(authored.reads.length, before)
  // The recorded tail's physical sector is beyond 4 GiB. Read across its
  // sparse boundary, then address its remaining zeros past 32-bit file offsets.
  assert.deepEqual(await file.read(beforeTail - 2, 6), Uint8Array.of(0, 0, 11, 22, 33, 44))
  assert.deepEqual(await file.read(0x100000000, 6), new Uint8Array(6))
  assert(authored.reads.slice(before).some(([at]) => at > 0xffffffff))
  assert(authored.reads.reduce((sum, [, length]) => sum + length, 0) < 128 * 1024)
})

test('UDF uses the selected cooked/raw track and nonzero CUE INDEX for every file extent', async () => {
  for (const [stride, payload] of [[2048, 0], [2352, 16], [2336, 8], [2352, 24]] as const) {
    const authored = image(), first = 150, body = ascii('Scene from the selected data track')
    authored.root([{ name: 'Scene.txt', icb: 2 }]); authored.putFile(2, fileEntry(2, body.length, shortAd(body.length, 70), 0)); authored.putFile(70, body)
    const physical: ByteSource = { size: (first + authored.source.size / blockSize) * stride, async read(offset, length) {
      assert.equal(offset % stride, 0); assert(length <= 65536)
      const result = new Uint8Array(length)
      for (let at = 0; at < length; at += stride) {
        const logical = (offset + at) / stride - first, data = await authored.source.read(logical * blockSize, blockSize),
          raw = new Uint8Array(stride)
        if (stride === 2352) { raw.fill(255, 1, 11); raw[15] = payload === 16 ? 1 : 2 }
        if (payload === 8 || payload === 24) { raw[payload - 6] = 8; raw[payload - 2] = 8 }
        raw.set(data, payload); result.set(raw.subarray(0, Math.min(stride, length - at)), at)
      }
      return result
    } }, fs = await openDiscFilesystem(physical, track(first, stride, payload)); assert(fs)
    assert.deepEqual(await contents(await fs.file('SCENE.TXT')), body)
  }
})

test('UDF 2.01 extended file entries read embedded scripts and external media from their own allocation offsets', async () => {
  const authored = image(), script = Uint8Array.of(255, 254, 57, 0, 42, 0, 57, 0), media = Uint8Array.of(82, 73, 70, 70, 7, 8)
  authored.regions.get(17 * blockSize)!.set(ascii('NSR03'), 1)
  for (const [offset, bytes] of authored.regions) {
    if (offset < 256 * blockSize) continue
    const view = dataView(bytes), id = view.getUint16(0, true)
    if (id === 5) bytes.set(ascii('+NSR03'), 25)
    if (id === 6) view.setUint16(240, 0x201, true)
    if (id === 256) view.setUint16(440, 0x201, true)
    if (id === 9) for (const at of [128, 130, 132]) view.setUint16(at, 0x201, true)
    descriptor(id, view.getUint32(12, true), bytes, 3)
  }
  const root = directoryBytes(1, 1, [{ name: '章.tjs', icb: 2, wide: true }, { name: 'Sound.wav', icb: 3 }], true)
  authored.putFile(1, extendedEntry(1, root.length, root, 3, true))
  authored.putFile(2, extendedEntry(2, script.length, script, 3))
  authored.putFile(3, extendedEntry(3, media.length, longAd(media.length, 70), 1)); authored.putFile(70, media)
  const fs = await openDiscFilesystem(authored.source, track()); assert(fs)
  assert.deepEqual(await fs.list(''), [{ name: '章.tjs', size: script.length, directory: false }, { name: 'Sound.wav', size: media.length, directory: false }])
  assert.deepEqual(await contents(await fs.file('章.tjs')), script)
  assert.deepEqual(await contents(await fs.file('sound.WAV')), media)
})

test('UDF borrows a single cooked movie extent without copying its media or losing cancellation', async () => {
  const authored = image(500_000), size = 256 * 1024 * 1024, first = 150, borrowed: [number, number][] = [],
    immutable = (length: number): ImmutableBlob => ({ size: length, slice: (at = 0, end = length) => immutable(end - at),
      arrayBuffer: async () => { throw new Error('Movie bytes must remain borrowed') } })
  authored.root([{ name: 'Movie.mpg', icb: 2 }]); authored.putFile(2, fileEntry(2, size, longAd(size, 100), 1))
  const source: ByteSource = { size: authored.source.size + first * blockSize,
    read: (at, length) => authored.source.read(at - first * blockSize, length),
    borrowBlob: async (at, length) => { borrowed.push([at, length]); return immutable(length) } },
    fs = await openDiscFilesystem(source, track(first)); assert(fs)
  const file = await fs.file('movie.mpg'); assert(file?.borrowBlob)
  const before = authored.reads.length; let checks = 0
  const blob = await file.borrowBlob(11, size - 11, () => { checks++ })
  assert.equal(blob.size, size - 11); assert(checks >= 2)
  assert.deepEqual(borrowed, [[(first + partitionStart + 100) * blockSize + 11, size - 11]])
  assert.equal(authored.reads.length, before)
  const cancelled = new Error('Movie request cancelled')
  await assert.rejects(file.borrowBlob(0, 1, () => { throw cancelled }), (error) => error === cancelled)
  assert.equal(borrowed.length, 1)
})

test('a rewritable game disc follows its newest sparing table for the root, scene data and borrowed movie', async () => {
  const disc = image(1644), packet = 16, rootSpare = 1456, sceneSpare = 1472
  for (const base of [257, 270]) {
    const logical = new Uint8Array(504), view = dataView(logical)
    logical.set(disc.regions.get((base + 2) * blockSize)!.subarray(0, 440))
    view.setUint16(240, 0x201, true); view.setUint32(264, 64, true)
    logical[440] = 2; logical[441] = 64; entity(logical, 444, '*UDF Sparable Partition')
    view.setUint16(476, 1, true); view.setUint16(478, 7, true)
    view.setUint16(480, packet, true); logical[482] = 2
    view.setUint32(484, 80, true); view.setUint32(488, 288, true); view.setUint32(492, 304, true)
    disc.put(base + 2, descriptor(6, base + 2, logical))
  }
  for (const [block, sequence, active] of [[288, 3, false], [304, 4, true]] as const) {
    const data = new Uint8Array(80), view = dataView(data)
    entity(data, 16, '*UDF Sparing Table'); view.setUint16(48, 3, true); view.setUint32(52, sequence, true)
    for (const [index, [logical, physical]] of [[0, rootSpare], [80, sceneSpare], [0xffffffff, 1488]].entries()) {
      view.setUint32(56 + index * 8, active ? logical! : 0xffffffff, true)
      view.setUint32(60 + index * 8, physical!, true)
    }
    disc.put(block, descriptor(0, block, data))
  }

  const scene = Uint8Array.from({ length: 18 * blockSize + 3 }, (_, i) => (i + Math.floor(i / blockSize) * 7) % 251)
  disc.root([{ name: 'Scene.dat', icb: 2 }, { name: 'Movie.mpg', icb: 3 }])
  disc.putFile(2, fileEntry(2, scene.length, shortAd(scene.length, 79), 0))
  disc.putFile(3, fileEntry(3, 3 * blockSize, longAd(3 * blockSize, 82), 1))
  for (let i = 0; i < packet; i++) {
    const old = (partitionStart + i) * blockSize, bytes = disc.regions.get(old)
    if (bytes) { disc.put(rootSpare + i, bytes); disc.regions.delete(old) }
  }
  for (let i = 0; i * blockSize < scene.length; i++) {
    const logical = 79 + i, physical = logical >= 80 && logical < 96 ? sceneSpare + logical - 80 : partitionStart + logical
    disc.put(physical, scene.subarray(i * blockSize, (i + 1) * blockSize))
  }
  const source: ByteSource = { ...disc.source, borrowBlob: async (at, n) =>
    new Blob([Uint8Array.from(await disc.source.read(at, n))]) }
  assert.equal(await readDiscVolumeLabel(source, track()), 'STORY_DISC')
  const fs = await openDiscFilesystem(source, track()); assert(fs)
  const file = await fs.file('scene.dat'); assert(file)
  assert.deepEqual(await contents(file), scene)
  for (const boundary of [blockSize, 17 * blockSize])
    assert.deepEqual(await file.read(boundary - 3, 9), scene.slice(boundary - 3, boundary + 6))
  assert.equal(file.borrowBlob, undefined)
  const movie = await fs.file('movie.mpg'); assert(movie?.borrowBlob)
  const clip = await movie.borrowBlob(7, 2 * blockSize)
  assert.deepEqual(new Uint8Array(await clip.arrayBuffer()), scene.slice(3 * blockSize + 7, 5 * blockSize + 7))
  const joinedFs = await openDiscFilesystem(source, track(), archiveReader.joinBlobs)
  const joined = await joinedFs?.file('scene.dat'); assert(joined?.borrowBlob)
  const crossing = await joined.borrowBlob(8, scene.length - 16)
  assert(crossing instanceof Blob)
  assert.deepEqual(new Uint8Array(await crossing.arrayBuffer()), scene.slice(8, -8))
  assert.equal((await joined.borrowBlob(joined.size, 0)).size, 0)
  let checks = 0
  await assert.rejects(joined.borrowBlob(0, scene.length, () => {
    if (++checks === 4) throw new Error('Game stopped during disc read')
  }), /Game stopped during disc read/)
  assert(!disc.reads.some(([at]) => at >= (partitionStart + 80) * blockSize && at < (partitionStart + 96) * blockSize))
})
