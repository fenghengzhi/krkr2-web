import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeSelectedEri } from '../../src/formats/image/eri.ts'
import { ImageDecodeError, type ImageDecodeProgress } from '../../src/formats/image/selection.ts'
import { decodeSelectedImage } from '../../src/engine/graphics/image-decoder.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { eriTruecolorCases, eriTruecolorFiles, eriTruecolorInput, eriTruecolorError,
  eriTrueRaw, eriTrueRgb, eriTrueGrayRgba } from '../helpers/eri-truecolor-fixtures.ts'

const options = { timeout: 30000 }
function finish<T>(work: Generator<void, T>): T {
  try {
    for (let i = 0; i < 100000; i++) { const next = work.next(); if (next.done) return next.value }
    throw new Error('ERI truecolor test exceeded its work bound')
  } finally { work.return(undefined as T) }
}
function observe() {
  const sizes: number[][] = [], rows: { y: number; rgba: number[] }[] = [], writes: number[] = []
  const progress: ImageDecodeProgress = {
    size(w, h) { sizes.push([w, h]) }, write(y) { writes.push(y) },
    row(y, rgba) { rows.push({ y, rgba: [...rgba] }) },
  }
  return { sizes, rows, writes, progress }
}
const native = (error: unknown) => {
  assert(error instanceof ImageDecodeError)
  assert.equal(error.format, 'eri'); assert.equal(error.reason, eriTruecolorError)
  return true
}

test('independent ERI forward writer has a literal zero-run frame control', options, () => {
  // 2x2 RGB=12zero symbols. Header01 00 01 00; op0000, separator0,
  // zero-run flag0, gamma(12)=1110100, then DWORD padding. No decode oracle.
  const bytes = eriTruecolorInput({ width: 2, height: 2, raw: Array(16).fill(0), table: true })
  assert.deepEqual([...bytes.subarray(-8)], [1, 0, 1, 0, 3, 160, 0, 0])
  assert.deepEqual([...finish(decodeSelectedEri(bytes, 'normal')).data],
    [0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0, 255])
})

test('ERI RGB24/RGB32 and gray frame1/frame4 preserve authored block edges, directions and whole-image publication', options, () => {
  const files = eriTruecolorFiles()
  for (const item of eriTruecolorCases.filter((item) => !item.input.alpha)) {
    const observed = observe(), image = finish(decodeSelectedEri(files[item.name]!, 'normal', observed.progress))
    assert.deepEqual([image.width, image.height], [item.width, item.height], item.name)
    assert.deepEqual([...image.data], item.rgba, item.name)
    assert.equal(image.indices, undefined); assert.equal(image.grayscale, undefined)
    assert.deepEqual(observed.sizes, [[item.width, item.height]])
    assert.deepEqual(observed.rows.map(({ y }) => y), Array.from({ length: item.height }, (_, y) => y))
    assert.deepEqual(observed.rows.flatMap(({ rgba }) => rgba), item.rgba)
    assert.deepEqual(observed.writes, [], 'Private ERI block storage is never an image raw-write callback')
  }
})

test('ERI additive RGBA uses literal inverse-alpha output while gray consumes raw channels and ignores alpha', options, () => {
  const files = eriTruecolorFiles()
  for (const item of eriTruecolorCases) {
    for (const key of [undefined, 0, 1, 255])
      assert.deepEqual([...finish(decodeSelectedEri(files[item.name]!, 'normal', undefined, key)).data], item.rgba, item.name)
    const gray = finish(decodeSelectedEri(files[item.name]!, 'grayscale'))
    assert.equal(gray.grayscale, true); assert.equal(gray.indices, undefined)
    assert.deepEqual([...gray.data], eriTrueGrayRgba(item.gray), item.name)
  }
})

test('all nine forward color differences, native no-ops and enhanced arrangements preserve the authored RGB plane', options, () => {
  for (const frame of [1, 4] as const) for (const table of [false, true]) for (let operation = 0; operation < (frame === 1 ? 16 : 64); operation++) {
    const bytes = eriTruecolorInput({ width: 3, height: 3, raw: eriTrueRaw, frame, table,
      operations: [operation, operation, operation, operation] })
    assert.deepEqual([...finish(decodeSelectedEri(bytes, 'normal')).data], eriTrueRgb, `${frame}:${table}:${operation}`)
  }
})

test('ERI incomplete late block and invalid stream separator fail after size without exposing any private decoded row', options, () => {
  const files = eriTruecolorFiles()
  for (const name of ['tc-late-failure.eri', 'tc-bad-separator.eri']) for (const mode of ['normal', 'grayscale'] as const) {
    const observed = observe()
    assert.throws(() => finish(decodeSelectedEri(files[name]!, mode, observed.progress)), native)
    assert.deepEqual(observed.sizes, [[3, 3]])
    assert.deepEqual(observed.rows, []); assert.deepEqual(observed.writes, [])
  }
})

test('ERI callback failures and retirement preserve exact causes and stop publication of later rows', options, () => {
  const bytes = eriTruecolorFiles()['tc-rgba-v1-independent.eri']!
  for (const where of ['size', 'row'] as const) {
    const cause = new Error('owned truecolor ' + where), seen: string[] = []
    assert.throws(() => finish(decodeSelectedEri(bytes, 'normal', {
      size() { seen.push('size'); if (where === 'size') throw cause },
      row(y) { seen.push('row:' + y); throw cause },
    })), (error) => error === cause)
    assert.deepEqual(seen, where === 'size' ? ['size'] : ['size', 'row:0'])
  }
  const observed = observe(), work = decodeSelectedEri(bytes, 'normal', observed.progress)
  try {
    assert.equal(work.next().done, false)
    assert.deepEqual(observed.sizes, [[3, 3]])
    assert.equal(work.next().done, false, 'The first complete2x2 entropy block is still private')
    // Retire at the first explicit private-work checkpoint. No native caller
    // row is visible merely because size allocated a fresh destination.
    assert.deepEqual(observed.rows, []); assert.deepEqual(observed.writes, [])
  } finally { work.return(undefined as never) }
  assert.equal(work.next().done, true); assert.deepEqual(observed.rows, [])
})

test('truecolor selected failures retain the actual ERI holder and observer errors bypass codec remapping', options, async () => {
  const files = eriTruecolorFiles(), deps = {
    async finish<T>(work: Generator<void, T>) { return finish(work) },
    async inflate() { throw new Error('Unexpected ERI inflater') }, async host() { throw new Error('Unexpected ERI host fallback') },
  }
  await assert.rejects(decodeSelectedImage(files['tc-late-failure.eri']!, { format: 'eri', mode: 'normal' }, deps), (error: unknown) => {
    assert(error instanceof TvpError)
    assert.deepEqual(error.tvpMessage, { id: 'TVPERILoadError', args: [eriTruecolorError] })
    assert(error.cause instanceof ImageDecodeError); return true
  })
  const cause = new ImageDecodeError('eri', 'owned observer reason')
  await assert.rejects(decodeSelectedImage(files['tc-rgb-v4-table.eri']!, { format: 'eri', mode: 'normal' }, deps,
    { size() {}, row() { throw cause } }), (error: unknown) => error === cause)
})
