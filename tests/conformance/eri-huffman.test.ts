import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeSelectedEri } from '../../src/formats/image/eri.ts'
import { decodeSelectedImage } from '../../src/engine/graphics/image-decoder.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { eriHuffmanEncode, eriHuffmanFiles, eriHuffmanCases, eriHuffmanPaletteCases, eriHuffmanStress } from '../helpers/eri-huffman-fixtures.ts'
import { eriTrueRaw, eriTrueRgb, eriTrueGrayRgba } from '../helpers/eri-truecolor-fixtures.ts'

const options = { timeout: 60000 }, decodeReason = 'ERIDecoder::DecodeImage failed.'
function finish<T>(work: Generator<void, T>): T {
  try {
    for (let i = 0; i < 200000; i++) { const result = work.next(); if (result.done) return result.value }
    throw new Error('ERI Huffman fixture exceeded its cooperative bound')
  } finally { work.return(undefined as T) }
}
function observe() {
  const sizes: number[][] = [], rows: { y: number; bytes: number[] }[] = [], writes: number[] = [],
    progress: ImageDecodeProgress = { size(w, h) { sizes.push([w, h]) }, write(y) { writes.push(y) },
      row(y, rgba) { rows.push({ y, bytes: [...rgba] }) } }
  return { sizes, rows, writes, progress }
}
const codecFailure = (error: unknown) => {
  assert(error instanceof ImageDecodeError)
  assert.equal(error.format, 'eri'); assert.equal(error.reason, decodeReason)
  return true
}
function recordOffset(bytes: Uint8Array, text: string) {
  const marker = new TextEncoder().encode(text)
  for (let at = 64; at + 16 <= bytes.length; at++)
    if (marker.every((byte, i) => bytes[at + i] === byte)) return at + 16
  throw new Error('Missing authored ERI record')
}

test('independent Huffman zero frame has literal bytes and preserves real final DWORD padding', options, () => {
  const encoded = eriHuffmanEncode({ width: 2, height: 2, raw: Array(16).fill(0), table: true })
  // Original fresh op literalc0; separator0; fresh data literal00;
  // fresh length gamma(12)=1110100, then8 zero padding bits.
  assert.deepEqual([...encoded.frame], [8, 0, 1, 8, 192, 0, 116, 0])
  const expected = [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255]
  for (const bytes of [encoded.bytes, encoded.bytes.subarray(0, encoded.bytes.length - 1)])
    assert.deepEqual([...finish(decodeSelectedEri(bytes, 'normal')).data], expected)
  assert.throws(() => finish(decodeSelectedEri(encoded.bytes.subarray(0, encoded.bytes.length - 2), 'normal')), codecFailure)
})

test('frame8 authored RGB/RGBA pixels, raw-channel gray, keys and block contexts retain the exact original whole-image boundary', options, () => {
  const files = eriHuffmanFiles()
  for (const item of eriHuffmanCases) {
    for (const key of [undefined, 0, 1, 255]) {
      const seen = observe(), image = finish(decodeSelectedEri(files[item.name]!, 'normal', seen.progress, key))
      assert.deepEqual([image.width, image.height], [item.width, item.height])
      assert.deepEqual([...image.data], item.rgba, item.name)
      assert.equal(image.indices, undefined); assert.equal(image.grayscale, undefined)
      assert.deepEqual(seen.sizes, [[item.width, item.height]])
      assert.deepEqual(seen.rows.map(({ y }) => y), [0, 1, 2])
      assert.deepEqual(seen.rows.flatMap(({ bytes }) => bytes), item.rgba)
      assert.deepEqual(seen.writes, [])
    }
    const gray = finish(decodeSelectedEri(files[item.name]!, 'grayscale'))
    assert.equal(gray.grayscale, true); assert.deepEqual([...gray.data], eriTrueGrayRgba(item.gray))
  }
  const inline = eriHuffmanEncode(eriHuffmanCases.find((item) => item.name === 'hc-zero-inline.eri')!.input),
    table = eriHuffmanEncode(eriHuffmanCases.find((item) => item.name === 'hc-zero-table.eri')!.input)
  assert.equal(inline.stats.lengths, 4); assert.equal(inline.stats.lengthHits, 3)
  assert.equal(table.stats.lengths, 1, 'One actual zero run crosses all four table-mode blocks')
  assert(inline.stats.hits >= 3, 'Repeated operations use the same adaptive operation tree')
})

test('Huffman operation contexts cover original diff2/3, all channel transforms and all four v8 layouts', options, () => {
  for (const table of [false, true]) for (let op = 128; op <= 255; op++) {
    const input = eriHuffmanEncode({ width: 3, height: 3, raw: eriTrueRaw, table, operations: [op, op, op, op] })
    assert.deepEqual([...finish(decodeSelectedEri(input.bytes, 'normal')).data], eriTrueRgb, `${table}:${op}`)
  }
})

test('independent sparse-picture entropy crosses half-weight rebuild and full length-tree replacement without changing any pixel', options, () => {
  const input = eriHuffmanStress()
  assert(input.stats.rebuilds > 0, 'The independent original encoder must exercise0x4000 tree rebuilding')
  assert(input.stats.replacements > 0, 'The independent original encoder must replace a full length-tree leaf')
  assert(input.stats.blocks > 0x4000)
  const image = finish(decodeSelectedEri(input.bytes, 'normal'))
  assert.deepEqual([image.width, image.height], [input.width, input.height])
  assert.deepEqual([...image.data], input.rgba)
  // A subsequent image starts with fresh operation/data trees, not stress
  // weights. Both decodes use normal public selected-codec entry points.
  const small = eriHuffmanCases[0]!
  assert.deepEqual([...finish(decodeSelectedEri(eriHuffmanEncode(small.input).bytes, 'normal')).data], small.rgba)
})

