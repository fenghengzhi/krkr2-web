import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { BlobSource } from '../../src/backends/files/blob-source.ts'

const program = String.raw`
var win=new Window();win.setInnerSize(3,2);var image=new Layer(win,null);win.add(image);image.setSize(3,2);image.setImageSize(3,2);
image.fillRect(0,0,3,2,0xff778899);
function requireReadonly(call,target){try{call(target);}catch(error){if(error.message.indexOf("read-only")<0)throw error;return 1;}throw "write unexpectedly succeeded";}
function writes(path,empty,ancestor){
 var denied=0;
 // TJS function values do not capture the enclosing function's locals.
 // Pass each target explicitly so every actual writer reaches the readonly sink.
 denied+=requireReadonly(function(target){["changed"].save(target,"utf-8");},path);
 denied+=requireReadonly(function(target){["changed"].save(target,"utf-8a");},path);
 denied+=requireReadonly(function(target){["changed"].save(target,"utf-8o0");},path);
 denied+=requireReadonly(function(target){var value=%[state:"changed"];(Dictionary.saveStruct incontextof value)(target,"b");},path);
 denied+=requireReadonly(function(target){["changed",42].saveStruct(target,"b");},path);
 denied+=requireReadonly(function(target){Scripts.compileStorage("compile-source.tjs",target,false,true,false);},path);
 denied+=requireReadonly(function(target){global.image.saveLayerImage(target,"bmp32");},path);
 denied+=requireReadonly(function(target){["new file"].save(target,"utf-8");},empty+"new.sav");
 denied+=requireReadonly(function(target){["ancestor"].save(target,"utf-8");},ancestor);
 denied+=requireReadonly(function(target){["case alias"].save(target.toUpperCase(),"utf-8");},path);
 ["kept"].save("savedata/healthy.txt","utf-8");
 return denied+"|"+[].load(path,"utf-8")[0];
}
`

for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: every real VM writer and atomic save import rejects dropped namespace shadowing`, { timeout: 60000 }, async () => {
  const f = await headless({ 'matrix.tjs': program, 'compile-source.tjs': '42;',
    'startup.tjs': binary
      ? 'Scripts.compileStorage("matrix.tjs","savedata/drop-matrix.cjs",false,true,false);Scripts.execStorage("savedata/drop-matrix.cjs");'
      : 'Scripts.execStorage("matrix.tjs");',
  })
  try {
    await f.session.start()
    const names = await f.session.commitDroppedResources({ roots: [{ name: 'original.txt', kind: 'file' }, { name: 'Empty', kind: 'directory' }], entries: [
      { root: 0, path: '', kind: 'file', source: new BlobSource(new Blob(['original\n'])) },
      { root: 1, path: '', kind: 'directory' },
    ] }, () => true), ancestor = names[0]!.slice(0, names[0]!.indexOf('/0/'))
    assert.equal(await f.session.evaluate(`writes(${JSON.stringify(names[0])},${JSON.stringify(names[1])},${JSON.stringify(ancestor)})`), '10|original')
    const before = f.session.exportSaves()
    f.session.pause()
    await assert.rejects(f.session.importSaves([
      { path: 'savedata/healthy.txt', bytes: new TextEncoder().encode('corrupt') },
      { path: 'savedata/new.txt', bytes: new Uint8Array([9]) },
      { path: names[0]!.slice('game://./'.length).toUpperCase(), bytes: new Uint8Array([10]) },
    ]), /read-only/)
    assert.deepEqual(f.session.exportSaves(), before)
    f.session.resume()
    assert.equal(await f.session.evaluate(`[].load(${JSON.stringify(names[0])},"utf-8")[0]`), 'original')
    assert.equal(await f.session.evaluate('[].load("savedata/healthy.txt","utf-8")[0]'), 'kept')
  } finally { await f.session.stop() }
  assert.equal(f.session.snapshot().resources, 0)
  assert.equal(f.session.snapshot().handles, 0)
})
