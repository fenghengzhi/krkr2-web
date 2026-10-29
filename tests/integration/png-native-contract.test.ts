import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { pngMetadataExpected, pngNativeFiles, pngNativeSource } from '../helpers/png-native-contract.ts'

async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof headless>>) => Promise<void>) {
  const f = await headless({ ...pngNativeFiles(), 'png-native.tjs': pngNativeSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("png-native.tjs","savedata/png-native.cjs",false,true,false);Scripts.execStorage("savedata/png-native.cjs");'
      : 'Scripts.execStorage("png-native.tjs");' }), failures: unknown[] = []
  try {
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/png-native.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    await run(f)
  } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'PNG native consumer or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: selected PNG distinguishes native RGB tRNS, expanded gray tRNS and explicit RGBA alpha`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('pngAlpha()'), '255,255,0,255,64,191')
      assert.equal(await session.evaluate('[pngRgb.getMainPixel(0,0),pngGray.getMainPixel(0,0),pngRgba.getMainPixel(0,0)].join(",")'), '1321020,2105376,6566425')
      // The RGB key callback is later than the selected PNG handler and still
      // replaces alpha even though that handler ignores RGB tRNS itself.
      await session.evaluate('pngRgb.loadImages("native-rgb.png",0x14283c)')
      assert.equal(await session.evaluate('[pngRgb.getMaskPixel(0,0),pngRgb.getMaskPixel(1,0)].join(",")'), '0,255')
    })
  })
  test(`${mode}: PNG metadata uses native read-info ordering and signed values through private cache results`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('pngMeta()'), pngMetadataExpected)
      assert.equal(await session.evaluate('(pngMetadata.offs_x="changed",pngMetadata.vpag_w="changed",[pngMetadata.offs_x,pngMetadata.vpag_w].join(","))'), 'changed,changed')
      const hits = session.snapshot().imageCacheHits
      assert.equal(await session.evaluate('pngMeta()'), pngMetadataExpected)
      assert.equal(session.snapshot().imageCacheHits, hits + 1)
      assert.equal(await session.evaluate('pngEmptyMeta("native-tail.png")'), '1')
      assert.equal(await session.evaluate('pngEmptyMeta("native-short.png")'), '1')
    })
  })
  test(`${mode}: native PNG metadata CRC warnings retain only callback-accepted metadata without failing image load`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }) => {
      assert.equal(await session.evaluate('pngCrcMeta()'), '1,1,-1,9,pixel')
      assert.equal(await session.evaluate('[pngProbe.getMainPixel(0,0),pngProbe.getMaskPixel(0,0)].join(",")'), '1321020,255')
    })
  })
}
