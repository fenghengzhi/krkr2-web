import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate as nextTurn } from 'node:timers/promises'
import {
  CursorStorage, maximumCursorCacheBytes, maximumCursorCacheEntries, maximumCursorSourceBytes,
  maximumCursorPendingSourceBytes,
} from '../../src/engine/storage/cursors.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import type { CursorAsset } from '../../src/formats/cursor/index.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function asset(value = 1, sourceBytes = 1, imageCount = 1, width = 1, height = 1): CursorAsset {
  const pixels = width * height
  return {
    kind: 'cur', sequence: [0], rates: [1], durationJiffies: 1,
    sourceBytes, decodedBytes: pixels * 5 * imageCount, imageCount,
    frames: [{ images: Array.from({ length: imageCount }, () => ({
      width, height, data: new Uint8Array(pixels * 4).fill(value), andMask: new Uint8Array(pixels),
      depth: 32, encoding: 'dib' as const, mode: 'and-xor' as const, hotspot: { x: 0, y: 0 },
    })) }],
  }
}
function resource(name: string, value = 1): Resource {
  return { name, size: 1, cacheToken: {}, read: async () => Uint8Array.of(value) }
}
const alive = () => true
const empty = { cursorCacheEntries: 0, cursorCacheBytes: 0, cursorCachePending: 0 }

test('cursor path cache resolves every assignment and survives replacement, aliases and Layer retirement', async () => {
  const resources = new Map<string, Resource>(), lookups: string[] = [], published: number[] = []
  let reads = 0, decodes = 0, valid = true
  const original = resource('archive.xp3>ui/pointer.cur', 7)
  resources.set('short.cur', original)
  resources.set('other-alias.cur', original)
  const storage = new CursorStorage((name) => { lookups.push(name); return resources.get(name) },
    async (bytes) => { decodes++; return asset(bytes[0], bytes.length) }, () => {},
    (id) => published.push(id))
  resources.set('short.cur', { ...original, read: async () => { reads++; return original.read() } })
  assert.equal(await storage.load('short.cur', () => valid), 2)
  assert.equal(await storage.load('other-alias.cur', alive), 2)
  valid = false
  await assert.rejects(storage.load('short.cur', () => valid), /caller has expired/)
  assert.equal(storage.get(2)!.frames[0]!.images[0]!.data[0], 7)
  // Native cache ignores new content identity at an already loaded placed path.
  resources.set('short.cur', { ...resource(original.name, 99), size: maximumCursorSourceBytes + 1 })
  assert.equal(await storage.load('short.cur', alive), 2)
  resources.delete('short.cur')
  await assert.rejects(storage.load('short.cur', alive), /resource not found/)
  resources.set('short.cur', resource(original.name, 88))
  assert.equal(await storage.load('short.cur', alive), 2)
  resources.set('next.cur', resource('ui/next.cur', 9))
  assert.equal(await storage.load('next.cur', alive), 3)
  assert.equal(reads, 1)
  assert.equal(decodes, 2)
  assert.deepEqual(published, [2, 3])
  assert.deepEqual(lookups, ['short.cur', 'other-alias.cur', 'short.cur', 'short.cur', 'short.cur', 'next.cur'])
  assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 2, cursorCacheBytes: 10, cursorCachePending: 0 })
  storage.dispose()
  assert.equal(storage.get(2), undefined)
  assert.deepEqual(storage.snapshot(), empty)
})

