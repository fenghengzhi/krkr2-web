import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { importResources } from '../../src/backends/files/import-resources.ts'
import { HeadlessWindowGeometry } from '../../src/engine/scene/window-geometry.ts'
import type { WindowGeometryRequest } from '../../src/engine/ports/window-geometry.ts'
import type { TvpMessageId } from '../../src/engine/system/tvp-message-ids.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

// Every failing public operation below is part of this source or its actual
// compiled bytecode. No fixture host manufactures a TvpError.
const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(12,8);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(12,8);root.fillRect(0,0,12,8,0xff123456);
var child=new Layer(win,root);win.add(child);child.setImageSize(4,3);child.setSize(4,3);child.visible=true;
var binder=new Layer(win,root);win.add(binder);binder.type=ltBinder;
var menuA=new MenuItem(win,"A"),menuB=new MenuItem(win,"B"),itemA=new MenuItem(win,"a"),itemB=new MenuItem(win,"b");
win.menu.add(menuA);win.menu.add(menuB);menuA.add(itemA);menuB.add(itemB);win.setInnerSize(12,8);
function assign(id,value){return System.assignMessage(id,value);}
function storageFailure(which){
 try{
  if(which==0)Scripts.execStorage("missing-script.tjs");
  else if(which==1){var rows=[];rows.load("missing-lines.txt");}
  else if(which==2){var rows=[];rows.loadStruct("missing-struct.bin");}
  else if(which==3)["bad"].save("missing-update.txt","utf-8o0");
  else if(which==4)["bad"].save("bundle.xp3>kept.txt","utf-8");
  else if(which==5)Storages.addAutoPath("missing-slash");
  else if(which==6)return Storages.getFullPath("https://example.invalid/file");
  else if(which==7)return Storages.getLocalName("bundle.xp3>kept.txt");
  else if(which==8)["bad"].saveStruct("bundle.xp3>kept.txt","b");
  else throw new Exception("unknown storage case");
 }catch(error){return error.message;}
 return "NO_ERROR";
}
function readArchive(){var rows=[];rows.load("bundle.xp3>kept.txt");return rows.join("|");}
function layerFailure(which){
 try{
  if(which==0)root.setPos(1,0);
  else if(which==1)root.visible=false;
  else if(which==2)root.opacity=128;
  else if(which==3)child.imageLeft=1;
  else if(which==4)child.setImageSize(0,3);
  else if(which==5)child.parent=child;
  else if(which==6)binder.fillRect(0,0,1,1,0xffabcdef);
  else if(which==7)binder.hasImage=true;
  else if(which==8)child.setSize(5000,3);
  else if(which==9)child.copyRect(0,0,binder,0,0,1,1);
  else if(which==10)binder.copyRect(0,0,child,0,0,1,1);
  else if(which==11)child.imageWidth=0;
  else if(which==12)child.imageHeight=0;
  else throw new Exception("unknown layer case");
 }catch(error){return error.message;}
 return "NO_ERROR";
}
function layerState(){return [root.left,root.top,root.visible,root.opacity,child.width,child.height,child.imageWidth,child.imageHeight,
 child.imageLeft,child.imageTop,child.parent==root,binder.hasImage].join("|");}
