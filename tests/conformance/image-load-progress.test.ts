import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { ImageLoader, ProvinceImageLoadError, type ImageLoadDestination, type LoadedImage } from '../../src/engine/storage/images.ts'
import type { DecodedImage } from '../../src/engine/ports/graphics.ts'
import type { ImageDecodeProgress, ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { noColorKey } from '../../src/engine/graphics/loading.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { ProcessedImageCache, maximumImageCacheBytes } from '../../src/engine/storage/processed-image-cache.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 30000 }, run)
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function finish<T>(work: Generator<void, T>): Promise<T> {
  let step = work.next()
  while (!step.done) step = work.next()
  return step.value
}
function observed<T>(promise: Promise<T>) {
  return promise.then((value) => ({ status: 'fulfilled', value } as const),
    (reason: unknown) => ({ status: 'rejected', reason } as const))
}
const rgba = (r: number, alpha = 255) => Uint8Array.of(r, 20, 30, alpha)
const gray = (value: number) => Uint8Array.of(value, value, value, 255)
function bitmap(rows: Uint8Array[]): DecodedImage {
  return { width: rows[0]!.length / 4, height: rows.length, data: Uint8Array.from(rows.flatMap((row) => [...row])) }
}
function sink() {
  let width = 1, height = 1, data = rgba(99), completed = 0
  const events: string[] = []
  const target: ImageLoadDestination = {
    size(w, h) { width = w; height = h; data = new Uint8Array(w * h * 4); events.push('size') },
    row(y, row) { data.set(row, y * width * 4); events.push('row:' + y) },
    main(image) { width = image.width; height = image.height; data = new Uint8Array(image.data); completed++; events.push('main') },
  }
  return { target, events, pixels: () => [...data], dimensions: () => [width, height], completed: () => completed }
}
function fixture(decode: (name: string, selection: ImageDecodeSelection, progress: ImageDecodeProgress) => Promise<DecodedImage>,
  companions: string[] = [], read?: (name: string) => void, wait?: () => void | Promise<void>) {
  const names = ['a.png', ...companions], reads: string[] = [], calls: string[] = [],
    resources = new Map(names.map((name, index) => [name, { name, size: 1, cacheToken: {},
      async read() { reads.push(name); read?.(name); return Uint8Array.of(index) } }])),
    loader = new ImageLoader((name) => resources.get(name), async (bytes, selection, progress) => {
      const name = names[bytes[0]!]!; calls.push(name)
      return decode(name, selection, progress!)
    }, finish, { now: () => 0, check() {}, yield: async () => {}, ...(wait ? { wait } : {}) })
  return { loader, reads, calls }
}

test('a main error before size preserves the destination and the original failure identity', async () => {
  const cause = new Error('header'), target = sink(), f = fixture(async () => { throw cause })
  await assert.rejects(f.loader.load('a.png', noColorKey, target.target), (error) => error === cause)
  assert.deepEqual(target.events, [])
  assert.deepEqual(target.pixels(), [...rgba(99)])
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
})

test('same-size main recreation zeros unwritten rows and retains completed keyed rows after failure', async () => {
  const cause = new Error('second row'), target = sink(), f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 2); progress.row(0, rgba(7, 80)); throw cause
  })
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(f.loader.load('a.png', 0x07141e, target.target), (error) => error === cause)
    assert.deepEqual(target.pixels(), [...rgba(7, 0), 0, 0, 0, 0])
    assert.equal(target.completed(), 0)
  }
  assert.equal(f.reads.length, 2)
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
  assert.equal(f.loader.snapshot().imageCacheResidentBytes, 0)
})

test('a mask read failure preserves the keyed main and skips matting and province pixels', async () => {
  const cause = new Error('mask open'), target = sink(), f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 1); progress.row(0, rgba(7, 80)); return bitmap([rgba(7, 80)])
  }, ['a_m.png', 'a_p.png'], (name) => { if (name === 'a_m.png') throw cause })
  await assert.rejects(f.loader.load('a.png', 0x04ffffff, target.target), (error) => error === cause)
  assert.deepEqual(target.pixels(), [...rgba(7, 80)])
  assert.deepEqual(f.reads, ['a.png', 'a_m.png'])
  assert.equal(target.completed(), 0)
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
})

