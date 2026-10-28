import test from 'node:test'
import assert from 'node:assert/strict'
import { ProcessedImageCache, autoImageCacheBytes, maximumImageCacheBytes,
  type ProcessedImage, type ProcessedImageRequest, type ProcessedImageObservations } from '../../src/engine/storage/processed-image-cache.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'

function request(name = 'a', changes: Partial<ProcessedImageRequest> = {}): ProcessedImageRequest {
  return { name, key: 0x1fffffff, mode: 'normal', width: 0, height: 0, ...changes }
}
function image(mode: ProcessedImage['mode'] = 'normal', value = 7, width = 1, height = 1): ProcessedImage {
  return { mode, width, height, data: new Uint8Array(width * height * (mode === 'normal' ? 4 : 1)).fill(value) }
}
function resource(name: string): Resource {
  return { name, size: 1, cacheToken: {}, async read() { throw new Error('Cache observations must not read bytes') } }
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

test('processed hits precede every processor/lookup and preserve all five native key components', { timeout: 30_000 }, async () => {
  const seen: ProcessedImageRequest[] = [], cache = new ProcessedImageCache((value) => {
    seen.push(value)
    return image(value.mode, seen.length, 3, 3)
  })
  const requests = [request('art/a'), request('art/a.png'), request('art/a', { key: 0 }),
    request('art/a', { mode: 'grayscale' }), request('art/a', { width: 1 }), request('art/a', { height: 1 })]
  for (const value of requests) await cache.read(value)
  assert.equal(seen.length, 6)
  for (let i = 0; i < requests.length; i++) assert.equal((await cache.read({ ...requests[i]! })).data[0], i + 1)
  assert.equal(seen.length, 6)
  assert.equal(cache.snapshot().imageCacheHits, 6)
  assert.equal(cache.snapshot().imageCacheEntries, 6)
  const signed = new ProcessedImageCache((value) => {
    assert.equal(value.key, 0xffffffff)
    return image()
  })
  await signed.read(request('same', { key: -1 }))
  await signed.read(request('same', { key: 0xffffffff }))
  assert.equal(signed.snapshot().imageCacheMisses, 1)
  assert.equal(signed.snapshot().imageCacheHits, 1)
})

test('request snapshots and compact owned planes/metadata isolate processor and every consumer', { timeout: 30_000 }, async () => {
  const gate = deferred<ProcessedImage>(), backing = Buffer.alloc(1024, 7), metadata = new Map([['k', 'xy']]),
    value = { ...image(), data: backing.subarray(100, 104), metadata, provinceName: 'a_p.png', unrelated: resource('never') },
    mutable = { ...request() }, cache = new ProcessedImageCache((captured) => {
      assert.deepEqual(captured, request())
      assert.equal(Object.isFrozen(captured), true)
      return gate.promise
    }), first = cache.read(mutable), second = cache.read(request())
  mutable.name = 'different'; mutable.mode = 'palettized'; mutable.key = 0
  gate.resolve(value)
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.data.buffer.byteLength, 4)
  assert.equal('unrelated' in a, false)
  backing.fill(1); metadata.set('k', 'processor mutation')
  a.data.fill(2); a.metadata!.set('k', 'consumer mutation'); a.provinceName = 'changed'
  assert.deepEqual([...b.data], [7, 7, 7, 7])
  const hit = await cache.read(request())
  assert.deepEqual([...hit.data], [7, 7, 7, 7])
  assert.equal(hit.metadata!.get('k'), 'xy')
  assert.equal(hit.provinceName, 'a_p.png')
})

test('normal bitmap and real grayscale/palettized planes have independent logical and resident accounting', { timeout: 30_000 }, async () => {
  const plain = new ProcessedImageCache(() => image()), tagged = new ProcessedImageCache(() => ({
    ...image(), metadata: new Map([['k', 'xy']]), provinceName: 'a_p.png',
  }))
  await plain.read(request()); await tagged.read(request())
  assert.equal(plain.snapshot().imageCacheBytes, 4)
  assert.equal(tagged.snapshot().imageCacheBytes, 4)
  assert.equal(tagged.snapshot().imageCacheResidentBytes - plain.snapshot().imageCacheResidentBytes, 20)
  assert.ok(plain.snapshot().imageCacheResidentBytes > 4)
  const planes = new ProcessedImageCache((r) => image(r.mode, 9, 2, 3))
  for (const mode of ['normal', 'grayscale', 'palettized'] as const) {
    const output = await planes.read(request('pixels', { mode }))
    assert.equal(output.data.length, mode === 'normal' ? 24 : 6)
    assert.equal(output.data.buffer.byteLength, output.data.length)
    output.data.fill(0)
    assert.ok((await planes.read(request('pixels', { mode }))).data.every((value) => value === 9))
  }
  assert.equal(planes.snapshot().imageCacheBytes, 36)
})

