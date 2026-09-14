import test from 'node:test'
import assert from 'node:assert/strict'
import {
  HttpRangePool,
  HTTP_BLOCK_BYTES as B,
  remoteUrl,
} from '../../src/backends/files/http-range.ts'
import { MAX_RESOURCE_BYTES as MAX } from '../../src/engine/ports/storage.ts'
import { deferred, httpServer, until } from '../helpers/http-server.ts'

const URL = 'https://example.test/game.xp3'
function mock(total = B * 12 + 13) {
  const calls: RequestInit[] = []
  let transform: (response: Response, init: RequestInit) => Response | Promise<Response> = (
    response,
  ) => response
  const fetcher: typeof fetch = async (_input, init = {}) => {
    calls.push(init)
    const range = /^bytes=(\d+)-(\d+)$/.exec(new Headers(init.headers).get('range')!)!
    const start = Number(range[1]),
      end = Math.min(Number(range[2]), total - 1)
    const bytes = Uint8Array.from({ length: end - start + 1 }, (_, i) => (start + i) % 251)
    return transform(
      new Response(bytes, {
        status: 206,
        headers: {
          'Content-Range': `bytes ${start}-${end}/${total}`,
          ETag: '"v1"',
          'Content-Length': String(bytes.length),
        },
      }),
      init,
    )
  }
  return {
    calls,
    fetcher,
    transform: (value: typeof transform) => {
      transform = value
    },
  }
}
function mutate(
  response: Response,
  change: Record<string, string | null>,
  status = response.status,
) {
  const headers = new Headers(response.headers)
  for (const [key, value] of Object.entries(change))
    value === null ? headers.delete(key) : headers.set(key, value)
  return new Response(response.body, { status, headers })
}

test('HTTP blocks are lazy, aligned, coalesced and independent of returned buffers', async (t) => {
  const m = mock(),
    gate = deferred()
  const pool = new HttpRangePool({ fetch: m.fetcher })
  t.after(() => pool.close())
  const [source, same] = await Promise.all([pool.open(URL), pool.open(URL + '#fragment')])
  assert.equal(source, same)
  assert.equal(source.mode, 'range')
  assert.equal(pool.inspect().receivedBytes, 1)
  m.transform(async (response) => {
    await gate.promise
    return response
  })
  const first = source.read(B - 7, B * 5 + 12),
    overlap = source.read(B, B)
  await until(() => m.calls.length === 3)
  gate.resolve()
  const [bytes, other] = await Promise.all([first, overlap])
  assert.deepEqual(
    bytes,
    Uint8Array.from({ length: bytes.length }, (_, i) => (B - 7 + i) % 251),
  )
  assert.equal(other[0], B % 251)
  bytes.fill(0)
  other.fill(0)
  assert.equal((await source.read(B, 1))[0], B % 251)
  assert.equal(m.calls.length, 3)
  assert.deepEqual(
    m.calls.map((c) => new Headers(c.headers).get('range')),
    ['bytes=0-0', `bytes=0-${B * 4 - 1}`, `bytes=${B * 4}-${B * 7 - 1}`],
  )
  for (const init of m.calls.slice(1)) {
    assert.equal(new Headers(init.headers).get('if-match'), '"v1"')
    assert.equal(init.credentials, 'omit')
    assert.equal(init.mode, 'cors')
    assert.equal(init.cache, 'no-store')
  }
  assert.equal(pool.inspect().pendingReadBytes, 0)
})