test('mask size validation happens in the callback before any mask row or final main stage', async () => {
  const target = sink(); let afterSize = false
  const f = fixture(async (name, _selection, progress) => {
    if (name === 'a.png') { progress.size(1, 1); progress.row(0, rgba(7)); return bitmap([rgba(7)]) }
    progress.size(2, 1); afterSize = true; return bitmap([new Uint8Array(8)])
  }, ['a_m.png'])
  await assert.rejects(f.loader.load('a.png', noColorKey, target.target), /mask size mismatch/)
  assert.equal(afterSize, false)
  assert.deepEqual(target.pixels(), [...rgba(7)])
  assert.equal(target.completed(), 0)
})

test('a failed mask retains only completed mask rows and preserves a non-Error cause', async () => {
  const cause = 'mask tail failed', target = sink(), f = fixture(async (name, _selection, progress) => {
    progress.size(1, 2)
    if (name === 'a.png') {
      progress.row(0, rgba(7, 80)); progress.row(1, rgba(9, 90)); return bitmap([rgba(7, 80), rgba(9, 90)])
    }
    progress.row(0, gray(33)); throw cause
  }, ['a_m.png'])
  await assert.rejects(f.loader.load('a.png', 0x04ffffff, target.target), (error) => error === cause)
  assert.deepEqual(target.pixels(), [...rgba(7, 33), ...rgba(9, 90)])
  assert.equal(target.completed(), 0)
  assert.equal(f.loader.snapshot().imageCacheEntries, 0)
})

test('adaptive keying waits for handler completion, while completed RGB rows are already keyed', async () => {
  const cause = new Error('tail'), adaptive = sink(), rgb = sink(), f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 1); progress.row(0, rgba(7, 80)); throw cause
  })
  await assert.rejects(f.loader.load('a.png', 0x01ffffff, adaptive.target), (error) => error === cause)
  await assert.rejects(f.loader.load('a.png', 0x07141e, rgb.target), (error) => error === cause)
  assert.deepEqual(adaptive.pixels(), [...rgba(7, 80)])
  assert.deepEqual(rgb.pixels(), [...rgba(7, 0)])
})

test('adaptive keying completes before a later companion lookup failure', async () => {
  const cause = new Error('mask open'), target = sink(), f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 1); progress.row(0, rgba(7, 80)); return bitmap([rgba(7, 80)])
  }, ['a_m.png'], (name) => { if (name === 'a_m.png') throw cause })
  await assert.rejects(f.loader.load('a.png', 0x01ffffff, target.target), (error) => error === cause)
  assert.deepEqual(target.pixels(), [...rgba(7, 0)])
})

test('palette keying uses source indices in completed rows even when colors are identical', async () => {
  const target = sink(), cause = new Error('palette tail'), row = Uint8Array.from([...rgba(7, 80), ...rgba(7, 90)]),
    f = fixture(async (_name, _selection, progress) => {
      progress.size(2, 1); progress.row(0, row, Uint8Array.of(3, 4)); throw cause
    })
  await assert.rejects(f.loader.load('a.png', 0x03000003, target.target), (error) => error === cause)
  assert.deepEqual(target.pixels(), [...rgba(7, 0), ...rgba(7, 255)])
})

test('an exact-flight join replays current partial pixels without re-reading and keeps the shared raw rejection', async () => {
  const entered = deferred<void>(), release = deferred<void>(), cause = new Error('late codec'), a = sink(), b = sink(),
    f = fixture(async (_name, _selection, progress) => {
      progress.size(1, 2); progress.row(0, rgba(7)); entered.resolve(); await release.promise; throw cause
    }), first = observed(f.loader.load('a.png', noColorKey, a.target))
  try {
    await entered.promise
    assert.equal(f.loader.snapshot().imageCacheResidentBytes, 8)
    const second = observed(f.loader.load('a.png', noColorKey, b.target))
    assert.deepEqual(b.pixels(), [...rgba(7), 0, 0, 0, 0])
    release.resolve()
    for (const result of await Promise.all([first, second])) {
      assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, cause)
    }
    assert.equal(f.reads.length, 1)
    assert.equal(f.loader.snapshot().imageCacheEntries, 0)
    assert.equal(f.loader.snapshot().imageCacheResidentBytes, 0)
  } finally { release.resolve(); await first; f.loader.dispose() }
})

