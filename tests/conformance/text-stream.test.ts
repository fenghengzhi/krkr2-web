import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { readText, writeText, readScript } from '../../src/backends/files/text-codecs.ts'
import { parseStreamMode, parseTextWriterMode } from '../../src/formats/text/mode.ts'
import { modeOffset } from '../../src/formats/text/stream.ts'

for (const mode of ['', 'utf-8', 'c2', 'c1', 'z'])
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

test('text writer classifies the first c/z digit, z override and Web UTF-8 priority', () => {
  const cases = [
    ['', 'utf16', undefined],
    ['C0 Z O8 A', 'utf16', undefined],
    ['c', 'simple', undefined],
    ['c1', 'simple', undefined],
    ['c10', 'simple', undefined],
    ['c-1', 'simple', undefined],
    ['cc0', 'simple', undefined],
    ['c1c9', 'simple', undefined],
    ['c2', 'compressed', undefined],
    ['c20', 'compressed', undefined],
    ['z', 'compressed', undefined],
    ['z0', 'compressed', 0],
    ['z9', 'compressed', 9],
    ['z10', 'compressed', 1],
    ['z-1', 'compressed', undefined],
    ['zz9', 'compressed', undefined],
    ['z1z9', 'compressed', 1],
    ['c0z', 'compressed', undefined],
    ['zc0', 'compressed', undefined],
    ['c9z1', 'compressed', 1],
    ['c０', 'simple', undefined],
    ['z９', 'compressed', undefined],
    ['c0utf-8z9', 'utf8', undefined],
    ['UTF8c9', 'utf8', undefined],
    ['\0c0z9utf8', 'utf16', undefined],
    ['c1\0z9', 'simple', undefined],
  ] as const
  for (const [mode, encoding, compressionLevel] of cases) {
    const parsed = parseTextWriterMode(mode)
    assert.equal(parsed.encoding, encoding, mode)
    assert.equal(parsed.compressionLevel, compressionLevel, mode)
  }
  assert.deepEqual(parseTextWriterMode('c2o010a\0c0'), {
    mode: 'c2o010a',
    hasOffset: true,
    offset: 8,
    append: true,
    encoding: 'compressed',
  })
})

