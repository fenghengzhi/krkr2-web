import assert from 'node:assert/strict'
import test from 'node:test'
import { createSessionArchiveReader } from '../../src/backends/files/archive-reader.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import { prepareProject } from '../../src/engine/storage/distribution.ts'
import { headless } from '../helpers/headless.ts'
import { udfGameDisc } from '../helpers/udf-game-discs.ts'

function pressing(binary: boolean): Resource {
  const { buffer } = udfGameDisc(binary).files[0]!
  return { name: 'Game.iso', size: buffer.length, source: { size: buffer.length, async read(at, length) {
    assert(at >= 0 && at + length <= buffer.length)
    assert(length <= 65536, 'The game should read disc sectors in bounded ranges')
    return buffer.subarray(at, at + length)
  } }, read: async () => { throw new Error('Unexpected whole DVD read') } }
}

test('a UDF game keeps its directory, mounted archives and save when the same drive changes UDF revision', async (t) => {
  const first = pressing(false), next = pressing(true), drive = { drive: 'G', cue: first.name }
  const archives = createSessionArchiveReader()
  t.after(() => archives.dispose())
  const mount = await prepareProject([first], { mode: 'collection' }, archives, async () => {}, 'startup.tjs', [drive])
  assert.equal(mount.project?.bootDisc, first.name)
  const { session } = await headless({}, { project: mount.project, cddaDiscs: [drive] })
  t.after(() => session.stop())
  session.mount(mount.resources)
  const sourceText = () => session.evaluate('[].load(System.exePath+"AfterInit2.tjs").join("\\n")')
  const bootHook = await sourceText()
  assert.match(bootHook, /Scripts\.execStorage/)
  assert.doesNotMatch(bootHook, /Scripts\.compileStorage/)
  assert.equal(await session.evaluate(`(function(){
    var drive=Storages.searchCD("krkr_story"),scene=Scripts.evalStorage(drive+":/Routes/開幕.tjs");
    var window=new Window(), layer=new Layer(window,null);
    layer.loadImages(drive+":/Art/Title.bmp");
    var locked=0;try{["change"].save(drive+":/Routes/開幕.tjs");}catch(e){locked++;}
    [scene].save(System.dataPath+"udf-slot.txt");
    return [drive,System.exePath,Storages.getPlacedPath("startup.tjs"),
      scene,Scripts.evalStorage("G:/Books/Scenes.zip>Bonus.tjs"),layer.getMainPixel(0,0),locked].join("|");})()`),
    'G|file://./g/discgame/|file://./g/discgame/data.xp3>startup.tjs|42|81|' + 0x336699 + '|1')
  await session.changeDisc({ kind: 'insert', ...drive }, async () => [next])
  assert.match(await sourceText(), /Scripts\.compileStorage/)
  assert.equal(await session.evaluate('Storages.searchCD("KRKR_STORY")'), 'G')
  await session.changeDisc({ kind: 'eject', drive: 'G' })
  assert.equal(await session.evaluate('int(Storages.isExistentStorage("G:/Routes/開幕.tjs"))'), '0')
  await session.changeDisc({ kind: 'reset', drive: 'G' })
  assert.equal(await sourceText(), bootHook)
  assert.equal(await session.evaluate('[].load(System.dataPath+"udf-slot.txt")[0]'), '42')
  assert(session.exportSaves().some((file) => file.path === 'savedata/udf-slot.txt'))
})
