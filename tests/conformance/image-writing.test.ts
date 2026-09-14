import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { ImageWriter, layerImageMetadata } from '../../src/engine/storage/image-writer.ts'
import { deflateImage, inflateImage } from '../../src/backends/files/blob-source.ts'
import { decodePng } from '../../src/formats/image/png.ts'
import { decodeTlg } from '../../src/formats/image/tlg/index.ts'
import { encodeTlg } from '../../src/formats/image/tlg/encoder.ts'
import { encodePng } from '../../src/formats/image/png-encoder.ts'
import { SlideEncoder } from '../../src/formats/image/tlg/slide-encoder.ts'
import { SlideDecoder } from '../../src/formats/image/tlg/slide.ts'
import { BinaryWriter } from '../../src/formats/binary/writer.ts'
import { writingCases, writingTags } from '../helpers/image-writing-vectors.ts'
function finish<T>(work: Generator<void, T>): T {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
const writer = new ImageWriter(deflateImage, async (work) => finish(work)),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

test('image encoders retain independently verified PNG rows and native-decoded TLG bytes', async () => {
  const reference = JSON.parse(
    readFileSync(new URL('../fixtures/image-writing-reference.json', import.meta.url), 'utf8'),
  )
  let index = 0
  for (const c of writingCases()) {
    const entry = reference.entries[index++],
      encoded = await writer.encode(c.image, c.type, writingTags),
      expected = c.image.data.slice()
    if (c.type.endsWith('24')) for (let at = 3; at < expected.length; at += 4) expected[at] = 255
    assert.equal(entry.id, c.id)
    let image
    const png = decodePng(encoded)
    if (png) {
      const plan = finish(png),
        filtered = await inflateImage(plan.compressed, plan.expandedLength)
      assert.equal(hash(filtered), entry.filteredSha256, c.id)
      image = finish(plan.decode(filtered))
      assert.equal(image.metadata!.get('offs_y'), '-7')
    } else {
      assert.equal(hash(encoded), entry.encodedSha256, c.id)
      image = finish(decodeTlg(encoded)!)
      assert.deepEqual(image.metadata, writingTags, c.id)
    }
    assert.equal(image.width, c.image.width, c.id)
    assert.equal(image.height, c.image.height, c.id)
    assert.deepEqual(image.data, expected, c.id)
    assert.equal(hash(expected), entry.decodedSha256, c.id)
  }
  assert.equal(index, reference.cases)
})

test('TLG slide compression restores the dictionary after choosing an uncompressed plane', () => {
  const encoder = new SlideEncoder(),
    decoder = new SlideDecoder(),
    noise = Uint8Array.from(
      { length: 4096 },
      (_, i) => (Math.imul(i + 7, 1103515245) >>> 17) & 255,
    ),
    repeat = new Uint8Array(9000).fill(17)
  const first = finish(encoder.encode(new Uint8Array([1, 2])))
  assert.equal(first.compressed, false)
  for (const input of [noise, repeat, noise, repeat]) {
    const encoded = finish(encoder.encode(input))
    assert.deepEqual(
      encoded.compressed ? finish(decoder.decode(encoded.bytes, input.length)) : encoded.bytes,
      input,
    )
  }
  assert.ok(finish(new SlideEncoder().encode(repeat)).bytes.length < repeat.length / 8)
})

test('image output validates dimensions, modes, metadata and final byte budgets', async () => {
  const image = { width: 1, height: 1, data: new Uint8Array([12, 34, 56, 78]) }
  await assert.rejects(() => writer.encode(image, 'unknown', new Map()), /not implemented/)
  for (const width of [0, -1, 1.5, NaN, 4097]) {
    assert.throws(() => finish(encodeTlg({ ...image, width }, 5)), /dimensions/)
    assert.throws(() => finish(encodePng({ ...image, width })), /source image/)
  }
  await assert.rejects(() => writer.encode(image, 'png', new Map([['offs_x', 'NaN']])), /metadata/)
  assert.throws(
    () => finish(encodeTlg(image, 5, true, new Map([['x', 'a'.repeat(1024 * 1024)]]))),
    /budget/,
  )
  const output = new BinaryWriter(8)
  output.u32(1)
  output.u32(2)
  assert.throws(() => output.u8(3), /budget/)
  assert.deepEqual([...output.finish()], [1, 0, 0, 0, 2, 0, 0, 0])
})

test('saved layer metadata uses the blend type and image offsets, not layer placement', () => {
  assert.deepEqual(layerImageMetadata(12, -5, -7), new Map([['mode', 'addalpha']]))
  assert.deepEqual(
    layerImageMetadata(28, 3, 4),
    new Map([
      ['mode', 'psexcl'],
      ['offs_x', '3'],
      ['offs_y', '4'],
      ['offs_unit', 'pixel'],
    ]),
  )
})