test('cursor read, decode, publication and accounting failures do not consume cache identities', async () => {
  let phase: 'read' | 'decode' | 'publish' | 'accounting' | 'ready' = 'read'
  const stored = resource('fixed.cur')
  const storage = new CursorStorage(() => ({
    ...stored, read: async () => {
      if (phase === 'read') throw new Error('read-fault')
      return Uint8Array.of(1)
    },
  }), async () => {
    if (phase === 'decode') throw new Error('decode-fault')
    const decoded = asset()
    if (phase === 'accounting') decoded.decodedBytes = 1
    return decoded
  }, () => {}, () => { if (phase === 'publish') throw new Error('publish-fault') })
  for (const mode of ['read', 'decode', 'publish', 'accounting'] as const) {
    phase = mode
    await assert.rejects(storage.load('request.cur', alive), mode === 'accounting' ? /accounting mismatch/ : new RegExp(mode + '-fault'))
    assert.deepEqual(storage.snapshot(), empty)
    assert.equal(storage.get(2), undefined)
  }
  phase = 'ready'
  assert.equal(await storage.load('request.cur', alive), 2)
  storage.dispose()
})

test('cursor source limits check metadata before reading and actual bytes before decoding', async () => {
  let size = maximumCursorSourceBytes + 1, reads = 0, decodes = 0,
    bytes = Uint8Array.of(1)
  const storage = new CursorStorage(() => ({
    name: 'limited.cur', size, read: async () => { reads++; return bytes },
  }), async (input) => { decodes++; return asset(1, input.length) }, () => {}, () => {})
  for (const invalid of [maximumCursorSourceBytes + 1, NaN, -1, 0, 0.5]) {
    size = invalid
    await assert.rejects(storage.load('limited.cur', alive), /source byte budget/)
  }
  assert.equal(reads, 0)
  size = 1
  bytes = new Uint8Array(maximumCursorSourceBytes + 1)
  await assert.rejects(storage.load('limited.cur', alive), /source byte budget/)
  assert.equal(reads, 1)
  assert.equal(decodes, 0)
  assert.deepEqual(storage.snapshot(), empty)
  bytes = new Uint8Array(maximumCursorSourceBytes)
  size = bytes.length
  assert.equal(await storage.load('limited.cur', alive), 2)
  assert.equal(decodes, 1)
  storage.dispose()
})

test('a retired cursor caller after resource read cannot initiate decode or publish', async () => {
  const started = deferred<void>(), read = deferred<Uint8Array>()
  let valid = true, decoded = false, published = false
  const storage = new CursorStorage(() => ({
    name: 'slow.cur', size: 1, read: () => { started.resolve(); return read.promise },
  }), async () => { decoded = true; return asset() }, () => {}, () => { published = true })
  const pending = assert.rejects(storage.load('slow.cur', () => valid), /caller has expired/)
  await started.promise
  assert.equal(storage.snapshot().cursorCachePending, 1)
  valid = false
  read.resolve(Uint8Array.of(1))
  await pending
  assert.equal(decoded, false)
  assert.equal(published, false)
  assert.deepEqual(storage.snapshot(), empty)
  storage.dispose()
})

test('cursor read snapshots compact the actual source view before asynchronous decoding', async () => {
  const workspace = new Uint8Array(1024), started = deferred<void>(), resume = deferred<void>()
  workspace.set([7, 8, 9], 100)
  const storage = new CursorStorage(() => ({
    name: 'source-view.cur', size: 3, read: async () => workspace.subarray(100, 103),
  }), async (bytes) => {
    started.resolve()
    await resume.promise
    assert.equal(bytes.byteOffset, 0)
    assert.equal(bytes.buffer.byteLength, 3)
    assert.deepEqual([...bytes], [7, 8, 9])
    return asset(bytes[0], bytes.length)
  }, () => {}, () => {})
  const pending = storage.load('source-view.cur', alive)
  try {
    await started.promise
    workspace.fill(99)
    resume.resolve()
    assert.equal(await pending, 2)
    assert.equal(storage.get(2)!.sourceBytes, 3)
    assert.equal(storage.get(2)!.frames[0]!.images[0]!.data[0], 7)
    assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 1, cursorCacheBytes: 5, cursorCachePending: 0 })
  } finally {
    resume.resolve()
    storage.dispose()
    await pending.catch(() => {})
  }
})