test('native pre-insert LRU trims old overshoot; hits and touch do not trim or perform processing', { timeout: 30_000 }, async () => {
  const seen: string[] = [], cache = new ProcessedImageCache((r) => { seen.push(r.name); return image() })
  cache.setLimit(8)
  for (const name of ['a', 'b', 'c']) await cache.read(request(name))
  assert.equal(cache.snapshot().imageCacheBytes, 12)
  cache.touch(request('a')); cache.touch(request('absent'))
  assert.equal(cache.snapshot().imageCacheHits, 0)
  await cache.read(request('a'))
  assert.equal(cache.snapshot().imageCacheBytes, 12)
  await cache.read(request('d'))
  assert.equal(cache.snapshot().imageCacheBytes, 12)
  await cache.read(request('c'))
  await cache.read(request('b'))
  assert.deepEqual(seen, ['a', 'b', 'c', 'd', 'b'])
  cache.setLimit(8)
  assert.equal(cache.snapshot().imageCacheBytes, 8)
  cache.setLimit(3)
  assert.equal(cache.snapshot().imageCacheBytes, 0)
  await cache.read(request('one'))
  assert.equal(cache.snapshot().imageCacheBytes, 4)
  await cache.read(request('one'))
  assert.equal(cache.snapshot().imageCacheBytes, 4)
})

test('limits reset/clamp/disable without caching misses and reject invalid configuration atomically', { timeout: 30_000 }, async () => {
  let calls = 0
  const cache = new ProcessedImageCache(() => { calls++; return image() })
  assert.equal(cache.limit, autoImageCacheBytes)
  cache.setLimit(Number.MAX_SAFE_INTEGER)
  assert.equal(cache.limit, maximumImageCacheBytes)
  for (const invalid of [-2, 0.5, NaN, Infinity]) {
    assert.throws(() => cache.setLimit(invalid), /Invalid/)
    assert.equal(cache.limit, maximumImageCacheBytes)
  }
  cache.setLimit(-1)
  assert.equal(cache.limit, autoImageCacheBytes)
  await cache.read(request())
  cache.setLimit(0)
  await Promise.all([cache.read(request()), cache.read(request())])
  assert.equal(calls, 3)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
  assert.equal(cache.snapshot().imageCacheResidentBytes, 0)
})

test('resident hard ceiling counts metadata independently and oversized completed results are returned but not retained', { timeout: 30_000 }, async () => {
  const text = 'x'.repeat(16 * 1024 * 1024), calls: string[] = [],
    cache = new ProcessedImageCache((r) => { calls.push(r.name); return { ...image(), metadata: new Map([['m', text]]) } })
  cache.setLimit(maximumImageCacheBytes)
  await cache.read(request('a')); await cache.read(request('b'))
  // Pixels are only eight logical bytes, but two UTF-16 metadata payloads plus
  // names exceed the independent resident ceiling; exactly one can remain.
  assert.equal(cache.snapshot().imageCacheEntries, 1)
  assert.equal(cache.snapshot().imageCacheBytes, 4)
  assert.ok(cache.snapshot().imageCacheResidentBytes <= maximumImageCacheBytes)
  await cache.read(request('a'))
  assert.deepEqual(calls, ['a', 'b', 'a'])
  const huge = new ProcessedImageCache(() => ({ ...image('palettized'), metadata: new Map([['m', text + text + 'x']]) }))
  const returned = await huge.read(request('huge', { mode: 'palettized' }))
  assert.equal(returned.metadata!.get('m')!.length, 32 * 1024 * 1024 + 1)
  assert.equal(returned.data.length, 1)
  assert.equal(huge.snapshot().imageCacheEntries, 0)
  assert.equal(huge.snapshot().imageCacheResidentBytes, 0)
})

