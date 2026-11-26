import assert from 'node:assert/strict'
import test from 'node:test'
import { HttpRangePool } from '../../src/backends/files/http-range.ts'
import { parseRemoteManifest, readRemoteManifest } from '../../src/backends/files/remote-manifest.ts'
import { resolveFiles } from '../../src/backends/files/source-files.ts'
import { gameIdentity } from '../../src/player/game-identity.ts'
import { httpServer, deferred } from '../helpers/http-server.ts'

const base = 'https://games.example/releases/2026/files.json?edition=cn'
const json = (files: unknown[], version = 1) => Buffer.from(JSON.stringify({ version, files }))

test('remote directory filenames are literal, links follow URL rules and original path spelling survives', () => {
  const entries = ['data.xp3', '图/朝 #1?%.png', { path: 'scene\\next.ks', url: '../content/scene.bin?revision=2#unused' },
    { path: 'Music/title.ogg', url: 'https://media.example/sound' }, 'Case.tjs', 'case.tjs']
  assert.deepEqual(parseRemoteManifest(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), json(entries)]), base), [
    { path: 'data.xp3', url: 'https://games.example/releases/2026/data.xp3' },
    { path: '图/朝 #1?%.png', url: 'https://games.example/releases/2026/%E5%9B%BE/%E6%9C%9D%20%231%3F%25.png' },
    { path: 'scene/next.ks', url: 'https://games.example/releases/content/scene.bin?revision=2' },
    { path: 'Music/title.ogg', url: 'https://media.example/sound' },
    { path: 'Case.tjs', url: 'https://games.example/releases/2026/Case.tjs' },
    { path: 'case.tjs', url: 'https://games.example/releases/2026/case.tjs' },
  ])
})

test('invalid remote directory entries reject the entire manifest before any game files are opened', async () => {
  for (const bytes of [
    Buffer.from('{"'), Buffer.from([255, 254]), json([], 1), json(['data.xp3'], 2),
    json(Array(10001).fill('a')), new Uint8Array(8 * 1024 * 1024 + 1),
    ...[null, 42, 'trailing/', 'a/..', '/absolute', '../escape.tjs', 'a.xp3>b.tjs',
      { path: 'data.xp3', url: 'file:///game.xp3' }, { path: 'data.xp3', url: '' },
      { path: 'data.xp3', url: 'https://user:pass@games.example/p' }, { path: 7 }].map((item) => json(['ok.tjs', item])),
    json(['scene/a.ks', './scene/x/../a.ks']),
  ]) assert.throws(() => parseRemoteManifest(bytes, base))
  assert.throws(() => parseRemoteManifest(json(Array.from({ length: 4096 }, (_, i) => i + '.ks')),
    'https://game.example/' + 'a'.repeat(2048) + '/index.json'), /展开后的路径/)
  const server = await httpServer({ '/game.json': { bytes: json(['ok.tjs', 'ok.tjs']) } }), pool = new HttpRangePool()
  try {
    await assert.rejects(readRemoteManifest(server.url + '/game.json', pool), /重复路径/)
    assert.deepEqual(server.requests.map((request) => request.path), ['/game.json'])
  } finally { pool.close(); await server.close() }
})

test('a redirected manifest shares the direct import identity and pins each independent game resource version', async () => {
  const manifest = { bytes: json(['startup.tjs', { path: 'patch.xp3', url: '../packs/patch.bin?v=2' }]) },
    patch = { bytes: Buffer.from('archive-v1'), etag: '"patch-1"' },
    server = await httpServer({ '/launch': { bytes: Buffer.alloc(0), intercept(_request, response) {
      response.writeHead(302, { Location: '/release/list.json' }).end(); return true
    } }, '/release/list.json': manifest, '/release/startup.tjs': { bytes: Buffer.from('start'), etag: '"start"' },
      '/packs/patch.bin': patch })
  const pool = new HttpRangePool(), next = new HttpRangePool(), checkpoint = async () => {}
  try {
    const descriptors = await readRemoteManifest(server.url + '/launch', pool),
      direct = [{ path: 'startup.tjs', url: server.url + '/release/startup.tjs' },
        { path: 'patch.xp3', url: server.url + '/packs/patch.bin?v=2' }]
    assert.deepEqual(descriptors, direct)
    const sources = await resolveFiles(descriptors, checkpoint, pool), identity = await gameIdentity(sources)
    assert.equal(await gameIdentity(await resolveFiles([...direct].reverse(), checkpoint, pool)), identity)
    assert.equal(server.requests.filter((request) => request.range === 'bytes=0-0').length, 2)
    manifest.bytes = json(['renamed.tjs'])
    assert.equal(Buffer.from(await sources[0]!.source.read(0, 5)).toString(), 'start')
    patch.etag = '"patch-2"'
    await assert.rejects(sources[1]!.source.read(0, 1), /version|412|changed/i)
    assert.notEqual(await gameIdentity(await resolveFiles(direct, checkpoint, next)), identity)
  } finally { pool.close(); next.close(); await server.close() }
})

test('a stopped manifest fetch releases the session while its JSON body is still in transit', { timeout: 20000 }, async () => {
  const entered = deferred(), server = await httpServer({ '/list.json': { bytes: Buffer.alloc(0), intercept(_request, response) {
    response.writeHead(200, { 'Content-Type': 'application/json' }); response.write('{"version":1,'); entered.resolve(); return true
  } } }), pool = new HttpRangePool()
  try {
    const reading = readRemoteManifest(server.url + '/list.json', pool)
    await Promise.race([entered.promise, reading.then(() => { throw new Error('Partial manifest completed unexpectedly') })])
    const failure = assert.rejects(reading, /abort|closed/i)
    pool.close()
    await failure
    assert.equal(pool.inspect().activeRequests, 0)
    assert.equal(server.requests.length, 1)
  } finally { pool.close(); await server.close() }
})
