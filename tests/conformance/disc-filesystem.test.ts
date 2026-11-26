import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import type { ByteSource, ImmutableBlob } from '../../src/engine/ports/storage.ts'
import { openDiscFilesystem } from '../../src/formats/disc/filesystem.ts'
import type { DiscVolumeTrack } from '../../src/formats/disc/volume-label.ts'

const sector = 2048, ascii = (text: string) => new TextEncoder().encode(text),
  fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../../out/verification/disc-volumes/${name}.iso`, import.meta.url))),
  track = (first = 0, bytes = 2048, payload = 0): DiscVolumeTrack => ({ file: 'game.iso', first, layout: { bytes, payload } })
function bufferSource(bytes: Uint8Array): ByteSource {
  return { size: bytes.length, read: async (at, length) => bytes.slice(at, at + length) }
}
async function contents(source: ByteSource | undefined) {
  assert(source); return source.read(0, source.size)
}

// Independent ECMA-119 directory records for layout/extent boundaries. These
// author bytes directly; production is only used to read the finished image.
function dual16(bytes: Uint8Array, offset: number, value: number) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  v.setUint16(offset, value, true); v.setUint16(offset + 2, value)
}
function dual32(bytes: Uint8Array, offset: number, value: number) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  v.setUint32(offset, value, true); v.setUint32(offset + 4, value)
}
function dirent(name: string | number, block: number, size: number, flags = 0, unit = 0, gap = 0, attributes = 0) {
  const identifier = typeof name === 'number' ? Uint8Array.of(name) : ascii(name),
    bytes = new Uint8Array(33 + identifier.length + (identifier.length % 2 === 0 ? 1 : 0))
  bytes[0] = bytes.length; bytes[1] = attributes; dual32(bytes, 2, block); dual32(bytes, 10, size)
  bytes[25] = flags; bytes[26] = unit; bytes[27] = gap; dual16(bytes, 28, 1)
  bytes[32] = identifier.length; bytes.set(identifier, 33)
  return bytes
}
function directory(block: number, parent: number, entries: Uint8Array[]) {
  const bytes = new Uint8Array(sector)
  let at = 0
  for (const entry of [dirent(0, block, sector, 2), dirent(1, parent, sector, 2), ...entries]) {
    bytes.set(entry, at); at += entry.length
  }
  return bytes
}
function author(entries: Uint8Array[], blocks = 40) {
  const header = new Uint8Array(sector), end = new Uint8Array(sector)
  header[0] = 1; header.set(ascii('CD001'), 1); header[6] = 1
  dual32(header, 80, blocks); dual16(header, 120, 1); dual16(header, 124, 1); dual16(header, 128, sector)
  header.set(dirent(0, 20, sector, 2), 156); header[881] = 1
  end[0] = 255; end.set(ascii('CD001'), 1); end[6] = 1
  const regions = new Map<number, Uint8Array>([[16 * sector, header], [17 * sector, end], [20 * sector, directory(20, 20, entries)]]),
    reads: [number, number][] = [], source: ByteSource = { size: blocks * sector, read: async (at, length) => {
      assert(length <= 65536); assert(at >= 0 && at + length <= blocks * sector); reads.push([at, length])
      const bytes = new Uint8Array(length)
      for (const [offset, value] of regions) {
        const start = Math.max(at, offset), finish = Math.min(at + length, offset + value.length)
        if (finish > start) bytes.set(value.subarray(start - offset, finish - offset), start - at)
      }
      return bytes
    } }
  return { source, regions, reads, header }
}

test('reads independent genisoimage files through all cooked/raw MODE layouts and nonzero CUE INDEX', async () => {
  for (const name of ['plain', 'joliet']) for (const [stride, payload] of [[2048, 0], [2352, 16], [2336, 8], [2352, 24]] as const) {
    const input = fixture(name), first = 150, reads: [number, number][] = [], source: ByteSource = {
      size: (first + input.length / sector) * stride,
      borrowBlob: async () => { throw new Error('This control reads actual sectors') },
      async read(at, length) {
        assert.equal(at % stride, 0); assert.equal(length % stride, 0); assert(length <= 65536)
        reads.push([at, length]); const out = new Uint8Array(length)
        for (let offset = 0; offset < length; offset += stride) {
          const logical = (at + offset) / stride - first, raw = out.subarray(offset, offset + stride)
          assert(logical >= 16)
          if (stride === 2352) { raw.fill(255, 1, 11); raw[15] = payload === 16 ? 1 : 2 }
          if (payload === 8 || payload === 24) { raw[payload - 6] = 8; raw[payload - 2] = 8 }
          raw.set(input.subarray(logical * sector, (logical + 1) * sector), payload)
        }
        return out
      },
    }, fs = await openDiscFilesystem(source, track(first, stride, payload))
    assert(fs)
    assert.deepEqual(await fs.list(''), [{ name: 'SCENE.TXT', size: 26, directory: false }])
    const file = await fs.file('scene.txt')
    assert.equal(typeof file?.borrowBlob, stride === sector ? 'function' : 'undefined')
    assert.equal(new TextDecoder().decode(await contents(file)), 'Disc identification scene\n')
    assert.equal(await fs.file('SCENE.TXT'), file, 'Case aliases reuse the same byte source')
    if (name === 'plain') assert.equal(await fs.file('SCENE.TXT;1'), file, 'Recorded version aliases reuse the same byte source')
    assert.equal(await fs.file('SCENE.TXT;2'), undefined)
    assert(reads.reduce((sum, [, bytes]) => sum + bytes, 0) < input.length)
  }
})

test('opens actual Joliet game subdirectories, Japanese scripts, an archive and empty entries without whole-image reads', async () => {
  const bytes = fixture('story'), reads: [number, number][] = [], fs = await openDiscFilesystem({ size: bytes.length,
    read: async (at, length) => { assert(length <= 65536); reads.push([at, length]); return bytes.slice(at, at + length) } }, track())
  assert(fs)
  const roots = await fs.list('')
  assert(roots?.some((entry) => entry.name === 'Routes' && entry.directory))
  assert.deepEqual(await fs.list('Empty'), [])
  assert.equal(await fs.list('missing'), undefined)
  assert.equal(await fs.file('Routes'), undefined)
  const empty = await fs.file('empty.DAT'); assert(empty); assert.equal(empty.size, 0)
  const before = reads.length; assert.deepEqual(await empty.read(0, 0), new Uint8Array()); assert.equal(reads.length, before)
  const latin = await contents(await fs.file('routes/MOON FINALE.TJS')), japanese = await contents(await fs.file('Routes\\開幕.tjs'))
  assert.deepEqual(latin.subarray(0, 2), Uint8Array.of(255, 254)); assert.deepEqual(japanese.subarray(0, 2), Uint8Array.of(255, 254))
  assert.equal(new TextDecoder('utf-16le').decode(latin), '"Moon disc scene"')
  assert.equal(new TextDecoder('utf-16le').decode(japanese), '6*7')
  const bitmap = await fs.file('Art/title.bmp'), archive = await fs.file('Books/Scenes.zip')
  assert(bitmap); assert(archive)
  assert.equal(new TextDecoder().decode(await bitmap.read(0, 2)), 'BM')
  assert.deepEqual(await archive.read(0, 4), Uint8Array.of(80, 75, 3, 4))
  assert.equal(await fs.file('Routes/../Books/Scenes.zip'), archive)
  assert.equal(await fs.list('Books/Scenes.zip'), undefined)
})

test('follows CDFS version order, empty extensions and associated-file filtering while caching only requested directories', async () => {
  const image = author([dirent('SCENE.TXT;3', 30, 1, 4), dirent('SCENE.TXT;2', 30, 1), dirent('SCENE.TXT;1', 31, 1),
    dirent('README.;1', 32, 1), dirent('UNVISITED', 21, sector, 2), dirent('EMPTY.DAT;1', 0, 0)])
  image.regions.set(30 * sector, Uint8Array.of(2)); image.regions.set(31 * sector, Uint8Array.of(1)); image.regions.set(32 * sector, Uint8Array.of(9))
  const fs = await openDiscFilesystem(image.source, track()); assert(fs)
  assert.deepEqual(await contents(await fs.file('scene.txt')), Uint8Array.of(2))
  assert.deepEqual(await contents(await fs.file('scene.txt;1')), Uint8Array.of(1))
  assert.deepEqual(await contents(await fs.file('./readme.')), Uint8Array.of(9))
  assert.deepEqual((await fs.list(''))?.map((row) => row.name), ['SCENE.TXT', 'README', 'UNVISITED', 'EMPTY.DAT'])
  assert(!image.reads.some(([at, length]) => at <= 21 * sector && at + length > 21 * sector))
  await assert.rejects(fs.file('../SCENE.TXT'), /relative|root/)
  await assert.rejects(fs.file('C:\\SCENE.TXT'), /relative/)
})

test('reads valid multi-extent files larger than 4 GiB and distant extents without 32-bit offset truncation', async () => {
  const firstSize = 0xfffff800, secondBlock = 2_500_000,
    image = author([dirent('LARGE.BIN;1', 30, firstSize, 128), dirent('LARGE.BIN;1', secondBlock, 4096)], 3_000_000)
  image.source.borrowBlob = async () => { throw new Error('Multi-extent files cannot borrow a contiguous view') }
  image.regions.set(30 * sector + firstSize - 3, Uint8Array.of(1, 2, 3))
  image.regions.set(secondBlock * sector, Uint8Array.of(4, 5, 6, 7, 8))
  const fs = await openDiscFilesystem(image.source, track()); assert(fs)
  const file = await fs.file('large.bin'); assert(file); assert.equal(file.size, firstSize + 4096); assert(file.size > 0xffffffff)
  assert.deepEqual(await file.read(firstSize - 3, 8), Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))
  assert(image.reads.some(([at]) => at > 0xffffffff)); assert(image.reads.reduce((sum, [, length]) => sum + length, 0) < 20000)
  await assert.rejects(file.read(file.size - 1, 2), /range/)
  await assert.rejects(file.read(0, 64 * 1024 * 1024 + 1), /64 MiB/)
  const shortSections = author([dirent('TEXT.TXT;1', 30, 3, 128), dirent('TEXT.TXT;1', 31, 2)])
  shortSections.regions.set(30 * sector, ascii('ABC')); shortSections.regions.set(31 * sector, ascii('DE'))
  const shortFs = await openDiscFilesystem(shortSections.source, track()); assert(shortFs)
  assert.deepEqual(await contents(await shortFs.file('text.txt')), ascii('ABCDE'))

  // A media consumer may borrow a large contiguous cooked extent. This source
  // owns the immutable view; the filesystem must never materialize its bytes.
  const largeSize = 256 * 1024 * 1024, first = 150, contiguous = author([dirent('MOVIE.MPG;1', secondBlock, largeSize)], 3_000_000),
    borrowed: [number, number][] = [], immutable = (size: number): ImmutableBlob => ({ size,
      slice: (start = 0, end = size) => immutable(end - start),
      arrayBuffer: async () => { throw new Error('The sparse movie must remain borrowed') } }),
    provider: ByteSource = { size: contiguous.source.size + first * sector,
      read: (at, length) => contiguous.source.read(at - first * sector, length),
      borrowBlob: async (at, length) => { borrowed.push([at, length]); return immutable(length) } },
    borrowedFs = await openDiscFilesystem(provider, track(first)); assert(borrowedFs)
  const movie = await borrowedFs.file('movie.mpg'); assert(movie?.borrowBlob)
  const before = contiguous.reads.length
  let checks = 0
  const blob = await movie.borrowBlob(7, largeSize - 7, () => { checks++ })
  assert.equal(blob.size, largeSize - 7); assert(checks >= 2)
  assert.deepEqual(borrowed, [[(first + secondBlock) * sector + 7, largeSize - 7]])
  assert.equal(contiguous.reads.length, before)
  const cancelled = new Error('Borrow cancelled')
  await assert.rejects(movie.borrowBlob(0, 1, () => { throw cancelled }), (error) => error === cancelled)
  assert.equal(borrowed.length, 1)
  let stages = 0
  await assert.rejects(movie.borrowBlob(0, 1, () => { if (++stages === 2) throw cancelled }), (error) => error === cancelled)
  assert.equal(stages, 2); assert.equal(borrowed.length, 2); assert.equal(contiguous.reads.length, before)
  await assert.rejects(async () => movie.borrowBlob!(largeSize, 1), /range/)
  assert.equal(file.borrowBlob, undefined, 'Multi-extent files retain range reads')
})

test('accounts for extended-attribute blocks and legal file-unit gaps', async () => {
  const image = author([dirent('INTER.BIN;1', 29, sector * 2 + 3, 0, 1, 1, 1)])
  image.source.borrowBlob = async () => { throw new Error('Interleaved files cannot borrow a contiguous view') }
  // Block 29 is the attribute unit; 30 is its gap. Data units are 31/33/35.
  image.regions.set(30 * sector, new Uint8Array(sector).fill(99))
  image.regions.set(31 * sector, new Uint8Array(sector).fill(10))
  image.regions.set(33 * sector, new Uint8Array(sector).fill(20))
  image.regions.set(35 * sector, Uint8Array.of(30, 31, 32))
  const fs = await openDiscFilesystem(image.source, track()); assert(fs)
  const file = await fs.file('inter.bin'); assert(file)
  assert.equal(file.borrowBlob, undefined)
  assert.deepEqual(await file.read(sector - 2, 6), Uint8Array.of(10, 10, 20, 20, 20, 20))
  assert.deepEqual(await file.read(sector * 2 - 2, 5), Uint8Array.of(20, 20, 30, 31, 32))
})

test('keeps provider failures and rejects incomplete records, continuations and selected-track overrun', async () => {
  const unrecognized = new Uint8Array(sector * 18)
  assert.equal(await openDiscFilesystem(bufferSource(unrecognized), track()), undefined)
  const complete = author([dirent('FILE.TXT;1', 30, 3)])
  await assert.rejects(openDiscFilesystem(complete.source, { ...track(), end: 17 }), /range|terminator/)
  const original = new Error('Source stopped')
  await assert.rejects(openDiscFilesystem({ size: sector * 40, read: async () => { throw original } }, track()), (error) => error === original)
  const short = await openDiscFilesystem({ ...complete.source, read: async (at, length) => {
    const bytes = await complete.source.read(at, length); return at === 20 * sector ? bytes.subarray(1) : bytes
  } }, track()); assert(short)
  await assert.rejects(short.file('file.txt'), /short sector/)
  for (const records of [
    [dirent('FILE.TXT;1', 39, sector + 1)],
    [dirent('FILE.TXT;1', 30, sector, 128)],
    [dirent('FILE.TXT;1', 30, sector, 128), dirent('OTHER.TXT;1', 31, 1)],
  ]) {
    const image = author(records), fs = await openDiscFilesystem(image.source, track()); assert(fs)
    await assert.rejects(fs.file('file.txt'), /range|final|consecutive/)
  }
  const corrupt = author([dirent('FILE.TXT;1', 30, 3)])
  corrupt.regions.get(20 * sector)![68] = 1
  const fs = await openDiscFilesystem(corrupt.source, track()); assert(fs)
  await assert.rejects(fs.list(''), /record/)
})