test('entry count has an independent hard limit even for tiny packed planes', { timeout: 30_000 }, async () => {
  let calls = 0
  const cache = new ProcessedImageCache(() => { calls++; return image('grayscale') })
  for (let i = 0; i < 4097; i++) await cache.read(request(String(i), { mode: 'grayscale' }))
  assert.equal(cache.snapshot().imageCacheEntries, 4096)
  assert.equal(cache.snapshot().imageCacheBytes, 4096)
  await cache.read(request('0', { mode: 'grayscale' }))
  assert.equal(calls, 4098)
  assert.equal(cache.snapshot().imageCacheEntries, 4096)
})

test('failure never caches; coalesced readers keep exact failure identity and can retry', { timeout: 30_000 }, async () => {
  const failed = deferred<ProcessedImage>(), error = new Error('actual decoder error')
  let calls = 0
  const cache = new ProcessedImageCache(() => ++calls === 1 ? failed.promise : image()),
    a = cache.read(request()), b = cache.read(request()),
    checks = [assert.rejects(a, (caught) => caught === error), assert.rejects(b, (caught) => caught === error)]
  failed.reject(error)
  await Promise.all(checks)
  assert.equal(calls, 1)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
  assert.equal(cache.snapshot().imageCachePending, 0)
  await cache.read(request())
  assert.equal(calls, 2)
})

test('clear detaches old publication but does not release the actual 64 pending operation budget', { timeout: 30_000 }, async () => {
  const gate = deferred<ProcessedImage>(), cache = new ProcessedImageCache(() => gate.promise),
    pending = Array.from({ length: 64 }, (_, i) => cache.read(request(String(i))))
  try {
    assert.equal(cache.snapshot().imageCachePending, 64)
    cache.clear()
    assert.equal(cache.snapshot().imageCachePending, 64)
    await assert.rejects(cache.read(request('overflow')), /Too many pending/)
  } finally { gate.resolve(image()); await Promise.all(pending) }
  assert.equal(cache.snapshot().imageCachePending, 0)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
  await cache.read(request('fresh'))
  assert.equal(cache.snapshot().imageCacheEntries, 1)
})

test('clear and namespace changes detach stale flights while compact can share work without republishing', { timeout: 30_000 }, async () => {
  for (const method of ['clear', 'namespaceChanged'] as const) {
    const old = deferred<ProcessedImage>(), fresh = deferred<ProcessedImage>()
    let calls = 0
    const cache = new ProcessedImageCache(() => ++calls === 1 ? old.promise : fresh.promise), first = cache.read(request())
    await Promise.resolve()
    cache[method]()
    const second = cache.read(request())
    fresh.resolve(image('normal', 9)); await second
    old.resolve(image('normal', 1)); await first
    assert.equal((await cache.read(request())).data[0], 9)
    assert.equal(calls, 2)
  }
  const gate = deferred<ProcessedImage>()
  let calls = 0
  const compact = new ProcessedImageCache(() => { calls++; return gate.promise }), one = compact.read(request())
  compact.compact()
  const two = compact.read(request())
  gate.resolve(image())
  const [a, b] = await Promise.all([one, two])
  a.data[0] = 0
  assert.equal(b.data[0], 7)
  assert.equal(calls, 1)
  assert.equal(compact.snapshot().imageCacheEntries, 0)
})

test('namespace changes preserve existing hits, while unrelated writes revoke pending publication only', { timeout: 30_000 }, async () => {
  const gate = deferred<ProcessedImage>()
  let broken = false, calls = 0
  const cache = new ProcessedImageCache((r) => {
    calls++
    if (broken) throw new Error('new corrupt AutoPath table')
    return r.name === 'pending' ? gate.promise : image()
  })
  await cache.read(request('old'))
  const pending = cache.read(request('pending'))
  await Promise.resolve()
  cache.invalidate('unrelated/save.log')
  gate.resolve(image()); await pending
  assert.equal(cache.snapshot().imageCacheEntries, 1)
  broken = true; cache.namespaceChanged()
  assert.equal((await cache.read(request('old'))).data[0], 7)
  assert.equal(calls, 2)
  await assert.rejects(cache.read(request('new')), /corrupt AutoPath/)
})