test('concurrent cursor source reservations stop at 64 MiB and a failed read frees its reservation', async () => {
  const firstRead = deferred<Uint8Array>(), secondRead = deferred<Uint8Array>(), thirdRead = deferred<Uint8Array>(),
    firstStarted = deferred<void>(), secondStarted = deferred<void>(), thirdStarted = deferred<void>()
  const sources = new Map<string, Resource>([
    ['first', { name: 'first', size: maximumCursorSourceBytes, read: () => { firstStarted.resolve(); return firstRead.promise } }],
    ['second', { name: 'second', size: maximumCursorSourceBytes, read: () => { secondStarted.resolve(); return secondRead.promise } }],
    ['third', { name: 'third', size: maximumCursorSourceBytes, read: () => { thirdStarted.resolve(); return thirdRead.promise } }],
  ])
  assert.equal(maximumCursorSourceBytes * 2, maximumCursorPendingSourceBytes)
  let reads = 0
  const storage = new CursorStorage((name) => {
    const source = sources.get(name)
    return source && { ...source, read: () => { reads++; return source.read() } }
  }, async (bytes) => asset(bytes[0], bytes.length), () => {}, () => {})
  const first = assert.rejects(storage.load('first', alive), /read-fault/),
    second = storage.load('second', alive)
  await Promise.all([firstStarted.promise, secondStarted.promise])
  await assert.rejects(storage.load('third', alive), /pending source byte budget/)
  assert.equal(reads, 2, 'Over-budget source must not start its read')
  assert.equal(storage.snapshot().cursorCachePending, 2)
  firstRead.reject(new Error('read-fault'))
  await first
  const third = storage.load('third', alive)
  await thirdStarted.promise
  assert.equal(reads, 3)
  secondRead.resolve(Uint8Array.of(2))
  thirdRead.resolve(Uint8Array.of(3))
  assert.deepEqual(await Promise.all([second, third]), [2, 3])
  assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 2, cursorCacheBytes: 10, cursorCachePending: 0 })
  storage.dispose()
})

test('actual cursor read length cannot grow beyond the shared source reservation and failure permits retry', async () => {
  const heldA = deferred<Uint8Array>(), heldB = deferred<Uint8Array>(),
    startedA = deferred<void>(), startedB = deferred<void>()
  let decodes = 0
  const storage = new CursorStorage((name) => name === 'a'
    ? { name, size: maximumCursorSourceBytes, read: () => { startedA.resolve(); return heldA.promise } }
    : name === 'b'
      ? { name, size: maximumCursorSourceBytes - 1, read: () => { startedB.resolve(); return heldB.promise } }
      : { name, size: 1, read: async () => Uint8Array.of(1, 2) },
  async (bytes) => { decodes++; return asset(1, bytes.length) }, () => {}, () => {})
  const a = assert.rejects(storage.load('a', alive), /read-fault/),
    b = assert.rejects(storage.load('b', alive), /read-fault/)
  await Promise.all([startedA.promise, startedB.promise])
  // Metadata reservations fill exactly 64 MiB. Only two real bytes are read;
  // the extra byte must be rejected before decoder work, without large buffers.
  await assert.rejects(storage.load('growth', alive), /pending source byte budget/)
  assert.equal(decodes, 0)
  assert.equal(storage.snapshot().cursorCachePending, 2)
  heldA.reject(new Error('read-fault'))
  heldB.reject(new Error('read-fault'))
  await Promise.all([a, b])
  assert.deepEqual(storage.snapshot(), empty)
  assert.equal(await storage.load('growth', alive), 2)
  assert.equal(decodes, 1)
  storage.dispose()
})

