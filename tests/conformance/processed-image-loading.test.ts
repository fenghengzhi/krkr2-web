import test from 'node:test'
import assert from 'node:assert/strict'
import type { DecodedImage } from '../../src/engine/ports/graphics.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import type { ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { ImageLoader, ProvinceImageLoadError } from '../../src/engine/storage/images.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'

async function finish<T>(work: Generator<void, T>): Promise<T> {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
const image = (value: number, alpha = 255): DecodedImage => ({
  width: 1, height: 1, data: Uint8Array.of(value, value, value, alpha),
})
function copy(value: DecodedImage): DecodedImage {
  return { ...value, data: value.data.slice(), ...(value.indices ? { indices: value.indices.slice() } : {}),
    ...(value.metadata ? { metadata: new Map(value.metadata) } : {}) }
}
function fixture(initial: Record<string, DecodedImage>, options: {
  lookup?: (name: string, resource?: Resource) => Resource | undefined
  decode?: (name: string, selection: ImageDecodeSelection, value: DecodedImage) => Promise<DecodedImage>
  normalize?: (name: string) => string
} = {}) {
  const resources = new Map<string, Resource>(), values: Array<{ name: string; image: DecodedImage }> = [],
    lookups: string[] = [], reads: string[] = [], decodes: Array<{ name: string; mode: string }> = []
  let now = 0, cancelled: unknown
  const put = (name: string, value: DecodedImage, canonicalName = name) => {
    const id = values.length
    values.push({ name, image: value })
    const resource: Resource = { name: canonicalName, size: 1, cacheToken: {},
      async read() { reads.push(name); return Uint8Array.of(id) } }
    resources.set(name, resource)
    return resource
  }
  for (const [name, value] of Object.entries(initial)) put(name, value)
  const loader = new ImageLoader(
    (name) => { lookups.push(name); return options.lookup ? options.lookup(name, resources.get(name)) : resources.get(name) },
    async (bytes, selection) => {
      const entry = values[bytes[0]!]!
      decodes.push({ name: entry.name, mode: selection.mode })
      return options.decode ? options.decode(entry.name, selection, copy(entry.image)) : copy(entry.image)
    }, finish, { now: () => now, check() { if (cancelled !== undefined) throw cancelled }, yield: async () => {} },
    options.normalize,
  )
  return { loader, put, resources, lookups, reads, decodes, advance: (amount: number) => { now += amount },
    cancel: (cause: unknown) => { cancelled = cause } }
}

test('a processed normal hit repeats no existence, read, decode or companion operation and owns its metadata/pixels', async () => {
  const f = fixture({
    'scene.png': { ...image(20, 64), indices: Uint8Array.of(7), metadata: new Map([['tag', 'original']]) },
    'scene_m.png': image(128),
  })
  const first = await f.loader.load('scene.png', 0x04ffffff),
    before = { lookups: f.lookups.length, reads: f.reads.length, decodes: f.decodes.length }
  assert.deepEqual([...first.image.data], [137, 137, 137, 255])
  assert.equal(first.image.indices, undefined)
  first.image.data.fill(0); first.image.metadata!.set('tag', 'mutated')
  const second = await f.loader.load('scene.png', 0x04ffffff)
  assert.deepEqual([...second.image.data], [137, 137, 137, 255])
  assert.equal(second.image.metadata!.get('tag'), 'original')
  assert.deepEqual({ lookups: f.lookups.length, reads: f.reads.length, decodes: f.decodes.length }, before)
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
  assert.equal(f.loader.snapshot().imageCacheBytes, 4)
  assert.ok(f.loader.snapshot().imageCacheResidentBytes > 4)
})

test('normalized request spelling, color key and mode each define separate processed entries', async () => {
  const f = fixture({ 'a.png': { ...image(7), indices: Uint8Array.of(3) } })
  f.resources.set('alias.png', f.resources.get('a.png')!)
  for (let repeat = 0; repeat < 2; repeat++) {
    await f.loader.load('a.png', noColorKey)
    await f.loader.load('alias.png', noColorKey)
    assert.equal((await f.loader.load('a.png', 0x03000003)).image.data[3], 0)
    await f.loader.rule('a.png')
    assert.deepEqual([...(await f.loader.province('a.png', 1, 1))], [3])
  }
  assert.equal(f.decodes.length, 5)
  assert.equal(f.loader.snapshot().imageCacheEntries, 5)
  assert.equal(f.loader.snapshot().imageCacheBytes, 14)
})

test('grayscale rules retain packed bytes and requested dimensions even when requests produce identical larger output', async () => {
  const f = fixture({ 'rule.png': {
    width: 2, height: 1, data: Uint8Array.of(5, 5, 5, 255, 9, 9, 9, 255), grayscale: true,
  } })
  const expanded = await f.loader.rule('rule.png', 3, 2)
  assert.equal(expanded.width, 3); assert.equal(expanded.height, 2)
  assert.deepEqual([...expanded.data], [5, 5, 5, 255, 9, 9, 9, 255, 5, 5, 5, 255,
    5, 5, 5, 255, 9, 9, 9, 255, 5, 5, 5, 255])
  expanded.data.fill(0)
  assert.equal((await f.loader.rule('rule.png', 3, 2)).data[0], 5)
  await f.loader.rule('rule.png', 0, 0)
  await f.loader.rule('rule.png', 1, 1)
  assert.equal(f.decodes.length, 3)
  assert.equal(f.loader.snapshot().imageCacheBytes, 10) // 6 + 2 + 2 native bytes, not 40 RGBA bytes.
})

test('province tiling uses palette indices and caches each requested shape as an independent eight-bit plane', async () => {
  const f = fixture({ 'map.png': { width: 2, height: 1,
    data: Uint8Array.of(255, 0, 0, 0, 255, 0, 0, 255), indices: Uint8Array.of(2, 9) } })
  const first = await f.loader.province('map.png', 3, 2)
  assert.deepEqual([...first], [2, 9, 2, 2, 9, 2])
  first.fill(0)
  assert.deepEqual([...(await f.loader.province('map.png', 3, 2))], [2, 9, 2, 2, 9, 2])
  assert.deepEqual([...(await f.loader.province('map.png', 4, 1))], [2, 9, 2, 9])
  assert.equal(f.decodes.length, 2)
  assert.equal(f.loader.snapshot().imageCacheBytes, 10)
})

test('an oversized successfully decoded province remains cached even when the Layer size check rejects it', async () => {
  const f = fixture({ 'map.png': { width: 2, height: 1, data: new Uint8Array(8), indices: Uint8Array.of(2, 9) } })
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(f.loader.province('map', 1, 1), (error: unknown) => {
      assert.ok(error instanceof TvpError)
      assert.deepEqual(error.tvpMessage, { id: 'TVPProvinceSizeMismatch', args: ['map'] })
      return true
    })
  assert.equal(f.decodes.length, 1)
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
  assert.equal(f.loader.snapshot().imageCacheBytes, 2)
})

test('main processing failures do not leave source or mask entries behind', async () => {
  const f = fixture({ 'bad.png': image(7), 'bad_m.png': { width: 2, height: 1, data: new Uint8Array(8) } })
  for (let attempt = 0; attempt < 2; attempt++)
    await assert.rejects(f.loader.load('bad.png', noColorKey), (error: unknown) =>
      error instanceof TvpError && error.tvpMessage.id === 'TVPMaskSizeMismatch')
  assert.deepEqual(f.reads, ['bad.png', 'bad_m.png', 'bad.png', 'bad_m.png'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
  assert.equal(f.loader.snapshot().imageCacheBytes, 0)
})

test('cached normal results retain their discovered province name while its own failed pixel load retries separately', async () => {
  let fail = true
  const f = fixture({ 'a.png': image(20), 'a_p.bmp': { ...image(9), indices: Uint8Array.of(9) } }, {
    decode: async (name, _selection, value) => { if (name === 'a_p.bmp' && fail) throw new Error('bad province'); return value },
  })
  await assert.rejects(f.loader.load('a.png', noColorKey), (error: unknown) => error instanceof ProvinceImageLoadError)
  const mainQueries = f.lookups.filter((name) => name === 'a.png').length
  f.put('a_p.png', { ...image(2), indices: Uint8Array.of(2) })
  f.loader.namespaceChanged() // A changed search table keeps already completed normal hits.
  fail = false
  assert.deepEqual([...(await f.loader.load('a.png', noColorKey)).province!], [9])
  assert.equal(f.lookups.filter((name) => name === 'a.png').length, mainQueries)
  assert.equal(f.reads.includes('a_p.png'), false)
  assert.equal(f.loader.snapshot().imageCacheEntries, 2)
})

test('namespace changes preserve finished hits even when a subsequent storage lookup would fail', async () => {
  const cause = new Error('new corrupt archive')
  let fail = false
  const f = fixture({ 'a.png': image(7) }, { lookup(_name, resource) { if (fail) throw cause; return resource } })
  await f.loader.load('a.png', noColorKey)
  const before = f.lookups.length
  fail = true; f.loader.namespaceChanged()
  assert.equal((await f.loader.load('a.png', noColorKey)).image.data[0], 7)
  assert.equal(f.lookups.length, before)
  f.loader.clear()
  await assert.rejects(f.loader.load('a.png', noColorKey), (error: unknown) => error === cause)
})

test('generic save invalidation observes formerly missing higher-priority candidates without resolving a hit', async () => {
  const f = fixture({ 'scene.png': image(7) })
  assert.equal((await f.loader.load('scene', noColorKey)).image.data[0], 7)
  f.put('scene.tlg6', image(9))
  f.loader.invalidate('scene.tlg6')
  assert.equal((await f.loader.load('scene', noColorKey)).image.data[0], 9)
  assert.deepEqual(f.reads, ['scene.png', 'scene.tlg6'])
})

test('generic save invalidation revokes canonical mask dependencies and missing province observations', async () => {
  const f = fixture({ 'a.png': image(20), 'a_m.png': image(128) })
  f.put('a_m.png', image(128), 'patch.xp3>different-mask.png')
  assert.equal((await f.loader.load('a.png', noColorKey)).image.data[3], 128)
  f.put('a_m.png', image(64), 'patch.xp3>different-mask.png')
  f.loader.invalidate('patch.xp3')
  assert.equal((await f.loader.load('a.png', noColorKey)).image.data[3], 64)
  f.put('a_p.png', { ...image(9), indices: Uint8Array.of(9) })
  f.loader.invalidate('a_p.png')
  assert.deepEqual([...(await f.loader.load('a.png', noColorKey)).province!], [9])
})

test('TouchImages charges duplicate successful bitmaps and never charges mask storage separately', async () => {
  const f = fixture({ 'a.png': image(7), 'a_m.png': image(128), 'b.png': image(9) })
  await f.loader.touch(['a.png', 'a.png', 'b.png'], 8)
  assert.deepEqual(f.reads, ['a.png', 'a_m.png'])
  assert.equal(f.lookups.includes('b.png'), false)
  assert.equal(f.loader.snapshot().imageCacheBytes, 4)
})

test('failed preload outputs consume no bitmap allowance, and the following complete mask is still processed', async () => {
  const f = fixture({ 'bad.png': image(7), 'bad_m.png': { width: 2, height: 1, data: new Uint8Array(8) },
    'good.png': image(20), 'good_m.png': image(128), 'last.png': image(30) })
  await f.loader.touch(['bad.png', 'good.png', 'last.png'], 4)
  assert.deepEqual(f.reads, ['bad.png', 'bad_m.png', 'good.png', 'good_m.png'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
  assert.equal(f.loader.snapshot().imageCacheBytes, 4)
})

test('preload timeout is checked between complete images including their masks', async () => {
  let advance!: (amount: number) => void
  const f = fixture({ 'a.png': image(7), 'a_m.png': image(128), 'b.png': image(9) }, {
    decode: async (_name, _selection, value) => { advance(4); return value },
  })
  advance = f.advance
  await f.loader.touch(['a.png', 'b.png'], 0, 3)
  assert.deepEqual(f.reads, ['a.png', 'a_m.png'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
})

test('preload reverse retouch changes LRU only for surviving processed entries and performs no hidden reads', async () => {
  const f = fixture({ 'a.png': image(1), 'b.png': image(2), 'c.png': image(3), 'd.png': image(4) })
  f.loader.setLimit(8)
  await f.loader.touch(['a.png', 'b.png'], 8)
  await f.loader.load('c.png', noColorKey) // Native pre-insert trimming permits 12 logical bytes.
  assert.equal(f.loader.snapshot().imageCacheBytes, 12)
  await f.loader.load('d.png', noColorKey) // b was LRU after reverse retouch, so b is evicted.
  await f.loader.load('a.png', noColorKey)
  assert.deepEqual(f.reads, ['a.png', 'b.png', 'c.png', 'd.png'])
  await f.loader.load('b.png', noColorKey)
  assert.deepEqual(f.reads, ['a.png', 'b.png', 'c.png', 'd.png', 'b.png'])
})

test('reverse retouch never reloads an attempted image that disappeared during the preload pass', async () => {
  let clear!: () => void
  const f = fixture({ 'a.png': image(1), 'b.png': image(2), 'c.png': image(3) }, {
    decode: async (name, _selection, value) => { if (name === 'b.png') clear(); return value },
  })
  clear = () => f.loader.clear()
  await f.loader.touch(['a.png', 'b.png', 'c.png'])
  assert.deepEqual(f.reads, ['a.png', 'b.png', 'c.png'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
  await f.loader.load('a.png', noColorKey)
  assert.deepEqual(f.reads, ['a.png', 'b.png', 'c.png', 'a.png'])
})

test('reverse retouch includes the attempted failed prefix and preserves its normalization error boundary', async () => {
  const cause = new Error('invalid normalized request'), f = fixture({ 'good.png': image(7) }, {
    normalize(name) { if (name === 'bad') throw cause; return name },
  })
  await assert.rejects(f.loader.touch(['bad', 'good.png']), (error: unknown) => error === cause)
  assert.deepEqual(f.reads, ['good.png'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
})

test('a compact during a selected decode lets the reader finish without repopulating the processed cache', async () => {
  const entered = deferred<void>(), gate = deferred<DecodedImage>(),
    f = fixture({ 'a.png': image(7) }, { decode: async () => { entered.resolve(); return gate.promise } })
  const loading = f.loader.load('a.png', noColorKey)
  await entered.promise
  f.loader.compact()
  gate.resolve(image(7))
  assert.equal((await loading).image.data[0], 7)
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
  assert.equal(f.loader.snapshot().imageCachePending, 0)
})

test('dispose observes a late province failure without replacing its original cause or retaining finished main pixels', async () => {
  const entered = deferred<void>(), gate = deferred<DecodedImage>(), cause = new Error('late province failure'),
    f = fixture({ 'a.png': image(7), 'a_p.png': { ...image(9), indices: Uint8Array.of(9) } }, {
      decode: async (name, _selection, value) => { if (name === 'a_p.png') { entered.resolve(); return gate.promise }; return value },
    })
  const loading = f.loader.load('a.png', noColorKey), assertion = assert.rejects(loading, (error: unknown) => {
    assert.ok(error instanceof ProvinceImageLoadError)
    assert.equal(error.cause, cause)
    assert.deepEqual([...error.image.data], [7, 7, 7, 255])
    return true
  })
  await entered.promise
  f.loader.dispose()
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
  assert.equal(f.loader.snapshot().imageCachePending, 0)
  gate.reject(cause)
  await assertion
  assert.equal(f.loader.snapshot().imageCacheResidentBytes, 0)
})

test('cancellation during a finished-cache read still rejects without any resource work', async () => {
  const f = fixture({ 'a.png': image(7) }), cause = new Error('cancelled')
  await f.loader.load('a.png', noColorKey)
  const count = f.lookups.length
  f.cancel(cause)
  await assert.rejects(f.loader.load('a.png', noColorKey), (error: unknown) => error === cause)
  assert.equal(f.lookups.length, count)
})
