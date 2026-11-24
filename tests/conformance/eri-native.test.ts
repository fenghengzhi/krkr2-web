import test from 'node:test'
import assert from 'node:assert/strict'
import { checkEriSourceSize, decodeSelectedEri, EriUnsupportedError } from '../../src/formats/image/eri.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'
import { eriContractCases, eriContractFiles, eriRgbNegative, eriProvinceReason } from '../helpers/eri-fixtures.ts'

const options = { timeout: 30000 }
function finish<T>(work: Generator<void, T>): T {
  try {
    for (let i = 0; i < 100000; i++) {
      const step = work.next()
      if (step.done) return step.value
    }
    throw new Error('ERI test exhausted its cooperative step bound')
  } finally { work.return(undefined as T) }
}
function observe() {
  const sizes: number[][] = [], rows: { y: number; rgba: number[] }[] = [],
    progress: ImageDecodeProgress = {
      size(width, height) { sizes.push([width, height]) },
      row(y, rgba) { rows.push({ y, rgba: [...rgba] }) },
    }
  return { sizes, rows, progress }
}
function field(bytes: Uint8Array, at: number, value: number) {
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(at, value >>> 0, true)
  return bytes
}
function record(bytes: Uint8Array, name: string): number {
  const id = new TextEncoder().encode(name)
  for (let i = 64; i <= bytes.length - 16; i++)
    if (id.every((value, at) => bytes[i + at] === value)) return i
  throw new Error('Missing independent ERI fixture record: ' + name)
}
function native(reason: string) {
  return (error: unknown) => {
    assert.ok(error instanceof ImageDecodeError)
    assert.equal(error.format, 'eri'); assert.equal(error.reason, reason)
    return true
  }
}

test('ERI original integer palette, gray, height direction and palette key contracts use authored entropy bytes', options, () => {
  const files = eriContractFiles()
  for (const item of eriContractCases.filter((entry) => entry.rgba)) {
    const observed = observe(), image = finish(decodeSelectedEri(files[item.name]!, item.mode, observed.progress, item.paletteKey))
    assert.deepEqual([image.width, image.height], [item.width, item.height])
    assert.deepEqual([...image.data], item.rgba)
    assert.equal(image.grayscale, item.mode === 'grayscale' ? true : undefined)
    assert.equal(image.indices, undefined, 'The codec already applies palette-key alpha; no second generic index mask')
    assert.deepEqual(observed.sizes, [[3, 2]])
    assert.deepEqual(observed.rows.map(({ y }) => y), [0, 1])
    assert.deepEqual(observed.rows.flatMap(({ rgba }) => rgba), item.rgba)
  }
})

test('ERI Open, Initialize and whole-image entropy failures keep the original size-only publication phases', options, () => {
  const files = eriContractFiles()
  for (const item of eriContractCases.filter((entry) => entry.error)) {
    const observed = observe()
    assert.throws(() => finish(decodeSelectedEri(files[item.name]!, item.mode, observed.progress)), native(item.error!))
    assert.deepEqual(observed.sizes, item.sizeExpected ? [[3, 2]] : [])
    assert.deepEqual(observed.rows, [])
  }
  assert.throws(() => finish(decodeSelectedEri(new Uint8Array(), 'palettized')), native(eriProvinceReason))
})

test('ERI size and row callback exceptions keep exact identity and stop later publication', options, () => {
  for (const where of ['size', 'row'] as const) {
    const error = new ImageDecodeError('eri', 'ERIFile::Open failed.'), called: string[] = []
    assert.throws(() => finish(decodeSelectedEri(eriContractFiles()['rgb-negative.eri']!, 'normal', {
      size() { called.push('size'); if (where === 'size') throw error },
      row(y) { called.push('row:' + y); throw error },
    })), (actual) => actual === error)
    assert.deepEqual(called, where === 'size' ? ['size'] : ['size', 'row:0'])
  }
})

test('ERI yields during private image decoding without publishing rows and can be retired there', options, () => {
  const observed = observe(), work = decodeSelectedEri(eriContractFiles()['rgb-negative.eri']!, 'normal', observed.progress)
  assert.equal(work.next().done, false)
  assert.deepEqual(observed.sizes, [[3, 2]])
  assert.equal(work.next().done, false, 'First entropy row completes privately')
  assert.deepEqual(observed.rows, [])
  work.return(undefined as never)
  assert.equal(work.next().done, true)
  assert.deepEqual(observed.rows, [])
})

