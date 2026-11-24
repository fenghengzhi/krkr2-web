import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateSync } from 'node:zlib'
import { decodePng } from '../../src/formats/image/png.ts'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import type { ImageDecodeProgress, ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { TjsError } from '../../src/engine/system/tjs-error.ts'
import { ImageReadError } from '../../src/formats/image/read-error.ts'
import { createHeadlessImageInflaterProvider } from '../helpers/image-zlib.ts'
import { lowbitPng, lowbitChunk, grayTransparency, lowbitSamples, lowbitValues } from '../helpers/png-lowbit-fixtures.ts'

const options = { timeout: 60000 }, modes = ['normal', 'grayscale', 'palettized'] as const
function finish<T>(work: Generator<void, T>): T {
  try {
    for (let count = 0; count < 10000; count++) { const result = work.next(); if (result.done) return result.value }
    throw new Error('Low-bit PNG fixture exceeded its work bound')
  } finally { work.return(undefined as T) }
}
async function using(run: (dependencies: SelectedImageDecoderDependencies) => Promise<void>) {
  const provider = createHeadlessImageInflaterProvider(), failures: unknown[] = []
  let opened = 0, closed = 0
  try {
    await run({ async finish<T>(work: Generator<void, T>) { return finish(work) },
      async inflate(compressed) { return inflateSync(compressed) },
      async host() { throw new Error('Selected low-bit PNG reached the host fallback') },
      async openInflater(source, length) {
        const stream = await provider.open(source, length); opened++
        return { step: (input, output) => stream.step(input, output), close() { closed++; stream.close() } }
      },
    })
  } catch (error) { failures.push(error) }
  try { assert.equal(closed, opened) } catch (error) { failures.push(error) }
  try { provider.dispose() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Low-bit PNG or cleanup failed', { cause: failures[0] })
}
function selected(bytes: Uint8Array, dependencies: SelectedImageDecoderDependencies, streaming: boolean,
  mode: ImageDecodeSelection['mode'] = 'normal', progress?: ImageDecodeProgress, paletteKey?: number) {
  return decodeSelectedImage(bytes, { format: 'png', mode, ...(paletteKey === undefined ? {} : { paletteKey }) },
    streaming ? dependencies : { ...dependencies, openInflater: undefined }, progress)
}
function generic(bytes: Uint8Array) {
  const plan = finish(decodePng(bytes)!)
  return finish(plan.decode(inflateSync(plan.compressed)))
}
const gray = (values: readonly number[], alpha: (index: number) => number = () => 255) =>
  values.flatMap((value, index) => [value, value, value, alpha(index)])
const pngError = (reason: string) => (error: unknown) => {
  assert(error instanceof TvpError)
  assert.deepEqual(error.tvpMessage, { id: 'TVPPNGLoadError', args: [reason] })
  return true
}

test('selected low-bit gray without tRNS uses exact native expansion in all safe modes and Adam7', options, async () => {
  await using(async (dependencies) => {
    for (const depth of [1, 2, 4] as const) for (const interlace of [false, true]) {
      const samples = lowbitSamples[depth], values = samples.flat().map((value) => lowbitValues[depth][value]!),
        bytes = lowbitPng({ width: 7, samples, depth, interlace }), expected = gray(values)
      for (const streaming of [false, true]) for (const mode of modes) {
        const image = await selected(bytes, dependencies, streaming, mode)
        assert.deepEqual([image.width, image.height], [7, 3]); assert.equal(image.grayscale, true)
        assert.equal(image.indices, undefined); assert.deepEqual([...image.data], expected)
      }
      assert.deepEqual([...generic(bytes).data], expected)
    }
  })
})

test('selected normal gray retains decoder tRNS despite its ancillary CRC while generic PNG remains strict', options, async () => {
  await using(async (dependencies) => {
    for (const depth of [1, 2, 4, 8, 16] as const) for (const interlace of [false, true]) {
      const samples = depth === 16 ? [[0x1234, 0x1200, 0, 0xffff]] : [[0, 1, 0, (1 << depth) - 1]],
        key = depth === 16 ? 0x1234 : 0,
        values = depth === 16 ? [18, 18, 0, 255] : depth === 8 ? samples[0]! : samples[0]!.map((value) => lowbitValues[depth][value]!),
        bytes = lowbitPng({ width: 4, samples, depth, interlace, before: [grayTransparency(key, true)] }),
        expected = gray(values, (index) => samples[0]![index] === key ? 0 : 255)
      for (const streaming of [false, true]) {
        const rows: number[][] = [], image = await selected(bytes, dependencies, streaming, 'normal', {
          size(w, h) { assert.deepEqual([w, h], [4, 1]) }, row(y, rgba) { assert.equal(y, 0); rows.push([...rgba]) },
        })
        assert.deepEqual([...image.data], expected); assert.deepEqual(rows, [expected])
      }
      assert.throws(() => generic(bytes), { message: 'PNG chunk CRC mismatch' })
    }
  })
})

test('selected tRNS decoder data and successful info slot obey independent first-valid and replacement rules', options, async () => {
  await using(async (dependencies) => {
    const malformed = lowbitChunk('tRNS', Uint8Array.of(0, 2, 99)), cases = [
      { chunks: [grayTransparency(0, true)], key: 0 },
      { chunks: [grayTransparency(0, true), malformed, grayTransparency(1, true)], key: 1 },
      { chunks: [grayTransparency(0, true), grayTransparency(1), grayTransparency(2, true)], key: 1 },
      { chunks: [grayTransparency(0), grayTransparency(1)], key: 0 },
      { chunks: [malformed, grayTransparency(2)], key: 2 },
      { chunks: [grayTransparency(0), malformed, grayTransparency(3)], key: 0 },
    ]
    for (const { chunks, key } of cases) for (const streaming of [false, true]) {
      const bytes = lowbitPng({ width: 4, samples: [[0, 1, 2, 3]], depth: 2, before: chunks }),
        image = await selected(bytes, dependencies, streaming)
      assert.deepEqual([...image.data], gray([0, 85, 170, 255], (index) => index === key ? 0 : 255))
    }
    const duplicate = lowbitPng({ width: 2, samples: [[0, 1]], depth: 1,
      before: [grayTransparency(0), grayTransparency(1)] })
    assert.throws(() => generic(duplicate), { message: 'Invalid PNG transparency' })
  })
})

test('palette tRNS CRC data reaches original key and manual-gray paths before or after PLTE', options, async () => {
  await using(async (dependencies) => {
    const palette = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120],
      transparency = lowbitChunk('tRNS', Uint8Array.of(13, 127, 241, 255), true),
      normal = [10, 20, 30, 13, 40, 50, 60, 127, 70, 80, 90, 241, 100, 110, 120, 255]
    for (const beforePalette of [false, true]) for (const interlace of [false, true]) for (const streaming of [false, true]) {
      const bytes = lowbitPng({ width: 4, samples: [[0, 1, 2, 3]], color: 3, depth: 2, palette, interlace,
        ...(beforePalette ? { beforePalette: [transparency] } : { before: [transparency] }) })
      for (const key of [undefined, 1, 255])
        assert.deepEqual([...(await selected(bytes, dependencies, streaming, 'normal', undefined, key)).data], normal)
      const grayscale = await selected(bytes, dependencies, streaming, 'grayscale')
      assert.deepEqual([...grayscale.data], gray([18, 54, 112, 106]))
      const palettized = await selected(bytes, dependencies, streaming, 'palettized')
      assert.deepEqual([...palettized.indices!], [0, 1, 2, 3])
      assert.deepEqual([...palettized.data], normal.map((value, index) => index % 4 === 3 ? 255 : value))
    }
    // A successful info slot, unlike a failed CRC, locks later valid chunks.
    for (const streaming of [false, true]) {
      const bytes = lowbitPng({ width: 4, samples: [[0, 1, 2, 3]], color: 3, depth: 2, palette,
        before: [transparency, lowbitChunk('tRNS', Uint8Array.of(7, 8)), lowbitChunk('tRNS', Uint8Array.of(9, 10))] })
      assert.deepEqual([...(await selected(bytes, dependencies, streaming)).data],
        [10, 20, 30, 7, 40, 50, 60, 8, 70, 80, 90, 255, 100, 110, 120, 255])
      const oversized = lowbitPng({ width: 4, samples: [[0, 1, 2, 3]], color: 3, depth: 2, palette,
        beforePalette: [lowbitChunk('tRNS', new Uint8Array(257))] })
      await assert.rejects(selected(oversized, dependencies, streaming),
        { message: 'PNG transparency before palette exceeds 256-entry Web budget' })
    }
  })
})

test('invalid tRNS lengths and original alpha-image prohibition warn without inventing a native failure', options, async () => {
  await using(async (dependencies) => {
    for (const streaming of [false, true]) {
      const rgb = lowbitPng({ width: 1, samples: [[18, 86, 154]], color: 2,
        before: [lowbitChunk('tRNS', Uint8Array.of(0, 18, 0, 86, 0, 154), true)] })
      assert.deepEqual([...(await selected(rgb, dependencies, streaming)).data], [18, 86, 154, 255])
      assert.deepEqual([...(await selected(rgb, dependencies, streaming, 'grayscale')).data], [154, 154, 154, 255])
      for (const [color, samples, expected] of [
        [4, [[71, 13]], [71, 71, 71, 13]], [6, [[18, 86, 154, 13]], [18, 86, 154, 13]],
      ] as const) {
        const bytes = lowbitPng({ width: 1, samples, color, before: [grayTransparency(71), grayTransparency(18, true)] })
        assert.deepEqual([...(await selected(bytes, dependencies, streaming)).data], expected)
      }
      const palette = [10, 20, 30, 40, 50, 60], bytes = lowbitPng({ width: 2, samples: [[0, 1]], color: 3, depth: 1, palette,
        before: [lowbitChunk('tRNS', Uint8Array.of()), lowbitChunk('tRNS', Uint8Array.of(1, 2, 3)),
          lowbitChunk('tRNS', Uint8Array.of(17))] })
      assert.deepEqual([...(await selected(bytes, dependencies, streaming)).data], [10, 20, 30, 17, 40, 50, 60, 255])
    }
  })
})

test('tail tRNS stays ignored and critical read-end CRC still rejects after the same exact row publication', options, async () => {
  await using(async (dependencies) => {
    for (const interlace of [false, true]) for (const streaming of [false, true]) {
      const before = [grayTransparency(0, true)], after = [grayTransparency(1), grayTransparency(0, true)],
        source = { width: 2, samples: [[0, 1]], depth: 1 as const, interlace, before, after },
        bytes = lowbitPng(source), expected = [0, 0, 0, 0, 255, 255, 255, 255]
      assert.deepEqual([...(await selected(bytes, dependencies, streaming)).data], expected)
      const rows: number[][] = [], pending = selected(lowbitPng({ ...source, badEnd: true }), dependencies, streaming, 'normal', {
        size() {}, row(_y, rgba) { rows.push([...rgba]) },
      })
      await assert.rejects(pending, streaming ? pngError('IEND: CRC error') : { message: 'PNG chunk CRC mismatch' })
      assert.deepEqual(rows, interlace ? [] : [expected])
    }
  })
})

test('tRNS warning paths still propagate real source short reads and callback causes without recategorization', options, async () => {
  await using(async (dependencies) => {
    const bytes = lowbitPng({ width: 2, samples: [[0, 1]], depth: 1, before: [grayTransparency(0, true)] })
    for (const streaming of [false, true]) {
      // Signature8 + IHDR25 + tRNS header8: the original fixed read wants2.
      await assert.rejects(selected(bytes.subarray(0, 42), dependencies, streaming), (error: unknown) => {
        assert(error instanceof TjsError); assert.deepEqual(error.tjsMessage, { id: 'TJSReadError' })
        assert(error.cause instanceof ImageReadError)
        assert.deepEqual([error.cause.offset, error.cause.requested, error.cause.actual], [41, 2, 1])
        return true
      })
      const cause = new Error('owned low-bit row observer'), events: string[] = []
      await assert.rejects(selected(bytes, dependencies, streaming, 'normal', {
        size() { events.push('size') }, row() { events.push('row'); throw cause },
      }), (error: unknown) => error === cause)
      assert.deepEqual(events, ['size', 'row'])
    }
  })
})

test('unsafe original gray tRNS expansion retains the explicit bounded Web plane policy in eight-bit destinations', options, async () => {
  await using(async (dependencies) => {
    // Original EXPAND produces2W bytes but these caller modes own onlyW. This
    // verifies existing safe Web behavior, not equality with an overflowing
    // native destination or unspecified adjacent memory.
    for (const depth of [1, 2, 4] as const) for (const interlace of [false, true]) for (const streaming of [false, true]) {
      const samples = lowbitSamples[depth], values = samples.flat().map((value) => lowbitValues[depth][value]!),
        bytes = lowbitPng({ width: 7, samples, depth, interlace, before: [grayTransparency(0)] })
      for (const mode of ['grayscale', 'palettized'] as const) {
        const image = await selected(bytes, dependencies, streaming, mode)
        assert.deepEqual([image.width, image.height, image.data.length], [7, 3, 84])
        assert.deepEqual([...image.data], gray(values))
      }
      assert.deepEqual([...generic(bytes).data], gray(values, (index) => samples.flat()[index] === 0 ? 0 : 255))
    }
  })
})