test('one destination failure detaches that reader without changing another reader or cached pixels', async () => {
  const entered = deferred<void>(), release = deferred<void>(), cause = new Error('destination changed'), good = sink(),
    f = fixture(async (_name, _selection, progress) => {
      progress.size(1, 2); entered.resolve(); await release.promise
      progress.row(0, rgba(7)); progress.row(1, rgba(9)); return bitmap([rgba(7), rgba(9)])
    }), bad = observed(f.loader.load('a.png', noColorKey, { size() {}, row(_y, row) { row.fill(0); throw cause }, main() {} }))
  let second: Promise<PromiseSettledResult<LoadedImage>> | undefined
  try {
    await entered.promise
    second = observed(f.loader.load('a.png', noColorKey, good.target))
    release.resolve()
    const result = await bad
    assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, cause)
    assert.equal((await second).status, 'fulfilled')
    assert.deepEqual(good.pixels(), [...rgba(7), ...rgba(9)])
    assert.deepEqual([...(await f.loader.load('a.png', noColorKey)).image.data], good.pixels())
    assert.equal(f.reads.length, 1)
  } finally { release.resolve(); await bad; if (second) await second; f.loader.dispose() }
})

for (const action of ['clear', 'compact'] as const) {
  test(action + ' keeps live progress ownership while revoking completed cache publication', async () => {
    const entered = deferred<void>(), release = deferred<void>(), a = sink(), b = sink(),
      f = fixture(async (_name, _selection, progress) => {
        progress.size(1, 2); progress.row(0, rgba(7)); entered.resolve(); await release.promise
        progress.row(1, rgba(9)); return bitmap([rgba(7), rgba(9)])
      }), first = observed(f.loader.load('a.png', noColorKey, a.target))
    let second: Promise<unknown> | undefined
    try {
      await entered.promise; f.loader[action]()
      assert.equal(f.loader.snapshot().imageCachePending, 1)
      assert.equal(f.loader.snapshot().imageCacheResidentBytes, 8)
      if (action === 'compact') second = f.loader.load('a.png', noColorKey, b.target)
      release.resolve(); assert.equal((await first).status, 'fulfilled'); await second
      assert.deepEqual(a.pixels(), [...rgba(7), ...rgba(9)])
      if (action === 'compact') assert.deepEqual(b.pixels(), a.pixels())
      assert.equal(f.reads.length, 1)
      assert.equal(f.loader.snapshot().imageCacheEntries, 0)
    } finally { release.resolve(); await first; await second?.catch(() => {}); f.loader.dispose() }
  })
}

for (const outcome of ['resolve', 'reject'] as const) {
  test('dispose retires progress readers before a late codec ' + outcome, async () => {
    const entered = deferred<void>(), release = deferred<void>(), target = sink(), cause = new Error('late codec'),
      f = fixture(async (_name, _selection, progress) => {
        progress.size(1, 2); progress.row(0, rgba(7)); entered.resolve(); await release.promise
        if (outcome === 'reject') throw cause
        progress.row(1, rgba(9)); return bitmap([rgba(7), rgba(9)])
      }), pending = observed(f.loader.load('a.png', noColorKey, target.target))
    try {
      await entered.promise; f.loader.dispose(); const before = target.pixels()
      release.resolve(); const result = await pending
      assert.equal(result.status, 'rejected')
      if (result.status === 'rejected') {
        if (outcome === 'reject') assert.equal(result.reason, cause)
        else assert.match(String(result.reason), /disposed/)
      }
      assert.deepEqual(target.pixels(), before)
      assert.equal(target.completed(), 0)
      assert.equal(f.loader.snapshot().imageCacheResidentBytes, 0)
    } finally { release.resolve(); await pending; f.loader.dispose() }
  })
}

