import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ImageCache,
  autoImageCacheBytes,
  maximumImageCacheBytes,
} from '../../src/engine/storage/image-cache.ts'
import { ImageLoader } from '../../src/engine/storage/images.ts'
import { StorageResolver } from '../../src/engine/storage/resolver.ts'
import { SaveOverlay } from '../../src/engine/storage/save-overlay.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import type { DecodedImage } from '../../src/engine/ports/graphics.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'

const resource = (name: string, value = 1): Resource => ({
  name,
  cacheToken: {},
  size: 1,
  read: async () => Uint8Array.of(value),
})
const pixels = (value = 1): DecodedImage => ({
  width: 1,
  height: 1,
  data: Uint8Array.of(value, 2, 3, 64),
})
async function finish<T>(work: Generator<void, T>): Promise<T> {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
function loaderFixture() {
  const storage = new StorageResolver(),
    reads: string[] = []
  for (const name of ['a', 'b', 'c', 'd'])
    storage.mount([resource(name + '.png', name.charCodeAt(0))])
  let now = 0,
    cancelled = false,
    yields = 0
  const loader = new ImageLoader(
    (name) => {
      try {
        return storage.resolve(name)
      } catch {
        return undefined
      }
    },
    async (bytes) => {
      const name = String.fromCharCode(bytes[0]!)
      reads.push(name)
      now += 4
      return pixels(bytes[0])
    },
    finish,
    {
      now: () => now,
      check: () => {
        if (cancelled) throw new Error('Cancelled')
      },
      yield: async () => {
        yields++
      },
    },
  )
  return {
    loader,
    storage,
    reads,
    cancel: () => {
      cancelled = true
    },
    get yields() {
      return yields
    },
  }
}

test('decoded image LRU obeys payload bytes, resizing and disabled/automatic limits', async () => {
  const reads: string[] = [],
    cache = new ImageCache(async (r) => {
      reads.push(r.name)
      return pixels()
    })
  const a = resource('a'),
    b = resource('b'),
    c = resource('c')
  cache.setLimit(8)
  await cache.read(a)
  await cache.read(b)
  await cache.read(a)
  await cache.read(c)
  assert.deepEqual(reads, ['a', 'b', 'c'])
  await cache.read(a)
  await cache.read(b)
  assert.deepEqual(reads, ['a', 'b', 'c', 'b'])
  assert.equal(cache.snapshot().imageCacheBytes, 8)
  cache.setLimit(4)
  assert.equal(cache.snapshot().imageCacheEntries, 1)
  cache.setLimit(0)
  await cache.read(a)
  await cache.read(a)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
  assert.deepEqual(reads.slice(-2), ['a', 'a'])
  cache.setLimit(-1)
  assert.equal(cache.limit, autoImageCacheBytes)
  cache.setLimit(Number.MAX_SAFE_INTEGER)
  assert.equal(cache.limit, maximumImageCacheBytes)
  for (const invalid of [-2, 0.5, NaN, Infinity])
    assert.throws(() => cache.setLimit(invalid), /Invalid/)
  cache.setLimit(3)
  await cache.read(a)
  assert.equal(cache.snapshot().imageCacheBytes, 0)
})

test('cache payload accounting includes indices and tags; consumer mutations cannot poison it', async () => {
  const cache = new ImageCache(async () => ({
      ...pixels(),
      indices: Uint8Array.of(7),
      metadata: new Map([['k', 'xy']]),
    })),
    r = resource('a')
  const first = await cache.read(r)
  first.data.fill(0)
  first.indices![0] = 99
  first.metadata!.set('k', 'changed')
  const second = await cache.read(r)
  assert.deepEqual([...second.data], [1, 2, 3, 64])
  assert.equal(second.indices![0], 7)
  assert.equal(second.metadata!.get('k'), 'xy')
  assert.equal(cache.snapshot().imageCacheBytes, 11)
  cache.setLimit(10)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
  const invalid = new ImageCache(async () => ({ ...pixels(), indices: new Uint8Array(2) }))
  await assert.rejects(invalid.read(r), /Invalid decoded/)
  assert.equal(invalid.snapshot().imageCachePending, 0)
})

test('cache caps entry count even when tiny images fit the byte budget', async () => {
  let reads = 0
  const cache = new ImageCache(async () => {
      reads++
      return pixels()
    }),
    resources = Array.from({ length: 4097 }, (_, i) => resource(String(i)))
  for (const r of resources.slice(0, 4096)) await cache.read(r)
  cache.setLimit(-1)
  assert.equal(cache.snapshot().imageCacheEntries, 4096)
  await cache.read(resources[4096]!)
  await cache.read(resources[0]!)
  assert.equal(reads, 4098)
  assert.equal(cache.snapshot().imageCacheEntries, 4096)
})

test('concurrent reads coalesce, keep separate results and retry decoding failures', async () => {
  const gate = deferred<DecodedImage>(),
    r = resource('same')
  let reads = 0
  const cache = new ImageCache(async () => {
    reads++
    return gate.promise
  })
  const first = cache.read(r),
    second = cache.read({ ...r })
  await Promise.resolve()
  assert.equal(reads, 1)
  assert.equal(cache.snapshot().imageCachePending, 1)
  gate.resolve(pixels())
  const [a, b] = await Promise.all([first, second])
  a.data[0] = 0
  assert.equal(b.data[0], 1)
  let attempts = 0
  const failed = new ImageCache(async () => {
    if (++attempts === 1) throw new Error('Broken')
    return pixels()
  })
  await assert.rejects(failed.read(r), /Broken/)
  await failed.read(r)
  assert.equal(attempts, 2)
})

test('clear, invalidation and resource replacement cannot resurrect stale pending entries', async () => {
  for (const action of ['clear', 'invalidate'] as const) {
    const old = deferred<DecodedImage>(),
      fresh = deferred<DecodedImage>(),
      a = resource('same'),
      b = resource('same'),
      cache = new ImageCache((r) => (r === a ? old.promise : fresh.promise))
    const first = cache.read(a)
    if (action === 'clear') cache.clear()
    else cache.invalidate('same')
    const second = cache.read(b)
    old.resolve(pixels(1))
    await first
    assert.equal(cache.snapshot().imageCachePending, 1)
    assert.equal(cache.snapshot().imageCacheEntries, 0)
    fresh.resolve(pixels(9))
    await second
    assert.equal((await cache.read(b)).data[0], 9)
    assert.equal(cache.snapshot().imageCacheMisses, 2)
  }
  const gate = deferred<DecodedImage>(),
    cache = new ImageCache(() => gate.promise),
    pending = cache.read(resource('a'))
  cache.dispose()
  gate.resolve(pixels())
  await assert.rejects(pending, /disposed/)
  assert.equal(cache.snapshot().imageCacheBytes, 0)
  await assert.rejects(cache.read(resource('a')), /disposed/)
})

test('mounted and saved resource versions stay stable until replacement and preserve captured bytes', async () => {
  const storage = new StorageResolver(),
    a = resource('Art/a.png')
  storage.mount([a])
  storage.addAutoPath('Art')
  const before = storage.resolve('A.PNG')
  assert.equal(before, storage.resolve('Art/a.png'))
  assert.throws(() => storage.mount([resource('Art/a.png'), resource('../invalid')]))
  assert.equal(before, storage.resolve('a.png'))
  storage.mount([a])
  assert.notEqual(before.cacheToken, storage.resolve('a.png').cacheToken)
  const changed: string[] = [],
    overlay = new SaveOverlay(new MemorySaveStore(), (name) => changed.push(name))
  await overlay.initialize()
  overlay.write('save/a.png', Uint8Array.of(1))
  const saved = overlay.resource('SAVE/A.PNG')!
  assert.equal(saved, overlay.resource('save/a.png'))
  overlay.write('save/a.png', Uint8Array.of(2))
  assert.notEqual(saved.cacheToken, overlay.resource('save/a.png')!.cacheToken)
  assert.deepEqual([...(await saved.read())], [1])
  assert.deepEqual([...(await overlay.resource('save/a.png')!.read())], [2])
  const current = overlay.resource('save/a.png')
  assert.throws(() => overlay.write('save/a.png', new Uint8Array(64 * 1024 * 1024 + 1)), /budget/)
  assert.equal(current, overlay.resource('save/a.png'))
  assert.deepEqual(changed, ['save/a.png', 'save/a.png'])
})

test('preloading honors positive/negative/full budgets, duplicates and front-of-list priority', async () => {
  for (const limit of [8, -4, 0]) {
    const f = loaderFixture()
    f.loader.setLimit(12)
    await f.loader.touch(['a', 'a', 'b', 'c'], limit)
    assert.deepEqual(f.reads, limit === 0 ? ['a', 'b', 'c'] : ['a', 'b'])
    assert.equal(f.loader.snapshot().imageCacheBytes, limit === 0 ? 12 : 8)
    if (limit !== 0) {
      await f.loader.rule('c')
      await f.loader.rule('d')
      await f.loader.rule('a')
      assert.equal(f.reads.filter((n) => n === 'a').length, 1)
    }
  }
  const f = loaderFixture()
  f.loader.setLimit(8)
  await f.loader.touch(['a'], -8)
  assert.deepEqual(f.reads, [])
  f.loader.setLimit(0)
  await f.loader.touch(['a'])
  assert.deepEqual(f.reads, [])
  f.loader.setLimit(3)
  await f.loader.touch(['a', 'b'])
  assert.deepEqual(f.reads, ['a'])
  assert.equal(f.loader.snapshot().imageCacheBytes, 0)
})

test('preload timeout finishes the current image, ignores missing/broken images and checks cancellation', async () => {
  const f = loaderFixture()
  f.loader.setLimit(32)
  await f.loader.touch(['missing', 'a', 'b', 'c'], 0, 3)
  assert.deepEqual(f.reads, ['a'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
  await f.loader.touch(['missing', 'b', 'c'])
  assert.deepEqual(f.reads, ['a', 'b', 'c'])
  assert.ok(f.yields > 0)
  const broken = resource('broken.png')
  f.storage.mount([
    {
      ...broken,
      read: async () => {
        throw new Error('Broken file')
      },
    },
  ])
  await f.loader.touch(['broken', 'd'])
  await assert.rejects(f.loader.rule('broken'), /Broken file/)
  f.cancel()
  await assert.rejects(f.loader.touch(['a']), /Cancelled/)
  await assert.rejects(f.loader.touch(['a'], 0, -1), /Invalid/)
})

test('raw cache reuse preserves palette keys, companion updates and auto-path switches', async () => {
  const storage = new StorageResolver(),
    reads: number[] = [],
    decode = async (bytes: Uint8Array) => {
      const n = bytes[0]!
      reads.push(n)
      return { ...pixels(n), indices: Uint8Array.of(n) }
    }
  storage.mount([
    resource('base/a.png', 7),
    resource('patch/a.png', 9),
    resource('base/a_p.png', 4),
  ])
  storage.addAutoPath('base')
  const loader = new ImageLoader(
    (name) => {
      try {
        return storage.resolve(name)
      } catch {
        return undefined
      }
    },
    decode,
    finish,
    { now: () => 0, check() {}, yield: async () => {} },
  )
  await loader.touch(['a'])
  assert.deepEqual(reads, [7, 4])
  const keyed = await loader.load('a', 0x03000007)
  assert.equal(keyed.image.data[3], 0)
  keyed.image.indices![0] = 99
  const plain = await loader.load('A.PNG', noColorKey)
  assert.equal(plain.image.data[3], 64)
  assert.equal(plain.province![0], 4)
  storage.mount([resource('base/a_p.png', 5)])
  assert.equal((await loader.load('a', noColorKey)).province![0], 5)
  storage.addAutoPath('patch')
  assert.equal((await loader.load('a', noColorKey)).image.data[0], 9)
  storage.removeAutoPath('patch')
  assert.equal((await loader.load('a', noColorKey)).image.data[0], 7)
  assert.equal(reads.filter((n) => n === 7).length, 1)
})
