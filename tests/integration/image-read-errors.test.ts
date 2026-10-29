import test from 'node:test'
import assert from 'node:assert/strict'
import type { LayerTree } from '../../src/engine/scene/layers.ts'
import { headless } from '../helpers/headless.ts'
import { imageReadFiles, imageReadSource, imageReadLiteral, imageReadSecondLiteral,
  imageReadInitialGeometry, imageReadPartialGeometry } from '../helpers/image-read-errors.ts'

async function fixture(binary: boolean) {
  const reads = new Map<string, number>(), frames: unknown[] = [],
    hostFailure = new Error('host-storage-read-failed'),
    f = await headless({}, { now: () => 0,
      renderer: { present(layers) { frames.push(layers.map(({ id }) => id)) }, dispose() {} } }),
    files: Record<string, string | Uint8Array> = {
      ...imageReadFiles(), 'read-errors.tjs': imageReadSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("read-errors.tjs","savedata/read-errors.cjs",false,true,false);Scripts.execStorage("savedata/read-errors.cjs");'
        : 'Scripts.execStorage("read-errors.tjs");',
    }
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {}, async read() {
      reads.set(name, (reads.get(name) ?? 0) + 1)
      if (name === 'host-read-failure.bmp') throw hostFailure
      return bytes
    } }
  }))
  try {
    await f.session.start()
    const id = Number(await f.session.evaluate('partialLayer.__id')),
      layers = (f.session as unknown as { layers: LayerTree }).layers
    assert.equal(await f.session.evaluate('partialGeometry()'), imageReadInitialGeometry)
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((entry) => entry.path === 'savedata/read-errors.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    return { ...f, id, layers, reads, frames,
      load: (name: string, key = 'clNone') => f.session.evaluate(`partialLoad(${JSON.stringify(name)},${key})`),
      reset: () => f.session.evaluate('resetPartialImage()'),
      async assign(value: string) {
        assert.equal(await f.session.evaluate(`System.assignMessage("TJSReadError",${JSON.stringify(value)})`), '1')
      },
    }
  } catch (primary) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Image read setup and cleanup failed', { cause: primary }) }
    throw primary
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function using(binary: boolean, run: (f: Fixture) => Promise<void>) {
  const f = await fixture(binary), failures: unknown[] = []
  try { await run(f) } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Image short-read scenario and cleanup failed', { cause: failures[0] })
}
function state(f: Fixture) {
  const layer = f.layers.get(f.id), bitmap = f.layers.bitmap(f.id)
  return { bitmap, bytes: [...bitmap.pixels.data], province: layer.province,
    provinceBytes: layer.province && [...layer.province.data],
    geometry: [layer.left, layer.top, layer.width, layer.height, layer.imageLeft, layer.imageTop],
    clip: { ...bitmap.clip }, modified: layer.imageModified, frames: f.frames.length }
}
function retained(f: Fixture, before: ReturnType<typeof state>) {
  const after = state(f)
  assert.deepEqual(after.geometry, before.geometry)
  assert.deepEqual(after.clip, before.clip)
  assert.equal(after.province, before.province)
  assert.deepEqual(after.provinceBytes, before.provinceBytes)
  assert.equal(after.modified, false)
  assert.equal(after.frames, before.frames, 'Short main/mask reads must not synthesize Update')
  assert.equal(f.session.snapshot().imageCacheEntries, 0)
}
function expectedRows(rows: number, options: { solid?: boolean; keyed?: boolean; alpha?: (y: number) => number } = {}) {
  const result = new Uint8Array(5 * 17 * 4)
  for (let y = 0; y < rows; y++) for (let x = 0; x < 5; x++) {
    const rgb = options.solid || x ? [200, 100, 50] : [17, 34, 51],
      alpha = options.keyed && !options.solid && !x ? 0 : options.alpha?.(y) ?? 255
    result.set([...rgb, alpha], (y * 5 + x) * 4)
  }
  return result
}
function image(f: Fixture, bytes: Uint8Array) {
  const bitmap = f.layers.bitmap(f.id)
  assert.deepEqual([bitmap.width, bitmap.height], [5, 17])
  assert.deepEqual(bitmap.pixels.data, bytes)
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source', options = { timeout: 60_000 }
  test(`${mode}: BMP palette, TLG and PNG required-header short reads use the current literal TJS holder before size mutation`, options, async () => {
    await using(binary, async (f) => {
      assert.equal(await f.load('read-bmp-header.bmp'), 'failed:Read error')
      await f.assign(imageReadLiteral)
      for (const name of ['read-bmp-header.bmp', 'read-bmp-palette.bmp', 'read-tlg-header.tlg',
        'read-png-signature.png', 'read-png-header.png']) {
        const before = state(f)
        assert.equal(await f.load(name), 'failed:' + imageReadLiteral, name)
        retained(f, before)
        assert.equal(f.layers.bitmap(f.id), before.bitmap)
        assert.deepEqual([...f.layers.bitmap(f.id).pixels.data], before.bytes)
        assert.equal(await f.session.evaluate('partialGeometry()'), imageReadInitialGeometry)
      }
    })
  })
  test(`${mode}: late BMP/TLG and first-IDAT short reads preserve native partial destinations without finalizing Layer state`, options, async () => {
    await using(binary, async (f) => {
      await f.assign(imageReadLiteral)
      for (const [name, rows, solid] of [
        ['read-bmp-late.bmp', 8, false], ['read-tlg-late.tlg', 8, true], ['read-png-idat.png', 0, false],
      ] as const) {
        await f.reset()
        const before = state(f)
        assert.equal(await f.load(name, '0x112233'), 'failed:' + imageReadLiteral)
        assert.notEqual(f.layers.bitmap(f.id), before.bitmap)
        image(f, expectedRows(rows, { solid, keyed: true }))
        retained(f, before)
        assert.equal(await f.session.evaluate('partialGeometry()'), imageReadPartialGeometry)
      }
    })
  })
  test(`${mode}: PNG tail and required SDS tag payload short reads retain all written main rows, while an optional short chunk name is EOF`, options, async () => {
    await using(binary, async (f) => {
      await f.assign(imageReadLiteral)
      for (const [name, solid] of [['read-png-tail.png', false], ['read-tlg-tags.tlg', true]] as const) {
        await f.reset()
        const before = state(f)
        assert.equal(await f.load(name, '0x112233'), 'failed:' + imageReadLiteral)
        image(f, expectedRows(17, { solid, keyed: true }))
        retained(f, before)
      }
      await f.reset()
      assert.equal(await f.load('tlg-short-optional-name.tlg'), 'null:')
      image(f, expectedRows(17, { solid: true }))
      assert.equal(f.layers.get(f.id).imageModified, true)
      assert.equal(f.layers.get(f.id).province, undefined)
      assert.deepEqual(f.layers.bitmap(f.id).clip, { x: 0, y: 0, width: 5, height: 17 })
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
    })
  })
  test(`${mode}: short mask reads bind only completed alpha rows and bypass color matting with unchanged old clip and province`, options, async () => {
    await using(binary, async (f) => {
      await f.assign(imageReadLiteral)
      for (const [name, alphaRows] of [['read-mask.bmp', 8], ['read-png-mask.bmp', 17]] as const) {
        await f.reset()
        const before = state(f)
        assert.equal(await f.load(name, 'clAlphaMat+0xffffff'), 'failed:' + imageReadLiteral)
        image(f, expectedRows(17, { alpha: (y) => y < alphaRows ? 64 + y * 4 : 255 }))
        retained(f, before)
      }
    })
  })
  test(`${mode}: reassigned short-read holders are resolved anew after failed-cache rereads without swallowing provider failures`, options, async () => {
    await using(binary, async (f) => {
      await f.assign(imageReadLiteral)
      assert.equal(await f.load('read-bmp-late.bmp'), 'failed:' + imageReadLiteral)
      await f.assign(imageReadSecondLiteral)
      assert.equal(await f.load('read-bmp-late.bmp'), 'failed:' + imageReadSecondLiteral)
      assert.equal(f.reads.get('read-bmp-late.bmp'), 2)
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      await f.reset()
      const before = state(f)
      assert.equal(await f.load('host-read-failure.bmp'), 'failed:host-storage-read-failed')
      retained(f, before)
      assert.equal(f.layers.bitmap(f.id), before.bitmap)
      assert.equal(await f.load('read-valid.bmp'), 'null:')
      assert.equal(await f.load('read-valid.bmp'), 'null:')
      assert.equal(f.reads.get('read-valid.bmp'), 1)
      image(f, expectedRows(17))
    })
  })
  test(`${mode}: codec diagnoses and Web dimension limits remain distinct from stream reads and a restarted Session restores the default holder`, options, async () => {
    await using(binary, async (f) => {
      await f.assign(imageReadLiteral)
      for (const [name, message] of [
        ['codec-bad-header.tlg', 'read-tlg:Invalid TLG header or unsupported TLG version.'],
        ['codec-bad-crc.png', 'partial-png:IHDR: CRC error'],
        ['web-dimension-budget.png', 'PNG dimensions must be between 1 and 4096'],
      ]) {
        const before = state(f)
        assert.equal(await f.load(name!), 'failed:' + message)
        retained(f, before)
        assert.equal(f.layers.bitmap(f.id), before.bitmap)
      }
    })
    await using(binary, async (f) => {
      assert.equal(await f.load('read-png-signature.png'), 'failed:Read error')
      assert.equal(await f.session.evaluate('partialGeometry()'), imageReadInitialGeometry)
    })
  })
}