test('ERI container respects bounded records, open-ended streams, caller byte offsets and ignored trailing records', options, () => {
  const bytes = eriContractFiles()['rgb-negative.eri']!, stream = record(bytes, 'Stream  '), framed = bytes.slice()
  field(framed, stream + 8, 0xffffffff); field(framed, stream + 12, 0xffffffff)
  const backed = new Uint8Array(framed.length + 17)
  backed.fill(0xff); backed.set(framed, 7)
  assert.deepEqual([...finish(decodeSelectedEri(backed.subarray(7, 7 + framed.length), 'normal')).data], eriRgbNegative)
  const trailing = new Uint8Array(bytes.length + 19)
  trailing.set(bytes); trailing.fill(0xff, bytes.length)
  assert.deepEqual([...finish(decodeSelectedEri(trailing, 'normal')).data], eriRgbNegative)
  for (const length of [0, 1, 63, 79]) {
    const observed = observe()
    assert.throws(() => finish(decodeSelectedEri(bytes.subarray(0, length), 'normal', observed.progress)), native('ERIFile::Open failed.'))
    assert.deepEqual(observed.sizes, [])
  }
})

test('ERI Web budgets remain separate from original codec errors and do not publish invalid dimensions', options, () => {
  checkEriSourceSize(64 * 1024 * 1024)
  assert.throws(() => checkEriSourceSize(2 ** 32), native('Too large storage'))
  for (const size of [-1, NaN, Infinity, 1.5, 64 * 1024 * 1024 + 1])
    assert.throws(() => checkEriSourceSize(size), (error) => error instanceof Error && !(error instanceof ImageDecodeError))
  const bytes = eriContractFiles()['rgb-negative.eri']!, info = record(bytes, 'ImageInf') + 16,
    large = field(bytes.slice(), info + 16, 4097), address = field(bytes.slice(), 64 + 12, 1),
    records = new Uint8Array(64 + 65537 * 16 + bytes.length - 64)
  records.set(bytes.subarray(0, 64)); records.set(bytes.subarray(64), 64 + 65537 * 16)
  for (const input of [large, address, records]) {
    const observed = observe()
    assert.throws(() => finish(decodeSelectedEri(input, 'normal', observed.progress)), (error) => {
      assert.ok(error instanceof Error); assert.ok(!(error instanceof ImageDecodeError))
      assert.match(error.message, /Web|budget/); return true
    })
    assert.deepEqual(observed.sizes, []); assert.deepEqual(observed.rows, [])
  }
})

test('ERI distinguishes explicit frame precondition rejection from unimplemented recognized encodings', options, () => {
  const bytes = eriContractFiles()['rgb-negative.eri']!, info = record(bytes, 'ImageInf') + 16,
    frame = record(bytes, 'ImageFrm') + 16
  for (const input of [field(bytes.slice(), frame, 1), field(bytes.slice(), frame, 4), field(bytes.slice(), frame, 8),
    field(bytes.slice(), info + 24, 24)]) {
    const observed = observe()
    assert.throws(() => finish(decodeSelectedEri(input, 'normal', observed.progress)), native('ERIDecoder::DecodeImage failed.'))
    assert.deepEqual(observed.sizes, [[3, 2]]); assert.deepEqual(observed.rows, [])
  }
  // A palette header cannot initialize a DCT decoder. An unknown transform
  // stays distinct from that native error.
  assert.throws(() => finish(decodeSelectedEri(field(bytes.slice(), info + 4, 1), 'normal')), native('ERIDecoder::Initialize failed.'))
  const observed = observe()
  assert.throws(() => finish(decodeSelectedEri(field(bytes.slice(), info + 4, 0xabcdef), 'normal', observed.progress)), EriUnsupportedError)
  assert.deepEqual(observed.sizes, [[3, 2]]); assert.deepEqual(observed.rows, [])
})

test('ERI final DWORD zero padding and row-bounded repeat lengths preserve the actual entropy grammar', options, () => {
  const bytes = eriContractFiles()['rgb-negative.eri']!, frame = record(bytes, 'ImageFrm') + 16
  // The independent frame ends 4d b3 00 00. A short nonempty prefetch pads the
  // two missing zeros; an entirely absent entropy DWORD does not invent data.
  assert.deepEqual([...finish(decodeSelectedEri(bytes.subarray(0, bytes.length - 2), 'normal')).data], eriRgbNegative)
  assert.throws(() => finish(decodeSelectedEri(bytes.subarray(0, bytes.length - 4), 'normal')), native('ERIDecoder::DecodeImage failed.'))
  const repeated = bytes.slice()
  // First row 0|0|11110 repeats zero by6, clamped to its remaining1 pixel.
  // Row2 still consumes110|110|0|110 ->2,2,1; its symbols are not a carried run.
  repeated.set([0x3d, 0xb3, 0, 0], frame + 4)
  assert.deepEqual([...finish(decodeSelectedEri(repeated, 'normal')).data], [
    0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255,
    200, 100, 50, 255, 200, 100, 50, 255, 17, 34, 51, 255,
  ])
})
