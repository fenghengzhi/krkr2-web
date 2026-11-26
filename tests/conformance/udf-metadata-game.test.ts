import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { openDiscFilesystem } from '../../src/formats/disc/filesystem.ts'
import { readDiscVolumeLabel } from '../../src/formats/disc/volume-label.ts'
import { udfMetadataGameDisc } from '../helpers/udf-game-discs.ts'

for (const bridge of [false, true]) test(`every path and byte on the Windows-mastered ${bridge ? 'bridge' : 'UDF-only'} game disc matches independent 7-Zip extraction`, async () => {
  const { files, manifest } = udfMetadataGameDisc(bridge), disc = files[0]!, source = {
    size: disc.buffer.length,
    async read(at: number, length: number) {
      assert(at >= 0 && length > 0 && length <= 65536 && at + length <= disc.buffer.length)
      return disc.buffer.subarray(at, at + length)
    },
  }
  const track = { file: disc.name, first: 0, layout: { bytes: 2048, payload: 0 } }
  assert.equal(await readDiscVolumeLabel(source, track), 'KRKR_STORY')
  const fs = await openDiscFilesystem(source, track); assert(fs)
  const actual: Record<string, string | null> = {}, pending = ['']
  while (pending.length) {
    const parent = pending.pop()!
    const children = await fs.list(parent); assert(children)
    for (const child of children) {
      const path = parent ? parent + '/' + child.name : child.name
      assert(!Object.hasOwn(actual, path))
      if (child.directory) { actual[path] = null; pending.push(path); continue }
      const file = await fs.file(path); assert(file); assert.equal(file.size, child.size)
      const digest = createHash('sha256')
      for (let at = 0; at < file.size; at += 65536)
        digest.update(await file.read(at, Math.min(65536, file.size - at)))
      actual[path] = digest.digest('hex')
    }
  }
  assert.deepEqual(actual, manifest.tree)
})

test('a bridge with unreadable UDF anchors still serves the independently readable ISO chapter', async () => {
  const { files, manifest } = udfMetadataGameDisc(true), disc = files[0]!, bytes = Buffer.from(disc.buffer)
  assert(manifest.isoTree)
  const chapterHash = manifest.tree['Routes/開幕.tjs']
  const isoName = Object.keys(manifest.isoTree).find((name) => manifest.isoTree![name] === chapterHash)
  assert(isoName); assert.notEqual(isoName.toLowerCase(), 'routes/開幕.tjs')
  const source = { size: bytes.length, read: async (at: number, length: number) => bytes.subarray(at, at + length) }
  const track = { file: disc.name, first: 0, layout: { bytes: 2048, payload: 0 } }
  // Give the ISO primary descriptor a different legal label on this copy.
  // The volume label returned to searchCD must follow the selected namespace.
  const primary = Array.from({ length: 16 }, (_, i) => (16 + i) * 2048)
    .find((at) => bytes[at] === 1 && bytes.toString('ascii', at + 1, at + 6) === 'CD001')
  assert(primary !== undefined)
  bytes.write('SHORT_CD'.padEnd(32), primary + 40, 'ascii')
  assert.equal(await readDiscVolumeLabel(source, track), 'KRKR_STORY')
  for (const sector of [256, bytes.length / 2048 - 257, bytes.length / 2048 - 1])
    if (bytes.readUInt16LE(sector * 2048) === 2) bytes.fill(0, sector * 2048, sector * 2048 + 16)
  assert.equal(await readDiscVolumeLabel(source, track), 'SHORT_CD')
  const fs = await openDiscFilesystem(source, track); assert(fs)
  assert.equal(await fs.file('Routes/開幕.tjs'), undefined)
  const chapter = await fs.file(isoName); assert(chapter)
  assert.equal(createHash('sha256').update(await chapter.read(0, chapter.size)).digest('hex'), chapterHash)
})
