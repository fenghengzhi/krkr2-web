import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'

const program = String.raw`
System.exitOnNoWindowStartup=false;
var window=new Window(), layer=new Layer(window,null);
Storages.addAutoPath("D:/Routes/");Storages.addAutoPath("D:/Archive.zip>");
function chapter(){var p=new KAGParser();p.loadScenario("scene.ks");var tag=p.getNextTag();return tag.text;}
function discValues(){
 layer.loadImages("D:/Art.bmp");var pixel=layer.getMainPixel(0,0);
 return [chapter(),Scripts.evalStorage("bonus.tjs"),pixel,
  int(Storages.isExistentStorage("onlyA.tjs")),int(Storages.isExistentStorage("onlyB.tjs"))].join("|");
}
`
const image = (name: string) => readFileSync(new URL('../../out/verification/disc-volumes/swap-' + name + '.iso', import.meta.url))

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'} game reloads same-name scenes, archives and pictures after a live disc change`, { timeout: 90000 }, async () => {
  const a = image('A'), b = image('B')
  const { session } = await headless({ 'First.iso': a, 'next.tjs': program, 'startup.tjs': binary
    ? 'Scripts.compileStorage("next.tjs","savedata/handler.cjs",false,true,false);Scripts.execStorage("savedata/handler.cjs");'
    : 'Scripts.execStorage("next.tjs");' }, { cddaDiscs: [{ drive: 'D', cue: 'First.iso' }] })
  try {
    await session.start()
    const first = 'A|41|' + 0x336699 + '|1|0', second = 'B|82|' + 0x996633 + '|0|1'
    assert.equal(await session.evaluate('discValues()'), first)
    await session.evaluate('["chapter progress"].save(System.dataPath+"progress.txt")')
    // The physical filename is deliberately identical to the boot input.
    await session.changeDisc({ kind: 'insert', drive: 'D', cue: 'First.iso' }, async () => [
      { name: 'First.iso', size: b.length, read: async () => b },
    ])
    assert.equal(await session.evaluate('discValues()'), second)
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_SWAP_A")'), '')
    assert.equal(await session.evaluate('Storages.searchCD("KRKR_SWAP_B")'), 'D')
    await session.changeDisc({ kind: 'eject', drive: 'D' })
    assert.equal(await session.evaluate('int(Storages.isExistentStorage("onlyB.tjs"))'), '0')
    assert.equal(await session.evaluate('int(Storages.isExistentStorage("bonus.tjs"))'), '0')
    await session.changeDisc({ kind: 'reset', drive: 'D' })
    assert.equal(await session.evaluate('discValues()'), first)
    assert.equal(await session.evaluate('[].load(System.dataPath+"progress.txt")[0]'), 'chapter progress')
  } finally { await session.stop() }
})
