import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { HttpRangePool } from '../../src/backends/files/http-range.ts'
import { resolveFiles } from '../../src/backends/files/source-files.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { gameIdentity } from '../../src/player/game-identity.ts'
import { headless } from '../helpers/headless.ts'
import { httpServer, until } from '../helpers/http-server.ts'
import { remoteArchive } from '../helpers/remote-archive.ts'
const checkpoint = async () => {}

for (const kind of ['xp3', 'zip'] as const)
  test(`remote ${kind} is sniffed without extension, starts TJS lazily and keeps save overlays local`, async (t) => {
    const bytes = remoteArchive(kind),
      server = await httpServer({ '/download': { bytes, etag: '"v1"' } })
    t.after(() => server.close())
    const pool = new HttpRangePool()
    t.after(() => pool.close())
    const files = await resolveFiles(
      [{ path: 'game.data', url: server.url + '/download' }],
      checkpoint,
      pool,
    )
    const before = pool.inspect().requests
    assert.match(await gameIdentity(files), /^game-[a-f0-9]{64}$/)
    assert.equal(pool.inspect().requests, before, 'remote identity must not sample all members')
    const { session, logs } = await headless()
    t.after(() => session.stop())
    session.control.onCancel(() => pool.close())
    session.mount(await importSources(files, checkpoint))
    await session.start()
    assert.ok(logs.includes('zip-ready:42:0'))
    assert.equal(await session.evaluate('asset.getMainPixel(0,0)'), String(0x336699))
    assert.ok(
      server.stats().sent < bytes.length / 8,
      `${server.stats().sent} bytes fetched out of ${bytes.length}`,
    )
    session.pause()
    await session.importSaves([{ path: 'シーン/value.tjs', bytes: Buffer.from('113') }])
    session.resume()
    assert.equal(await session.evaluate('Scripts.evalStorage("シーン/value.tjs")'), '113')
    assert.equal(await session.evaluate('Scripts.evalStorage("game.data>シーン/value.tjs")'), '42')
    const count = server.requests.length
    assert.equal(await session.evaluate('Scripts.evalStorage("late.tjs")'), '73')
    assert.ok(server.requests.length > count)
    const after = server.requests.length
    assert.equal(await session.evaluate('Scripts.evalStorage("late.tjs")'), '73')
    assert.equal(server.requests.length, after)
    await session.stop()
    assert.equal(pool.inspect().cacheBytes, 0)
  })

test('source validation finishes before network work and cancellation leaves no publishable mount', async (t) => {
  const server = await httpServer({
    '/blocked': { bytes: Buffer.from('x'), etag: '"v1"', intercept: () => true },
  })
  t.after(() => server.close())
  const pool = new HttpRangePool()
  t.after(() => pool.close())
  const remote = { path: 'game.data', url: server.url + '/blocked' }
  await assert.rejects(
    resolveFiles([remote, { path: '../escape', blob: new Blob() }], checkpoint, pool),
  )
  assert.equal(server.requests.length, 0)
  const preparing = resolveFiles([remote], checkpoint, pool)
  const rejected = assert.rejects(preparing, { name: 'AbortError' })
  await until(() => server.requests.length > 0)
  pool.close()
  await rejected
  await until(() => server.stats().aborted > 0)
  assert.equal(pool.inspect().activeRequests, 0)
})

test('local identity preserves previous sample hashes, while remote identities follow pinned versions', async (t) => {
  const input = [
    { path: 'b\\small.tjs', blob: new Blob(['abc']) },
    { path: './large.bin', blob: new Blob([Buffer.alloc(160000, 7)]) },
    { path: 'middle.bin', blob: new Blob([Buffer.alloc(90000, 11)]) },
    { path: 'empty.bin', blob: new Blob() },
  ]
  const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  const expected = []
  for (const file of [...input].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
    const bytes = Buffer.from(await file.blob.arrayBuffer())
    expected.push({
      path: file.path.replaceAll('\\', '/'),
      size: bytes.length,
      sample: hash(
        Buffer.concat([
          bytes.subarray(0, 65536),
          bytes.subarray(Math.max(65536, bytes.length - 65536)),
        ]),
      ),
    })
  }
  const identity = await gameIdentity(await resolveFiles(input, checkpoint))
  assert.equal(identity, 'game-' + hash(Buffer.from(JSON.stringify(expected))))
  assert.equal(await gameIdentity(await resolveFiles([...input].reverse(), checkpoint)), identity)
  const file = { bytes: Buffer.from('first'), etag: '"v1"' },
    server = await httpServer({ '/game': file })
  t.after(() => server.close())
  async function remote() {
    const pool = new HttpRangePool()
    t.after(() => pool.close())
    return gameIdentity(
      await resolveFiles([{ path: 'game', url: server.url + '/game' }], checkpoint, pool),
    )
  }
  const first = await remote()
  assert.equal(await remote(), first)
  file.etag = '"v2"'
  assert.notEqual(await remote(), first)
})