test('HTTP cache is one bounded LRU across sources; zero budget retains no blocks', async (t) => {
  const m = mock(),
    pool = new HttpRangePool({ fetch: m.fetcher, cacheBytes: B * 2 })
  t.after(() => pool.close())
  const a = await pool.open(URL),
    b = await pool.open(URL + '?patch=1')
  await a.read(0, 1)
  await a.read(B, 1)
  await a.read(0, 1)
  await b.read(0, 1)
  assert.equal(pool.inspect().cacheBytes, B * 2)
  const count = m.calls.length
  await a.read(0, 1)
  assert.equal(m.calls.length, count)
  await a.read(B, 1)
  assert.equal(m.calls.length, count + 1)
  const zero = new HttpRangePool({ fetch: m.fetcher, cacheBytes: 0 })
  t.after(() => zero.close())
  const c = await zero.open(URL)
  await c.read(0, 1)
  await c.read(0, 1)
  assert.equal(zero.inspect().requests, 3)
  assert.equal(zero.inspect().cacheBytes, 0)
})

test('HTTP reads preserve offsets over 4 GiB and reject unsafe or oversized intervals', async (t) => {
  const total = 2 ** 32 + B + 9,
    m = mock(total),
    pool = new HttpRangePool({ fetch: m.fetcher })
  t.after(() => pool.close())
  const source = await pool.open(URL)
  assert.equal(source.size, total)
  assert.deepEqual(
    await source.read(total - 9, 9),
    Uint8Array.from({ length: 9 }, (_, i) => (total - 9 + i) % 251),
  )
  assert.equal((await source.read(total, 0)).length, 0)
  for (const [offset, length] of [
    [-1, 1],
    [1.5, 0],
    [0, -1],
    [total, 1],
    [0, MAX + 1],
    [NaN, 0],
    [0, Infinity],
    [Number.MAX_SAFE_INTEGER + 1, 0],
  ])
    await assert.rejects(source.read(offset, length), /bounds|budget/)
  assert.equal(m.calls.length, 2)
})

for (const [name, change, status] of [
  ['ETag', { ETag: '"v2"' }, 206],
  ['missing ETag', { ETag: null }, 206],
  ['weak ETag', { ETag: 'W/"v1"' }, 206],
  ['total', { 'Content-Range': `bytes ${B}-${B * 2 - 1}/${B * 20}` }, 206],
  ['interval', { 'Content-Range': `bytes 0-${B - 1}/${B * 12 + 13}` }, 206],
  ['hidden range', { 'Content-Range': null }, 206],
  ['length', { 'Content-Length': '0' }, 206],
  ['encoding', { 'Content-Encoding': 'gzip' }, 206],
  ['condition failed', {}, 412],
  ['range ignored', {}, 200],
] as const) {
  test(`HTTP ${name} invalidates the source, including earlier cached bytes`, async (t) => {
    const m = mock(),
      pool = new HttpRangePool({ fetch: m.fetcher })
    t.after(() => pool.close())
    const source = await pool.open(URL),
      unaffected = await pool.open(URL + '?other')
    await source.read(0, 1)
    await unaffected.read(0, 1)
    m.transform((response) => mutate(response, change, status))
    await assert.rejects(source.read(B, 1), /HTTP|Remote|Content-Range/)
    await assert.rejects(source.read(0, 1), /HTTP|Remote|Content-Range/)
    assert.equal(pool.inspect().cacheBytes, B)
    assert.equal((await unaffected.read(0, 1))[0], 0)
  })
}

test('HTTP validates probe syntax, actual body length and pinned redirect URL', async (t) => {
  for (const value of [
    'bytes 0-0/*',
    'bytes 1-1/2',
    'bytes 0-0/0',
    'bytes 0-0/9007199254740992',
    'bytes 0-1/3',
    'nonsense',
  ]) {
    const m = mock()
    m.transform((r) => mutate(r, { 'Content-Range': value }))
    const pool = new HttpRangePool({ fetch: m.fetcher })
    t.after(() => pool.close())
    await assert.rejects(pool.open(URL))
  }
  for (const length of [0, B - 1, B + 1]) {
    const m = mock(),
      pool = new HttpRangePool({ fetch: m.fetcher })
    t.after(() => pool.close())
    const source = await pool.open(URL)
    m.transform((r) => new Response(new Uint8Array(length), { status: 206, headers: r.headers }))
    await assert.rejects(source.read(0, 1), /body/i)
  }
  const m = mock(),
    pool = new HttpRangePool({ fetch: m.fetcher })
  t.after(() => pool.close())
  m.transform((r) => {
    Object.defineProperty(r, 'url', { value: 'https://cdn.test/v1' })
    return r
  })
  const source = await pool.open(URL)
  assert.ok(source.identity.includes('https://cdn.test/v1'))
  m.transform((r) => {
    Object.defineProperty(r, 'url', { value: 'https://cdn.test/v2' })
    return r
  })
  await assert.rejects(source.read(0, 1), /version changed/)
})

