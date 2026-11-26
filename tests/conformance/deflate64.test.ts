import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { crc32 } from 'node:zlib'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { createArchiveInflatePool } from '../../src/backends/files/archive-inflater.ts'
import { readZip } from '../../src/formats/zip/archive.ts'
import { readNativeSaves } from '../../src/player/native-saves.ts'
import { distributionZip } from '../helpers/deflated-distribution.ts'
import { centralRecords, zipCodecs } from '../helpers/zip-fixtures.ts'

class Bits {
  private bytes: number[] = []
  private used = 0
  put(value: number, bits: number) {
    for (let n = 0; n < bits; n++) {
      if (!this.used) this.bytes.push(0)
      this.bytes[this.bytes.length - 1] |= ((value >>> n) & 1) << this.used
      this.used = (this.used + 1) % 8
    }
  }
  code(value: number, bits: number) {
    for (let n = bits - 1; n >= 0; n--) this.put((value >>> n) & 1, 1)
  }
  finish() { return Buffer.from(this.bytes) }
}

function stored(bytes: Buffer) {
  const header = Buffer.alloc(5)
  header.writeUInt16LE(bytes.length, 1)
  header.writeUInt16LE(65535 - bytes.length, 3)
  return Buffer.concat([header, bytes])
}

function pack(name: string, packed: Buffer, size: number, crc: number) {
  const zip = distributionZip([{ name, packed, size, crc }])
  const { records: [entry] } = centralRecords(zip)
  zip.writeUInt16LE(21, entry!.local + 4); zip.writeUInt16LE(9, entry!.local + 8)
  zip.writeUInt16LE(21, entry!.at + 6); zip.writeUInt16LE(9, entry!.at + 10)
  return zip
}
function source(bytes: Uint8Array) { return new BlobSource(new Blob([Uint8Array.from(bytes).buffer])) }

test('ZIP method 9 accepts both extended distances, the full 16-bit match length and overlapping history copies', async () => {
  const history = Buffer.alloc(65536)
  for (let i = 0; i < history.length; i++) history[i] = ((i * 31) ^ (i >>> 7) ^ (i >>> 11)) & 255
  const block = new Bits()
  block.put(3, 3) // Final fixed block follows two stored blocks.
  block.code(197, 8); block.put(65535, 16) // Fixed code 285, length 65538.
  block.code(31, 5); block.put(16383, 14) // Distance 65536.
  block.code(197, 8); block.put(65533, 16) // Length 65536.
  block.code(30, 5); block.put(0, 14) // Distance 32769, copy overlaps its own output.
  block.code(0, 7)
  const packed = Buffer.concat([stored(history.subarray(0, 65535)), stored(history.subarray(65535)), block.finish()])
  const first = Buffer.concat([history, history, history.subarray(0, 2)])
  const repeat = first.subarray(first.length - 32769)
  const plain = Buffer.concat([first, repeat, repeat.subarray(0, 65536 - repeat.length)])
  const bytes = pack('章/slot.ksd', packed, plain.length, crc32(plain))
  const [entry] = await readZip(source(bytes), zipCodecs)
  assert.equal(entry!.zip.method, 9)
  assert.deepEqual(Buffer.from(await entry!.source!.read(131065, 80)), plain.subarray(131065, 131145))
  assert.deepEqual(Buffer.from(await entry!.read()), plain)
  const saves = await readNativeSaves([new File([Uint8Array.from(bytes).buffer], 'savedata.zip')], false)
  assert.deepEqual(saves.map((s) => s.path), ['章/slot.ksd'])
  assert.deepEqual(Buffer.from(saves[0]!.bytes), plain)
})

