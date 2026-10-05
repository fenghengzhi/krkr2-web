import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { archivePatchFiles, kagAutoPathProgram, patchColors, solidBmp } from '../helpers/archive-patch.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'

const program = String.raw`
var patchWindow=new Window();patchWindow.setInnerSize(4,3);
var patchRoot=new Layer(patchWindow,null);patchRoot.setSize(4,3);
var patchImage=new Layer(patchWindow,patchRoot);
function patchRead(action){
 if(action=="remove2")Storages.removeAutoPath("patch2.xp3>");
 if(action=="remove1")Storages.removeAutoPath("patch.xp3>");
 if(action=="add2")Storages.addAutoPath("patch2.xp3>");
 if(action=="duplicate1")Storages.addAutoPath("patch.xp3>");
 patchImage.loadImages("patch-probe.bmp");
 return Scripts.evalStorage("patch-value.tjs")+"|"+Storages.getPlacedPath("patch-value.tjs")+"|"+
  patchImage.getMainPixel(1,1)+"|"+Storages.getPlacedPath("patch-probe.bmp");
}
function denyArchiveUpdates(){
 var denied=0,modes=["utf-8a","utf-8o0"];
 for(var j=0;j<modes.count;j++){
  try{["corrupt"].save("patch-value.tjs",modes[j]);}
  catch(error){if(error.message.indexOf("read-only")<0)throw error;denied++;}
 }
 try{["corrupt"].save("patch2.xp3>patch-value.tjs","utf-8");}
 catch(error){if(error.message.indexOf("read-only")<0)throw error;denied++;}
 return denied;
}
function createLooseOverlay(){
 ['"saved"'].save("patch-value.tjs","utf-8");
 patchImage.loadImages("replacement.bmp");patchImage.saveLayerImage("patch-probe.bmp","bmp32");
 return patchRead("");
}
`

async function fixture(binary: boolean, store = new MemorySaveStore(), reverse = false) {
  const original = await kagAutoPathProgram(), source = original.source + program,
    f = await headless({
      'startup.tjs': binary
        ? 'Scripts.compileStorage("archive-search.tjs","savedata/archive-search.cjs",false,true,false);Scripts.execStorage("savedata/archive-search.cjs");'
        : 'Scripts.execStorage("archive-search.tjs");',
      'archive-search.tjs': source, 'replacement.bmp': solidBmp(0xabcdef),
    }, { saveStore: store }), files = archivePatchFiles()
  if (reverse) files.reverse()
  try {
    f.session.mount(await importResources(files.map(({ path, bytes }) => ({ path,
      blob: new Blob([Uint8Array.from(bytes).buffer]) })), async () => f.session.control.check()))
    await f.session.start()
    return { ...f, store, original }
  } catch (error) { await f.session.stop(); throw error }
}

const expected = (label: 'base' | 'patch' | 'patch2') => label === 'base'
  ? `base|game://./data.xp3>system/patch-value.tjs|${patchColors.base}|game://./data.xp3>image/patch-probe.bmp`
  : `${label}|game://./${label}.xp3>patch-value.tjs|${patchColors[label]}|game://./${label}.xp3>patch-probe.bmp`

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  for (const reverse of [false, true])
    test(`${mode}/${reverse ? 'reverse' : 'forward'} imports: original KAG registration controls real script and cached image placement`, { timeout: 60000 }, async (t) => {
      const f = await fixture(binary, undefined, reverse)
      t.diagnostic(JSON.stringify({ original: 'system/Initialize.tjs', ...f.original, source: undefined }))
      try {
        assert.equal(await f.session.evaluate('patchRead("")'), expected('patch2'))
        const first = f.session.snapshot()
        assert.equal(await f.session.evaluate('patchRead("duplicate1")'), expected('patch2'))
        assert.equal(f.session.snapshot().imageCacheMisses, first.imageCacheMisses)
        assert(f.session.snapshot().imageCacheHits > first.imageCacheHits)
        assert.equal(await f.session.evaluate('patchRead("remove2")'), expected('patch'))
        assert.equal(await f.session.evaluate('patchRead("remove1")'), expected('base'))
        const base = f.session.snapshot()
        assert.equal(base.imageCacheMisses, first.imageCacheMisses + 2)
        assert.equal(await f.session.evaluate('patchRead("add2")'), expected('patch2'))
        assert.equal(f.session.snapshot().imageCacheMisses, base.imageCacheMisses, 'Revisiting the same canonical source reuses its own cache entry')
        assert(f.session.snapshot().imageCacheHits > base.imageCacheHits)
        assert.equal(await f.session.evaluate('Scripts.evalStorage("data.xp3>system/patch-value.tjs")'), 'base')
        assert.equal(await f.session.evaluate('Scripts.evalStorage("patch4.xp3>patch-value.tjs")'), 'patch4')
        assert.equal(await f.session.evaluate('Storages.isExistentStorage("patch4.xp3")'), '1')
        // TJS typeof still resolves a missing bare global and throws. Catch
        // that exact native error inside the VM; the Session must stay live.
        assert.equal(await f.session.evaluate('(function(){try{return "present:"+useArchiveIfExists;}catch(error){return error.message;}})()'),
          'Member "useArchiveIfExists" does not exist', 'The original initializer also removes its temporary helper')
        if (binary) assert(f.session.exportSaves().some((entry) => entry.path === 'savedata/archive-search.cjs' && Buffer.from(entry.bytes.subarray(0, 4)).toString() === 'TJS2'))
      } finally { await f.session.stop() }
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    })

  test(`${mode}: bare archive UPDATE stays read-only while explicit loose WRITE survives a fresh KAG initialization`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(await f.session.evaluate('patchRead("")'), expected('patch2'))
      assert.equal(await f.session.evaluate('denyArchiveUpdates()'), '3')
      assert.equal(f.session.exportSaves().some((entry) => entry.path === 'patch-value.tjs'), false)
      const saved = `saved|game://./patch-value.tjs|${0xabcdef}|game://./patch-probe.bmp`
      assert.equal(await f.session.evaluate('createLooseOverlay()'), saved)
      assert.equal(await f.session.evaluate('patchRead("remove2")'), saved)
      assert.equal(await f.session.evaluate('Scripts.evalStorage("patch2.xp3>patch-value.tjs")'), 'patch2')
      assert.equal(await f.session.evaluate('(function(){patchImage.loadImages("patch2.xp3>patch-probe.bmp");return patchImage.getMainPixel(1,1);})()'), String(patchColors.patch2))
      await f.session.stop()
      const next = await fixture(binary, f.store, true)
      try {
        assert.equal(await next.session.evaluate('patchRead("")'), saved)
        assert.equal(await next.session.evaluate('Scripts.evalStorage("patch2.xp3>patch-value.tjs")'), 'patch2')
        assert.equal(next.session.snapshot().pendingSaves, 0)
      } finally { await next.session.stop() }
    } finally { await f.session.stop() }
  })
}
