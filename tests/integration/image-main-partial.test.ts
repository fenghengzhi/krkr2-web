import test from 'node:test'
import assert from 'node:assert/strict'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { LayerTree } from '../../src/engine/scene/layers.ts'
import { headless } from '../helpers/headless.ts'
import { pngInflateGate } from '../helpers/image-decoder-gate.ts'
import { imagePartialFiles, imagePartialSource } from '../helpers/image-partial-fixtures.ts'

async function within<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 10000)
    })])
  } finally { clearTimeout(timer) }
}
function observed<T>(promise: Promise<T>): Promise<PromiseSettledResult<T>> {
  return promise.then((value): PromiseFulfilledResult<T> => ({ status: 'fulfilled', value }),
    (reason: unknown): PromiseRejectedResult => ({ status: 'rejected', reason }))
}
async function entered<T>(gate: Promise<void>, pending: Promise<PromiseSettledResult<T>>): Promise<void> {
  await within(Promise.race([gate, pending.then((result) => {
    throw new Error('Image load settled before the actual inflate gate: ' + result.status)
  })]), 'actual PNG inflate entry')
}
async function withGate(gate: ReturnType<typeof pngInflateGate>, run: () => Promise<void>, afterRelease?: () => void) {
  const failures: unknown[] = []
  try { await run() } catch (error) { failures.push(error) }
  gate.release()
  try { afterRelease?.() } catch (error) { failures.push(error) }
  try { await within(gate.drain(), 'actual PNG decoder drain') } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Partial image assertion and decoder cleanup failed', { cause: failures[0] })
}