test('a completed cache hit commits only the main stage and performs no fake decoder progress', async () => {
  const target = sink(), f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 1); progress.row(0, rgba(7)); return bitmap([rgba(7)])
  })
  await f.loader.load('a.png', noColorKey)
  await f.loader.load('a.png', noColorKey, target.target)
  assert.deepEqual(target.events, ['main'])
  assert.deepEqual(target.pixels(), [...rgba(7)])
  assert.equal(f.reads.length, 1)
})

test('a paused cache read waits before replay or main publication without decoding the entry again', async () => {
  const entered = deferred<void>(), resume = deferred<void>(), target = sink()
  let paused = false
  const f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 1); progress.row(0, rgba(7)); return bitmap([rgba(7)])
  }, [], undefined, () => { if (paused) { entered.resolve(); return resume.promise } })
  await f.loader.load('a.png', noColorKey)
  paused = true
  const pending = observed(f.loader.load('a.png', noColorKey, target.target))
  try {
    await entered.promise
    assert.deepEqual(target.events, [])
    assert.equal(f.reads.length, 1)
    paused = false; resume.resolve()
    assert.equal((await pending).status, 'fulfilled')
    assert.deepEqual(target.events, ['main'])
    assert.equal(f.reads.length, 1)
  } finally { paused = false; resume.resolve(); await pending; f.loader.dispose() }
})

test('a bulk resource read may finish privately while paused but selected decoding waits for resume', async () => {
  const reading = deferred<void>(), bytes = deferred<Uint8Array>(), waiting = deferred<void>(), resume = deferred<void>(), target = sink()
  let paused = false, decodes = 0
  const loader = new ImageLoader((name) => name === 'a.bmp' ? { name, size: 1,
    async read() { reading.resolve(); return bytes.promise } } : undefined,
  async (_bytes, _selection, progress) => {
    decodes++; progress!.size(1, 1); progress!.row(0, rgba(7)); return bitmap([rgba(7)])
  }, finish, { now: () => 0, check() {}, yield: async () => {},
    wait: () => { if (paused) { waiting.resolve(); return resume.promise } } }),
    pending = observed(loader.load('a.bmp', noColorKey, target.target))
  try {
    await reading.promise; paused = true; bytes.resolve(Uint8Array.of(1)); await waiting.promise
    assert.equal(decodes, 0)
    assert.deepEqual(target.events, [])
    paused = false; resume.resolve()
    assert.equal((await pending).status, 'fulfilled')
    assert.equal(decodes, 1)
    assert.deepEqual(target.pixels(), [...rgba(7)])
  } finally { paused = false; bytes.resolve(Uint8Array.of(1)); resume.resolve(); await pending; loader.dispose() }
})

test('the main destination stage precedes the separate province attempt and retains its failure type', async () => {
  const target = sink(), cause = new Error('province'), f = fixture(async (name, _selection, progress) => {
    if (name === 'a_p.png') { assert.equal(target.completed(), 1); throw cause }
    progress.size(1, 1); progress.row(0, rgba(7)); return bitmap([rgba(7)])
  }, ['a_p.png'])
  await assert.rejects(f.loader.load('a.png', noColorKey, target.target), (error: unknown) =>
    error instanceof ProvinceImageLoadError && error.cause === cause)
  assert.equal(f.loader.snapshot().imageCacheEntries, 1)
  assert.deepEqual(target.pixels(), [...rgba(7)])
})

test('a destination main-stage rejection keeps its identity and does not start province I/O', async () => {
  const target = sink(), cause = new Error('destination retired'), f = fixture(async (_name, _selection, progress) => {
    progress.size(1, 1); progress.row(0, rgba(7)); return bitmap([rgba(7)])
  }, ['a_p.png'])
  await assert.rejects(f.loader.load('a.png', noColorKey, { ...target.target, main() { throw cause } }),
    (error) => error === cause)
  assert.deepEqual(f.reads, ['a.png'])
  assert.equal(f.loader.snapshot().imageCacheEntries, 1, 'The normal processed result succeeded before the consumer failed')
})

