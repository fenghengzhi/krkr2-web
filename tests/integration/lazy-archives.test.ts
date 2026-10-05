import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { malformedXp3 } from '../helpers/lazy-archives.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { solidBmp } from '../helpers/archive-patch.ts'
import type { ArchiveReader } from '../../src/engine/ports/storage.ts'

const demand = 'function demand(a,b,label){if(a!==b)throw label+": expected "+b+" actual "+a;}\n'
async function fixture(binary: boolean, source: string, reader: ArchiveReader = archiveReader) {
  const f = await headless({
    'content-data/startup.tjs': binary
      ? 'Scripts.compileStorage("program.tjs",System.dataPath+"lazy.cjs",false,true,false);Scripts.execStorage(System.dataPath+"lazy.cjs");'
      : 'Scripts.execStorage("program.tjs");',
    'content-data/program.tjs': demand + source,
    'content-data/direct.tjs': '"direct"',
  }, { project: { directory: 'content-data/', executableDirectory: '' }, archives: reader })
  try {
    f.session.mount(await importResources([
      { path: 'data.xp3', blob: new Blob([malformedXp3.buffer]) },
      { path: 'bad.xp3', blob: new Blob([malformedXp3.buffer]) },
      { path: 'good.xp3', blob: new Blob([Uint8Array.from(xp3Fixture({
        'value.tjs': '"good"', 'pixel.bmp': solidBmp(0x778899),
      }).bytes).buffer]) },
    ], async () => f.session.control.check(), undefined, { lazyArchives: true }))
    return f
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: lower-priority malformed data archive does not block content-data, but member access preserves its real error`, { timeout: 60000 }, async () => {
    const opened: string[] = [], f = await fixture(binary, String.raw`
demand(Storages.isExistentStorage(System.exePath+"data.xp3"),true,"raw container exists");
demand(Storages.getPlacedPath("direct.tjs"),"game://./content-data/direct.tjs","current project direct");
var failure="";try{Scripts.execStorage("/data.xp3>startup.tjs");}catch(error){failure=error.message;}
demand(failure,"Unsupported XP3 index compression: 7","access-time index error");
demand(Scripts.evalStorage("direct.tjs"),"direct","VM recovers after caught index failure");
var complete=true;
`, { ...archiveReader, async open(resource, checkpoint) { opened.push(resource.name); return archiveReader.open(resource, checkpoint) } })
    try {
      assert.deepEqual(opened, [], 'Mount does not open indices')
      await f.session.start()
      assert.equal(await f.session.evaluate('complete'), '1')
      assert.deepEqual([...opened], ['data.xp3'])
      assert.equal(f.session.snapshot().state, 'running')
    } finally { await f.session.stop() }
  })

  test(`${mode}: AutoPath registration defers errors, rebuild visits old bad paths, remove recovers real script/image and readonly UPDATE`, { timeout: 60000 }, async () => {
    const opened: string[] = [], f = await fixture(binary, String.raw`
Storages.addAutoPath("/bad.xp3>");Storages.addAutoPath("/good.xp3>");
demand(Scripts.evalStorage("direct.tjs"),"direct","direct hit bypasses table");
var failure="";try{Scripts.evalStorage("value.tjs");}catch(error){failure=error.message;}
demand(failure,"Unsupported XP3 index compression: 7","older registered package must not be skipped");
Storages.removeAutoPath("/bad.xp3>");
demand(Scripts.evalStorage("value.tjs"),"good","remove failed registration");
var win=new Window();win.setInnerSize(4,3);var root=new Layer(win,null);win.add(root);root.setSize(4,3);var image=new Layer(win,root);
image.loadImages("pixel.bmp");demand(image.getMainPixel(1,1),0x778899,"actual indexed bitmap");
System.assignMessage("TVPCannotWriteToArchive","lazy-archives:readonly");
var denied=0;try{["overwrite"].save("value.tjs","utf-8o0");}catch(error){if(error.message!=="lazy-archives:readonly")throw error;denied++;}
demand(denied,1,"UPDATE binds archive readonly path");
demand(Storages.getPlacedPath("value.tjs"),"game://./good.xp3>value.tjs","canonical identity");
var complete=true;
`, { ...archiveReader, async open(resource, checkpoint) { opened.push(resource.name); return archiveReader.open(resource, checkpoint) } })
    try {
      await f.session.start()
      assert.equal(await f.session.evaluate('complete'), '1')
      assert.deepEqual([...opened], ['bad.xp3', 'good.xp3'])
      assert.equal(f.session.exportSaves().some((entry) => entry.path === 'content-data/value.tjs'), false)
    } finally { await f.session.stop() }
  })

  test(`${mode}: Stop cancels VM storage wait before the underlying archive index IO settles`, { timeout: 60000 }, async () => {
    let entered!: () => void, release!: () => void
    const inside = new Promise<void>((resolve) => { entered = resolve }),
      gate = new Promise<void>((resolve) => { release = resolve }),
      f = await fixture(binary, 'Scripts.execStorage("/good.xp3>value.tjs");Debug.message("after-index-must-not-run");', {
        ...archiveReader, async open(resource, checkpoint) {
          entered(); await gate; return archiveReader.open(resource, checkpoint)
        },
      }), starting = f.session.start(), rejected = assert.rejects(starting, /cancel|disposed|stopped/i)
    try {
      await inside
      await f.session.stop()
      await rejected
      assert.equal(f.session.snapshot().state, 'stopped')
      assert.equal(f.session.snapshot().handles, 0)
      assert.equal(f.logs.includes('after-index-must-not-run'), false)
      release(); await Promise.resolve(); await Promise.resolve()
      assert.equal(f.session.snapshot().state, 'stopped')
      assert.equal(f.logs.includes('after-index-must-not-run'), false)
    } finally { release(); await f.session.stop(); await rejected }
  })
}
