import test from 'node:test'
import assert from 'node:assert/strict'
import { readText, writeText, readScript } from '../../src/backends/files/text-codecs.ts'

for (const mode of ['', 'utf-8', 'c0', 'c1', 'z'])
  test(`text stream round trip: ${mode || 'UTF-16'}`, async () => {
    const text = '日本語 中文 😀\r\nsecond line\t終わり'
    const encoded = await writeText(text, mode)
    // Buffer subviews must not accidentally decode unrelated backing bytes.
    const slab = Buffer.concat([Buffer.alloc(13, 0xa5), encoded, Buffer.alloc(4)])
    assert.equal(await readText(slab.subarray(13, 13 + encoded.length)), text)
    assert.equal(await readScript(encoded), text)
  })

test('text offsets, UTF-32 BOM, malformed envelopes and decompression bounds', async () => {
  const text = await writeText('hello')
  assert.equal(await readText(Buffer.concat([Buffer.alloc(8), text]), 'o8'), 'hello')
  const utf32 = Buffer.alloc(12)
  utf32.set([0xff, 0xfe, 0, 0])
  utf32.writeUInt32LE(0x65e5, 4)
  utf32.writeUInt32LE(0x1f600, 8)
  assert.equal(await readText(utf32), '日😀')
  await assert.rejects(readText(new Uint8Array([0xff, 0xfe, 1])), /Truncated/)
  await assert.rejects(readText(new Uint8Array([0xfe, 0xfe, 1])), /header/)
  const compressed = await writeText('hello', 'z')
  new DataView(compressed.buffer).setBigUint64(13, 1000000000n, true)
  await assert.rejects(readText(compressed), /budget/)
})
