import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

async function fixture(binary: boolean, body = '') {
  const f = await headless({
    'startup.tjs': '',
    'set-pos.tjs': String.raw`
var win=new Window();win.setInnerSize(64,48);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(64,48);root.fillRect(0,0,64,48,0xff112233);
var child=new Layer(win,root);win.add(child);child.setSize(4,4);child.visible=true;child.hitThreshold=0;
function rectangle(layer){return [layer.left,layer.top,layer.width,layer.height].join(",");}
${body}
`,
  })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("set-pos.tjs","savedata/set-pos.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/set-pos.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("set-pos.tjs")')
    await f.session.idle()
    return {
      ...f,
      execute: (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`),
      async stop() {
        await f.session.stop()
        assert.equal(f.session.snapshot().handles, 0)
        assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'setPos startup and cleanup failed', { cause: error }) }
    throw error
  }
}

async function using(binary: boolean, body: string, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary, body)
  let failure: unknown
  try { await run(f) } catch (error) { failure = error }
  try { await f.stop() }
  catch (cleanup) {
    if (failure) throw new AggregateError([failure, cleanup], 'setPos test and cleanup failed', { cause: failure })
    throw cleanup
  }
  if (failure) throw failure
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: setPos selects bounds only for exactly four non-void arguments`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
function overloads(){
 var states=[],missing=0,evaluated=0;
 try{child.setPos();}catch(error){missing++;}
 try{child.setPos(9);}catch(error){missing++;}
 states.add(rectangle(child));
 child.setPos(1,2);states.add(rectangle(child));
 child.setPos(3,4,%[]);states.add(rectangle(child));
 child.setPos(5,6,void,%[]);states.add(rectangle(child));
 child.setPos(7,8,%[],void);states.add(rectangle(child));
 child.setPos(9,10,%[],%[],++evaluated);states.add(rectangle(child));
 child.setPos(11,12,6,7);states.add(rectangle(child));
 child.setPos(4294967309,-4294967282,4294967304,4294967305);states.add(rectangle(child));
 return missing+"|"+evaluated+"|"+states.join("|");
}
`, async (f) => {
      assert.equal(await f.session.evaluate('overloads()'),
        '2|1|0,0,4,4|1,2,4,4|3,4,4,4|5,6,4,4|7,8,4,4|9,10,4,4|11,12,6,7|13,14,8,9')
    })
  })

  test(`${mode}: setPos rejects conversion, negative extent and primary movement before publishing a rectangle`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
function failures(){
 child.setPos(3,5,7,9);var states=[],rejected=0;
 try{child.setPos(17,%[]);}catch(error){rejected++;}states.add(rectangle(child));
 try{child.setPos(17,19,%[],4);}catch(error){rejected++;}states.add(rectangle(child));
 try{child.setPos(17,19,4,%[]);}catch(error){rejected++;}states.add(rectangle(child));
 try{child.setPos(17,19,-1,4);}catch(error){rejected++;}states.add(rectangle(child));
 try{child.setPos(17,19,4,-1);}catch(error){rejected++;}states.add(rectangle(child));
 try{root.setPos(0,1,2,3);}catch(error){rejected++;}states.add(rectangle(root));
 try{root.setPos(1,0);}catch(error){rejected++;}states.add(rectangle(root));
 var method=child.setPos;invalidate child;
 try{method(1,2);}catch(error){rejected++;}
 return rejected+"|"+states.join("|");
}
`, async (f) => {
      assert.equal(await f.session.evaluate('failures()'),
        '8|3,5,7,9|3,5,7,9|3,5,7,9|3,5,7,9|3,5,7,9|0,0,64,48|0,0,64,48')
    })
  })

  test(`${mode}: setPos bypasses overridden geometry properties and setSize while keeping real image growth`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
var intercepted=0;
class Positioned extends Layer {
 function Positioned(){super.Layer(global.win,global.root);visible=true;hitThreshold=0;}
 property left {getter(){return -100;}setter(value){intercepted++;}}
 property top {getter(){return -100;}setter(value){intercepted++;}}
 function setSize(args*){intercepted++;}
}
var placed=new Positioned();win.add(placed);
function overridden(){
 placed.setPos(10,12,40,30);
 return [intercepted,placed.width,placed.height,placed.imageWidth,placed.imageHeight,
   int(root.getLayerAt(10,12)===placed),int(root.getLayerAt(49,41)===placed),
   int(root.getLayerAt(50,42)===root)].join(",");
}
`, async (f) => {
      assert.equal(await f.session.evaluate('overridden()'), '0,40,30,40,32,1,1,1')
    })
  })

  test(`${mode}: setPos retains image planes and clips, clamps offsets, and synchronizes primary geometry`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
child.setImageSize(8,6);child.setImagePos(-4,-2);child.setClip(1,1,2,2);
child.setMainPixel(1,1,0x123456);child.setMaskPixel(1,1,91);child.setProvincePixel(1,1,17);child.imageModified=false;
function resizeGeometry(){
 child.setPos(9,11,7,5);
 var retained=[rectangle(child),child.imageWidth,child.imageHeight,child.imageLeft,child.imageTop,
   child.clipLeft,child.clipTop,child.clipWidth,child.clipHeight,child.getMainPixel(1,1),
   child.getMaskPixel(1,1),child.getProvincePixel(1,1),int(child.imageModified)].join("|");
 root.setPos(0,0,40,24);
 return retained+"|"+rectangle(root);
}
`, async (f) => {
      assert.equal(await f.session.evaluate('resizeGeometry()'),
        '9,11,7,5|8|6|-1|-1|1|1|2|2|1193046|91|17|0|0,0,40,24')
      const view = [...f.events].reverse().find((event) => event.type === 'window')
      assert(view?.type === 'window')
      assert.deepEqual([view.window.geometry?.paintBox.width, view.window.geometry?.paintBox.height], [40, 24])
    })
  })

  test(`${mode}: setPos cannot reenter pointer callbacks between axes and a later real move sees final bounds`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
var armed=false,callbacks=[],reentered=false;
child.onMouseLeave=function(){if(armed)callbacks.add("leave:"+rectangle(this));};
child.onMouseMove=function(x,y,shift){
 if(!armed)return;
 callbacks.add(rectangle(this));
 if(!reentered){reentered=true;this.setPos(20,10,3,2);callbacks.add(rectangle(this));}
};
function moveAtomic(){armed=true;child.setPos(10,10,4,4);return callbacks.count+"|"+rectangle(child);}
`, async (f) => {
      await f.session.input({ type: 'move', x: 2, y: 2, shift: 0 })
      assert.equal(await f.session.evaluate('moveAtomic()'), '0|10,10,4,4')
      await f.session.input({ type: 'move', x: 11, y: 11, shift: 0 })
      assert.equal(await f.session.evaluate('callbacks.join("|")'), '10,10,4,4|20,10,3,2')
    })
  })

  test(`${mode}: same bounds do not post a repaint and collapsing bounds still exposes the old Window area`, { timeout: 60000 }, async () => {
    await using(binary, String.raw`
var painted=0;
root.onPaint=function(){painted++;};
function unchanged(){root.callOnPaint=true;child.setPos(0,0,4,4);return painted;}
function collapse(){child.setPos(10,12,0,0);return rectangle(child);}
`, async (f) => {
      assert.equal(await f.session.evaluate('unchanged()'), '0')
      await f.session.idle()
      assert.equal(await f.session.evaluate('painted'), '0')
      assert.equal(await f.session.evaluate('collapse()'), '10,12,0,0')
      await f.session.idle()
      assert.equal(await f.session.evaluate('painted'), '1')
    })
  })
}
