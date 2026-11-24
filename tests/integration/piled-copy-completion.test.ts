import assert from 'node:assert/strict'
import test from 'node:test'
import { headless } from '../helpers/headless.ts'

// Fixed LayerIntf.cpp:3858–3885 and 6197–6252. Complete's direct MainImage
// return precedes BeforeCompletion, independently of TransWithChildren.
for (const binary of [false, true]) for (const children of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: piledCopy keeps full main-image reads separate from ${children ? 'subtree' : 'main-only'} transition completion`, async () => {
    const body = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(2,1);
var root=new Layer(win,null);root.setImageSize(2,1);root.setSize(2,1);
var fore=new Layer(win,root),back=new Layer(win,root),saved=new Layer(win,root);
fore.setImageSize(2,1);fore.setSize(2,1);fore.type=ltOpaque;fore.visible=true;
back.setImageSize(2,1);back.setSize(2,1);back.type=ltOpaque;
saved.setImageSize(2,1);saved.setSize(2,1);
fore.fillRect(0,0,2,1,0x13000000);back.fillRect(0,0,2,1,0x01ffffff);
var child=new Layer(win,fore);child.setSize(0,0);child.setPos(2,0);
var unrelatedFore=new Layer(win,root),unrelatedBack=new Layer(win,root),unrelatedTicks=0;
unrelatedFore.visible=true;
unrelatedFore.beginTransition("crossfade",false,unrelatedBack,%[time:1000,selfupdate:true,
  callback:function(){global.unrelatedTicks++;return 500;}]);
var paints=0,childPaints=0,ticks=0,tick=500;
fore.onPaint=function(){global.paints++;};child.onPaint=function(){global.childPaints++;};
fore.callOnPaint=true;child.callOnPaint=true;
fore.beginTransition("crossfade",${children},back,%[time:1000,selfupdate:true,callback:function(){global.ticks++;return global.tick;}]);
function copyProof(){
  global.saved.piledCopy(0,0,global.fore,0,0,2,1);
  return [global.paints,global.childPaints,global.ticks,int(global.fore.callOnPaint),int(global.child.callOnPaint),
    global.saved.getMainPixel(0,0),global.saved.getMaskPixel(0,0),
    global.saved.getMainPixel(1,0),global.saved.getMaskPixel(1,0),global.unrelatedTicks].join(",");
}
var hiddenProof=copyProof();
child.visible=true;child.opacity=0;
var transparentProof=copyProof();
child.opacity=255;
var completedProof=copyProof();
// The next Complete has already selected its non-leaf branch before onPaint
// makes the source a leaf. It must finish that selected composition path.
fore.onPaint=function(){global.paints++;global.child.visible=false;};
fore.update();tick=750;
var changedTreeProof=copyProof();
child.visible=true;fore.onPaint=function(){};
var completed=0,savedDuringCallback=0;
saved.setMainPixel(0,0,0x123456);
fore.onTransitionCompleted=function(dest,src){
  global.completed++;global.savedDuringCallback=global.saved.getMainPixel(0,0);
  src.setMainPixel(0,0,0x102030);src.setMaskPixel(0,0,77);
  global.saved.setMainPixel(0,0,0x987654);
};
tick=1000;fore.update();saved.piledCopy(0,0,fore,0,0,2,1);
var finalProof=[completed,savedDuringCallback,saved.getMainPixel(0,0),saved.getMaskPixel(0,0),
  back.getMainPixel(0,0),back.getMaskPixel(0,0),int(back.visible),int(fore.visible)].join(",");
`
    const { session } = await headless({ 'copy.tjs': body, 'startup.tjs': binary
      ? 'Scripts.compileStorage("copy.tjs","savedata/copy.cjs",false,true,false);Scripts.execStorage("savedata/copy.cjs");'
      : 'Scripts.execStorage("copy.tjs");' })
    const errors: unknown[] = []
    try {
      await session.start()
      assert.equal(await session.evaluate('hiddenProof'), '0,0,0,1,1,0,19,0,19,0')
      assert.equal(await session.evaluate('transparentProof'), '0,0,0,1,1,0,19,0,19,0')
      assert.equal(await session.evaluate('completedProof'), '1,1,1,0,0,8289918,0,8289918,0,0')
      assert.equal(await session.evaluate('changedTreeProof'), '2,1,2,0,0,12500670,0,12500670,0,0')
      assert.equal(await session.evaluate('finalProof'), '1,1193046,16777215,1,1056816,77,1,0')
    } catch (error) { errors.push(error) }
    try {
      await session.stop()
      assert.equal(session.snapshot().handles, 0)
      assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
    } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Completion boundary or cleanup failed', { cause: errors[0] })
  })