test('shared cursor reads and decode keep each caller validity independent', async () => {
  const readStarted = deferred<void>(), read = deferred<Uint8Array>(), decodeStarted = deferred<void>(),
    decoded = deferred<CursorAsset>(), publications: number[] = []
  let firstValid = true, reads = 0, decodes = 0
  const storage = new CursorStorage(() => ({
    name: 'shared.cur', size: 1,
    read: () => { reads++; readStarted.resolve(); return read.promise },
  }), () => { decodes++; decodeStarted.resolve(); return decoded.promise }, () => {},
    (id) => publications.push(id))
  const first = assert.rejects(storage.load('alias-one', () => firstValid), /caller has expired/),
    second = storage.load('alias-two', alive)
  await readStarted.promise
  firstValid = false
  read.resolve(Uint8Array.of(1))
  await decodeStarted.promise
  assert.equal(storage.snapshot().cursorCachePending, 1)
  decoded.resolve(asset(17))
  await first
  assert.equal(await second, 2)
  assert.equal(reads, 1)
  assert.equal(decodes, 1)
  assert.deepEqual(publications, [2])
  assert.equal(storage.get(2)!.frames[0]!.images[0]!.data[0], 17)
  assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 1, cursorCacheBytes: 5, cursorCachePending: 0 })
  storage.dispose()
})

test('expired callers after shared decode leave no asset or ID unless another caller commits', async () => {
  const started = deferred<void>(), decoded = deferred<CursorAsset>()
  let valid = true, publications = 0
  const storage = new CursorStorage((name) => resource(name), async () => {
    started.resolve(); return decoded.promise
  }, () => {}, () => { publications++ })
  const first = assert.rejects(storage.load('gone.cur', () => valid), /caller has expired/),
    second = assert.rejects(storage.load('gone.cur', () => valid), /caller has expired/)
  await started.promise
  valid = false
  decoded.resolve(asset())
  await Promise.all([first, second])
  assert.equal(publications, 0)
  assert.deepEqual(storage.snapshot(), empty)
  assert.equal(await storage.load('new.cur', alive), 2)
  assert.equal(publications, 1)
  storage.dispose()
})

test('successful cursor publication consumes its ID even if the assigning Layer expires in publish', async () => {
  let valid = true
  const publications: number[] = [], storage = new CursorStorage((name) => resource(name),
    async (bytes) => asset(bytes[0]), () => {}, (id) => { publications.push(id); valid = false })
  await assert.rejects(storage.load('first.cur', () => valid), /caller has expired/)
  assert(storage.get(2), 'Successful publication is Session-owned even when its original setter cannot finish')
  assert.equal(await storage.load('first.cur', alive), 2)
  assert.equal(await storage.load('second.cur', alive), 3)
  assert.deepEqual(publications, [2, 3])
  assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 2, cursorCacheBytes: 10, cursorCachePending: 0 })
  storage.dispose()
})

test('cursor publication failure allows another concurrent valid caller to commit without duplicate decode', async () => {
  let decodes = 0, attempts = 0
  const published: number[] = [], storage = new CursorStorage(() => resource('shared.cur'), async () => {
    decodes++; return asset()
  }, () => {}, (id) => {
    if (++attempts === 1) throw new Error('publish-fault')
    published.push(id)
  })
  const first = assert.rejects(storage.load('first-alias', alive), /publish-fault/),
    second = storage.load('second-alias', alive)
  await first
  assert.equal(await second, 2)
  assert.equal(decodes, 1)
  assert.deepEqual(published, [2])
  assert.equal(storage.snapshot().cursorCachePending, 0)
  storage.dispose()
})

test('cursor disposal expires read/decode flights and cannot be reversed by delayed completion', async () => {
  for (const phase of ['read', 'decode'] as const) {
    const started = deferred<void>(), reading = deferred<Uint8Array>(), decoding = deferred<CursorAsset>()
    let publications = 0
    const storage = new CursorStorage(() => ({
      name: 'late.cur', size: 1, read: () => {
        if (phase === 'read') { started.resolve(); return reading.promise }
        return Promise.resolve(Uint8Array.of(1))
      },
    }), () => { started.resolve(); return decoding.promise }, () => {}, () => { publications++ })
    const pending = assert.rejects(storage.load('late.cur', alive), /disposed/)
    await started.promise
    storage.dispose()
    storage.dispose()
    assert.deepEqual(storage.snapshot(), empty)
    reading.resolve(Uint8Array.of(1))
    decoding.resolve(asset())
    await pending
    assert.equal(publications, 0)
    assert.equal(storage.get(2), undefined)
    assert.deepEqual(storage.snapshot(), empty)
    await assert.rejects(storage.load('again.cur', alive), /disposed/)
  }
  let storage!: CursorStorage
  storage = new CursorStorage((name) => resource(name), async () => asset(), () => {},
    () => storage.dispose())
  await assert.rejects(storage.load('dispose-in-publish.cur', alive), /disposed/)
  assert.deepEqual(storage.snapshot(), empty)
  assert.equal(storage.get(2), undefined)
})