test('indexed frame2 Huffman keeps cross-row adaptive context but resets repeated-symbol runs at each row', options, () => {
  const files = eriHuffmanFiles()
  for (const item of eriHuffmanPaletteCases) {
    const seen = observe(), image = finish(decodeSelectedEri(files[item.name]!, 'normal', seen.progress))
    assert.deepEqual([...image.data], item.rgba); assert.deepEqual(seen.sizes, [[3, 2]])
    assert.deepEqual(seen.rows.map(({ y }) => y), [0, 1]); assert.deepEqual(seen.writes, [])
    for (const key of [0, 1, 2, 255]) {
      const expected = item.rgba.map((byte, at) => at % 4 === 3 && item.indices[at >>> 2] === key ? 0 : byte)
      assert.deepEqual([...finish(decodeSelectedEri(files[item.name]!, 'normal', undefined, key)).data], expected)
    }
    assert.deepEqual([...finish(decodeSelectedEri(files[item.name]!, 'grayscale')).data], eriTrueGrayRgba(item.gray))
    // The same authored byte samples with exactGRAY2 ImageInfo use direct
    // gray expansion; the present palette is immaterial to that source type.
    const grayBytes = files[item.name]!.slice(), info = recordOffset(grayBytes, 'ImageInf')
    new DataView(grayBytes.buffer).setUint32(info + 12, 2, true)
    for (const mode of ['normal', 'grayscale'] as const)
      assert.deepEqual([...finish(decodeSelectedEri(grayBytes, mode, undefined, 1)).data], eriTrueGrayRgba(item.indices))
  }
})

test('Huffman bad delimiter and late missing zero-run magnitude publish size but no private rows and use the ERI holder', options, async () => {
  const files = eriHuffmanFiles(), dependencies = {
    async finish<T>(work: Generator<void, T>) { return finish(work) },
    async inflate() { throw new Error('Unexpected ERI inflation') }, async host() { throw new Error('Unexpected ERI fallback') },
  }
  for (const name of ['hc-bad-separator.eri', 'hc-late-failure.eri']) for (const mode of ['normal', 'grayscale'] as const) {
    const seen = observe()
    assert.throws(() => finish(decodeSelectedEri(files[name]!, mode, seen.progress)), codecFailure)
    assert.deepEqual(seen.sizes, [[3, 3]]); assert.deepEqual(seen.rows, []); assert.deepEqual(seen.writes, [])
    await assert.rejects(decodeSelectedImage(files[name]!, { format: 'eri', mode }, dependencies), (error: unknown) => {
      assert(error instanceof TvpError)
      assert.deepEqual(error.tvpMessage, { id: 'TVPERILoadError', args: [decodeReason] })
      assert(error.cause instanceof ImageDecodeError); return true
    })
  }
})

test('Huffman size/row exceptions keep observer identity and private-block retirement cannot emit a late row', options, () => {
  const bytes = eriHuffmanFiles()['hc-rgba-inline.eri']!
  for (const where of ['size', 'row'] as const) {
    const cause = new Error('owned Huffman ' + where), events: string[] = []
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', {
      size() { events.push('size'); if (where === 'size') throw cause },
      row(y) { events.push('row:' + y); throw cause },
    })), (error) => error === cause)
    assert.deepEqual(events, where === 'size' ? ['size'] : ['size', 'row:0'])
  }
  const seen = observe(), work = decodeSelectedEri(bytes, 'normal', seen.progress)
  try {
    assert.equal(work.next().done, false); assert.deepEqual(seen.sizes, [[3, 3]])
    assert.equal(work.next().done, false, 'The first complete private block is still not a caller row')
    assert.deepEqual(seen.rows, []); assert.deepEqual(seen.writes, [])
  } finally { work.return(undefined as never) }
  assert.equal(work.next().done, true); assert.deepEqual(seen.rows, [])
})

test('frame8 rejects real header preconditions before entropy and preserves explicit dimension/block Web limits', options, () => {
  const original = eriHuffmanFiles()['hc-rgb-inline.eri']!, info = recordOffset(original, 'ImageInf'), frame = recordOffset(original, 'ImageFrm')
  for (const [offset, value] of [[frame + 1, 1], [frame + 2, 2], [frame + 3, 7]] as const) {
    const bytes = original.slice(), seen = observe(); bytes[offset] = value
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', seen.progress)), codecFailure)
    assert.deepEqual(seen.sizes, [[3, 3]]); assert.deepEqual(seen.rows, [])
  }
  for (const [offset, value] of [[info, 0x20100], [info + 8, 0xffffffff], [info + 12, 2]] as const) {
    const bytes = original.slice(), view = new DataView(bytes.buffer), seen = observe()
    view.setUint32(offset, value, true)
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', seen.progress)), codecFailure)
    assert.deepEqual(seen.sizes, [[3, 3]]); assert.deepEqual(seen.rows, [])
  }
  for (const [offset, value, size, message] of [
    [info + 16, 4097, false, 'ERI dimensions exceed the supported Web image bounds'],
    [info + 52, 9, true, 'ERI blocking degree exceeds the Web work budget'],
    [info + 52, 0, true, 'ERI truecolor block degree exceeds the safe Web range'],
  ] as const) {
    const bytes = original.slice(), seen = observe(); new DataView(bytes.buffer).setUint32(offset, value, true)
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', seen.progress)), (error: unknown) => {
      assert(error instanceof Error && !(error instanceof ImageDecodeError)); assert.equal(error.message, message); return true
    })
    assert.deepEqual(seen.sizes, size ? [[3, 3]] : []); assert.deepEqual(seen.rows, [])
  }
})
