import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var a=new Window(),b=new Window();
a.borderStyle=bsNone;a.innerSunken=false;a.setInnerSize(2,1);
b.borderStyle=bsNone;b.innerSunken=false;b.setInnerSize(2,1);
a.drawDevice.preferredDrawer=Window.PassThroughDrawDevice.dtDrawDib;
var pa=new Layer(a,null),pb=new Layer(b,null),ca=new Layer(a,pa);
a.add(pa);a.add(ca);b.add(pb);
pa.setSize(2,1);pa.fillRect(0,0,2,1,0xffff0000);
pb.setSize(2,1);pb.fillRect(0,0,2,1,0xff00ff00);
ca.type=ltOpaque;ca.setSize(1,1);ca.fillRect(0,0,1,1,0xff0000ff);ca.left=1;ca.visible=true;
a.visible=true;b.visible=true;a.update();b.update();
function changeHint(){a.drawDevice.preferredDrawer=Window.PassThroughDrawDevice.dtDBD3D;return a.drawDevice.drawer;}
function rebuild(){a.drawDevice.recreate();var before=a.drawDevice.drawer;a.update();return before+","+a.drawDevice.drawer;}
function resizeAndChoose(){a.drawDevice.preferredDrawer=2;a.setInnerSize(4,1);a.update();return a.drawDevice.drawer;}
function detach(){var old=a.drawDevice;a.drawDevice=void;a.update();return int(isvalid old)+","+int(a.drawDevice===void)+","+int(a.primaryLayer===null);}
function restore(){a.drawDevice=new Window.PassThroughDrawDevice();a.update();return a.drawDevice.drawer;}
function readonlyDevice(which){try{if(which==0)a.drawDevice.drawer=3;else if(which==1)a.drawDevice.interface=0;else a.drawDevice.dtDrawDib=9;}catch(e){return 1;}return 0;}
function forge(){var old=a.drawDevice,d=new Window.PassThroughDrawDevice(),fake=%["interface"=>d.interface],message="";
 try{a.drawDevice=fake;}catch(e){message=e.message;}
 return int(isvalid old)+","+int(isvalid d)+","+message;}
function replaceFake(){a.drawDevice=new Window.PassThroughDrawDevice();a.update();return a.drawDevice.drawer;}
function retire(){var old=a.drawDevice;invalidate a;return int(isvalid old)+","+int(isvalid b)+","+b.drawDevice.drawer;}
class CustomDevice extends Window.PassThroughDrawDevice {
 function CustomDevice(){super.PassThroughDrawDevice();}
 function finalize(){global.customFinalized++;}
}
var customFinalized=0;
function finalizeOnly(){a.drawDevice.finalize();return int(isvalid a.drawDevice)+","+a.drawDevice.drawer;}
function customDevice(){var d=new CustomDevice();d.preferredDrawer=2;invalidate d;return customFinalized+","+int(isvalid d);}
`

async function fixture(binary: boolean) {
  const frames = new Map<number, FrameLayer[]>(), recreated: number[] = [], closed: number[] = []
  const f = await headless({ 'device.tjs': source, 'startup.tjs': binary
    ? 'Scripts.compileStorage("device.tjs","savedata/device.cjs",false,true,false);Scripts.execStorage("savedata/device.cjs");'
    : 'Scripts.execStorage("device.tjs");' }, { renderer: {
      present(layers, _width, _height, windowId) { frames.set(windowId!, layers.map((layer) => ({ ...layer,
        pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))) },
      recreateWindow(id) { recreated.push(id) }, closeWindow(id) { closed.push(id) }, dispose() {},
    } })
  try {
    await f.session.start(); await f.session.idle()
    return { ...f, frames, recreated, closed, a: Number(await f.session.evaluate('a.__windowId')),
      b: Number(await f.session.evaluate('b.__windowId')) }
  } catch (error) {
    try { await f.session.stop() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Draw device startup and cleanup failed', { cause: error }) }
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: public draw-device hints select actual CPU composition and recreate only their Window`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(await f.session.evaluate('[Window.PassThroughDrawDevice.dtNone,Window.PassThroughDrawDevice.dtDrawDib,Window.PassThroughDrawDevice.dtDBGDI,Window.PassThroughDrawDevice.dtDBDD,Window.PassThroughDrawDevice.dtDBD3D].join(",")'), '0,1,2,3,4')
      assert.equal(await f.session.evaluate('a.drawDevice.preferredDrawer+","+a.drawDevice.drawer+","+b.drawDevice.drawer'), '1,1,4')
      const cpu = f.frames.get(f.a)!
      assert.equal(cpu.length, 1)
      assert.equal(cpu[0]!.type, 12)
      assert.deepEqual([...cpu[0]!.pixels.data], [255, 0, 0, 255, 0, 0, 255, 255])
      const other = f.frames.get(f.b)!
      assert.equal(await f.session.evaluate('changeHint()'), '1')
      f.recreated.length = 0
      assert.equal(await f.session.evaluate('rebuild()'), '0,4')
      assert.deepEqual(f.recreated, [f.a])
      assert.equal(f.frames.get(f.a)!.length, 2, 'Accelerated route submits the two original layer bitmaps')
      assert.deepEqual(f.frames.get(f.b), other)
      assert.equal(await f.session.evaluate('resizeAndChoose()'), '1')
      assert.equal(f.frames.get(f.a)!.length, 1)
      assert.equal(await f.session.evaluate('[readonlyDevice(0),readonlyDevice(1),readonlyDevice(2)].join(",")'), '1,1,1')
    } finally { await f.session.stop() }
    assert.equal(f.session.snapshot().handles, 0)
  })
  test(`${mode}: replacing a draw device invalidates its old identity before interface validation and Window retirement`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(await f.session.evaluate('finalizeOnly()'), '1,1')
      const owners = f.session.inspectOwnership().weakOwners
      assert.equal(await f.session.evaluate('customDevice()'), '1,0')
      await f.session.idle()
      assert.equal(f.session.inspectOwnership().weakOwners, owners)
      assert.equal(await f.session.evaluate('detach()'), '0,1,1')
      assert.deepEqual(f.frames.get(f.a), [])
      assert.equal(await f.session.evaluate('restore()'), '4')
      assert.equal(await f.session.evaluate('forge()'), '0,1,Draw device interface is not owned by this object')
      assert.deepEqual(f.frames.get(f.a), [])
      assert.equal(await f.session.evaluate('replaceFake()'), '4')
      assert.equal(await f.session.evaluate('retire()'), '0,1,4')
      assert.deepEqual(f.closed, [f.a])
    } finally { await f.session.stop() }
    assert.equal(f.session.snapshot().handles, 0)
    assert.ok(Object.values(f.session.inspectOwnership()).every((count) => count === 0))
  })
}
