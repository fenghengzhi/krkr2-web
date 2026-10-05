import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { encodeBmp } from '../../src/formats/image/bmp.ts'
import { archiveReader } from '../../src/backends/files/archive-reader.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { cursorDib, cursorFile } from '../helpers/cursor-fixtures.ts'

const image = encodeBmp({ width: 2, height: 1, data: new Uint8Array([17,34,51,255,68,85,102,255]) }),
  cursor = cursorFile([{ width: 1, height: 1, payload: cursorDib({ width: 1, height: 1, depth: 24, xorRows: [[33,22,11]] }) }]),
  coverage = new Uint8Array(readFileSync(new URL('../fixtures/font/coverage-v1.tft', import.meta.url)))

async function using(binary: boolean, body: string,
  run: (f: Awaited<ReturnType<typeof headless>>, exec: (source: string) => Promise<string>) => Promise<void>,
  overrides: Partial<SessionDependencies> = {}) {
  const f = await headless({ 'startup.tjs': '', 'image.bmp': image, 'cursor.cur': cursor,
    'a.ttf': new Uint8Array([7]), 'coverage.tft': coverage,
    'pack.xp3': xp3Fixture({ 'inside.txt': 'archive bytes' }).bytes,
    'compact.tjs': String.raw`
var win=new Window();win.setInnerSize(12,4);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(12,4);root.fillRect(0,0,12,4,0xffabcdef);
var layer=new Layer(win,root);win.add(layer);layer.loadImages("image.bmp");layer.visible=true;
function warm(){System.touchImages(["image.bmp"]);}
${body}
` }, overrides)
  const errors: unknown[] = [], exec = (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await f.session.start()
    if (binary) {
      await exec('Scripts.compileStorage("compact.tjs","savedata/compact.cjs",false,true,false);Scripts.execStorage("savedata/compact.cjs");')
    } else await exec('Scripts.execStorage("compact.tjs");')
    await run(f, exec)
  } catch (error) { errors.push(error) }
  try { await f.session.stop(); assert.equal(f.session.snapshot().handles, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0)) }
  catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Compact scenario or cleanup failed')
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: native doCompact preserves argument policy and signed level thresholds`, { timeout: 60000 }, async () => {
    await using(binary, '', async (f, exec) => {
      assert.equal(await f.session.evaluate('int(System.doCompact instanceof "Function")'), '1')
      for (const level of ['-1','0','4','clIdle','9','clDeactivate','14','4294967306']) {
        await exec(`warm();var result=System.doCompact(${level});`)
        assert.equal(await f.session.evaluate('result===void'), '1')
        assert.equal(f.session.snapshot().imageCacheEntries, 1, level)
      }
      for (const args of ['clMinimize','clAll','4294967311','','void']) {
        await exec(`warm();System.doCompact(${args});`)
        assert.equal(f.session.snapshot().imageCacheEntries, 0, args)
      }
      await exec('warm();var converted=0,extra=0;try{System.doCompact(%[]);}catch(error){converted++;}System.doCompact(0,++extra);')
      assert.equal(await f.session.evaluate('converted+","+extra'), '1,1')
      assert.equal(f.session.snapshot().imageCacheEntries, 1)
      assert.equal(await f.session.evaluate('layer.getMainPixel(0,0)+","+layer.getMainPixel(1,0)'), '1122867,4478310')
    })
  })

  test(`${mode}: compact releases cached font faces at minimize while retaining explicit mappings and reporting listener errors`, { timeout: 60000 }, async () => {
    let loads = 0, closed = 0, scratch = 0, failClose = false
    await using(binary, 'root.font.face="a.ttf";root.font.faceIsFileName=true;', async (f, exec) => {
      assert.equal(await f.session.evaluate('root.font.getTextWidth("AA")'), '12')
      assert.equal(loads, 1)
      await exec('System.doCompact(clDeactivate);')
      assert.equal(closed, 0)
      assert.equal(await f.session.evaluate('root.font.getTextWidth("AA")'), '12')
      assert.equal(loads, 1)
      failClose = true
      await exec('System.doCompact(clMinimize);')
      assert.equal(closed, 1)
      assert.equal(scratch, 1, 'A faulty face listener must not skip the next scratch listener')
      assert(f.events.some((event) => event.type === 'log' && event.level === 'error' && event.text.includes('Compact Event (Font faces)')))
      assert.equal(await f.session.evaluate('root.font.getTextWidth("AA")'), '12')
      assert.equal(loads, 2)
      await exec('root.font.face="mapped";root.font.faceIsFileName=false;root.font.mapPrerenderedFont("coverage.tft");var mappedWidth=root.font.getTextWidth("AB");System.doCompact();')
      assert.equal(await f.session.evaluate('root.font.getTextWidth("AB")==mappedWidth'), '1')
      assert.equal(loads, 2)
    }, { graphics: { decode: async () => { throw new Error('unexpected native image decode') }, text: () => { throw new Error('unexpected text draw') },
      measure: () => ({ width: 6, height: 18 }),
      loadFont: async () => ({ face: 'face-' + ++loads, dispose() { closed++; if (failClose) { failClose = false; throw new Error('face cleanup failure') } } }),
      compact() { scratch++ },
    } })
    assert.equal(closed, 2)
  })

  test(`${mode}: compact preserves archive indexes, active Layers, saves, auto paths and stable cursor identities`, { timeout: 60000 }, async () => {
    let opens = 0
    await using(binary, String.raw`
Storages.addAutoPath("pack.xp3>");var originalText=[].load("inside.txt","utf-8")[0];
layer.cursor="cursor.cur";var originalCursor=layer.cursor;
["saved"].save("savedata/kept.txt","utf-8");
function retained(){
 System.doCompact();
 var result=originalText==[].load("inside.txt","utf-8")[0] && [].load("savedata/kept.txt","utf-8")[0]=="saved";
 layer.cursor="cursor.cur";
 return int(result)+","+int(originalCursor==layer.cursor)+","+layer.getMainPixel(1,0);
}
`, async (f) => {
      assert.equal(opens, 1)
      const assets = f.events.filter((event) => event.type === 'cursor-asset').length,
        before = f.session.snapshot().cursorCacheBytes
      assert.equal(await f.session.evaluate('retained()'), '1,1,4478310')
      assert.equal(opens, 1, 'Native compact does not clear the archive-index LRU')
      assert.equal(f.events.filter((event) => event.type === 'cursor-asset').length, assets)
      assert.equal(f.session.snapshot().cursorCacheBytes, before)
      assert.equal(f.session.snapshot().imageCacheEntries, 0)
    }, { archives: { ...archiveReader, async open(resource, checkpoint) {
      if (resource.name === 'pack.xp3') opens++
      return archiveReader.open(resource, checkpoint)
    } } })
  })

  test(`${mode}: compact inside an actual paint preserves the native call stack and does not request another paint`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
var paints=0,depth=0,maxDepth=0,proof="";
root.onPaint=function(){
 depth++;if(depth>maxDepth)maxDepth=depth;paints++;
 var local="kept UTF-16 あ😀",array=[local,42];
 System.doCompact();
 proof=array[0]+":"+array[1];root.fillRect(0,0,12,4,0xff123456);depth--;
};
function compactPaint(){root.update();win.update();return paints+","+maxDepth+","+proof+","+root.getMainPixel(8,2);}
`, async (f) => {
      assert.equal(await f.session.evaluate('compactPaint()'), '1,1,kept UTF-16 あ😀:42,1193046')
      await f.session.idle()
      assert.equal(await f.session.evaluate('paints'), '1')
    })
  })
}