function imageState(){return [child.width,child.height,child.imageWidth,child.imageHeight,child.imageLeft,child.imageTop].join("|");}
function restoreBounds(){child.setSize(4,3);return layerState();}
function menuFailure(){try{menuA.remove(itemB);}catch(error){return error.message;}return "NO_ERROR";}
function menuState(){return [menuA.children.count,menuB.children.count,itemA.parent==menuA,itemB.parent==menuB].join("|");}
function fullscreen(value){win.fullScreen=value;return win.fullScreen;}
function windowFailure(which){
 try{if(which==0)win.width=99;else win.menu.visible=false;}catch(error){return error.message;}
 return "NO_ERROR";
}
function windowState(){return [win.width,win.height,win.left,win.top,win.fullScreen,win.menu.visible].join("|");}
function rename(){win.caption="Allowed in fullscreen";return win.caption;}
var unlayered=void;
function noLayerFailure(){
 if(unlayered===void)unlayered=new Window();
 try{unlayered.setMaskRegion();}catch(error){return error.message;}
 return "NO_ERROR";
}
`

/** Observe actual geometry acknowledgments, using the explicit unframed host
 * implementation. This is not evidence about native desktop fullscreen. */
class ObservedGeometry extends HeadlessWindowGeometry {
  readonly acknowledged: { id: number; fullScreen: boolean; revision: number }[] = []
  override async measure(request: WindowGeometryRequest) {
    const result = await super.measure(request)
    this.acknowledged.push({ id: request.windowId, fullScreen: request.view.fullScreen, revision: result.revision })
    return result
  }
}

async function fixture(binary: boolean) {
  const geometry = new ObservedGeometry(), archive = xp3Fixture({ 'kept.txt': 'original' }, { compressed: true }),
    f = await headless({ 'tvp-consumers.tjs': source, 'startup.tjs': binary
      ? 'Scripts.compileStorage("tvp-consumers.tjs","savedata/tvp-consumers.cjs",false,true,false);Scripts.execStorage("savedata/tvp-consumers.cjs");'
      : 'Scripts.execStorage("tvp-consumers.tjs");' }, { windowGeometry: geometry })
  try {
    f.session.mount(await importResources([{ path: 'bundle.xp3',
      blob: new Blob([Uint8Array.from(archive.bytes).buffer]) }], async () => f.session.control.check(), undefined, { lazyArchives: true }))
    await f.session.start()
    await f.session.idle()
    if (binary) {
      const saved = f.session.exportSaves().find((file) => file.path === 'savedata/tvp-consumers.cjs')
      assert(saved)
      assert.equal(new TextDecoder().decode(saved.bytes.subarray(0, 4)), 'TJS2')
    }
    return { ...f, geometry,
      assign: async (id: TvpMessageId, value: string) =>
        assert.equal(await f.session.evaluate(`assign(${JSON.stringify(id)},${JSON.stringify(value)})`), '1'),
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'TVP consumer setup and cleanup failed', { cause: error }) }
    throw error
  }
}
async function using(binary: boolean, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary), errors: unknown[] = []
  try { await body(f) } catch (error) { errors.push(error) }
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().state, 'stopped')
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'TVP consumer or cleanup failed', { cause: errors[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: actual script lookup and native Array streams retain distinct Find/Open holders and original name parameters`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      assert.equal(await f.session.evaluate('storageFailure(0)'), 'ストレージ missing-script.tjs が見つかりません')
      assert.equal(await f.session.evaluate('storageFailure(1)'), 'ストレージ missing-lines.txt を開くことができません')
      await f.assign('TVPCannotFindStorage', 'find[%1] %% %2 日本語😀')
      await f.assign('TVPCannotOpenStorage', 'open[%1]/%1')
      assert.equal(await f.session.evaluate('storageFailure(0)'), 'find[missing-script.tjs] % %2 日本語😀')
      assert.equal(await f.session.evaluate('storageFailure(1)'), 'open[missing-lines.txt]/missing-lines.txt')
      assert.equal(await f.session.evaluate('storageFailure(2)'), 'open[missing-struct.bin]/missing-struct.bin')
      assert.equal(await f.session.evaluate('storageFailure(3)'), 'open[missing-update.txt]/missing-update.txt')
      assert.equal(f.session.exportSaves().some((file) => file.path === 'missing-update.txt'), false)
      assert.equal(f.session.snapshot().state, 'running', 'Real TJS callers catch every failure')
    })
  })

  test(`${mode}: actual XP3 write rejection, auto-path delimiter and local-name errors read assigned TVP holders without changing archive bytes`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      assert.equal(await f.session.evaluate('readArchive()'), 'original')
      assert.equal(await f.session.evaluate('storageFailure(4)'), 'アーカイブにデータを書き込むことはできません')
      await f.assign('TVPCannotWriteToArchive', 'archive %% %1 stays literal')
      await f.assign('TVPMissingPathDelimiterAtLast', 'delimiter %% %1 stays literal')
      await f.assign('TVPCannotGetLocalName', 'local:%1')
      await f.assign('TVPUnsupportedMediaName', 'media:%1')
      for (const operation of [4, 8])
        assert.equal(await f.session.evaluate(`storageFailure(${operation})`), 'archive %% %1 stays literal')
      assert.equal(await f.session.evaluate('storageFailure(5)'), 'delimiter %% %1 stays literal')
      assert.equal(await f.session.evaluate('storageFailure(6)'), 'media:https')
      assert.equal(await f.session.evaluate('storageFailure(7)'), 'local:bundle.xp3>kept.txt')
      assert.equal(await f.session.evaluate('readArchive()'), 'original')
      assert.equal(f.session.exportSaves().some((file) => file.path.includes('bundle.xp3')), false)
      assert.equal(f.session.snapshot().pendingSaves, 0)
    })
  })

  test(`${mode}: actual Layer constraints translate at the native boundary while rejected mutations and Web budgets remain intact`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      assert.equal(await f.session.evaluate('layerFailure(0)'), 'プライマリレイヤは移動できません')
      assert.equal(await f.session.evaluate('layerFailure(2)'), 'プライマリレイヤは不可視にできません')
      const before = await f.session.evaluate('layerState()')
      assert.equal(before, '0|0|1|255|4|3|4|3|0|0|1|0')
      const cases: readonly (readonly [number, TvpMessageId])[] = [
        [0, 'TVPCannotMovePrimary'], [1, 'TVPCannotSetPrimaryInvisible'], [2, 'TVPCannotSetPrimaryInvisible'],
        [3, 'TVPInvalidImagePosition'], [5, 'TVPCannotSetParentSelf'],
        [6, 'TVPNotDrawableLayerType'], [7, 'TVPLayerCannotHaveImage'],
        [9, 'TVPSourceLayerHasNoImage'], [10, 'TVPNotDrawableLayerType'],
      ]
      for (const [operation, id] of cases) {
        await f.assign(id, `${operation}:${id}:%%:%1`)
        assert.equal(await f.session.evaluate(`layerFailure(${operation})`), `${operation}:${id}:%%:%1`)
        assert.equal(await f.session.evaluate('layerState()'), before)
      }
      await f.assign('TVPInvalidParam', 'must not mask Web resource budgets')
      assert.equal(await f.session.evaluate('layerFailure(8)'), 'Bitmap dimensions must be integers between 0 and 4096')
      assert.equal(await f.session.evaluate('layerState()'), before)
      await f.assign('TVPCannotCreateEmptyLayerImage', 'empty-image %% %1')
      // InternalSetImageSize changes the display bounds before ChangeImageSize
      // rejects a zero image. The old bitmap survives; this is not rollback.
      for (const [operation, expected] of [[4, '0|3|4|3|0|0'], [11, '0|3|4|3|0|0'], [12, '4|0|4|3|0|0']] as const) {
        assert.equal(await f.session.evaluate(`layerFailure(${operation})`), 'empty-image %% %1')
        assert.equal(await f.session.evaluate('imageState()'), expected)
        assert.equal(await f.session.evaluate('restoreBounds()'), before)
      }
    })
  })

  test(`${mode}: actual menu parent rejection and acknowledged fullscreen setters use native messages before mutating their owners`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      assert.equal(await f.session.evaluate('menuState()'), '1|1|1|1')
      assert.equal(await f.session.evaluate('menuFailure()'), '指定されたメニュー項目はこのメニュー項目の子ではありません')
      await f.assign('TVPNotChildMenuItem', 'menu-child %% %1')
      assert.equal(await f.session.evaluate('menuFailure()'), 'menu-child %% %1')
      assert.equal(await f.session.evaluate('menuState()'), '1|1|1|1')
      assert.equal(await f.session.evaluate('fullscreen(true)'), '1')
      assert(f.geometry.acknowledged.some((entry) => entry.fullScreen && entry.revision > 0))
      assert.equal(f.session.snapshot().windows?.[0]?.view.fullScreen, true)
      assert.equal(await f.session.evaluate('windowFailure(0)'), 'フルスクリーン中では操作できないプロパティを設定しようとしました')
      const before = await f.session.evaluate('windowState()'), measurements = f.geometry.acknowledged.length
      await f.assign('TVPInvalidPropertyInFullScreen', 'fullscreen %% %1')
      for (const operation of [0, 1]) {
        assert.equal(await f.session.evaluate(`windowFailure(${operation})`), 'fullscreen %% %1')
        assert.equal(await f.session.evaluate('windowState()'), before)
      }
      assert.equal(f.geometry.acknowledged.length, measurements, 'Rejected script setters never request replacement geometry')
      assert.equal(await f.session.evaluate('rename()'), 'Allowed in fullscreen')
      assert.equal(await f.session.evaluate('fullscreen(false)'), '0')
      assert.equal(f.session.snapshot().windows?.[0]?.view.fullScreen, false)
      await f.assign('TVPWindowHasNoLayer', 'window-empty %% %1')
      assert.equal(await f.session.evaluate('noLayerFailure()'), 'window-empty %% %1')
    })
  })

  test(`${mode}: real consumer translations remain local to concurrent Sessions and reset on a new Session after Stop`, { timeout: 60000 }, async () => {
    await using(binary, async (first) => {
      await first.assign('TVPCannotFindStorage', 'first:%1')
      await using(binary, async (second) => {
        assert.equal(await second.session.evaluate('storageFailure(0)'), 'ストレージ missing-script.tjs が見つかりません')
        await second.assign('TVPCannotFindStorage', 'second:%1')
        assert.equal(await first.session.evaluate('storageFailure(0)'), 'first:missing-script.tjs')
        assert.equal(await second.session.evaluate('storageFailure(0)'), 'second:missing-script.tjs')
      })
      assert.equal(await first.session.evaluate('storageFailure(0)'), 'first:missing-script.tjs')
    })
    await using(binary, async (fresh) => {
      assert.equal(await fresh.session.evaluate('storageFailure(0)'), 'ストレージ missing-script.tjs が見つかりません')
      assert.equal(await fresh.session.evaluate('storageFailure(1)'), 'ストレージ missing-lines.txt を開くことができません')
    })
  })
}
