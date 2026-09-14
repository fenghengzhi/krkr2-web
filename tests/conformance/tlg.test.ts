import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { decodeTlg } from '../../src/formats/image/tlg/index.ts'
import { SlideDecoder } from '../../src/formats/image/tlg/slide.ts'
import { decodeGolomb } from '../../src/formats/image/tlg/golomb.ts'
import { tlgCases } from '../helpers/tlg-vectors.ts'
import { tlgBytes, tlgFixture, tlgManifest, tlgSds, tlgTags } from '../helpers/tlg-fixtures.ts'

function finish<T>(work: Generator<void, T>): T {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
const decode = (bytes: Uint8Array) => finish(decodeTlg(bytes)!)

test('TLG5/TLG6 reconstruct independent native encoder fixtures byte for byte', () => {
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  assert.equal(hash(tlgBytes), tlgManifest.sha256)
  let cases = 0,
    pixels = 0
  for (const c of tlgCases()) {
    const bytes = tlgFixture(c.id),
      image = decode(bytes)
    assert.equal(hash(bytes), tlgManifest.entries[cases]!.sha256)
    assert.equal(image.width, c.width, c.id)
    assert.equal(image.height, c.height, c.id)
    assert.deepEqual(image.data, c.data, c.id)
    assert.equal(image.metadata, undefined)
    cases++
    pixels += c.width * c.height
  }
  assert.equal(cases, tlgManifest.cases)
  assert.equal(pixels, tlgManifest.pixels)
})

test('TLG0 reads byte-counted Unicode, duplicate and delimiter-containing tags across chunks', () => {
  for (const version of [5, 6]) {
    const raw = tlgFixture(`${version}-4-solid-17x9-auto`),
      expected: [string, string][] = [
        ['LEFT', '20'],
        ['题😀', 'あ,=:文😀'],
        ['__proto__', 'safe'],
        ['', ''],
      ],
      bytes = tlgSds(raw, [
        ['junk', Buffer.from([1, 2, 3])],
        ['tags', tlgTags([['LEFT', 'old']])],
        ['tags', tlgTags(expected)],
      ])
    const image = decode(bytes)
    assert.deepEqual(image.data, decode(raw).data)
    assert.deepEqual(image.metadata, new Map(expected))
    assert.equal(decode(tlgSds(raw, [['tags', Buffer.alloc(0)]])).metadata, undefined)
  }
})

test('TLG rejects truncated images, invalid dimensions, headers, plane sizes and filters', () => {
  assert.equal(decodeTlg(Buffer.from('PNG')), undefined)
  assert.throws(() => decode(Buffer.from('TLG')), /Truncated/)
  assert.throws(() => decode(Buffer.from('TLG9.0\x00raw\x1a')), /signature/)
  for (const version of [5, 6]) {
    const raw = tlgFixture(`${version}-4-solid-7x9-auto`)
    for (let length = 3; length < raw.length; length++)
      assert.throws(() => decode(raw.subarray(0, length)), `${version}: prefix ${length}`)
    for (const value of [0, 4097, 0xffffffff]) {
      const bad = Buffer.from(raw)
      bad.writeUInt32LE(value, version === 5 ? 12 : 15)
      assert.throws(() => decode(bad), /dimensions/)
    }
    assert.throws(() => decode(Buffer.concat([raw, Buffer.from([0])])), /Extra/)
  }
  const five = Buffer.from(tlgFixture('5-3-solid-1x1-auto'))
  five.writeUInt32LE(0, 20)
  assert.throws(() => decode(five), /block height/)
  five.writeUInt32LE(4, 20)
  five.writeUInt32LE(99, 24)
  assert.throws(() => decode(five), /block size/)
  const six = Buffer.from(tlgFixture('6-3-solid-1x1-auto'))
  six[12] = 1
  assert.throws(() => decode(six), /flags/)
  six[12] = 0
  const bitHeader = 31 + six.readUInt32LE(27)
  six.writeUInt32LE(0x40000001, bitHeader)
  assert.throws(() => decode(six), /entropy/)
  six.writeUInt32LE(0xffffffff, 27)
  assert.throws(() => decode(six), /Truncated/)
})

test('TLG0 bounds container chunks and tags and rejects malformed UTF-8', () => {
  const raw = tlgFixture('6-4-solid-1x1-auto')
  for (const invalid of ['x:a=1:b,', '1:a!1:b,', '1:a=1:b', '99:a=1:b,', '99999999:a=0:,'])
    assert.throws(() => decode(tlgSds(raw, [['tags', Buffer.from(invalid)]])))
  for (const utf8 of [[0xc0, 0x80], [0xed, 0xa0, 0x80], [0xf4, 0x90, 0x80, 0x80], [0xe3]])
    assert.throws(
      () =>
        decode(
          tlgSds(raw, [
            [
              'tags',
              Buffer.concat([
                Buffer.from('1:a=' + utf8.length + ':'),
                Buffer.from(utf8),
                Buffer.from(','),
              ]),
            ],
          ]),
        ),
      /UTF-8/,
    )
  const bytes = tlgSds(raw, [['tags', tlgTags([['a', 'b']])]])
  bytes.writeUInt32LE(0xffffffff, 11)
  assert.throws(() => decode(bytes), /Truncated/)
  assert.throws(() => decode(tlgSds(raw, [['tags', Buffer.alloc(1024 * 1024 + 1)]])), /1 MiB/)
  assert.throws(
    () =>
      decode(
        tlgSds(raw, [['tags', tlgTags(Array.from({ length: 4097 }, (_, i) => [String(i), '']))]]),
      ),
    /4096 entries/,
  )
})

test('TLG dictionary handles overlapping matches, wraparound and exact output bounds', () => {
  assert.deepEqual(
    [...finish(new SlideDecoder().decode(new Uint8Array([2, 65, 0, 0]), 4))],
    [65, 65, 65, 65],
  )
  const slide = new SlideDecoder()
  // Fill and wrap the dictionary with literals, then reference its last and first bytes.
  const literals = Buffer.concat(
    Array.from({ length: 513 }, (_, i) =>
      Buffer.from([0, ...Array.from({ length: 8 }, (_, j) => (i * 8 + j) & 255)]),
    ),
  )
  finish(slide.decode(literals, 4104))
  assert.deepEqual([...finish(slide.decode(new Uint8Array([1, 254, 15]), 3))], [254, 255, 0])
  for (const [input, size] of [
    [[1], 3],
    [[1, 0, 0], 2],
    [[0], 1],
    [[0, 1, 2], 1],
  ] as [number[], number][])
    assert.throws(() => finish(new SlideDecoder().decode(new Uint8Array(input), size)))
})

test('TLG6 Golomb handles byte-anchored escapes, run bounds and truncated residuals', () => {
  // First nonzero run of one pixel; escape at bit 2, quotient 254, k = 0 => -128.
  const bytes = new Uint8Array([3, 0, 0, 0, 254])
  assert.deepEqual([...finish(decodeGolomb(bytes, 40, 1))], [128])
  assert.throws(() => finish(decodeGolomb(bytes, 39, 1)), /Truncated/)
  assert.throws(() => finish(decodeGolomb(new Uint8Array([4]), 4, 1)), /run/)
  assert.throws(() => finish(decodeGolomb(new Uint8Array([3, 0, 0, 0, 255]), 40, 1)), /residual/)
})
