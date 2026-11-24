import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeSelectedEri } from '../../src/formats/image/eri.ts'
import { decodeSelectedImage } from '../../src/engine/graphics/image-decoder.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { eriArithmeticCases, eriArithmeticEncode, eriArithmeticFiles, eriArithmeticStress } from '../helpers/eri-arithmetic-fixtures.ts'
import { eriTrueRaw, eriTrueRgb, eriTrueRgba, eriTrueGrayRgba } from '../helpers/eri-truecolor-fixtures.ts'

const options = { timeout: 60000 }, decodeReason = 'ERIDecoder::DecodeImage failed.'
function finish<T>(work: Generator<void, T>): T {
  try {
    for (let count = 0; count < 200000; count++) { const result = work.next(); if (result.done) return result.value }
    throw new Error('ERI arithmetic fixture exceeded its cooperative bound')
  } finally { work.return(undefined as T) }
}
function observe() {
  const sizes: number[][] = [], rows: { y: number; bytes: number[] }[] = [], writes: number[] = [],
    progress: ImageDecodeProgress = { size(w, h) { sizes.push([w, h]) }, write(y) { writes.push(y) },
      row(y, rgba) { rows.push({ y, bytes: [...rgba] }) } }
  return { sizes, rows, writes, progress }
}
function recordOffset(bytes: Uint8Array, name: string) {
  const marker = new TextEncoder().encode(name)
  for (let at = 64; at + 16 <= bytes.length; at++)
    if (marker.every((byte, i) => bytes[at + i] === byte)) return at + 16
  throw new Error('Missing authored arithmetic ERI record: ' + name)
}
const codecFailure = (error: unknown) => {
  assert(error instanceof ImageDecodeError)
  assert.equal(error.format, 'eri'); assert.equal(error.reason, decodeReason)
  return true
}

test('independent arithmetic intervals decode all authored colors, alpha, directions and source layouts before publishing complete rows', options, () => {
  const files = eriArithmeticFiles()
  for (const item of eriArithmeticCases) for (const mode of ['normal', 'grayscale'] as const) {
    const seen = observe(), expected = mode === 'normal' ? item.rgba : eriTrueGrayRgba(item.gray),
      image = finish(decodeSelectedEri(files[item.name]!, mode, seen.progress))
    assert.deepEqual([image.width, image.height], [item.width, item.height])
    assert.deepEqual([...image.data], expected, item.name + ':' + mode)
    assert.equal(image.grayscale, mode === 'grayscale' ? true : undefined)
    assert.equal(image.indices, undefined)
    assert.deepEqual(seen.sizes, [[item.width, item.height]])
    assert.deepEqual(seen.rows.map(({ y }) => y), Array.from({ length: item.height }, (_, y) => y))
    assert.deepEqual(seen.rows.flatMap(({ bytes }) => bytes), expected)
    assert.deepEqual(seen.writes, [])
  }
})

test('arithmetic symbol widths preserve signed residuals and actual adaptive context changes without relying on virtual EOF bits', options, () => {
  for (let bitCount = 1; bitCount <= 8; bitCount++) {
    // -1 is represented by the high symbol of every alphabet. The positive
    // residual control is also legal for every alphabet wider than one bit.
    for (const value of bitCount === 1 ? [255] : [255, 1]) {
      const expected = Array.from({ length: 4 }, () => [value, value, value, 255]).flat(),
        encoded = eriArithmeticEncode({ width: 2, height: 2, pixels: expected, bitCount })
      assert.deepEqual([...encoded.frame.subarray(0, 4)], [1, 0, bitCount, 0])
      assert(encoded.stats.contexts >= 2); assert(encoded.stats.moves > 0)
      assert.deepEqual([...finish(decodeSelectedEri(encoded.bytes, 'normal')).data], expected)
    }
  }
  const color = eriArithmeticEncode(eriArithmeticCases[0]!.input)
  assert(color.stats.contexts > 4, 'Nontrivial colors select several previous-symbol models')
  assert(color.stats.moves > 0)
})

test('arithmetic pre-read operations preserve independent color differences and enhanced block arrangements', options, () => {
  for (const input of [
    { width: 3, height: 3, pixels: eriTrueRaw, frame: 1 as const, operations: [5, 10, 15, 0] },
    { width: 3, height: 3, pixels: eriTrueRaw, frame: 4 as const, operations: [6, 26, 36, 46] },
    { width: 3, height: 3, pixels: eriTrueRaw, frame: 4 as const, alpha: true, operations: [50, 63, 11, 49] },
  ]) {
    const encoded = eriArithmeticEncode(input)
    assert.deepEqual([...finish(decodeSelectedEri(encoded.bytes, 'normal')).data], input.alpha ? eriTrueRgba : eriTrueRgb)
  }
})

