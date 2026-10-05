import test from 'node:test'
import assert from 'node:assert/strict'
import { BlobSource, inflate } from '../../src/backends/files/blob-source.ts'
import { findXp3Archive, readXp3 } from '../../src/formats/xp3/archive.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { embedXp3, xp3Fixture, xp3Signature } from '../helpers/xp3-fixtures.ts'
import type { ByteSource } from '../../src/engine/ports/storage.ts'

const source = (bytes: Uint8Array): ByteSource => new BlobSource(new Blob([Uint8Array.from(bytes).buffer]))

for (const compressed of [false, true]) for (const continuation of [false, true])
  test(`embedded XP3 ${compressed ? 'zlib' : 'raw'}/${continuation ? 'continued' : 'single'} keeps all index and payload offsets relative to its mark`, async () => {
    const files = { 'startup.tjs': 'var answer=42;', 'scenario/二.tjs': '"第二段"', 'audio.bin': Uint8Array.of(1, 2, 3, 4) },
      archive = xp3Fixture(files, { compressed, continuation }), offset = 256 * 1024 + 16,
      bytes = embedXp3(archive.bytes, offset), reads: [number, number][] = [], original = source(bytes),
      input: ByteSource = { size: original.size, read: async (at, length) => {
        reads.push([at, length]); return original.read(at, length)
      } }
    assert.equal((await findXp3Archive(input))?.offset, offset)
    const decoded = await readXp3(input, inflate)
    assert.deepEqual(decoded.map((entry) => entry.name), Object.keys(files))
    reads.length = 0
    for (const [index, entry] of decoded.entries()) {
      const expected = Object.values(files)[index]!
      assert.deepEqual(Buffer.from(await entry.read()), typeof expected === 'string' ? Buffer.from(expected) : Buffer.from(expected))
      assert(reads.some(([at]) => at === offset + archive.segmentOffsets[index]!))
      assert.equal(!!entry.source, !compressed)
    }
    if (!compressed) {
      reads.length = 0
      assert.deepEqual([...await decoded[2]!.source!.read(1, 2)], [2, 3])
      assert.deepEqual(reads, [[offset + archive.segmentOffsets[2]! + 1, 2]])
    }
  })

test('XP3 scanning follows native MZ, first mark and 16-byte paragraph rules at block and file ends', async () => {
  const archive = xp3Fixture({ 'startup.tjs': '1' }).bytes
  assert.equal((await findXp3Archive(source(archive)))?.offset, 0)
  for (const offset of [16, 256 * 1024, 256 * 1024 + 16, 512 * 1024 + 16]) {
    const bytes = embedXp3(archive, offset)
    // A complete but unaligned earlier mark is not an archive boundary.
    if (offset > 32) bytes.set(xp3Signature, 17)
    assert.equal((await findXp3Archive(source(bytes)))?.offset, offset)
  }
  const first = embedXp3(Buffer.concat([archive, Buffer.alloc(64), archive]), 32)
  assert.equal((await findXp3Archive(source(first)))?.offset, 32)
  first[0] = 0
  assert.equal(await findXp3Archive(source(first)), undefined, 'An arbitrary prefix is not an executable header')
  const truncated = Buffer.alloc(16 + 10); truncated.set([0x4d, 0x5a]); truncated.set(xp3Signature.subarray(0, 10), 16)
  assert.equal(await findXp3Archive(source(truncated)), undefined)
  const exactMark = Buffer.alloc(16 + 11); exactMark.set([0x4d, 0x5a]); exactMark.set(xp3Signature, 16)
  assert.equal((await findXp3Archive(source(exactMark)))?.offset, 16)
  await assert.rejects(readXp3(source(exactMark), inflate), /outside valid range/)
})

test('an invalid first aligned XP3 is not replaced by a later valid archive and a failed import remains unpublished', async () => {
  const archive = xp3Fixture({ 'startup.tjs': '42' }).bytes,
    bytes = embedXp3(archive, 128)
  bytes.set(xp3Signature, 16)
  bytes.writeBigUInt64LE(BigInt(bytes.length), 27)
  assert.equal((await findXp3Archive(source(bytes)))?.offset, 16)
  await assert.rejects(readXp3(source(bytes), inflate), /outside valid range/)
  await assert.rejects(importSources([{ path: 'ordinary.txt', source: source(Buffer.from('old')) },
    { path: 'broken.exe', source: source(bytes) }], async () => {}), /outside valid range/)
})

test('embedded XP3 signature scanning is bounded, cancellable and rejects short source reads', async () => {
  const reads: [number, number][] = [], large: ByteSource = { size: 1024 ** 3,
    async read(offset, length) {
      reads.push([offset, length])
      const bytes = new Uint8Array(length)
      if (!offset) bytes.set([0x4d, 0x5a])
      return bytes
    } }, failure = new Error('cancel archive scan')
  await assert.rejects(findXp3Archive(large, { checkpoint() {
    if (reads.some(([offset]) => offset === 256 * 1024 + 16)) throw failure
  } }), (error) => error === failure)
  assert.deepEqual(reads, [[0, 11], [16, 256 * 1024], [256 * 1024 + 16, 256 * 1024]])
  await assert.rejects(findXp3Archive({ size: 20, async read() { return new Uint8Array(1) } }), /Short XP3/)
  await assert.rejects(findXp3Archive({ ...large, size: Number.MAX_SAFE_INTEGER + 1 }), /source size/)
})

test('MZ sources without XP3 stay ordinary files and embedded members keep qualified aliases and range access', async () => {
  const archive = xp3Fixture({ 'startup.tjs': '42' }), ordinary = Buffer.alloc(32)
  ordinary.set([0x4d, 0x5a])
  const resources = await importSources([
    { path: 'engine.exe', source: source(ordinary) },
    { path: 'game.dat', source: source(embedXp3(archive.bytes)) },
  ], async () => {})
  assert.deepEqual(resources.map((entry) => entry.name), ['engine.exe', 'game.dat', 'startup.tjs', 'game.dat>startup.tjs'])
  assert.deepEqual(Buffer.from(await resources[0]!.read()), ordinary)
  assert.equal(resources[2]!.source, resources[3]!.source)
  assert.equal(Buffer.from(await resources[3]!.source!.read(0, 2)).toString(), '42')
})
