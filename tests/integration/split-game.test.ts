import assert from 'node:assert/strict'
import test from 'node:test'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'
import { importSources } from '../../src/backends/files/import-resources.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { gameIdentity, projectIdentity } from '../../src/player/game-identity.ts'
import { headless } from '../helpers/headless.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a wrapped split XP3 game applies its split patch and loads its slot after reordered reimport`, async () => {
    const program = `System.exitOnNoWindowStartup=false;
Storages.addAutoPath(System.exePath+"patch.xp3>");
var chapter=Scripts.evalStorage("chapter.tjs");
function saveChapter(){[chapter,"7"].save(System.dataPath+"split-slot.txt","utf-8");}
function loadChapter(){return [].load(System.dataPath+"split-slot.txt").join("|");}`
    const base = xp3Fixture({ 'startup.tjs': binary ?
      'Scripts.compileStorage("novel.tjs",System.dataPath+"novel.cjs",false,true,false);Scripts.execStorage(System.dataPath+"novel.cjs");' :
      'Scripts.execStorage("novel.tjs");', 'novel.tjs': program }, { compressed: true, continuation: true })
    const patch = xp3Fixture({ 'chapter.tjs': '"updated chapter"' }, { compressed: true })
    const parts = (name: string, bytes: Buffer, cut: number) => [bytes.subarray(0, cut), bytes.subarray(cut)]
      .map((chunk, i) => ({ path: `Novel/${name}.00${i + 1}`, source: new BlobSource(new Blob([Uint8Array.from(chunk).buffer])) }))
    const files = [...parts('DATA.xp3', base.bytes, base.indexOffsets[0]! + 7), ...parts('patch.xp3', patch.bytes, 24)]
    const store = new MemorySaveStore(), step = async () => {}
    let identity: string | undefined
    for (const replay of [false, true]) {
      const physical = replay ? [...files].reverse() : files
      const inputs = await importSources(physical, step, { lazyArchives: true })
      const project = (await prepareProject(inputs, { mode: 'auto' }, archiveReader, step)).project!
      assert.deepEqual(project, { directory: 'Novel/DATA.xp3>', executableDirectory: 'Novel/' })
      const id = await projectIdentity(await gameIdentity(physical, step), project)
      if (replay) assert.equal(id, identity)
      identity = id
      const { session } = await headless({}, { project, saveStore: store })
      try {
        session.mount(inputs)
        await session.start()
        assert.equal(await session.evaluate('chapter'), 'updated chapter')
        assert.equal(await session.evaluate('Storages.getPlacedPath("chapter.tjs")'), 'game://./Novel/patch.xp3>chapter.tjs')
        if (!replay) await session.evaluate('saveChapter()')
        assert.equal(await session.evaluate('loadChapter()'), 'updated chapter|7')
        if (binary) assert.equal(Buffer.from(session.exportSaves().find((save) =>
          save.path === 'Novel/savedata/novel.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
      } finally { await session.stop() }
    }
  })

test('a subdirectory startup in a numbered ZIP opens its sibling game resources and writes beside the launcher', async () => {
  const entry = 'scripts/boot.tjs', zip = distributionZip([
    member('Edition/Story/Content-Data/Scripts/Boot.tjs', `System.exitOnNoWindowStartup=false;
var chapter=Scripts.evalStorage("chapter.tjs");[chapter].save(System.dataPath+"route.txt");`),
    member('Edition/Story/Content-Data/chapter.tjs', '"opening"'),
    member('Bonus/Tools/startup.tjs', 'throw "wrong startup";'),
  ])
  const step = async () => {}, files = [zip.subarray(0, 5), zip.subarray(5)]
    .map((part, i) => ({ path: 'story.zip.00' + (i + 1), source: new BlobSource(new Blob([Uint8Array.from(part).buffer])) }))
  const mount = await prepareProject(await importSources(files, step, { lazyArchives: true }), { mode: 'auto' }, archiveReader, step, entry)
  assert.equal(mount.project!.directory, 'Edition/Story/Content-Data/')
  const { session } = await headless({}, { project: mount.project })
  try {
    session.mount(mount.resources); await session.start(entry)
    assert.equal(await session.evaluate('chapter'), 'opening')
    assert.equal(await session.evaluate('[].load(System.dataPath+"route.txt")[0]'), 'opening')
    assert(session.exportSaves().some((f) => f.path === 'Edition/Story/savedata/route.txt'))
  } finally { await session.stop() }
})
