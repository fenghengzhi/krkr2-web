import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import {
  eriContractFiles, eriContractSource, eriContractCases, eriRgbNegative, eriRgbPositive,
  eriGrayNegative, eriGrayPositive, eriGrayRgba, eriKey1, eriPaletteGray, eriMaskedRgba,
  eriError, eriProvinceReason,
} from '../helpers/eri-fixtures.ts'

async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof headless>>, reads: Map<string, number>,
  frames: { id: number; width: number; height: number; data: number[] }[][]) => Promise<void>) {
  const files: Record<string, string | Uint8Array> = { ...eriContractFiles(), 'eri.tjs': eriContractSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("eri.tjs","savedata/eri.cjs",false,true,false);Scripts.execStorage("savedata/eri.cjs");'
      : 'Scripts.execStorage("eri.tjs");' },
    reads = new Map<string, number>(), frames: { id: number; width: number; height: number; data: number[] }[][] = [],
    f = await headless({}, { renderer: { present(layers) {
      frames.push(layers.map(({ id, pixels }) => ({ id, width: pixels.width, height: pixels.height, data: [...pixels.data] })))
    }, dispose() {} } }), failures: unknown[] = []
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {}, async read() {
      reads.set(name, (reads.get(name) ?? 0) + 1); return bytes
    } }
  }))
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/eri.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    await run(f, reads, frames)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert.equal(f.session.snapshot().imageCacheBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'ERI consumer or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: authored ERI MTF rows preserve both height directions, palette keys and private cache destinations`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      const id = Number(await session.evaluate('eriImage.__id')), cases = [
        ['rgb-negative.eri', eriRgbNegative], ['rgb-positive.eri', eriRgbPositive],
        ['gray-negative.eri', eriGrayRgba(eriGrayNegative)], ['gray-positive.eri', eriGrayRgba(eriGrayPositive)],
      ] as const
      for (const [name, expected] of cases) {
        assert.equal(await session.evaluate(`eriLoad(eriImage,"${name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('eriPixels(eriImage)'), expected.join(','))
        assert.deepEqual(frames.at(-1)!.find((layer) => layer.id === id), { id, width: 3, height: 2, data: [...expected] })
        const hits = session.snapshot().imageCacheHits
        assert.equal(await session.evaluate(`eriLoad(eriCopy,"${name}",clNone)`), 'ok')
        assert.equal(session.snapshot().imageCacheHits, hits + 1)
        await session.evaluate('(eriImage.setMainPixel(0,0,0xabcdef),eriImage.setMaskPixel(0,0,17),0)')
        assert.equal(await session.evaluate('eriPixels(eriCopy)'), expected.join(','))
        assert.equal(await session.evaluate(`eriLoad(eriImage,"${name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('eriPixels(eriImage)'), expected.join(','))
        assert.equal(reads.get(name), 1)
      }
      let entries = session.snapshot().imageCacheEntries
      for (const [name, key, expected] of [
        ['rgb-negative.eri', 1, eriKey1], ['rgb-negative.eri', 255, eriRgbNegative],
        ['gray-negative.eri', 1, eriGrayRgba(eriGrayNegative)],
      ] as const) {
        assert.equal(await session.evaluate(`eriLoad(eriImage,"${name}",clPalIdx+${key})`), 'ok')
        assert.equal(await session.evaluate('eriPixels(eriImage)'), expected.join(','))
        assert.equal(session.snapshot().imageCacheEntries, ++entries)
        assert.equal(await session.evaluate(`eriLoad(eriCopy,"${name}",clPalIdx+${key})`), 'ok')
        await session.evaluate('(eriImage.setMainPixel(1,0,0),eriImage.setMaskPixel(1,0,222),0)')
        assert.equal(await session.evaluate('eriPixels(eriCopy)'), expected.join(','))
      }
      await session.evaluate('(System.clearGraphicCache(),0)')
      for (const [name, expected] of cases) {
        const before = reads.get(name)!
        assert.equal(await session.evaluate(`eriLoad(eriImage,"${name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('eriPixels(eriImage)'), expected.join(','))
        assert.equal(reads.get(name), before + 1, 'Successful ERI storage can be read and decoded again after eviction')
      }
    })
  })
  test(`${mode}: ERI gray and palette companions supply actual mask bytes while failed entropy binds no mask row`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      for (const [name, alpha] of [['masked-gray.eri', eriGrayNegative], ['masked-palette.eri', eriPaletteGray]] as const) {
        const expected = eriMaskedRgba(alpha), maskName = name.replace('.eri', '_m.eri')
        assert.equal(await session.evaluate(`eriLoad(eriImage,"${name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('eriPixels(eriImage)'), expected.join(','))
        const hits = session.snapshot().imageCacheHits
        assert.equal(await session.evaluate(`eriLoad(eriCopy,"${name}",clNone)`), 'ok')
        assert.equal(session.snapshot().imageCacheHits, hits + 1)
        assert.equal(await session.evaluate('eriPixels(eriCopy)'), expected.join(','))
        assert.equal(reads.get(name), 1); assert.equal(reads.get(maskName), 1)
      }
      await session.evaluate('(System.clearGraphicCache(),0)')
      for (let attempt = 1; attempt <= 2; attempt++) {
        const before = frames.length
        assert.equal(await session.evaluate('eriLoad(eriImage,"masked-bad.eri",clNone)'), eriError('ERIDecoder::DecodeImage failed.'))
        assert.equal(await session.evaluate('eriPixels(eriImage)'), eriRgbNegative.join(','), 'Completed opaque main remains; no partial private ERI mask is bound')
        assert.equal(await session.evaluate('eriPixels(eriCopy)'), eriMaskedRgba(eriPaletteGray).join(','))
        assert.equal(frames.length, before, 'Failed processing does not request final Update')
        assert.equal(session.snapshot().imageCacheEntries, 0)
        assert.equal(reads.get('masked-bad.eri'), attempt); assert.equal(reads.get('masked-bad_m.eri'), attempt)
      }
    })
  })
  test(`${mode}: ERI open, initialization and entropy errors retain the native phase and province rejection precedes a byte read`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      for (const entry of eriContractCases.filter((entry) => entry.mode === 'normal' && entry.error)) {
        for (let attempt = 1; attempt <= 2; attempt++) {
          assert.equal(await session.evaluate('eriLoad(eriImage,"rgb-negative.eri",clNone)'), 'ok')
          assert.equal(await session.evaluate('eriLoad(eriCopy,"rgb-negative.eri",clNone)'), 'ok')
          await session.evaluate('(System.clearGraphicCache(),0)')
          const before = frames.length
          assert.equal(await session.evaluate(`eriLoad(eriImage,"${entry.name}",clNone)`), eriError(entry.error!))
          // Once size is published the Web bitmap is recreated with defined
          // zeroes. These are not a claim about native uninitialized memory.
          assert.equal(await session.evaluate('eriPixels(eriImage)'), (entry.sizeExpected ? Array(24).fill(0) : eriRgbNegative).join(','))
          assert.equal(await session.evaluate('eriPixels(eriCopy)'), eriRgbNegative.join(','))
          assert.equal(frames.length, before)
          assert.equal(session.snapshot().imageCacheEntries, 0)
          assert.equal(reads.get(entry.name), attempt, 'Failed ERI data never enters the processed cache')
        }
      }
      assert.equal(await session.evaluate('eriLoad(eriImage,"rgb-negative.eri",clNone)'), 'ok')
      const readsBefore = reads.get('rgb-negative.eri'), entries = session.snapshot().imageCacheEntries
      assert.equal(await session.evaluate('eriProvince("rgb-negative.eri")'), eriError(eriProvinceReason))
      assert.equal(await session.evaluate('eriPixels(eriImage)'), eriRgbNegative.join(','))
      assert.equal(reads.get('rgb-negative.eri'), readsBefore)
      assert.equal(session.snapshot().imageCacheEntries, entries)
    })
  })
}