test('Layer partial callbacks preserve nonpixel state and lose authority after a host pixel write', async () => {
  const layers = new LayerTree(), id = layers.create(0), layer = layers.get(id)
  layers.resizeImage(id, 2, 2); layers.provinceImage(id, Uint8Array.of(1, 2, 3, 4))
  const old = layers.bitmap(id); old.setClip({ x: 1, y: 1, width: 1, height: 1 })
  layer.imageModified = false
  const province = layer.province, geometry = [layer.width, layer.height, layer.imageLeft, layer.imageTop], ticket = layers.beginImageLoad(id)
  assert.equal(layers.sizeImageLoad(ticket, 2, 2), true)
  assert.notEqual(layers.bitmap(id), old)
  assert.deepEqual([...layers.bitmap(id).pixels.data], Array(16).fill(0))
  assert.equal(layers.rowImageLoad(ticket, 0, Uint8Array.from([...rgba(7), ...rgba(9)])), true)
  assert.deepEqual(layers.bitmap(id).clip, { x: 1, y: 1, width: 1, height: 1 })
  assert.equal(layer.province, province)
  assert.equal(layer.imageModified, false)
  assert.deepEqual([layer.width, layer.height, layer.imageLeft, layer.imageTop], geometry)
  assert.equal(layers.setPixel(id, 1, 1, 0xabcdef, 'main'), true)
  const before = [...layers.bitmap(id).pixels.data]
  assert.equal(layers.rowImageLoad(ticket, 1, new Uint8Array(8)), false)
  assert.equal(layers.mainImageLoad(ticket, bitmap([rgba(0)])), false)
  assert.deepEqual([...layers.bitmap(id).pixels.data], before)
})

test('normal completion adjusts Layer geometry and old province before final success or province failure', async () => {
  const layers = new LayerTree(), id = layers.create(0), layer = layers.get(id)
  layers.resizeImage(id, 2, 2); layers.provinceImage(id, Uint8Array.of(1, 2, 3, 4))
  layers.bitmap(id).setClip({ x: 1, y: 1, width: 1, height: 1 }); layer.imageModified = false
  const ticket = layers.beginImageLoad(id), image = bitmap([rgba(7)])
  assert.equal(layers.mainImageLoad(ticket, image), true)
  assert.deepEqual([layer.width, layer.height], [1, 1])
  assert.deepEqual([...layer.province!.data], [1])
  assert.deepEqual(layers.bitmap(id).clip, { x: 0, y: 0, width: 1, height: 1 })
  assert.equal(layer.imageModified, true)
  assert.equal(layers.failImageLoadProvince(ticket), true)
  assert.equal(layer.province, undefined)
  assert.deepEqual([...layers.bitmap(id).pixels.data], [...rgba(7)])
})

test('pending progress participates in the shared 64 MiB resident bound and survives clear until settlement', async () => {
  const entered = deferred<void>(), release = deferred<void>(), cause = new Error('done'),
    cache = new ProcessedImageCache(async (request, observations) => {
      observations.progress.size(request.name === 'big' ? 4096 : 1, request.name === 'big' ? 4096 : 1)
      entered.resolve(); await release.promise; throw cause
    }), request = (name: string) => ({ name, key: noColorKey, mode: 'normal' as const, width: 0, height: 0 }),
    big = observed(cache.read(request('big')))
  try {
    await entered.promise; cache.clear()
    assert.equal(cache.snapshot().imageCacheResidentBytes, maximumImageCacheBytes)
    await assert.rejects(cache.read(request('small')), /64 MiB budget/)
    assert.equal(cache.snapshot().imageCachePending, 1)
    release.resolve(); const result = await big
    assert.equal(result.status, 'rejected'); if (result.status === 'rejected') assert.equal(result.reason, cause)
    assert.equal(cache.snapshot().imageCacheResidentBytes, 0)
  } finally { release.resolve(); await big; cache.dispose() }
})

