import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'
import { headless } from '../helpers/headless.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: a custom ZIP entry keeps its selected cwd, archive reads and save namespace on a frozen reopen`, { timeout: 60000 }, async () => {
  const program = String.raw`
System.exitOnNoWindowStartup=false;
var entryValue=Scripts.evalStorage("chapter.tjs"),archiveValue=Scripts.evalStorage("engine.xp3>value.tjs");
function entryState(){return [entryValue,archiveValue,System.exePath,System.dataPath,Storages.getFullPath("chapter.tjs")].join("|");}
function writeEntry(){[entryValue,archiveValue].save(System.dataPath+"entry.txt");}
function readEntry(){return [].load(System.dataPath+"entry.txt").join("|");}
`, bytes = distributionZip([
    member('Release/data/boot.tjs', binary
      ? 'Scripts.compileStorage("game.tjs",System.dataPath+"entry.cjs",false,true,false);Scripts.execStorage(System.dataPath+"entry.cjs");'
      : 'Scripts.execStorage("game.tjs");'),
    member('Release/data/game.tjs', program), member('Release/data/chapter.tjs', '"chosen chapter"'),
    member('Release/data/outer.tjs', binary
      ? 'Scripts.compileStorage("custom-release.zip>Release/data/outer-game.tjs",System.dataPath+"outer.cjs",false,true,false);Scripts.execStorage(System.dataPath+"outer.cjs");'
      : 'Scripts.execStorage("custom-release.zip>Release/data/outer-game.tjs");'),
    member('Release/data/outer-game.tjs', 'System.exitOnNoWindowStartup=false;var outerValue=Scripts.evalStorage("custom-release.zip>Release/data/chapter.tjs");'),
    member('Release/data/engine.xp3', xp3Fixture({ 'value.tjs': '"chosen archive"' }).bytes),
    member('Release/Tools/startup.tjs', 'throw new Exception("Wrong tools project");'),
  ]), resource: Resource = { name: 'custom-release.zip', size: bytes.length,
    source: { size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) },
    read: async () => { throw new Error('Unexpected whole distribution read') } },
    reader = createSessionArchiveReader(), saves = new MemorySaveStore(), failures: unknown[] = []
  try {
    const selected = await prepareProject([resource], { mode: 'auto' }, reader, async () => {}, 'boot.tjs')
    assert.deepEqual(selected.project, { directory: 'Release/data/', executableDirectory: 'Release/', distribution: resource.name })
    for (const fresh of [false, true]) {
      const prepared = fresh
        ? await prepareProject([resource], { mode: 'root', ...selected.project! }, reader, async () => {}, 'startup.tjs')
        : selected, { session } = await headless({}, { project: prepared.project, saveStore: saves })
      try {
        session.mount(prepared.resources); await session.start('boot.tjs')
        assert.equal(await session.evaluate('entryState()'),
          'chosen chapter|chosen archive|game://./Release/|game://./Release/savedata/|game://./Release/data/chapter.tjs')
        if (!fresh) await session.evaluate('writeEntry()')
        assert.equal(await session.evaluate('readEntry()'), 'chosen chapter|chosen archive')
        assert(session.exportSaves().some((file) => file.path === 'Release/savedata/entry.txt'))
        if (binary) assert.equal(Buffer.from(session.exportSaves().find((file) => file.path === 'Release/savedata/entry.cjs')!.bytes.subarray(0, 4)).toString(), 'TJS2')
      } catch (error) { failures.push(error) }
      try { await session.stop() } catch (error) { failures.push(error) }
      if (failures.length) break
    }
    if (!failures.length) {
      const entry = 'custom-release.zip>Release/data/outer.tjs',
        outer = await prepareProject([resource], { mode: 'auto' }, reader, async () => {}, entry)
      assert.deepEqual(outer, { resources: [resource], project: { directory: '', executableDirectory: '' } })
      for (const fresh of [false, true]) {
        const prepared = fresh
          ? await prepareProject([resource], { mode: 'root', ...outer.project! }, reader, async () => {}, entry)
          : outer, { session } = await headless({}, { project: prepared.project, saveStore: saves })
        try {
          session.mount(prepared.resources); await session.start(entry)
          assert.equal(await session.evaluate('[outerValue,System.exePath,System.dataPath].join("|")'),
            'chosen chapter|game://./|game://./savedata/')
          if (!fresh) await session.evaluate('[outerValue].save(System.dataPath+"outer.txt")')
          assert.equal(await session.evaluate('[].load(System.dataPath+"outer.txt").join("|")'), 'chosen chapter')
          if (binary) assert.equal(Buffer.from(session.exportSaves().find((file) => file.path === 'savedata/outer.cjs')!.bytes.subarray(0, 4)).toString(), 'TJS2')
        } catch (error) { failures.push(error) }
        try { await session.stop() } catch (error) { failures.push(error) }
        if (failures.length) break
      }
    }
  } catch (error) { failures.push(error) }
  try { reader.dispose() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Custom ZIP startup or cleanup failed', { cause: failures[0] })
})
