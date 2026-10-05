import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

type Observation = { kind: 'frame'; windowId?: number; pixel: number[] } | { kind: 'log'; text: string }
async function fixture(binary: boolean, body: string, overrides: Partial<SessionDependencies> = {}) {
  const observations: Observation[] = [], f = await headless({ 'startup.tjs': '', 'update-gate.tjs': 'window-update-gate',
    'window-update.tjs': `System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(4,2);win.visible=true;
var root=new Layer(win,null);win.add(root);root.type=ltOpaque;root.setSize(4,2);
var trace=[],paints=0,seen="";
${body}` }, {
    renderer: { present(layers, _width, _height, windowId) {
      observations.push({ kind: 'frame', windowId, pixel: [...(layers[0]?.pixels.data.subarray(0,4) ?? [])] })
    }, dispose() {} },
    event(event) { if (event.type === 'log') observations.push({ kind: 'log', text: event.text }) },
    ...overrides,
  })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("window-update.tjs","savedata/window-update.cjs",false,true,false)')
      const bytes = f.session.exportSaves().find((entry) => entry.path === 'savedata/window-update.cjs')!.bytes
      assert.equal(new TextDecoder().decode(bytes.subarray(0,4)), 'TJS2')
      await f.session.evaluate('Scripts.execStorage("savedata/window-update.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("window-update.tjs")')
    await f.session.idle(); observations.length = 0
    return { ...f, observations, run: () => f.session.evaluate('runCase()'),
      async stop() { await f.session.stop(); assert(Object.values(f.session.inspectOwnership()).every((n) => n === 0)) } }
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false,true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: synchronous Window publication is not duplicated by its outer or host-only publication`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
function runCase(){root.fillRect(0,0,4,2,0xff123456);win.update();Debug.message("published-once");}`)
    try {
      await f.run()
      const frames = () => f.observations.filter((item) => item.kind === 'frame')
      assert.equal(frames().length, 1)
      assert.deepEqual(frames().map((frame) => frame.kind === 'frame' ? frame.pixel : []), [[18,52,86,255]])
      f.session.present(); f.session.present()
      assert.equal(frames().length, 1)
    } finally { await f.stop() }
  })
  test(`${mode}: publishing disabled pixels preserves the queued onPaint until game events resume`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
root.onPaint=function(){paints++;Debug.message("resumed-paint");};
function runCase(){System.eventDisabled=true;root.update();}
function resumePaint(){System.eventDisabled=false;}`)
    try {
      await f.run()
      const frames = f.observations.filter((item) => item.kind === 'frame').length
      assert.equal(frames, 1)
      assert.equal(f.observations.some((item) => item.kind === 'log' && item.text === 'resumed-paint'), false)
      f.session.present(); f.session.present()
      assert.equal(f.observations.filter((item) => item.kind === 'frame').length, frames)
      await f.session.evaluate('resumePaint()')
      assert.equal(await f.session.evaluate('paints+","+int(root.callOnPaint)'), '1,0')
      assert.equal(f.observations.filter((item) => item.kind === 'log' && item.text === 'resumed-paint').length, 1)
    } finally { await f.stop() }
  })
  test(`${mode}: Window.update paints and publishes pixels before the next TJS statement without inventing onPaint`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
root.onPaint=function(){paints++;root.fillRect(0,0,4,2,0xff112233);Debug.message("painted");};
function runCase(){win.update();var empty=paints;root.callOnPaint=true;win.update();seen=empty+","+paints+","+root.getMainPixel(0,0);Debug.message("after-update");}`)
    try {
      await f.run()
      assert.equal(await f.session.evaluate('seen'), '0,1,1122867')
      const after = f.observations.findIndex((item) => item.kind === 'log' && item.text === 'after-update')
      assert(after >= 0)
      assert(f.observations.slice(0,after).some((item) => item.kind === 'frame' && item.pixel.join(',') === '17,34,51,255'))
    } finally { await f.stop() }
  })
  test(`${mode}: explicit update drains posted windows in order and all own managers while leaving an unposted window alone`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var second=new Window();second.visible=true;second.setInnerSize(4,2);
var b=new Layer(second,null);second.add(b);b.setSize(4,2);
var third=new Window();third.visible=true;third.setInnerSize(4,2);
var c=new Layer(third,null);third.add(c);c.setSize(4,2);
var secondary=new Layer(win,null);win.add(secondary);secondary.setSize(4,2);
root.onPaint=function(){trace.add("A");};b.onPaint=function(){trace.add("B");};
c.onPaint=function(){trace.add("C");};secondary.onPaint=function(){trace.add("A2");};
function runCase(){trace.clear();root.callOnPaint=true;c.callOnPaint=true;secondary.callOnPaint=true;
 secondary.fillRect(0,0,4,2,0xff334455);b.update();second.update();var first=trace.join(",");
 trace.clear();b.update();win.update();seen=first+"|"+trace.join(",")+"|"+int(c.callOnPaint);}`)
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), 'B|B,A,A2|1') }
    finally { await f.stop() }
  })
  test(`${mode}: recursive Window.update is queued, never reenters paint, and one delivery permits only two entries`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var depth=0,maxDepth=0;
root.onPaint=function(){depth++;if(depth>maxDepth)maxDepth=depth;paints++;trace.add("enter"+paints);
 if(paints<3){root.update();win.update();trace.add("return"+paints);}depth--;};
function runCase(){root.update();win.update();seen=paints+"|"+maxDepth+"|"+trace.join(",");}`)
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), '2|1|enter1,return1,enter2,return2') }
    finally { await f.stop() }
  })
  test(`${mode}: removing an attached subtree and showing a hidden Window post the affected Window exposure`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var other=new Window();other.visible=true;other.setInnerSize(4,2);
var otherRoot=new Layer(other,null);other.add(otherRoot);otherRoot.setSize(4,2);
var child=new Layer(win,root);child.setSize(1,1);child.visible=true;
root.onPaint=function(){trace.add("A");};otherRoot.onPaint=function(){trace.add("B");};
child.onPaint=function(){trace.add("detached");};
function runCase(){root.callOnPaint=true;child.callOnPaint=true;child.parent=null;otherRoot.callOnPaint=true;other.update();
 var first=trace.join(",");trace.clear();win.visible=false;root.callOnPaint=true;win.visible=true;
 otherRoot.callOnPaint=true;other.update();seen=first+"|"+trace.join(",");}`)
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), 'A,B|A,B') }
    finally { await f.stop() }
  })
  test(`${mode}: disabled immediate paint delivery still consumes callOnPaint during explicit completion`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
root.onPaint=function(){paints++;};
function runCase(){System.eventDisabled=true;root.callOnPaint=true;win.update();seen=paints+","+int(root.callOnPaint);System.eventDisabled=false;}`)
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), '0,0'); assert.equal(await f.session.evaluate('paints'), '0') }
    finally { await f.stop() }
  })
  test(`${mode}: a normal scheduled paint shares the Window.update reentry guard and two-entry bound`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var depth=0,maxDepth=0;
root.onPaint=function(){depth++;if(depth>maxDepth)maxDepth=depth;paints++;
 var before=paints;if(paints<3){root.update();win.update();}
 trace.add(before+":"+paints);depth--;};
function runCase(){root.update();}`)
    try {
      await f.run()
      assert.equal(await f.session.evaluate('trace[0]+"|"+trace[1]+"|"+maxDepth'), '1:1|2:2|1')
    } finally { await f.stop() }
  })
  test(`${mode}: update unwinds a throwing callback, then permits another round and safe Window retirement inside paint`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var other=new Window();other.visible=true;other.setInnerSize(4,2);
var otherRoot=new Layer(other,null);other.add(otherRoot);otherRoot.setSize(4,2);
function runCase(){
 root.onPaint=function(){throw new Exception("update-paint-fault");};root.callOnPaint=true;
 try{win.update();}catch(e){trace.add(e.message);}
 root.onPaint=function(){paints++;};root.callOnPaint=true;win.update();
 root.onPaint=function(){invalidate win;};root.callOnPaint=true;win.update();
 otherRoot.onPaint=function(){trace.add("other-painted");};otherRoot.update();other.update();
 seen=paints+","+int(isvalid win)+"|"+trace.join("|");}`)
    try {
      await f.run()
      assert.match(await f.session.evaluate('seen'), /^1,0\|.*update-paint-fault.*\|other-painted$/)
      assert.equal(f.session.snapshot().state, 'running')
    } finally { await f.stop() }
  })
  test(`${mode}: Stop unwinds a synchronous update suspended in a real script decoder and does not publish its tail`, { timeout: 60000 }, async () => {
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve }), gate = new Promise<void>((resolve) => { release = resolve })
    const f = await fixture(binary, `
root.onPaint=function(){Debug.message("before-update-gate");Scripts.execStorage("update-gate.tjs");Debug.message("late-paint-tail");};
function runCase(){root.update();win.update();Debug.message("late-update-tail");}`, {
      async decodeScript(bytes, mode, encoding) {
        if (new TextDecoder().decode(bytes) === 'window-update-gate') { enter(); await gate; return '' }
        return readScript(bytes, mode, encoding)
      },
    })
    try {
      const running = f.run().then(() => undefined, (error: unknown) => error)
      await Promise.race([entered, running.then(() => { throw new Error('Update ended before decoder suspension') })])
      const stopped = f.session.stop(); release()
      await stopped; assert(await running instanceof Error)
      assert(!f.observations.some((item) => item.kind === 'log' && item.text.startsWith('late-')))
      assert.equal(f.session.snapshot().state, 'stopped')
    } finally { release(); await f.stop() }
  })
  test(`${mode}: update retains the fixed Intf second-argument conversion gate and evaluates extra arguments`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
function extra(){trace.add("extra");return 7;}
function runCase(){var failures=0;win.update(%[]);win.update(%[],void);
 try{win.update(%[],0);}catch(e){failures++;}
 win.update("1",0,extra());seen=failures+"|"+trace.join(",");}`)
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), '1|extra') }
    finally { await f.stop() }
  })
  test(`${mode}: default onResize forwards the actual coalesced event to Window.action`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var resized=0,sameTarget=false;
win.action=function(event){if(event.type=="onResize"){resized++;sameTarget=event.target===win;seen=win.innerWidth+","+win.innerHeight;}};
function runCase(){resized=0;win.setInnerSize(6,3);win.setInnerSize(8,4);}`)
    try {
      await f.run(); await f.session.idle()
      assert.equal(await f.session.evaluate('resized+","+int(sameTarget)+"|"+seen'), '1,1|8,4')
    } finally { await f.stop() }
  })
  test(`${mode}: transition phase calculation neither reposts its own Window nor ticks another unqueued Window`, { timeout: 60000 }, async () => {
    const scheduled = new Set<() => void>(), f = await fixture(binary, `
var back=new Layer(win,root);back.setSize(4,2);
var other=new Window();other.visible=true;other.setInnerSize(4,2);
var otherRoot=new Layer(other,null),otherBack=new Layer(other,otherRoot);other.add(otherRoot);
otherRoot.setSize(4,2);otherBack.setSize(4,2);
var ticks=0,otherTicks=0;
otherRoot.beginTransition("crossfade",false,otherBack,%[time:1000000,selfupdate:true,callback:function(){otherTicks++;return 0;}]);
function runCase(){
 var beforeOther=otherTicks;
 root.beginTransition("crossfade",false,back,%[time:1000000,selfupdate:true,callback:function(){ticks++;return 0;}]);
 win.update();seen=ticks+","+(otherTicks-beforeOther);
}`, { now: () => 0, schedule(callback) {
      scheduled.add(callback)
      return () => { scheduled.delete(callback) }
    } })
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), '1,0') }
    finally { await f.stop(); assert.equal(scheduled.size, 0) }
  })
  test(`${mode}: zero-size bounds, rejected empty-image shrink and missing images expose the old area while no-ops leave paint pending`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, `
var other=new Window();other.visible=true;other.setInnerSize(4,2);
var otherRoot=new Layer(other,null);other.add(otherRoot);otherRoot.setSize(4,2);
System.assignMessage("TVPCannotCreateEmptyLayerImage","window-update:empty-image");
var child=new Layer(win,root),empty=new Layer(win,null);child.visible=true;empty.hasImage=false;
root.onPaint=function(){paints++;};
function checkShrink(method){
 child.hasImage=true;child.setSize(1,1);child.setImageSize(1,1);child.setClip(0,0,1,1);
 child.setMainPixel(0,0,0x123456);child.setMaskPixel(0,0,191);win.update();paints=0;root.callOnPaint=true;
 if(method==0)child.setSize(1,1);else if(method==1)child.setImageSize(1,1);else child.assignImages(child);
 other.update();var before=paints;
 if(method==0)child.setSize(0,1);else if(method==1){
  var caught="";try{child.setImageSize(0,1);}catch(error){caught=error.message;}
  if(caught!=="window-update:empty-image" || !child.hasImage || child.imageWidth!=1 || child.imageHeight!=1 ||
     child.width!=0 || child.height!=1 || child.clipLeft!=0 || child.clipTop!=0 || child.clipWidth!=1 || child.clipHeight!=1 ||
     child.getMainPixel(0,0)!=0x123456 || child.getMaskPixel(0,0)!=191)
   throw "empty image rejection must retain bitmap and clip after the native display shrink";
 }else child.assignImages(empty);
 other.update();return before+","+paints;
}
function runCase(){seen=checkShrink(0)+"|"+checkShrink(1)+"|"+checkShrink(2);}`)
    try { await f.run(); assert.equal(await f.session.evaluate('seen'), '0,1|0,1|0,1') }
    finally { await f.stop() }
  })
}