test('unsupported text writer modes fail before offset parsing in preflight and encoding', async () => {
  for (const mode of ['c0', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8', 'c9', 'c01', 'c0c1']) {
    assert.throws(() => parseTextWriterMode(mode), /Unsupported text writer encoding/)
    await assert.rejects(writeText('unchanged', mode), /Unsupported text writer encoding/)
  }
  assert.throws(() => parseTextWriterMode('c9o67108865'), /Unsupported text writer encoding 9/)
  await assert.rejects(writeText('unchanged', 'c9o67108865'), /Unsupported text writer encoding 9/)
  assert.throws(() => parseTextWriterMode('c0utf8o67108865'), /Invalid text stream offset/)
  await assert.rejects(writeText('unchanged', 'c0utf8o67108865'), /Invalid text stream offset/)
  assert.throws(() => parseTextWriterMode('c0\0z'), /Unsupported text writer encoding 0/)
})

test('stream modes retain first-offset presence and TJS octal parsing through NUL', () => {
  const cases = [
    ['', false, 0],
    ['O6', false, 0],
    ['o', true, 0],
    ['o0', true, 0],
    ['oo6', true, 0],
    ['o-6', true, 0],
    ['o+6', true, 0],
    ['o10o2', true, 10],
    ['o010', true, 8],
    ['o078', true, 7],
    ['o089', true, 0],
    ['o019', true, 1],
    ['o0009', true, 0],
    ['o0x10', true, 0],
    ['o6e2', true, 6],
    ['o１２', true, 0],
    ['\0o8', false, 0],
    ['o6\0o10a', true, 6],
  ] as const
  for (const [mode, hasOffset, offset] of cases) {
    const parsed = parseStreamMode(mode)
    assert.equal(parsed.hasOffset, hasOffset, mode)
    assert.equal(parsed.offset, offset, mode)
    assert.equal(modeOffset(mode), offset, mode)
  }
  assert.deepEqual(parseStreamMode('a\0o8'), {
    mode: 'a',
    hasOffset: false,
    offset: 0,
    append: true,
  })
  assert.equal(parseStreamMode('A').append, false)
  assert.equal(parseStreamMode('o0a').append, true)
  assert.equal(parseStreamMode('o0\0a').append, false)
})

test('stream offsets reject oversized numbers and more than 255 collected digits without allocation', () => {
  assert.equal(parseStreamMode('o67108864').offset, 64 * 1024 * 1024)
  assert.equal(parseStreamMode('o0400000000').offset, 64 * 1024 * 1024)
  assert.equal(parseStreamMode(`o${'0'.repeat(255)}`).offset, 0)
  assert.equal(parseStreamMode(`o${'0'.repeat(254)}1`).offset, 1)
  for (const mode of [
    'o67108865',
    'o0400000001',
    'o9007199254740992',
    `o${'0'.repeat(256)}`,
    `o08${'0'.repeat(254)}`,
    'ao67108865',
  ]) {
    assert.throws(() => parseStreamMode(mode), /Invalid text stream offset/, mode)
    assert.throws(() => modeOffset(mode), /Invalid text stream offset/, mode)
  }
})

test('simple, ordinary and UTF-8 writer bytes follow their independently specified envelopes', async () => {
  for (const mode of ['c', 'c1', 'c10', 'c-1', 'cc0', 'c1\0z'])
    assert.deepEqual(
      await writeText('A', mode),
      Uint8Array.from([0xfe, 0xfe, 1, 0xff, 0xfe, 0x82, 0]),
      mode,
    )
  for (const mode of ['', 'C0', '\0c0zutf8'])
    assert.deepEqual(await writeText('A', mode), Uint8Array.from([0xff, 0xfe, 0x41, 0]), mode)
  for (const mode of ['utf-8', 'c0utf-8z9', 'UTF8c9'])
    assert.deepEqual(await writeText('Aé', mode), Uint8Array.from([0x41, 0xc3, 0xa9]), mode)
})

test('c2 and z writer envelopes carry exact sizes and independently inflate to UTF-16LE', async () => {
  const text = 'A日本語\r\n雪😀'
  const expected = Buffer.from(text, 'utf16le')
  for (const mode of ['c2', 'c20', 'z', 'z0', 'z9', 'z10', 'z-1', 'c0z', 'zc0', 'c9z1']) {
    const encoded = await writeText(text, mode)
    assert.deepEqual(Array.from(encoded.subarray(0, 5)), [0xfe, 0xfe, 2, 0xff, 0xfe], mode)
    const header = new DataView(encoded.buffer, encoded.byteOffset, encoded.byteLength)
    assert.equal(header.getBigUint64(5, true), BigInt(encoded.length - 21), mode)
    assert.equal(header.getBigUint64(13, true), BigInt(expected.length), mode)
    assert.deepEqual(inflateSync(encoded.subarray(21)), expected, mode)
  }
})

test('legacy c0 remains readable from a fixed envelope independent of the writer', async () => {
  // Fixed encoded UTF-16 units 0x4040 / 0x81e4 decode to A / 日;
  // c0 leaves the CR and LF control units unchanged.
  const encoded = Uint8Array.from([
    0xfe, 0xfe, 0, 0xff, 0xfe, 0x40, 0x40, 0xe4, 0x81, 0x0d, 0, 0x0a, 0,
  ])
  assert.equal(await readText(encoded), 'A日\r\n')
  assert.equal(await readScript(encoded), 'A日\r\n')
  const slab = Buffer.concat([Buffer.alloc(8, 0xa5), encoded, Buffer.alloc(4)])
  assert.equal(await readText(slab.subarray(0, 8 + encoded.length), 'o010'), 'A日\r\n')
})

test('text and script reads share first-offset and octal rules without writer-generated fixtures', async () => {
  const text = Uint8Array.from([0xff, 0xfe, 0x41, 0])
  for (const [mode, offset] of [
    ['o', 0],
    ['o0', 0],
    ['oo6', 0],
    ['o-6', 0],
    ['o+6', 0],
    ['o10o2', 10],
    ['o010', 8],
    ['o078', 7],
    ['o08', 0],
    ['\0o8', 0],
  ] as const) {
    const input = Buffer.concat([Buffer.alloc(offset, 0xa5), text])
    assert.equal(await readText(input, mode), 'A', mode)
    assert.equal(await readScript(input, mode), 'A', mode)
    const binary = Buffer.from([0x54, 0x4a, 0x53, 0x32, 0x01, 0x02])
    assert.deepEqual(
      await readScript(Buffer.concat([Buffer.alloc(offset, 0xa5), binary]), mode),
      binary,
      mode,
    )
  }
})

test('narrow reader encoding selection stops at the first mode NUL', async () => {
  const input = Uint8Array.from([0xc3, 0xa9])
  assert.equal(await readText(input, 'utf8\0', 'windows-1252'), 'é')
  assert.equal(await readText(input, '\0utf8', 'windows-1252'), 'Ã©')
  assert.equal(await readScript(input, 'utf-8\0', 'windows-1252'), 'é')
  assert.equal(await readScript(input, '\0utf-8', 'windows-1252'), 'Ã©')
})