test('frame2 arithmetic retains cross-row models and exact palette-key behavior while direct gray ignores palette keys', options, () => {
  const files = eriArithmeticFiles()
  for (const item of eriArithmeticCases.filter((value) => value.indexed)) for (const key of [0, 1, 2, 255]) {
    const expected = item.rgba.map((byte, at) => at % 4 === 3 && item.indices![at >>> 2] === key ? 0 : byte)
    assert.deepEqual([...finish(decodeSelectedEri(files[item.name]!, 'normal', undefined, key)).data], expected)
    assert.deepEqual([...finish(decodeSelectedEri(files[item.name]!, 'grayscale', undefined, key)).data], eriTrueGrayRgba(item.gray))
  }
  for (const item of eriArithmeticCases.filter((value) => !value.indexed)) for (const key of [0, 1, 255])
    assert.deepEqual([...finish(decodeSelectedEri(files[item.name]!, 'normal', undefined, key)).data], item.rgba)
})

test('independent arithmetic intervals cross repeated 65536-frequency rescaling and each new image starts fresh models', options, () => {
  const input = eriArithmeticStress()
  assert.equal(input.stats.symbols, 196608)
  assert(input.stats.rescales >= 3, 'The authored context must actually cross the original model threshold repeatedly')
  const seen = observe(), image = finish(decodeSelectedEri(input.bytes, 'normal', seen.progress))
  assert.deepEqual([image.width, image.height], [256, 256]); assert.deepEqual([...image.data], input.rgba)
  assert.deepEqual(seen.sizes, [[256, 256]]); assert.equal(seen.rows.length, 256); assert.deepEqual(seen.writes, [])
  const next = eriArithmeticCases[0]!
  assert.deepEqual([...finish(decodeSelectedEri(eriArithmeticEncode(next.input).bytes, 'normal')).data], next.rgba)
})

test('arithmetic invalid initial interval and delimiter retain native codec cause, size-only publication and the real ERI holder', options, async () => {
  const files = eriArithmeticFiles(), dependencies = {
    async finish<T>(work: Generator<void, T>) { return finish(work) },
    async inflate() { throw new Error('Unexpected arithmetic ERI inflation') },
    async host() { throw new Error('Unexpected arithmetic ERI fallback') },
  }
  // No SDK sees these malformed inputs. C=A=ffffffff gives an accumulator
  // beyond all symbols; the second case fails its real operation delimiter.
  for (const name of ['ar-bad-initial.eri', 'ar-bad-separator.eri']) for (const mode of ['normal', 'grayscale'] as const) {
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

test('arithmetic private decode retirement and caller callback exceptions cannot publish later rows or replace the caller cause', options, () => {
  const bytes = eriArithmeticFiles()['ar-rgba8-table.eri']!
  for (const where of ['size', 'row'] as const) {
    const cause = new Error('owned arithmetic ' + where), events: string[] = []
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', {
      size() { events.push('size'); if (where === 'size') throw cause },
      row(y) { events.push('row:' + y); throw cause },
    })), (error) => error === cause)
    assert.deepEqual(events, where === 'size' ? ['size'] : ['size', 'row:0'])
  }
  const seen = observe(), work = decodeSelectedEri(bytes, 'normal', seen.progress)
  try {
    assert.equal(work.next().done, false); assert.deepEqual(seen.sizes, [[3, 3]])
    assert.equal(work.next().done, false, 'Private arithmetic/model or block work yields before publication')
    assert.deepEqual(seen.rows, []); assert.deepEqual(seen.writes, [])
  } finally { work.return(undefined as never) }
  assert.equal(work.next().done, true); assert.deepEqual(seen.rows, [])
})

test('arithmetic real header rejects and Web symbol-width/dimension budgets remain distinct errors without private row leakage', options, () => {
  const original = eriArithmeticFiles()['ar-rgb8-table.eri']!,
    frame = recordOffset(original, 'ImageFrm'), info = recordOffset(original, 'ImageInf')
  for (const offset of [frame + 1, frame + 3]) {
    const bytes = original.slice(), seen = observe(); bytes[offset] = 1
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', seen.progress)), codecFailure)
    assert.deepEqual(seen.sizes, [[3, 3]]); assert.deepEqual(seen.rows, [])
  }
  for (const width of [0, 9, 255]) {
    const bytes = original.slice(), seen = observe(); bytes[frame + 2] = width
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', seen.progress)), (error: unknown) => {
      assert(error instanceof Error && !(error instanceof ImageDecodeError))
      assert.equal(error.message, 'ERI arithmetic symbol width exceeds the safe 1..8 bit range'); return true
    })
    assert.deepEqual(seen.sizes, [[3, 3]]); assert.deepEqual(seen.rows, [])
  }
  for (const [offset, value, hasSize, message] of [
    [info + 16, 4097, false, 'ERI dimensions exceed the supported Web image bounds'],
    [info + 52, 9, true, 'ERI blocking degree exceeds the Web work budget'],
  ] as const) {
    const bytes = original.slice(), seen = observe(); new DataView(bytes.buffer).setUint32(offset, value, true)
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', seen.progress)), (error: unknown) => {
      assert(error instanceof Error && !(error instanceof ImageDecodeError)); assert.equal(error.message, message); return true
    })
    assert.deepEqual(seen.sizes, hasSize ? [[3, 3]] : []); assert.deepEqual(seen.rows, [])
  }
})