test('cursor scheduler cancellation after decode cannot publish or poison a later valid load', async () => {
  const started = deferred<void>(), decode = deferred<CursorAsset>()
  let cancelled = false
  const publications: number[] = [], storage = new CursorStorage((name) => resource(name),
    () => { started.resolve(); return decode.promise },
    () => { if (cancelled) throw new Error('session-cancelled') }, (id) => publications.push(id))
  const pending = assert.rejects(storage.load('cancelled.cur', alive), /session-cancelled/)
  await started.promise
  cancelled = true
  decode.resolve(asset())
  await pending
  assert.deepEqual(storage.snapshot(), empty)
  cancelled = false
  assert.equal(await storage.load('retry.cur', alive), 2)
  assert.deepEqual(publications, [2])
  storage.dispose()
})

test('cursor cache owns compact copies rather than mutable decoder workspaces', async () => {
  const workspace = new Uint8Array(1024), decoded = asset()
  workspace.set([10, 20, 30, 255], 101)
  decoded.frames[0]!.images[0]!.data = workspace.subarray(101, 105)
  decoded.frames[0]!.images[0]!.andMask = workspace.subarray(500, 501)
  const storage = new CursorStorage((name) => resource(name), async () => decoded, () => {}, () => {})
  assert.equal(await storage.load('view.cur', alive), 2)
  workspace.fill(99)
  decoded.sequence[0] = 99
  decoded.frames[0]!.images[0]!.hotspot.x = 99
  const stored = storage.get(2)!, image = stored.frames[0]!.images[0]!
  assert.deepEqual([...image.data], [10, 20, 30, 255])
  assert.deepEqual([...image.andMask], [0])
  assert.equal(image.data.buffer.byteLength, 4)
  assert.equal(image.andMask.buffer.byteLength, 1)
  assert.deepEqual(stored.sequence, [0])
  assert.deepEqual(image.hotspot, { x: 0, y: 0 })
  assert.equal(storage.snapshot().cursorCacheBytes, 5)
  storage.dispose()
})

test('cursor cache asset ceiling preserves every previous numeric ID without eviction', async () => {
  let decodes = 0
  const storage = new CursorStorage((name) => resource(name),
    async () => { decodes++; return asset() }, () => {}, () => {})
  for (let i = 0; i < maximumCursorCacheEntries; i++)
    assert.equal(await storage.load('cursor-' + i, alive), i + 2)
  await assert.rejects(storage.load('overflow.cur', alive), /asset count budget/)
  assert.equal(decodes, maximumCursorCacheEntries)
  assert.equal(await storage.load('cursor-0', alive), 2)
  assert(storage.get(2))
  assert(storage.get(257))
  assert.equal(storage.get(258), undefined)
  assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 256, cursorCacheBytes: 1280, cursorCachePending: 0 })
  storage.dispose()
})

