import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { HttpRangePool } from '../../src/backends/files/http-range.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { readRemoteManifest } from '../../src/backends/files/remote-manifest.ts'
import { resolveFiles } from '../../src/backends/files/source-files.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { gameIdentity, projectIdentity } from '../../src/player/game-identity.ts'
import { headless } from '../helpers/headless.ts'
import { httpServer } from '../helpers/http-server.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const chapter = String.raw`
Storages.addAutoPath("scenario/");
Storages.addAutoPath(System.exePath+"patch.xp3>");
var slot=System.dataPath+"route.txt", story=Scripts.evalStorage("route.tjs"),
 title=[].load(System.exePath+"对白 #1.txt","utf-8")[0], old=Storages.isExistentStorage(slot) ? [].load(slot,"utf-8")[0] : "new";
[story+"|"+title].save(slot,"utf-8");
`

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a remote game directory opens its actual patch, loose chapter title and previous save`, { timeout: 60000 }, async () => {
  const files = ['data.xp3', { path: 'patch.xp3', url: '../dist/update.bin' }, '对白 #1.txt'],
    listing = { bytes: Buffer.from(JSON.stringify({ version: 1, files })) },
    server = await httpServer({
      '/story/files.json': listing,
      '/story/data.xp3': { etag: '"base"', bytes: xp3Fixture({
        'startup.tjs': binary
          ? 'Scripts.compileStorage("chapter.tjs",System.dataPath+"chapter.cjs",false,true,false);Scripts.execStorage(System.dataPath+"chapter.cjs");'
          : 'Scripts.execStorage("chapter.tjs");',
        'chapter.tjs': chapter, 'scenario/route.tjs': '"base"',
      }).bytes },
      '/dist/update.bin': { etag: '"translation"', bytes: xp3Fixture({ 'route.tjs': '"patch"' }, { compressed: true }).bytes },
      '/story/%E5%AF%B9%E7%99%BD%20%231.txt': { etag: '"title"', bytes: Buffer.from('第一章') },
    }), store = new MemorySaveStore(), ids: string[] = [], checkpoint = async () => {}
  try {
    for (const previous of ['new', 'patch|第一章']) {
      const pool = new HttpRangePool()
      try {
        const names = await readRemoteManifest(server.url + '/story/files.json', pool),
          sources = await resolveFiles(names, checkpoint, pool),
          resources = await importSources(sources, checkpoint, { lazyArchives: true }),
          mount = await prepareProject(resources, { mode: 'auto' }, archiveReader, checkpoint)
        assert.equal(mount.project?.directory, 'data.xp3>')
        ids.push(await projectIdentity(await gameIdentity(sources), mount.project))
        const { session } = await headless({}, { project: mount.project, saveStore: store })
        try {
          session.mount(mount.resources); await session.start()
          assert.equal(await session.evaluate('old'), previous)
          assert.equal(await session.evaluate('story+"|"+title'), 'patch|第一章')
          assert.equal(await session.evaluate('Storages.getPlacedPath("route.tjs")'), 'game://./patch.xp3>route.tjs')
          if (binary) assert.equal(Buffer.from(session.exportSaves().find((f) => f.path === 'savedata/chapter.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
        } finally { await session.stop() }
      } finally { pool.close() }
      listing.bytes = Buffer.from(JSON.stringify({ version: 1, files: [...files].reverse() }, null, 2))
    }
    assert.equal(ids[0], ids[1])
    for (const path of ['/story/data.xp3', '/dist/update.bin', '/story/%E5%AF%B9%E7%99%BD%20%231.txt'])
      assert(server.requests.some((request) => request.path === path && request.range && request.match), path)
  } finally { await server.close() }
})