test('successful progress transfers its buffer before cache publication without a double-owned resident peak', async () => {
  let cache!: ProcessedImageCache, original!: Uint8Array, calls = 0, scheduled = false,
    boundary: Promise<void> | undefined, late: Promise<PromiseSettledResult<Awaited<ReturnType<ProcessedImageCache['read']>>>> | undefined
  const snapshots: ReturnType<ProcessedImageCache['snapshot']>[] = [],
    request = { name: 'large', key: noColorKey, mode: 'normal' as const, width: 0, height: 0 }
  class ObservedMetadata extends Map<string, string> {
    override [Symbol.iterator]() {
      // payload validation/copy runs in the success handler. This microtask
      // executes after publication but before the flight's finally handler.
      if (!scheduled) {
        scheduled = true
        boundary = Promise.resolve().then(() => {
          snapshots.push(cache.snapshot())
          late = observed(cache.read(request))
        })
        void boundary.catch(() => {})
      }
      return super[Symbol.iterator]()
    }
  }
  cache = new ProcessedImageCache((_request, observations) => {
    calls++
    observations.progress.size(4096, 3072) // 48 MiB; two owned copies would exceed the 64 MiB bound.
    const image = observations.progress.image!
    original = image.data; original[0] = 7
    return { ...image, mode: 'normal', metadata: new ObservedMetadata([['key', 'value']]) }
  })
  try {
    const first = await cache.read(request)
    await boundary
    assert.equal(original.byteLength, 0, 'Transfer detaches every old producer view')
    assert.equal(snapshots.length, 1)
    assert.equal(snapshots[0]!.imageCachePending, 1, 'The observation preceded finally')
    assert.equal(snapshots[0]!.imageCacheEntries, 1)
    assert.ok(snapshots[0]!.imageCacheResidentBytes <= maximumImageCacheBytes)
    assert.ok(snapshots[0]!.imageCacheResidentBytes > 48 * 1024 * 1024)
    const second = await late!
    assert.equal(second.status, 'fulfilled')
    if (second.status === 'fulfilled') {
      assert.notEqual(first.data.buffer, second.value.data.buffer)
      first.data[0] = 99
      assert.equal(second.value.data[0], 7)
    }
    assert.equal(calls, 1)
  } finally { await boundary; if (late) await late; cache.dispose() }
})

test('synchronous disposal during live delivery or replay retires all remaining notifications without relabeling the codec failure', async () => {
  for (const phase of ['size', 'row', 'replay-size', 'replay-row'] as const) {
    const entered = deferred<void>(), release = deferred<void>(), cause = new Error('late original codec failure'), events: string[] = [],
      request = { name: 'retiring', key: noColorKey, mode: 'normal' as const, width: 0, height: 0 }
    let cache!: ProcessedImageCache, second: Promise<PromiseSettledResult<Awaited<ReturnType<ProcessedImageCache['read']>>>> | undefined
    cache = new ProcessedImageCache(async (_request, observations) => {
      observations.progress.size(1, 2)
      observations.progress.row(0, rgba(7))
      entered.resolve(); await release.promise
      observations.progress.row(1, rgba(9))
      throw cause
    })
    const replay = phase.startsWith('replay'), first = observed(cache.read(request, replay ? undefined : {
      size() { events.push('A:size'); if (phase === 'size') cache.dispose() },
      row(y) { events.push('A:row:' + y); if (phase === 'row') cache.dispose() },
    }))
    try {
      if (!replay) second = observed(cache.read(request, {
        size() { events.push('B:size') }, row(y) { events.push('B:row:' + y) },
      }))
      await entered.promise
      if (replay) second = observed(cache.read(request, {
        size() { events.push('replay:size'); if (phase === 'replay-size') cache.dispose() },
        row(y) { events.push('replay:row:' + y); if (phase === 'replay-row') cache.dispose() },
      }))
      const expected = phase === 'size' ? ['A:size'] : phase === 'row' ? ['A:size', 'B:size', 'A:row:0']
        : phase === 'replay-size' ? ['replay:size'] : ['replay:size', 'replay:row:0']
      assert.deepEqual(events, expected, phase)
      release.resolve()
      for (const result of await Promise.all([first, second!])) {
        assert.equal(result.status, 'rejected', phase)
        if (result.status === 'rejected') assert.equal(result.reason, cause, phase)
      }
      assert.deepEqual(events, expected, 'No later source row restores a retired receiver')
      assert.equal(cache.snapshot().imageCachePending, 0)
    } finally { release.resolve(); await first; if (second) await second; cache.dispose() }
  }
})