test('cursor cache decoded-byte ceiling rejects the new asset without evicting or consuming its ID', async () => {
  const large = asset(1, 1, 64, 256, 256), medium = asset(2, 1, 16, 256, 256),
    storage = new CursorStorage((name) => resource(name, name === 'small' ? 3 : name === 'overflow' ? 2 : 1),
      async (bytes) => bytes[0] === 3 ? asset() : bytes[0] === 2 ? medium : large, () => {}, () => {})
  for (const name of ['large-a', 'large-b', 'large-c']) await storage.load(name, alive)
  assert.equal(storage.snapshot().cursorCacheBytes, 60 * 1024 * 1024)
  assert(large.decodedBytes * 3 + medium.decodedBytes > maximumCursorCacheBytes)
  await assert.rejects(storage.load('overflow', alive), /decoded cache byte budget/)
  assert.equal(storage.snapshot().cursorCacheEntries, 3)
  assert.equal(storage.snapshot().cursorCacheBytes, 60 * 1024 * 1024)
  assert.equal(await storage.load('small', alive), 5)
  assert(storage.get(2))
  assert(storage.get(3))
  assert(storage.get(4))
  assert.equal(storage.get(6), undefined)
  storage.dispose()
  assert.deepEqual(storage.snapshot(), empty)
})

test('cursor decoding has one active workspace and follows ready-source order without blocking parallel reads', async () => {
  const firstRead = deferred<Uint8Array>(), reads = [deferred<void>(), deferred<void>(), deferred<void>()],
    starts = [deferred<void>(), deferred<void>(), deferred<void>()],
    releases = [deferred<void>(), deferred<void>(), deferred<void>()], order: number[] = []
  let active = 0, peak = 0
  const storage = new CursorStorage((name) => {
    const value = Number(name)
    return { name, size: 1, read: async () => {
      reads[value - 1]!.resolve()
      return value === 1 ? firstRead.promise : Uint8Array.of(value)
    } }
  }, async (bytes) => {
    const value = bytes[0]!
    active++
    peak = Math.max(peak, active)
    order.push(value)
    starts[value - 1]!.resolve()
    try { await releases[value - 1]!.promise; return asset(value) }
    finally { active-- }
  }, () => {}, () => {})
  const pending = [storage.load('1', alive), storage.load('2', alive), storage.load('3', alive)],
    settled = Promise.allSettled(pending)
  try {
    await Promise.all(reads.map((read) => read.promise))
    await starts[1]!.promise
    await nextTurn()
    assert.deepEqual(order, [2])
    assert.equal(storage.snapshot().cursorCachePending, 3)
    firstRead.resolve(Uint8Array.of(1))
    await nextTurn()
    assert.deepEqual(order, [2], 'Ready jobs must not expand while another decoder is held')
    releases[1]!.resolve()
    await starts[2]!.promise
    assert.deepEqual(order, [2, 3], 'The earlier slow read does not overtake an already ready source')
    releases[2]!.resolve()
    await starts[0]!.promise
    releases[0]!.resolve()
    assert.deepEqual(await Promise.all(pending), [4, 2, 3])
    assert.equal(peak, 1)
    assert.equal(active, 0)
    assert.equal(storage.snapshot().cursorCachePending, 0)
  } finally {
    firstRead.resolve(Uint8Array.of(1))
    for (const release of releases) release.resolve()
    storage.dispose()
    await settled
  }
})

test('queued cursor work skips retired owners while retaining live and newly joined readers of the same path', async () => {
  const started = deferred<void>(), release = deferred<void>(), order: number[] = []
  let expired = true, sharedOld = true
  const storage = new CursorStorage((name) => resource(name.startsWith('shared') ? 'shared' : name,
    name === 'active' ? 1 : name === 'expired' ? 2 : 3), async (bytes) => {
    order.push(bytes[0]!)
    if (bytes[0] === 1) { started.resolve(); await release.promise }
    return asset(bytes[0])
  }, () => {}, () => {})
  const active = storage.load('active', alive), dead = assert.rejects(storage.load('expired', () => expired), /caller has expired/),
    old = assert.rejects(storage.load('shared-old', () => sharedOld), /caller has expired/)
  const settled = Promise.allSettled([active, dead, old])
  let joined: Promise<number> | undefined
  try {
    await started.promise
    await nextTurn()
    expired = sharedOld = false
    joined = storage.load('shared-new', alive)
    // Observe its rejection immediately too, without changing the assertion.
    void joined.catch(() => {})
    await nextTurn()
    release.resolve()
    assert.equal(await active, 2)
    await Promise.all([dead, old])
    assert.equal(await joined, 3)
    assert.deepEqual(order, [1, 3])
    assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 2, cursorCacheBytes: 10, cursorCachePending: 0 })
  } finally {
    release.resolve()
    storage.dispose()
    await settled
    await joined?.catch(() => {})
  }
})

