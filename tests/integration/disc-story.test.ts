import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'
import { discStoryCue, discStoryImage } from '../helpers/disc-story.ts'
import { readFileSync } from 'node:fs'

const source = String.raw`
System.exitOnNoWindowStartup=false;
var drive=Storages.searchCD("krkr_story"),chapter=drive+":\\Routes\\Moon Finale.tjs";
var full=Storages.getFullPath(chapter),local=Storages.getLocalName(full),placed=Storages.getPlacedPath(local);
var routes=drive+":/Routes/",books=drive+":/Books/Scenes.zip>";
var original=Scripts.evalStorage(chapter),japanese=Scripts.evalStorage(routes+"開幕.tjs");
Storages.addAutoPath(routes);Storages.addAutoPath(books);
var searches=[Scripts.evalStorage("Moon Finale.tjs"),Scripts.evalStorage("bonus.tjs"),Storages.getPlacedPath("開幕.tjs")];
Storages.removeAutoPath(routes);Storages.removeAutoPath(books);
var misses=[int(Storages.isExistentStorage("開幕.tjs")),int(Storages.isExistentStorage(drive+":/Empty.dat")),
 int(Storages.isExistentStorage(drive+":/Empty/")),Storages.getPlacedPath(drive+":/absent.tjs")];
var refused=0;
try { ["overwritten"].save(local); } catch(e) {refused++;}
try { Scripts.compileStorage(chapter,drive+":/New.cjs",true,true,true); } catch(e) {refused++;}
var result=[drive,full,local,placed,original,japanese,searches.join("|"),misses.join("|"),refused,Scripts.evalStorage(chapter)].join("|");
`

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: ISO drive names round-trip through the VM, directory and archive auto paths and read-only storage`, async () => {
  const { session } = await headless({
    'startup.tjs': binary
      ? 'Scripts.compileStorage("verify.tjs","savedata/verify.cjs",false,true,false);Scripts.execStorage("savedata/verify.cjs");'
      : 'Scripts.execStorage("verify.tjs");',
    'verify.tjs': source, 'story.cue': discStoryCue, 'story.iso': discStoryImage(),
    'empty.cue': 'FILE "not-imported.bin" BINARY\n TRACK 01 MODE1/2048\n INDEX 01 00:00:00\n',
  }, { cddaDiscs: [{ drive: 'G', cue: 'story.cue' }, { drive: 'H', cue: 'empty.cue' }] })
  try {
    await session.start()
    const name = 'file://./g/routes/moon finale.tjs'
    assert.equal(await session.evaluate('result'), ['G', name, 'g:\\routes\\moon finale.tjs', name, 'Moon disc scene', 42,
      'Moon disc scene', 81, 'file://./g/routes/開幕.tjs', 0, 1, 0, '', 2, 'Moon disc scene'].join('|'))
    assert(session.exportSaves().every((file) => !file.path.startsWith('file:') && !file.path.includes(':')))
    assert.equal(await session.evaluate('(Storages.addAutoPath("H:/Routes/"),int(Storages.isExistentStorage("H:/missing.tjs")))'), '0')
  } finally { await session.stop() }
})

test('a bare ISO is identified as D, and replacing its source invalidates filenames, auto paths and the volume label', async () => {
  const { session } = await headless({ 'startup.tjs': 'System.exitOnNoWindowStartup=false;', 'game.iso': discStoryImage() })
  try {
    // An embedding can replace imported files while the initialized VM is
    // ready. A live, running game cannot be remounted.
    assert.equal(await session.evaluate('Storages.searchCD("krkr_story")'), 'D')
    assert.equal(await session.evaluate('(Storages.addAutoPath("D:/Routes/"),Scripts.evalStorage("Moon Finale.tjs"))'), 'Moon disc scene')
    const bytes = readFileSync(new URL('../../out/verification/disc-volumes/plain.iso', import.meta.url))
    session.mount([{ name: 'game.iso', size: bytes.length, source: { size: bytes.length, read: async (p, n) => bytes.subarray(p, p + n) },
      read: async () => { throw new Error('ISO replacement must use bounded source reads') } }])
    assert.equal(await session.evaluate('[Storages.searchCD("KRKR_PLAIN"),Storages.searchCD("KRKR_STORY"),int(Storages.isExistentStorage("Moon Finale.tjs"))].join("|")'), 'D||0')
    assert.equal(await session.evaluate('[].load("D:/scene.txt","utf-8")[0]'), 'Disc identification scene')
  } finally { await session.stop() }
})
