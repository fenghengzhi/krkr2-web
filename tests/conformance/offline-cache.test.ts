import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { ShellCache } from '../../src/pwa/cache.ts'
import { validateManifest, type ShellManifest } from '../../src/pwa/manifest.ts'
import { deferred, until } from '../helpers/http-server.ts'
const root = new URL('https://example.test/player/')
const hash = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function manifest(version = 'a', count = 3): ShellManifest {
  const paths = [
    'index.html',
    `assets/app-${version}.js`,
    `wasm/manifest-${version}.json`,
    ...Array.from({ length: count - 3 }, (_, i) => `assets/chunk-${version}-${i}.js`),
  ]
  return {
    schema: 1,
    build: hash(version),
    bytes: paths.reduce((n, p) => n + Buffer.byteLength(p), 0),
    assets: paths.map((path) => ({
      path,
      bytes: Buffer.byteLength(path),
      sha256: hash(path),
      mime: path.endsWith('.html') ? 'text/html' : 'text/javascript',
    })),
  }
}
function memory() {
  const caches = new Map<string, Map<string, Response>>()
  const storage = {
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
    open: async (name: string) => {
      let values = caches.get(name)
      if (!values) {
        values = new Map()
        caches.set(name, values)
      }
      return {
        match: async (input: Request | string) =>
          values!.get(typeof input === 'string' ? input : input.url)?.clone(),
        put: async (input: Request | string, response: Response) => {
          values!.set(typeof input === 'string' ? input : input.url, response.clone())
        },
      }
    },
  } as unknown as CacheStorage
  return { storage, caches }
}
const fetcher: typeof fetch = async (input) =>
  new Response(new URL(String(input)).pathname.slice(root.pathname.length), {
    headers: {
      'Content-Encoding': 'gzip',
      'Content-Length': '999',
      'Content-Security-Policy': "default-src 'self'",
    },
  })
const navigation = (url: string) => {
  const request = new Request(url)
  Object.defineProperty(request, 'mode', { value: 'navigate' })
  return request
}

test('offline manifest rejects traversal, reserved names, missing index and unsafe budgets', () => {
  assert.equal(validateManifest(manifest()).assets.length, 3)
  for (const path of ['../a', 'a/../b', '/a', 'sw.js', '__offline_manifest__', 'a?x', 'a//b']) {
    const value = manifest()
    value.assets[1]!.path = path
    assert.throws(() => validateManifest(value))
  }
  for (const mutate of [
    (m: ShellManifest) => {
      m.bytes++
    },
    (m: ShellManifest) => {
      m.assets[0]!.path = 'missing'
    },
    (m: ShellManifest) => {
      m.assets[1]!.bytes = Infinity
    },
    (m: ShellManifest) => {
      m.assets[1]!.bytes = 17 * 1024 * 1024
    },
    (m: ShellManifest) => {
      m.assets[1]!.sha256 = 'bad'
    },
    (m: ShellManifest) => {
      m.assets[1]!.path = 'index.html'
    },
  ]) {
    const value = manifest()
    mutate(value)
    assert.throws(() => validateManifest(value))
  }
})

test('offline installation verifies every artifact before publishing and bounds download concurrency', async () => {
  const m = memory(),
    gate = deferred(),
    data = manifest('a', 10)
  let active = 0,
    peak = 0,
    requests = 0
  const shell = new ShellCache(data, root, m.storage, async (input, options) => {
    requests++
    active++
    peak = Math.max(active, peak)
    await gate.promise
    active--
    return fetcher(input, options)
  })
  const installing = shell.install()
  await until(() => requests === 4)
  assert.equal((await shell.record())!.complete, false)
  assert.equal((await shell.status()).ready, false)
  gate.resolve()
  await installing
  assert.equal(peak, 4)
  assert.equal(requests, 10)
  assert.equal((await shell.status()).ready, true)
  await shell.install()
  assert.equal(requests, 10)
  const response = (await shell.response(navigation(root.href + '?backend=jspi')))!
  assert.equal(await response.text(), 'index.html')
  assert.equal(response.headers.get('content-encoding'), null)
  assert.equal(response.headers.get('content-length'), '10')
  assert.equal(response.headers.get('content-security-policy'), "default-src 'self'")
})

test('a corrupt deployment removes only the uncommitted generation and cannot publish late work', async () => {
  const m = memory(),
    old = new ShellCache(manifest('a'), root, m.storage, fetcher)
  await old.install()
  const gate = deferred<Response>()
  let cancelled = false
  const next = new ShellCache(manifest('b', 4), root, m.storage, async (input) => {
    if (String(input).endsWith('index.html')) return new Response('corrupt')
    return gate.promise
  })
  await assert.rejects(next.install(), /size|checksum/)
  assert.deepEqual(await m.storage.keys(), [old.name])
  assert.ok((await old.status()).ready)
  gate.resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true
        },
      }),
    ),
  )
  await until(() => cancelled)
  assert.deepEqual(await m.storage.keys(), [old.name])
})