test('a queued reader validity exception stays with its caller and cannot cancel another shared owner', async () => {
  const started = deferred<void>(), release = deferred<void>(), failure = new Error('owner-validity-fault')
  let failOwner = false, sharedDecodes = 0
  const storage = new CursorStorage((name) => resource(name === 'active' ? name : 'shared', name === 'active' ? 1 : 2),
    async (bytes) => {
      if (bytes[0] === 1) { started.resolve(); await release.promise }
      else sharedDecodes++
      return asset(bytes[0])
    }, () => {}, () => {})
  const active = storage.load('active', alive), broken = assert.rejects(storage.load('broken', () => {
    if (failOwner) throw failure
    return true
  }), (error) => error === failure), healthy = storage.load('healthy', alive),
    settled = Promise.allSettled([active, broken, healthy])
  try {
    await started.promise
    await nextTurn()
    failOwner = true
    release.resolve()
    await broken
    assert.equal(await active, 2)
    assert.equal(await healthy, 3)
    assert.equal(sharedDecodes, 1)
    assert.equal(storage.snapshot().cursorCachePending, 0)
  } finally { release.resolve(); storage.dispose(); await settled }
})

test('cursor disposal settles unfinished reads, queued work and active callers before external work returns', async () => {
  for (const outcome of ['resolve', 'reject'] as const) {
    const started = deferred<void>(), read = deferred<Uint8Array>(), decode = deferred<CursorAsset>(),
      readStarted = deferred<void>(), queuedRead = deferred<void>(), order: number[] = []
    let publications = 0, terminal = 0, latePixelsRead = 0
    const storage = new CursorStorage((name) => name === 'reading'
      ? { name, size: 1, read: () => { readStarted.resolve(); return read.promise } }
      : { name, size: 1, read: async () => {
        if (name === 'queued') queuedRead.resolve()
        return Uint8Array.of(name === 'active' ? 1 : 2)
      } }, (bytes) => { order.push(bytes[0]!); started.resolve(); return decode.promise },
    () => {}, () => { publications++ })
    const pending = ['active', 'queued', 'reading'].map((name) => storage.load(name, alive)),
      settled = Promise.allSettled(pending)
    for (const operation of pending) void operation.then(() => { terminal++ }, () => { terminal++ })
    try {
      await Promise.all([started.promise, queuedRead.promise, readStarted.promise])
      await nextTurn()
      assert.deepEqual(order, [1])
      storage.dispose()
      await nextTurn()
      assert.equal(terminal, 3, 'Stop cannot wait for an external read or decoder to settle')
      for (const result of await settled) {
        assert.equal(result.status, 'rejected')
        if (result.status === 'rejected') assert.match(String(result.reason), /disposed/)
      }
      assert.deepEqual(storage.snapshot(), empty)
      if (outcome === 'resolve') {
        const late = asset()
        Object.defineProperty(late, 'frames', { get() { latePixelsRead++; return [] } })
        decode.resolve(late)
        read.resolve(Uint8Array.of(3))
      } else {
        decode.reject(new Error('late-decode-fault'))
        read.reject(new Error('late-read-fault'))
      }
      await nextTurn()
      assert.equal(latePixelsRead, 0)
      assert.equal(publications, 0)
      assert.deepEqual(order, [1], 'A late active completion must never start retired queued work')
      assert.deepEqual(storage.snapshot(), empty)
    } finally {
      storage.dispose()
      read.resolve(Uint8Array.of(3))
      decode.resolve(asset())
      await settled
    }
  }
})