test('mutation index records actual/candidate/container names without I/O, including absent higher-priority companions', { timeout: 30_000 }, async () => {
  for (const changed of ['game://./pack.xp3>art/actual.png', 'PACK.XP3', 'elsewhere/HERO_M.PNG', 'new/hero_p.tlg6']) {
    let calls = 0
    const source = resource('pack.xp3>art/actual.png'), cache = new ProcessedImageCache((_r, observations) => {
      calls++
      observations.observe('game://./hero.png', source)
      observations.observe('game://./hero_m.png')
      observations.observe('game://./hero_p.tlg6')
      return image()
    })
    await cache.read(request('game://./hero'))
    cache.invalidate(changed)
    await cache.read(request('game://./hero'))
    assert.equal(calls, 2, changed)
  }
})

test('observation tokens cannot retain Resource capabilities or change a published dependency set', { timeout: 30_000 }, async () => {
  const source: Resource = { name: 'art/real.png', size: 1, async read() { throw new Error('must not read') } }
  Object.defineProperty(source, 'source', { get() { throw new Error('must not acquire bytes') } })
  let saved!: ProcessedImageObservations, calls = 0
  const cache = new ProcessedImageCache((_r, observations) => {
    calls++; saved = observations
    observations.observe('alias.png', source)
    observations.observe('alias.png', source)
    return image()
  })
  await cache.read(request())
  saved.observe('late.png', resource('late.png'))
  cache.invalidate('late.png')
  await cache.read(request())
  assert.equal(calls, 1)
  const inconsistent = new ProcessedImageCache((_r, observations) => {
    observations.observe('same.png', resource('same.png'))
    observations.observe('same.png', resource('same.png'))
    return image()
  })
  await inconsistent.read(request())
  assert.equal(inconsistent.snapshot().imageCacheEntries, 0)
})

test('dispose preserves already-owned late failures, rejects late success and prevents unstarted processors', { timeout: 30_000 }, async () => {
  for (const fails of [false, true]) {
    const gate = deferred<ProcessedImage>(), error = new Error('late inflate failed')
    let started = 0
    const cache = new ProcessedImageCache(() => { started++; return gate.promise }), pending = cache.read(request())
    await Promise.resolve()
    assert.equal(started, 1)
    cache.dispose()
    assert.equal(cache.snapshot().imageCachePending, 0)
    assert.equal(cache.snapshot().imageCacheResidentBytes, 0)
    const check = assert.rejects(pending, (caught) => fails ? caught === error : caught instanceof Error && /disposed/.test(caught.message))
    if (fails) gate.reject(error)
    else gate.resolve(image())
    await check
    await assert.rejects(cache.read(request()), /disposed/)
    assert.equal(cache.snapshot().imageCacheEntries, 0)
  }
  let started = false
  const cache = new ProcessedImageCache(() => { started = true; return image() }), pending = cache.read(request())
  cache.dispose()
  await assert.rejects(pending, /disposed/)
  assert.equal(started, false)
})

test('invalid completed mode/shape/metadata never publishes, and invalid request does not call its processor', { timeout: 30_000 }, async () => {
  for (const result of [image('grayscale'), { ...image(), data: new Uint8Array(3) },
    { ...image(), width: 0 }, { ...image(), metadata: new Map([['bad', 7]]) }]) {
    const cache = new ProcessedImageCache(() => result as ProcessedImage)
    await assert.rejects(cache.read(request()), /Invalid processed image/)
    assert.equal(cache.snapshot().imageCacheEntries, 0)
    assert.equal(cache.snapshot().imageCachePending, 0)
  }
  let called = false
  const cache = new ProcessedImageCache(() => { called = true; return image() })
  for (const changes of [{ width: -1 }, { height: 4097 }, { key: 0.5 }, { key: 0x100000000 }])
    await assert.rejects(cache.read(request('bad', changes)), /Invalid processed image request/)
  assert.equal(called, false)
  await assert.rejects(cache.read(request('too-small-output', { width: 2 })), /Invalid processed image/)
  assert.equal(cache.snapshot().imageCacheEntries, 0)
})
