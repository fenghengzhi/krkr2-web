import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { ImageCache } from '../../src/engine/storage/image-cache.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { SceneComposer } from '../../src/engine/scene/composer.ts'
import { ExecutionCancelled } from '../../src/engine/scheduler/control.ts'
import type { DecodedImage, FontSpec, GraphicsDecoder, LoadedFont } from '../../src/engine/ports/graphics.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'

function gate<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((yes) => { resolve = yes })
  return { promise, resolve }
}
async function finish<T>(work: Generator<void, T>): Promise<T> {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
const font: FontSpec = { face: 'a.ttf', faceIsFileName: true, height: 18, angle: 0,
  bold: false, italic: false, underline: false, strikeout: false }
const file = (name: string): Resource => ({ name, size: 1, cacheToken: {}, read: async () => new Uint8Array([7]) })

test('image compaction keeps pending decode capacity and readers but prevents late cache refill', { timeout: 30000 }, async () => {
  const ready = gate<DecodedImage>(), entered = gate<void>(), resource = file('image.png')
  let calls = 0
  const cache = new ImageCache(async () => { calls++; entered.resolve(); return ready.promise })
  const first = cache.read(resource)
  await entered.promise
  cache.compact()
  assert.equal(cache.snapshot().imageCachePending, 1)
  const joined = cache.read(resource)
  ready.resolve({ width: 1, height: 1, data: new Uint8Array([11,22,33,44]) })
  const [a, b] = await Promise.all([first, joined])
  assert.equal(calls, 1)
  assert.notEqual(a.data, b.data)
  assert.deepEqual([...a.data], [11,22,33,44])
  a.data[0] = 99
  assert.equal(b.data[0], 11)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
  assert.equal(cache.snapshot().imageCachePending, 0)
  await cache.read(resource)
  assert.equal(calls, 2)
  assert.equal(cache.snapshot().imageCacheEntries, 1)
  cache.dispose()
})

test('font compaction releases idle faces and pins an active raster until its final yield', { timeout: 30000 }, async () => {
  const files = new Map(['a.ttf','b.ttf'].map((name) => [name, file(name)])),
    active = new Set<string>(), released: string[] = [], compactErrors: unknown[] = []
  let loaded = 0, hold = false, cancelled = false, entered = gate<void>(), release = gate<void>()
  const graphics: GraphicsDecoder = {
    decode: async () => { throw new Error('unexpected image') }, text: () => { throw new Error('unexpected text raster') },
    loadFont: async () => {
      const face = 'face-' + ++loaded
      active.add(face)
      return { face, dispose() {
        assert(active.delete(face)); released.push(face)
        if (face === 'face-1') throw new Error('deferred compact cleanup failure')
      } }
    },
    measure: (_text, spec) => { assert(active.has(spec.face)); return { width: 9, height: 18 } },
  }, service = new FontService((name) => files.get(name)!, graphics, async (work) => {
    if (hold) { entered.resolve(); await release.promise }
    if (cancelled) throw new ExecutionCancelled()
    return finish(work)
  }, (error) => { compactErrors.push(error) })
  try {
    await service.measure('A', font)
    await service.measure('B', { ...font, face: 'b.ttf' })
    hold = true
    const pending = service.measure('AA', font)
    await entered.promise
    service.compact(); service.compact()
    assert.deepEqual(released, ['face-2'])
    assert.deepEqual([...active], ['face-1'])
    hold = false; release.resolve()
    assert.deepEqual(await pending, { width: 18, height: 18 })
    assert.deepEqual(released, ['face-2','face-1'])
    assert.equal(compactErrors.length, 1)
    assert.match(String(compactErrors[0]), /deferred compact cleanup failure/)
    await service.measure('A', font)
    assert.equal(loaded, 3)
    entered = gate<void>(); release = gate<void>(); hold = true
    const stopped = service.measure('AA', font)
    await entered.promise
    service.compact(); service.dispose()
    assert.deepEqual([...active], ['face-3'])
    cancelled = true; hold = false; release.resolve()
    await assert.rejects(stopped, ExecutionCancelled)
    assert.equal(compactErrors.length, 1, 'Stop must retain cancellation, not turn it into a compact report')
  } finally { hold = false; release.resolve(); service.dispose() }
  assert.equal(active.size, 0)
})

test('font compaction during an unfinished face load lets its reader finish without retaining the late face', { timeout: 30000 }, async () => {
  const entered = gate<void>(), ready = gate<LoadedFont>(), resource = file('a.ttf')
  let loaded = 0, closed = 0
  const service = new FontService(() => resource, {
    decode: async () => { throw new Error('unexpected image') }, text: () => { throw new Error('unexpected text') },
    loadFont: async () => { if (++loaded === 1) { entered.resolve(); return ready.promise }
      return { face: 'new-face', dispose() { closed++ } } },
    measure: () => ({ width: 7, height: 18 }),
  }, finish)
  try {
    const pending = service.measure('A', font)
    await entered.promise
    service.compact()
    ready.resolve({ face: 'late-face', dispose() { closed++ } })
    assert.deepEqual(await pending, { width: 7, height: 18 })
    assert.equal(closed, 1)
    await service.measure('A', font)
    assert.equal(loaded, 2)
  } finally { service.dispose() }
  assert.equal(closed, 2)
})

test('compact preserves explicit prerendered mappings and live/composed pixel readers', { timeout: 30000 }, async () => {
  const data = new Uint8Array(readFileSync(new URL('../fixtures/font/coverage-v1.tft', import.meta.url))),
    service = new FontService(() => ({ name: 'mapped.tft', size: data.length, read: async () => data }), {
      decode: async () => { throw new Error('unexpected image') }, text: () => { throw new Error('mapping must survive') },
      measure: () => { throw new Error('mapping must survive') },
    }, finish), spec = { ...font, face: 'mapped', faceIsFileName: false }
  try {
    await service.map(spec, 'mapped.tft')
    const before = await service.measure('A', spec)
    service.compact()
    assert.deepEqual(await service.measure('A', spec), before)
  } finally { service.dispose() }
  const tree = new LayerTree(), root = tree.create(0), child = tree.create(root)
  tree.resize(root, 2, 1); tree.resize(child, 1, 1); tree.set(child, 'visible', 1)
  tree.fill(root, { x: 0, y: 0, width: 2, height: 1 }, 0xff112233)
  tree.fill(child, { x: 0, y: 0, width: 1, height: 1 }, 0xffabcdef)
  const composer = new SceneComposer(tree), held = composer.snapshot(root), live = tree.bitmap(child)
  composer.clear()
  const rebuilt = composer.snapshot(root)
  assert.notEqual(held.data, rebuilt.data)
  assert.deepEqual([...held.data], [171,205,239,255,17,34,51,255])
  assert.deepEqual(rebuilt, held)
  assert.equal(tree.bitmap(child), live)
})