test('HTTP transient failures can retry and do not cache failed reads', async (t) => {
  const m = mock(),
    pool = new HttpRangePool({ fetch: m.fetcher })
  t.after(() => pool.close())
  const source = await pool.open(URL)
  m.transform(() => new Response(null, { status: 503 }))
  await assert.rejects(source.read(0, B * 8), /503/)
  assert.equal(pool.inspect().cacheBytes, 0)
  m.transform((r) => r)
  assert.equal((await source.read(0, 1))[0], 0)
})

test('HTTP uses at most four requests and closing cancels active, queued and overlapping reads', async (t) => {
  const m = mock(B * 100),
    pool = new HttpRangePool({ fetch: m.fetcher })
  t.after(() => pool.close())
  const source = await pool.open(URL),
    gate = deferred<Response>()
  m.transform(() => gate.promise)
  const pending = source.read(0, B * 40),
    overlap = source.read(0, B)
  const finished = Promise.allSettled([pending, overlap])
  await until(() => pool.inspect().queuedRequests === 6)
  assert.equal(m.calls.length, 5)
  assert.equal(pool.inspect().activeRequests, 4)
  pool.close()
  assert.ok((await finished).every((r) => r.status === 'rejected'))
  assert.equal(pool.inspect().activeRequests, 0)
  assert.equal(pool.inspect().queuedRequests, 0)
  assert.equal(pool.inspect().pendingReadBytes, 0)
  assert.equal(pool.inspect().cacheBytes, 0)
  // Even a transport that ignores AbortSignal cannot publish its late response.
  let cancelled = 0
  gate.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled++
        },
      }),
    ),
  )
  await until(() => cancelled > 0)
  assert.equal(pool.inspect().cacheBytes, 0)
})

test('HTTP pending output budget is shared and released after cancellation', async (t) => {
  const m = mock(MAX * 4),
    pool = new HttpRangePool({ fetch: m.fetcher })
  t.after(() => pool.close())
  const source = await pool.open(URL)
  m.transform(() => new Promise(() => {}))
  const a = source.read(0, MAX),
    b = source.read(0, MAX)
  const finished = Promise.allSettled([a, b])
  await assert.rejects(source.read(0, 1), /128 MiB/)
  assert.equal(pool.inspect().pendingReadBytes, MAX * 2)
  pool.close()
  await finished
  assert.equal(pool.inspect().pendingReadBytes, 0)
})

test('HTTP timeout includes stalled response bodies and permits a clean retry', async (t) => {
  const m = mock(),
    pool = new HttpRangePool({ fetch: m.fetcher, timeoutMs: 40 })
  t.after(() => pool.close())
  const source = await pool.open(URL)
  let cancelled = false
  m.transform(
    (r) =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true
          },
        }),
        { status: 206, headers: r.headers },
      ),
  )
  await assert.rejects(source.read(0, 1), { name: 'TimeoutError' })
  await until(() => cancelled)
  assert.equal(pool.inspect().activeRequests, 0)
  m.transform((r) => r)
  assert.equal((await source.read(0, 1)).length, 1)
})

