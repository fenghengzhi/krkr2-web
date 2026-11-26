import assert from 'node:assert/strict'
import test from 'node:test'
import { openPortablePcmSource } from '../../src/backends/audio/pcm-source.ts'
import { mp3AudioEnd } from '../../src/formats/audio/mp3-tags.ts'
import { mp3Reference } from '../helpers/cdda-mp3.ts'

function albumTag(withHeader: boolean): Buffer {
  const name = Buffer.from('Cover Art (Front)\0'), picture = Buffer.alloc(200_000, 0x55)
  const item = Buffer.alloc(8)
  item.writeUInt32LE(picture.length); item.writeUInt32LE(2, 4)
  const footer = Buffer.alloc(32)
  footer.write('APETAGEX'); footer.writeUInt32LE(2000, 8)
  footer.writeUInt32LE(32 + item.length + name.length + picture.length, 12)
  footer.writeUInt32LE(1, 16); footer.writeUInt32LE(withHeader ? 0x80000000 : 0, 20)
  const header = Buffer.from(footer)
  header.writeUInt32LE(0xa0000000, 20)
  return Buffer.concat([...(withHeader ? [header] : []), item, name, picture, footer])
}

const id3 = Buffer.alloc(128)
id3.write('TAG')
const sourceOf = (bytes: Uint8Array) => ({
  size: bytes.length, read: async (at: number, count: number) => bytes.subarray(at, at + count),
})

test('APEv2 with or without a header and ID3v1 needs only tag boundary reads', async () => {
  const audio = Buffer.alloc(2457, 0x73)
  for (const tag of [albumTag(false), albumTag(true)]) {
    for (const suffix of [[tag], [tag, id3], [id3, tag]]) {
      const bytes = Buffer.concat([audio, ...suffix]), reads: number[] = []
      const end = await mp3AudioEnd(async (at, count) => {
        reads.push(count)
        return bytes.subarray(at, at + count)
      }, bytes.length)
      assert.equal(end, audio.length)
      assert(reads.every((count) => count <= 32))
      assert(reads.length <= 4)
    }
  }
})

test('album metadata after real CD music preserves gapless length and opening and closing samples', async (t) => {
  const { files } = mp3Reference(), mp3 = files.get('vbr.mp3')!
  const sources = []
  for (const file of [mp3, Buffer.concat([mp3, albumTag(true), id3])]) {
    const source = await openPortablePcmSource(sourceOf(file), { cddaFile: true })
    assert(source)
    t.after(() => source.close())
    sources.push(source)
  }
  const [plain, tagged] = sources
  assert.deepEqual(plain!.info, tagged!.info)
  for (const at of [0, plain!.info.sampleCount - 4096])
    assert.deepEqual(await tagged!.read(at, 4096), await plain!.read(at, 4096))
})