async function fixture(binary: boolean, overrides: Partial<SessionDependencies> = {}) {
  const frames: unknown[] = [], reads = new Map<string, number>(), f = await headless({}, {
    now: () => 0,
    renderer: { present(layers) {
      frames.push(layers.map(({ id, pixels }) => ({ id, width: pixels.width, height: pixels.height, data: [...pixels.data] })))
    }, dispose() {} }, ...overrides,
  }), files: Record<string, string | Uint8Array> = {
    ...imagePartialFiles(), 'partial.tjs': imagePartialSource,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("partial.tjs","savedata/partial.cjs",false,true,false);Scripts.execStorage("savedata/partial.cjs");'
      : 'Scripts.execStorage("partial.tjs");',
  }
  f.session.mount(Object.entries(files).map(([name, value]) => {
    const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
    return { name, size: bytes.length, cacheToken: {},
      source: { size: bytes.length, async read(offset: number, length: number) { return bytes.slice(offset, offset + length) } },
      async read() { reads.set(name, (reads.get(name) ?? 0) + 1); return bytes },
    }
  }))
  try {
    await f.session.start()
    const id = Number(await f.session.evaluate('partialLayer.__id')),
      layers = (f.session as unknown as { layers: LayerTree }).layers
    assert.equal(await f.session.evaluate('partialGeometry()'), '0,0,3,2,7,19,-2,-1,1,1,2,2')
    assert.equal(await f.session.evaluate('int(partialLayer.imageModified)'), '0')
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves()
      .find((file) => file.path === 'savedata/partial.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    return { ...f, id, layers, frames, reads,
      load: (name: string, key = 'clNone') => f.session.evaluate(`partialLoad(${JSON.stringify(name)},${key})`),
      reset: () => f.session.evaluate('resetPartialImage()'),
    }
  } catch (primary) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([primary, cleanup], 'Partial image setup and cleanup failed', { cause: primary }) }
    throw primary
  }
}
type Fixture = Awaited<ReturnType<typeof fixture>>
async function using(binary: boolean, run: (f: Fixture) => Promise<void>, overrides: Partial<SessionDependencies> = {}) {
  const f = await fixture(binary, overrides), failures: unknown[] = []
  try { await run(f) } catch (error) { failures.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert.equal(f.session.snapshot().imageCacheBytes, 0)
    assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Partial image scenario and cleanup failed', { cause: failures[0] })
}
function state(f: Fixture) {
  const layer = f.layers.get(f.id), bitmap = f.layers.bitmap(f.id)
  return { bitmap, province: layer.province,
    data: [...bitmap.pixels.data], provinceData: layer.province && [...layer.province.data],
    geometry: [layer.left, layer.top, layer.width, layer.height, layer.imageLeft, layer.imageTop],
    clip: { ...bitmap.clip }, modified: layer.imageModified, frames: f.frames.length }
}
function retainedState(f: Fixture, before: ReturnType<typeof state>) {
  const after = state(f)
  assert.deepEqual(after.geometry, before.geometry)
  assert.deepEqual(after.clip, before.clip)
  assert.equal(after.province, before.province, 'a main/mask error does not replace the old Province')
  assert.deepEqual(after.provinceData, before.provinceData)
  assert.equal(after.modified, before.modified)
  assert.equal(after.frames, before.frames, 'a main/mask decoder failure does not request Update')
}
function pixels(f: Fixture, width: number, height: number, written: (y: number) => boolean,
  alpha: (x: number, y: number) => number = () => 255) {
  const bitmap = f.layers.bitmap(f.id), expected = new Uint8Array(width * height * 4)
  assert.equal(bitmap.width, width); assert.equal(bitmap.height, height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (written(y))
    expected.set(x === 0 ? [17,34,51,alpha(x,y)] : [200,100,50,alpha(x,y)], (y * width + x) * 4)
  assert.deepEqual(bitmap.pixels.data, expected,
    'only complete published rows have colors; unwritten memory is explicitly safe zero in the Web implementation')
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: failures before the native size callback preserve every image plane and request no paint`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      for (const [name, error] of [['early.bmp', 'Truncated BMP stream'], ['early.png', 'PNG chunk CRC mismatch']] as const) {
        const before = state(f), paints = await f.session.evaluate('partialPaints')
        assert.equal(await f.load(name), 'failed:' + error)
        retainedState(f, before)
        assert.equal(f.layers.bitmap(f.id), before.bitmap)
        assert.deepEqual(f.layers.bitmap(f.id).pixels.data, Uint8Array.from(before.data))
        assert.equal(await f.session.evaluate('partialPaints'), paints)
        assert.equal(f.session.snapshot().imageCacheEntries, 0)
      }
    })
  })
  test(`${mode}: BMP file-order eight-row reads retain only complete batches and recreate even at the same dimensions`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      for (const [name, width, height, bottomUp] of [
        ['main-truncated.bmp', 5, 17, false], ['bottom-truncated.bmp', 5, 17, true], ['same-truncated.bmp', 7, 19, false],
      ] as const) {
        await f.reset()
        const before = state(f)
        assert.equal(await f.load(name, '0x112233'), 'failed:Truncated BMP pixels or palette')
        assert.notEqual(f.layers.bitmap(f.id), before.bitmap)
        pixels(f, width, height, (y) => bottomUp ? y >= height - 8 : y < 8, (x) => x === 0 ? 0 : 255)
        retainedState(f, before)
        assert.equal(f.session.snapshot().imageCacheEntries, 0)
      }
    })
  })
  test(`${mode}: a mask size or pre-size read failure retains the complete new main and all old Layer metadata`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      for (const [name, error] of [['mask-size.bmp', 'partial-mask-size'], ['mask-read.bmp', 'Truncated BMP stream']] as const) {
        await f.reset()
        const before = state(f)
        assert.equal(await f.load(name, 'clAlphaMat+0xffffff'), 'failed:' + error)
        pixels(f, 5, 17, () => true)
        retainedState(f, before)
        assert.equal(f.session.snapshot().imageCacheEntries, 0)
      }
    })
  })
  test(`${mode}: a truncated mask changes only completed alpha rows and never applies the later color matte`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const before = state(f)
      assert.equal(await f.load('mask-truncated.bmp', 'clAlphaMat+0xffffff'), 'failed:Truncated BMP pixels or palette')
      pixels(f, 5, 17, () => true, (_x, y) => y < 8 ? 64 + y * 4 : 255)
      retainedState(f, before)
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      assert.equal(f.reads.get('mask-truncated.bmp'), 1)
      assert.equal(f.reads.get('mask-truncated_m.bmp'), 1)
    })
  })
  test(`${mode}: PNG bad filters and trailing chunk failures preserve their actual completed rows without post-load geometry effects`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      for (const [name, error, rows] of [
        ['png-filter.png', 'Unsupported PNG scanline filter', 8],
        ['png-tail.png', 'PNG chunk CRC mismatch', 17],
        ['png-tail-short.png', 'Truncated PNG chunk', 17],
      ] as const) {
        await f.reset()
        const before = state(f)
        assert.equal(await f.load(name, '0x112233'), 'failed:' + error)
        pixels(f, 5, 17, (y) => y < rows, (x) => x === 0 ? 0 : 255)
        retainedState(f, before)
        assert.equal(f.session.snapshot().imageCacheEntries, 0)
      }
    })
  })
  test(`${mode}: failed processed images are reread rather than cached, while a completed request is privately reusable`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      assert.equal(await f.load('main-truncated.bmp'), 'failed:Truncated BMP pixels or palette')
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      assert.equal(await f.load('main-truncated.bmp'), 'failed:Truncated BMP pixels or palette')
      assert.equal(f.reads.get('main-truncated.bmp'), 2)
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
      assert.equal(await f.load('plain.bmp'), 'null:')
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
      await f.session.evaluate('partialLayer.setMainPixel(1,1,0xabcdef)')
      assert.equal(await f.load('plain.bmp'), 'null:')
      assert.equal(f.reads.get('plain.bmp'), 1)
      pixels(f, 5, 17, () => true)
      assert.equal(f.layers.get(f.id).province, undefined)
    })
  })
  test(`${mode}: completed main and mask normalize Layer state before the real province inflate, then install the province on success`, { timeout: 60000 }, async () => {
    const gate = pngInflateGate(3)
    try {
      await using(binary, async (f) => {
        const before = state(f), pending = observed(f.load('success.bmp'))
        await withGate(gate, async () => {
          await entered(gate.entered, pending)
          pixels(f, 5, 17, () => true, (_x, y) => 64 + y * 4)
          const layer = f.layers.get(f.id), bitmap = f.layers.bitmap(f.id)
          assert.deepEqual([layer.width, layer.height, layer.imageLeft, layer.imageTop], [3,2,-2,-1])
          assert.deepEqual(bitmap.clip, { x: 0, y: 0, width: 5, height: 17 })
          assert.equal(layer.imageModified, true)
          assert.deepEqual([layer.province?.width, layer.province?.height, layer.province?.data[0]], [5,17,91])
          assert.notEqual(layer.province, before.province)
          assert.equal(f.frames.length, before.frames, 'no display clamp and no final Update before province completes')
          gate.release()
          assert.deepEqual(await within(pending, 'province completion'), { status: 'fulfilled', value: 'null:' })
          assert.equal(await f.session.evaluate('partialLayer.getProvincePixel(0,0)+","+partialLayer.getProvincePixel(1,0)+","+partialLayer.getProvincePixel(4,16)'), '7,19,7')
          assert.equal(f.session.snapshot().imageCacheEntries, 2)
          assert.deepEqual(['success.bmp', 'success_m.bmp', 'success_p.png'].map((name) => f.reads.get(name)), [1,1,1])
          assert(f.frames.length > before.frames)
        })
      }, { inflateImage: gate.inflate })
    } finally { gate.release() }
  })
  test(`${mode}: pausing during real PNG inflation retains the sized blank main until resume publishes rows`, { timeout: 60000 }, async () => {
    const gate = pngInflateGate(357)
    try {
      await using(binary, async (f) => {
        const before = state(f), pending = observed(f.load('pending.png'))
        await withGate(gate, async () => {
          await entered(gate.entered, pending)
          pixels(f, 5, 17, () => false)
          retainedState(f, before)
          f.session.pause(); gate.release()
          await within(gate.drain(), 'paused native inflate completion')
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          assert.equal(f.session.snapshot().state, 'paused')
          pixels(f, 5, 17, () => false)
          f.session.resume()
          assert.deepEqual(await within(pending, 'resumed main load'), { status: 'fulfilled', value: 'null:' })
          pixels(f, 5, 17, () => true)
          assert.equal(f.layers.get(f.id).province, undefined)
        }, () => { if (f.session.snapshot().state === 'paused') f.session.resume() })
      }, { inflateImage: gate.inflate })
    } finally { gate.release() }
  })
  test(`${mode}: Stop abandons a real suspended PNG without publishing late rows or restoring its retired cache`, { timeout: 60000 }, async () => {
    const gate = pngInflateGate(357)
    try {
      await using(binary, async (f) => {
        const pending = observed(f.session.evaluate('(partialLoad("pending.png"),Debug.message("partial-after-stop"),0)'))
        await withGate(gate, async () => {
          await entered(gate.entered, pending)
          const bitmap = f.layers.bitmap(f.id), blank = [...bitmap.pixels.data]
          pixels(f, 5, 17, () => false)
          await within(f.session.stop(), 'Stop before the underlying inflate gate is released')
          assert.equal(f.session.snapshot().state, 'stopped')
          assert.equal(f.session.snapshot().bitmapBytes, 0)
          assert.equal(f.layers.has(f.id), false)
          const outcome = await within(pending, 'cancelled TJS load')
          assert.equal(outcome.status, 'rejected')
          if (outcome.status === 'rejected') {
            assert(outcome.reason instanceof Error)
            assert.equal(outcome.reason.name, 'AbortError')
            assert.equal(outcome.reason.message, 'Execution cancelled')
          }
          gate.release(); await within(gate.drain(), 'late native inflate completion')
          await new Promise<void>((resolve) => setTimeout(resolve, 0))
          assert.deepEqual([...bitmap.pixels.data], blank)
          assert.equal(f.session.snapshot().imageCacheEntries, 0)
          assert.equal(f.session.snapshot().imageCacheResidentBytes, 0)
          assert.equal(f.layers.has(f.id), false)
          assert.equal(f.logs.includes('partial-after-stop'), false)
        })
      }, { inflateImage: gate.inflate })
    } finally { gate.release() }
  })
  test(`${mode}: a host bitmap write while PNG inflation is pending invalidates that destination and is not overwritten by late decoded rows`, { timeout: 60000 }, async () => {
    const gate = pngInflateGate(357)
    try {
      await using(binary, async (f) => {
        const before = state(f), pending = observed(f.load('pending.png'))
        await withGate(gate, async () => {
          await entered(gate.entered, pending)
          const bitmap = f.layers.bitmap(f.id)
          bitmap.setPixel(1, 1, 0xabcdef, 'main')
          const written = [...bitmap.pixels.data]
          gate.release()
          assert.deepEqual(await within(pending, 'revoked image destination'), {
            status: 'fulfilled', value: 'failed:Image load destination changed',
          })
          await within(gate.drain(), 'revoked decoder drain')
          assert.equal(f.layers.bitmap(f.id), bitmap)
          assert.deepEqual([...bitmap.pixels.data], written)
          retainedState(f, before)
          assert.equal(bitmap.getPixel(1, 1, 'main'), 0xabcdef)
        })
      }, { inflateImage: gate.inflate })
    } finally { gate.release() }
  })
}