test('offline routes preserve scope and never capture range, query, POST or unrelated resources', async () => {
  const m = memory(),
    shell = new ShellCache(manifest(), root, m.storage, fetcher)
  await shell.install()
  for (const request of [
    new Request(root + 'assets/app-a.js', { headers: { Range: 'bytes=0-1' } }),
    new Request(root + 'assets/app-a.js', { headers: { 'If-Match': '"v1"' } }),
    new Request(root + 'assets/app-a.js?test-worker=1'),
    new Request(root + 'game.xp3'),
    new Request(root + 'api', { method: 'POST', body: 'private' }),
    new Request('https://other.test/player/assets/app-a.js'),
    navigation(root + 'missing.zip'),
  ])
    assert.equal(await shell.response(request), undefined)
  assert.equal(
    await (await shell.response(new Request(root + 'assets/app-a.js')))!.text(),
    'assets/app-a.js',
  )
  assert.equal(
    await (await shell.response(navigation(root + 'index.html?backend=jspi')))!.text(),
    'index.html',
  )
})

test('old hashed dependencies remain available while new navigation uses the new app generation', async () => {
  const withFonts = (version: string) => {
    const m = manifest(version)
    for (const path of [
      `fonts/manifest-${version}.json`,
      `fonts/font-${version}.mjs`,
      `fonts/font-${version}.wasm`,
    ]) {
      m.assets.push({
        path,
        bytes: Buffer.byteLength(path),
        sha256: hash(path),
        mime: 'application/octet-stream',
      })
      m.bytes += Buffer.byteLength(path)
    }
    return m
  }
  const m = memory(),
    a = new ShellCache(withFonts('a'), root, m.storage, fetcher),
    b = new ShellCache(withFonts('b'), root, m.storage, fetcher)
  await a.install()
  await b.install()
  assert.equal(
    await (await b.response(new Request(root + 'wasm/manifest-a.json')))!.text(),
    'wasm/manifest-a.json',
  )
  const offline = new ShellCache(b.manifest, root, m.storage, async () => {
    throw new Error('network unavailable')
  })
  for (const path of ['fonts/manifest-a.json', 'fonts/font-a.mjs', 'fonts/font-a.wasm']) {
    const response = await offline.response(new Request(root + path))
    assert(response, 'Old font dependency must remain available: ' + path)
    assert.equal(await response.text(), path)
  }
  assert.equal(await offline.response(new Request(root + 'fonts/private-game-font.ttf')), undefined)
  const staging = new ShellCache(manifest('c'), root, m.storage, fetcher)
  const cache = await m.storage.open(staging.name)
  await cache.put(
    staging.marker,
    new Response(JSON.stringify({ complete: false, manifest: staging.manifest })),
  )
  await cache.put(root + 'assets/app-c.js', new Response('unverified'))
  assert.equal(await b.response(new Request(root + 'assets/app-c.js')), undefined)
  await m.storage.open('other-application')
  const other = new ShellCache(
    manifest('d'),
    new URL('https://example.test/other/'),
    m.storage,
    async (input) => new Response(new URL(String(input)).pathname.slice('/other/'.length)),
  )
  await other.install()
  await b.prune()
  assert.deepEqual(
    new Set(await m.storage.keys()),
    new Set([b.name, other.name, 'other-application']),
  )
})

test('missing cached assets are repaired only with matching bytes; offline failures return explicit errors', async () => {
  const m = memory(),
    data = manifest(),
    shell = new ShellCache(data, root, m.storage, fetcher)
  await shell.install()
  const url = root + 'assets/app-a.js'
  m.caches.get(shell.name)!.delete(url)
  const bad = new ShellCache(data, root, m.storage, async () => new Response('new bad bytes'))
  assert.equal((await bad.response(new Request(url)))!.status, 503)
  assert.equal((await bad.status()).ready, false)
  assert.equal(await (await shell.response(new Request(url)))!.text(), 'assets/app-a.js')
  assert.ok((await shell.status()).ready)
})

test('offline generation limits fail before creating another cache and incomplete cleanup keeps complete builds', async () => {
  const m = memory()
  for (let i = 0; i < 8; i++)
    await new ShellCache(manifest(String(i)), root, m.storage, fetcher).install()
  const extra = new ShellCache(manifest('overflow'), root, m.storage, fetcher)
  await assert.rejects(extra.install(), /cache is full/)
  assert.equal((await m.storage.keys()).length, 8)
  const partial = new ShellCache(manifest('partial'), root, m.storage, fetcher)
  await m.storage.open(partial.name)
  await extra.clearIncomplete()
  assert.equal((await m.storage.keys()).length, 8)
})

test('a cache write failure cannot leave a generation marked ready', async () => {
  const m = memory(),
    open = m.storage.open.bind(m.storage)
  m.storage.open = async (name) => {
    const cache = await open(name),
      put = cache.put.bind(cache)
    cache.put = async (input, response) => {
      if (String(input).endsWith('.js')) throw new DOMException('quota', 'QuotaExceededError')
      return put(input, response)
    }
    return cache
  }
  const shell = new ShellCache(manifest(), root, m.storage, fetcher)
  await assert.rejects(shell.install(), /quota/)
  assert.equal((await m.storage.keys()).length, 0)
})
