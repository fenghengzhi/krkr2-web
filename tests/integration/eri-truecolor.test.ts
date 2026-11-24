import test from 'node:test'
import assert from 'node:assert/strict'
import type { LayerTree } from '../../src/engine/scene/layers.ts'
import { headless } from '../helpers/headless.ts'
import { eriTruecolorFiles, eriTruecolorSource, eriTruecolorCases, eriTrueRgb,
  eriTrueGray, eriTruecolorError } from '../helpers/eri-truecolor-fixtures.ts'
import { eriHuffmanFiles, eriHuffmanCases, eriHuffmanPaletteCases } from '../helpers/eri-huffman-fixtures.ts'
import { eriKey1 } from '../helpers/eri-fixtures.ts'

async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof headless>>, reads: Map<string, number>,
  frames: { id: number; data: number[] }[][]) => Promise<void>) {
  const files: Record<string, string | Uint8Array> = { ...eriTruecolorFiles(), ...eriHuffmanFiles(), 'truecolor.tjs': eriTruecolorSource,
    'startup.tjs': binary ? 'Scripts.compileStorage("truecolor.tjs","savedata/truecolor.cjs",false,true,false);Scripts.execStorage("savedata/truecolor.cjs");'
      : 'Scripts.execStorage("truecolor.tjs");' }, reads = new Map<string, number>(),
    frames: { id: number; data: number[] }[][] = [], failures: unknown[] = [],
    f = await headless({}, { now: () => 0,
      renderer: { present(layers) { frames.push(layers.map(({ id, pixels }) => ({ id, data: [...pixels.data] }))) }, dispose() {} } })
  try {
    f.session.mount(Object.entries(files).map(([name, value]) => {
      const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
      return { name, size: bytes.length, cacheToken: {}, async read() {
        reads.set(name, (reads.get(name) ?? 0) + 1); return bytes
      } }
    }))
    await f.session.start()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/truecolor.cjs')!.bytes.subarray(0, 4)), 'TJS2')
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
  if (failures.length) throw new AggregateError(failures, 'Truecolor ERI consumer or cleanup failed', { cause: failures[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: Huffman ERI reaches Layer pixels, invalidates on clear and recovers from a failed companion mask`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads) => {
      for (const item of [...eriHuffmanCases, ...eriHuffmanPaletteCases]) {
        assert.equal(await session.evaluate(`tcLoad(tcImage,"${item.name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('tcPixels(tcImage)'), item.rgba.join(','), item.name)
      }
      assert.equal(await session.evaluate('tcLoad(tcImage,"hp-indexed-negative.eri",clPalIdx+1)'), 'ok')
      assert.equal(await session.evaluate('tcPixels(tcImage)'), eriKey1.join(','))
      const mask = eriTrueRgb.map((v, i) => i % 4 === 3 ? eriTrueGray[i >> 2]! : v)
      assert.equal(await session.evaluate('tcLoad(tcCopy,"hc-mask.eri",clNone)'), 'ok')
      await session.evaluate('(System.clearGraphicCache(),0)')
      for (let attempt = 1; attempt <= 2; attempt++) {
        assert.equal(await session.evaluate('tcLoad(tcImage,"hc-mask-bad.eri",clNone)'), `eri-true:<${eriTruecolorError}>`)
        assert.equal(await session.evaluate('tcPixels(tcImage)'), eriTrueRgb.join(','))
        assert.equal(await session.evaluate('tcPixels(tcCopy)'), mask.join(','))
        assert.equal(reads.get('hc-mask-bad_m.eri'), attempt)
      }
      assert.equal(await session.evaluate('tcLoad(tcImage,"hc-mask.eri",clNone)'), 'ok')
      assert.equal(await session.evaluate('tcPixels(tcImage)'), mask.join(','))
      assert.equal(reads.get('hc-mask_m.eri'), 2)
    })
  })
  test(`${mode}: real ERI truecolor frames decode both directions and remain independent in processed cache destinations`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      const id = Number(await session.evaluate('tcImage.__id'))
      for (const item of eriTruecolorCases.filter((item) => item.width === 3)) {
        assert.equal(await session.evaluate(`tcLoad(tcImage,"${item.name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('tcPixels(tcImage)'), item.rgba.join(','))
        assert.deepEqual(frames.at(-1)!.find((layer) => layer.id === id)!.data, item.rgba)
        const hits = session.snapshot().imageCacheHits
        assert.equal(await session.evaluate(`tcLoad(tcCopy,"${item.name}",clNone)`), 'ok')
        assert.equal(session.snapshot().imageCacheHits, hits + 1)
        await session.evaluate('(tcImage.setMainPixel(1,1,0xabcdef),tcImage.setMaskPixel(1,1,17),0)')
        assert.equal(await session.evaluate('tcPixels(tcCopy)'), item.rgba.join(','))
        assert.equal(await session.evaluate(`tcLoad(tcImage,"${item.name}",clNone)`), 'ok')
        assert.equal(await session.evaluate('tcPixels(tcImage)'), item.rgba.join(','))
        assert.equal(reads.get(item.name), 1)
      }
      await session.evaluate('(System.clearGraphicCache(),0)')
      assert.equal(await session.evaluate('tcLoad(tcImage,"tc-rgba-v4-positive.eri",clNone)'), 'ok')
      assert.equal(reads.get('tc-rgba-v4-positive.eri'), 2)
    })
  })

  test(`${mode}: truecolor palette keys are ignored but actual RGB keys and raw-channel gray masks retain their distinct stages`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads) => {
      for (const key of ['clPalIdx', 'clPalIdx+1', 'clPalIdx+255']) {
        assert.equal(await session.evaluate(`tcLoad(tcImage,"tc-rgb-v1-independent.eri",${key})`), 'ok')
        assert.equal(await session.evaluate('tcPixels(tcImage)'), eriTrueRgb.join(','))
      }
      const keyed = [...eriTrueRgb]; keyed[3] = 0
      assert.equal(await session.evaluate('tcLoad(tcImage,"tc-rgb-v1-independent.eri",0x0a141e)'), 'ok')
      assert.equal(await session.evaluate('tcPixels(tcImage)'), keyed.join(','))
      const masked = eriTrueRgb.map((value, at) => at % 4 === 3 ? eriTrueGray[at >> 2]! : value)
      assert.equal(await session.evaluate('tcLoad(tcImage,"tc-mask.eri",clNone)'), 'ok')
      assert.equal(await session.evaluate('tcPixels(tcImage)'), masked.join(','))
      const hits = session.snapshot().imageCacheHits
      assert.equal(await session.evaluate('tcLoad(tcCopy,"tc-mask.eri",clNone)'), 'ok')
      assert.equal(session.snapshot().imageCacheHits, hits + 1)
      assert.equal(reads.get('tc-mask.eri'), 1); assert.equal(reads.get('tc-mask_m.eri'), 1)
      assert.equal(await session.evaluate('tcPixels(tcCopy)'), masked.join(','))
    })
  })

  test(`${mode}: a later private ERI block failure preserves old Layer state and cached failures are reread with the current holder`, { timeout: 60000 }, async () => {
    await using(binary, async ({ session }, reads, frames) => {
      const id = Number(await session.evaluate('tcImage.__id')), layers = (session as unknown as { layers: LayerTree }).layers
      for (const name of ['tc-late-failure.eri', 'tc-mask-bad.eri']) for (let attempt = 1; attempt <= 2; attempt++) {
        assert.equal(await session.evaluate('tcPrepareFailure()'), '0')
        const layer = layers.get(id), bitmap = layers.bitmap(id), province = layer.province!,
          before = { geometry: [layer.width, layer.height, layer.imageLeft, layer.imageTop], clip: { ...bitmap.clip },
            modified: layer.imageModified, province: [...province.data], frames: frames.length }
        assert.deepEqual(before.geometry, [2, 2, -1, -1]); assert.equal(before.modified, false)
        const message = `truecolor-${attempt}:<%1>`
        assert.equal(await session.evaluate(`System.assignMessage("TVPERILoadError",${JSON.stringify(message)})`), '1')
        assert.equal(await session.evaluate(`tcLoad(tcImage,"${name}",clNone)`), `truecolor-${attempt}:<${eriTruecolorError}>`)
        assert.deepEqual([layer.width, layer.height, layer.imageLeft, layer.imageTop], before.geometry)
        assert.deepEqual(layers.bitmap(id).clip, before.clip)
        assert.equal(layer.imageModified, before.modified); assert.equal(layer.province, province)
        assert.deepEqual([...province.data], before.province)
        assert.deepEqual([...layers.bitmap(id).pixels.data], name === 'tc-late-failure.eri' ? Array(36).fill(0) : eriTrueRgb)
        assert.equal(frames.length, before.frames, 'No caller row or final Update is published from failed private ERI decoding')
        assert.equal(session.snapshot().imageCacheEntries, 0)
        assert.equal(reads.get(name), attempt)
        if (name === 'tc-mask-bad.eri') assert.equal(reads.get('tc-mask-bad_m.eri'), attempt)
      }
    })
  })
}