test('cursor decode reentry shares its installed flight and a failure releases the next ready job', async () => {
  const failure = new Error('decode-entry-fault'), order: number[] = []
  let storage!: CursorStorage, alias: Promise<number> | undefined, next: Promise<number> | undefined
  storage = new CursorStorage((name) => resource(name === 'next' ? 'next' : 'first', name === 'next' ? 2 : 1),
    (bytes) => {
      order.push(bytes[0]!)
      if (bytes[0] === 1) {
        alias = storage.load('alias', alive)
        next = storage.load('next', alive)
        void alias.catch(() => {})
        void next.catch(() => {})
        throw failure
      }
      return Promise.resolve(asset(bytes[0]))
    }, () => {}, () => {})
  try {
    await assert.rejects(storage.load('first', alive), (error) => error === failure)
    assert(alias)
    assert(next)
    await assert.rejects(alias, (error) => error === failure)
    assert.equal(await next, 2)
    assert.deepEqual(order, [1, 2])
    assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 1, cursorCacheBytes: 5, cursorCachePending: 0 })
  } finally {
    storage.dispose()
    await Promise.allSettled([alias, next])
  }
})

test('scheduler cancellation drains queued cursor callers and a later retry starts with a free permit', async () => {
  const started = deferred<void>(), release = deferred<void>(), cancellation = new Error('queue-cancelled'),
    order: number[] = []
  let cancelled = false
  const storage = new CursorStorage((name) => resource(name, name === 'active' ? 1 : 2), async (bytes) => {
    order.push(bytes[0]!)
    if (bytes[0] === 1) { started.resolve(); await release.promise }
    return asset(bytes[0])
  }, () => { if (cancelled) throw cancellation }, () => {})
  const active = assert.rejects(storage.load('active', alive), (error) => error === cancellation),
    queued = assert.rejects(storage.load('queued', alive), (error) => error === cancellation),
    settled = Promise.allSettled([active, queued])
  try {
    await started.promise
    await nextTurn()
    cancelled = true
    release.resolve()
    await Promise.all([active, queued])
    assert.deepEqual(order, [1])
    assert.deepEqual(storage.snapshot(), empty)
    cancelled = false
    assert.equal(await storage.load('retry', alive), 2)
    assert.deepEqual(order, [1, 2])
  } finally { release.resolve(); storage.dispose(); await settled }
})

test('a new valid caller cannot inherit an expired queued flight before its old readers unwind', async () => {
  const started = deferred<void>(), release = deferred<void>(), joined = deferred<void>(), order: number[] = []
  let expire = false, queued = false, reads = 0, fresh: Promise<number> | undefined
  const storage = new CursorStorage((name) => ({
    name, size: 1, read: async () => {
      if (name === 'retry') reads++
      return Uint8Array.of(name === 'active' ? 1 : 2)
    },
  }), async (bytes) => {
    order.push(bytes[0]!)
    if (bytes[0] === 1) { started.resolve(); await release.promise }
    return asset(bytes[0])
  }, () => {}, () => {})
  const active = storage.load('active', alive), old = assert.rejects(storage.load('retry', () => {
    if (!expire) return true
    if (!queued) {
      queued = true
      queueMicrotask(() => {
        fresh = storage.load('retry', alive)
        void fresh.catch(() => {})
        joined.resolve()
      })
    }
    return false
  }), /caller has expired/), settled = Promise.allSettled([active, old])
  try {
    await started.promise
    await nextTurn()
    expire = true
    release.resolve()
    await joined.promise
    await old
    assert(fresh)
    assert.equal(await fresh, 3)
    assert.equal(await active, 2)
    assert.equal(reads, 2, 'The new owner resolves and reads a new flight')
    assert.deepEqual(order, [1, 2], 'The expired flight never expands its pixels')
    assert.deepEqual(storage.snapshot(), { cursorCacheEntries: 2, cursorCacheBytes: 10, cursorCachePending: 0 })
  } finally {
    release.resolve()
    storage.dispose()
    await settled
    await fresh?.catch(() => {})
  }
})