test('a literal-only dynamic block handles long canonical codes and an empty distance alphabet', async () => {
  const block = new Bits()
  block.put(5, 3); block.put(0, 5); block.put(0, 5); block.put(15, 4)
  for (const symbol of [16,17,18,0,8,7,9,6,10,5,11,4,12,3,13,2,14,1,15]) block.put(symbol < 16 ? 4 : 0, 3)
  for (let symbol = 0; symbol <= 256; symbol++) {
    const width = symbol === 256 ? 15 : symbol >= 65 && symbol <= 79 ? symbol - 64 : 0
    block.code(width, 4)
  }
  block.code(0, 4) // The only distance width is zero.
  block.code(32766, 15); block.code(0, 1); block.code(32767, 15)
  const expected = Buffer.from('OA')
  const [entry] = await readZip(source(pack('line.tjs', block.finish(), 2, crc32(expected))), zipCodecs)
  assert.deepEqual(Buffer.from(await entry!.read()), expected)
})

test('method 9 verifies the full member CRC and size before exposing the first requested range', async () => {
  const block = new Bits()
  block.put(3, 3)
  block.code(0x30 + 65, 8) // A literal 'A' and the shortest possible final EOB.
  block.code(0, 7)
  const packed = block.finish(), crc = crc32(Buffer.from('A'))
  const read = async (bytes: Buffer) => (await readZip(source(bytes), zipCodecs))[0]!.source!.read(0, 1)
  assert.deepEqual(await read(pack('slot', packed, 1, crc)), Uint8Array.of(65))
  await assert.rejects(read(pack('slot', packed, 1, (crc ^ 1) >>> 0)), /CRC32/)
  await assert.rejects(read(pack('slot', packed, 2, crc)), /size mismatch/)
  await assert.rejects(read(pack('slot', packed.subarray(0, -1), 1, crc)), /truncated|unknown Huffman/)
  await assert.rejects(read(pack('slot', Buffer.concat([packed, Buffer.from([0])]), 1, crc)), /unused compressed bytes/)
})

test('a method-9 game asset above the whole-file limit remains seekable and cancellable', async (t) => {
  const block = new Bits(), page = Buffer.alloc(65536, 65)
  block.put(3, 3); block.code(0x30 + 65, 8)
  let crc = crc32(Buffer.from('A'))
  for (let i = 0; i < 1024; i++) {
    block.code(197, 8); block.put(65533, 16); block.code(0, 5)
    crc = crc32(page, crc)
  }
  block.code(0, 7)
  const size = 64 * 1024 * 1024 + 1, resource = source(pack('chapter.bin', block.finish(), size, crc))
  let checkpoints = 0, cancelAt = Infinity
  const cancelled = new Error('Game stopped')
  const pool = createArchiveInflatePool(true); t.after(() => pool.dispose())
  const [entry] = await readZip(resource, { ...zipCodecs, compressedRanges: pool, checkpoint: async () => {
    if (++checkpoints >= cancelAt) throw cancelled
  } })
  await assert.rejects(entry!.read(), /64 MiB/)
  cancelAt = checkpoints + 40
  await assert.rejects(entry!.source!.read(size - 15, 15), (error: unknown) => error === cancelled)
  cancelAt = Infinity
  assert.deepEqual(Buffer.from(await entry!.source!.read(size - 15, 15)), page.subarray(0, 15))
  assert.deepEqual(Buffer.from(await entry!.source!.read(3, 17)), page.subarray(0, 17))
  assert.deepEqual(Buffer.from(await entry!.source!.read(2 * 1024 * 1024, 7)), page.subarray(0, 7))
})

test('desktop Deflate64 archive ranges match the independently generated multi-window asset', async () => {
  const directory = 'out/verification/deflate64-games'
  const packed = await readFile(directory + '/multi-window.zip'), expected = await readFile(directory + '/multi-window.bin')
  const pool = createArchiveInflatePool(true)
  try {
    const [entry] = await readZip(source(packed), { ...zipCodecs, compressedRanges: pool })
    assert.equal(entry!.zip.method, 9)
    assert(expected.length > 2 * 1024 * 1024)
    assert.deepEqual(Buffer.from(await entry!.read()), expected)
    for (const offset of [65520, 1300000, 3, expected.length - 80])
      assert.deepEqual(Buffer.from(await entry!.source!.read(offset, 80)), expected.subarray(offset, offset + 80))
  } finally { pool.dispose() }
})