test('HTTP full fallback freezes small files without strong tags, including empty sources', async (t) => {
  const files = {
    '/full': { bytes: Buffer.from('first'), full: true },
    '/weak': { bytes: Buffer.from('first'), etag: 'W/"v1"' },
    '/empty': { bytes: Buffer.alloc(0), etag: '"v1"' },
  }
  const server = await httpServer(files)
  t.after(() => server.close())
  const pool = new HttpRangePool()
  t.after(() => pool.close())
  for (const name of ['/full', '/weak', '/empty'] as const) {
    const source = await pool.open(server.url + name)
    assert.equal(source.mode, 'snapshot')
    files[name].bytes = Buffer.from('changed')
    const bytes = await source.read(0, source.size)
    bytes.fill(0)
    assert.equal(
      Buffer.from(await source.read(0, source.size)).toString(),
      name === '/empty' ? '' : 'first',
    )
    assert.match(source.identity, /sha256:|v1/)
  }
  assert.equal(server.requests.filter((r) => r.path === '/weak').length, 2)
  assert.equal(pool.inspect().snapshotBytes, 10)
  pool.close()
  assert.equal(pool.inspect().snapshotBytes, 0)
})

test('HTTP full downloads reserve a shared budget before bodies arrive and discard partial failures', async (t) => {
  const gate = deferred(),
    length = MAX / 2 + 1
  const pool = new HttpRangePool({
    fetch: async () =>
      new Response(
        new ReadableStream({
          async pull() {
            await gate.promise
          },
        }),
        { headers: { 'Content-Length': String(length) } },
      ),
  })
  t.after(() => pool.close())
  const opening = pool.open(URL),
    result = Promise.allSettled([opening])
  await until(() => pool.inspect().reservedBytes === length)
  await assert.rejects(pool.open(URL + '?other'), /shared 64 MiB/)
  pool.close()
  gate.resolve()
  await result
  await until(() => pool.inspect().reservedBytes === 0)
  assert.equal(pool.inspect().snapshotBytes, 0)
})

test('HTTP rejects oversized unknown bodies and large partial sources without strong validators', async (t) => {
  const large = mock(MAX + 1)
  large.transform((r) => mutate(r, { etag: 'W/"v1"' }))
  const partial = new HttpRangePool({ fetch: large.fetcher })
  t.after(() => partial.close())
  await assert.rejects(partial.open(URL), /strong/)
  assert.equal(large.calls.length, 1)
  let cancelled = false,
    chunks = 0
  const pool = new HttpRangePool({
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            chunks++
            controller.enqueue(new Uint8Array(1024 * 1024))
          },
          cancel() {
            cancelled = true
          },
        }),
      ),
  })
  t.after(() => pool.close())
  await assert.rejects(pool.open(URL), /budget/)
  assert.ok(chunks <= 66)
  assert.ok(cancelled)
  assert.equal(pool.inspect().reservedBytes, 0)
  assert.equal(pool.inspect().snapshotBytes, 0)
})

test('decoded full responses use their actual bytes rather than compressed Content-Length', async (t) => {
  const pool = new HttpRangePool({
    fetch: async () =>
      new Response('decoded bytes', {
        headers: { 'Content-Encoding': 'gzip', 'Content-Length': '2' },
      }),
  })
  t.after(() => pool.close())
  const source = await pool.open(URL)
  assert.equal(source.size, 13)
  assert.equal(new TextDecoder().decode(await source.read(0, 13)), 'decoded bytes')
})

test('HTTP URL validation strips fragments while retaining version queries and rejecting credentials', () => {
  assert.equal(remoteUrl('https://example.test/a?version=1#x'), 'https://example.test/a?version=1')
  for (const url of ['file:///a', 'data:text/plain,a', 'https://user:secret@example.test/a', '/a'])
    assert.throws(() => remoteUrl(url))
  for (const options of [{ cacheBytes: -1 }, { cacheBytes: MAX + 1 }, { timeoutMs: 0 }])
    assert.throws(() => new HttpRangePool(options))
})
