import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const scene = String.raw`
System.exitOnWindowClose=false;
var trace=[],caught=[];
System.exceptionHandler=function(error){caught.add(error.message);return true;};
var win=new Window();win.setInnerSize(200,100);win.visible=true;
var root=new Layer(win,null);root.setSize(200,100);root.fillRect(0,0,200,100,0xff101010);
root.cursor=crArrow;root.hint="root";
class Control extends Layer {
  function Control(name,x){super.Layer(global.win,global.root);this.name=name;setPos(x,0);setSize(40,40);fillRect(0,0,40,40,0xffffffff);visible=true;}
  function onHitTest(x,y,hit){trace.add(name+":hit:"+x+","+y);}
  function onMouseEnter(){trace.add(name+":enter");}
  function onMouseLeave(){trace.add(name+":leave");}
  function onMouseMove(x,y,shift){trace.add(name+":move:"+x+","+y+":"+shift);}
  function onMouseDown(x,y,button,shift){trace.add(name+":down:"+x+","+y+":"+shift);}
  function onMouseUp(x,y,button,shift){trace.add(name+":up:"+x+","+y+":"+shift);}
}
var a=new Control("a",0),b=new Control("b",100);
a.cursor=crCross;a.hint="A";b.cursor=crIBeam;b.hint="B";
win.onMouseMove=function(x,y,shift){trace.add("window:move:"+x+","+y+":"+shift);};
win.onMouseDown=function(x,y,button,shift){trace.add("window:down:"+x+","+y+":"+shift);};
win.onMouseUp=function(x,y,button,shift){trace.add("window:up:"+x+","+y+":"+shift);};
win.onMouseLeave=function(){trace.add("window:leave");};
function reset(){trace.clear();}
function events(){return trace.join("|");}
function errors(){return caught.join("|");}
`

async function fixture(binary: boolean, body = '') {
  const f = await headless({ 'startup.tjs': '', 'mouse-order.tjs': scene + body })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("mouse-order.tjs","savedata/mouse-order.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/mouse-order.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("mouse-order.tjs")')
    const windowId = Number(await f.session.evaluate('win.__windowId'))
    await f.session.idle()
    await f.session.evaluate('reset()')
    return {
      ...f, windowId,
      run: (name: string) => f.session.evaluate(`${name}()`),
      async mouse(type: 'move' | 'down' | 'up', x: number, y: number, shift = type === 'down' ? 8 : 0) {
        await f.session.input({ type, x, y, shift, windowId, button: 0, clicks: 0 })
        await f.session.idle()
      },
      async trace(includeHits = false) {
        const result = (await f.session.evaluate('events()')).split('|').filter(Boolean)
        return includeHits ? result : result.filter((value) => !value.includes(':hit:'))
      },
      view(): Pick<InputView, 'cursor' | 'hint'> {
        for (let i = f.events.length - 1; i >= 0; i--) {
          const event = f.events[i]!
          if (event.type === 'window-input' && event.windowId === windowId)
            return { cursor: event.input.cursor, hint: event.input.hint }
        }
        throw new Error('Missing mouse Window input view')
      },
      async stop() {
        await f.session.stop()
        assert.equal(f.session.snapshot().handles, 0)
        assert.equal(f.session.snapshot().bitmapBytes, 0)
        assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Mouse fixture startup and cleanup failed') }
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: a direct down hits once and captures without inventing enter or move`, async () => {
    const f = await fixture(binary)
    try {
      await f.mouse('down', 105, 5)
      assert.deepEqual(await f.trace(true), ['window:down:105,5:8', 'b:hit:5,5', 'b:down:5,5:8'])
      assert.deepEqual(f.view(), { cursor: 0, hint: '' })
      await f.run('reset')
      await f.mouse('move', 5, 5, 8)
      assert.deepEqual(await f.trace(true), ['window:move:5,5:8', 'b:enter', 'b:move:-95,5:8'])
      assert.deepEqual(f.view(), { cursor: -4, hint: 'B' })
    } finally { await f.stop() }
  })

  test(`${mode}: direct down at B leaves the last move at A for callback notifications`, async () => {
    const f = await fixture(binary, String.raw`
b.onMouseDown=function(x,y,button,shift){trace.add("b:down");b.cursor=crNone;b.hint="new-B";};
function releaseAndNotify(){root.releaseCapture();a.cursor=crHandPoint;a.hint="notified-A";}
`)
    try {
      await f.mouse('move', 5, 5)
      await f.run('reset')
      await f.mouse('down', 105, 5)
      assert.deepEqual(await f.trace(), ['window:down:105,5:8', 'b:down'])
      assert.deepEqual(f.view(), { cursor: -3, hint: '' })
      await f.run('releaseAndNotify')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'notified-A' })
    } finally { await f.stop() }
  })

  test(`${mode}: a no-target up preserves the old move sample and displayed hint`, async () => {
    const f = await fixture(binary, 'function notify(){a.cursor=crHandPoint;}')
    try {
      await f.mouse('move', 5, 5)
      await f.run('reset')
      await f.mouse('up', -20, -20)
      assert.deepEqual(await f.trace(true), ['window:up:-20,-20:0'])
      assert.deepEqual(f.view(), { cursor: -3, hint: 'A' })
      await f.run('notify')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'A' })
    } finally { await f.stop() }
  })

  test(`${mode}: Window up changes the entering transform but Layer up cannot reproject its saved primary point`, async () => {
    const f = await fixture(binary, String.raw`
win.onMouseUp=function(x,y,button,shift){trace.add("window:up:"+x+","+y);win.setZoom(2,1);};
a.onMouseUp=function(x,y,button,shift){trace.add("a:up:"+x+","+y);win.setZoom(4,1);win.setLayerPos(-30,-20);};
`)
    try {
      await f.mouse('move', 5, 5)
      await f.mouse('down', 5, 5)
      await f.run('reset')
      await f.mouse('up', 220, 10)
      assert.deepEqual(await f.trace(), [
        'window:up:220,10', 'a:up:110,5', 'a:leave', 'b:enter', 'b:move:10,5:0',
      ])
      assert.deepEqual(f.view(), { cursor: -4, hint: 'B' })
    } finally { await f.stop() }
  })

  test(`${mode}: remaining mouse buttons keep capture and skip the up recheck`, async () => {
    const f = await fixture(binary)
    try {
      await f.mouse('move', 5, 5)
      await f.mouse('down', 5, 5)
      for (const shift of [8, 16, 32, 256, 512]) {
        await f.run('reset')
        await f.mouse('up', 105, 5, shift)
        assert.deepEqual(await f.trace(true), [`window:up:105,5:${shift}`, `a:up:105,5:${shift}`])
      }
      await f.run('reset')
      await f.mouse('up', 105, 5)
      assert.deepEqual(await f.trace(), [
        'window:up:105,5:0', 'a:up:105,5:0', 'a:leave', 'b:enter', 'b:move:5,5:0',
      ])
    } finally { await f.stop() }
  })

  test(`${mode}: throwing Layer up leaves capture and last move intact until a later successful up`, async () => {
    const f = await fixture(binary, String.raw`
var armed=true;
a.onMouseUp=function(x,y,button,shift){trace.add("a:up:"+x+","+y);if(armed){armed=false;throw new Exception("mouse-up-fault");}};
function notify(){a.cursor=crHandPoint;a.hint="still-captured";}
`)
    try {
      await f.mouse('move', 5, 5)
      await f.mouse('down', 5, 5)
      await f.run('reset')
      await f.mouse('up', 105, 5)
      assert.match(await f.run('errors'), /mouse-up-fault/)
      assert.deepEqual(await f.trace(), ['window:up:105,5:0', 'a:up:105,5'])
      await f.run('notify')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'still-captured' })
      await f.run('reset')
      await f.mouse('up', 105, 5)
      assert.deepEqual(await f.trace(), [
        'window:up:105,5:0', 'a:up:105,5', 'a:leave', 'b:enter', 'b:move:5,5:0',
      ])
    } finally { await f.stop() }
  })

  test(`${mode}: releaseCapture inside down prevents reacquisition without synthesizing hover`, async () => {
    const f = await fixture(binary, String.raw`
b.onMouseDown=function(x,y,button,shift){trace.add("b:down");root.releaseCapture();};
`)
    try {
      await f.mouse('down', 105, 5)
      await f.run('reset')
      await f.mouse('move', 5, 5)
      assert.deepEqual(await f.trace(), ['window:move:5,5:0', 'a:enter', 'a:move:5,5:0'])
      assert.deepEqual(f.view(), { cursor: -3, hint: 'A' })
    } finally { await f.stop() }
  })

  test(`${mode}: manager position changes compare integer primary samples, including a changed transform`, async () => {
    const f = await fixture(binary, String.raw`
function zoomIn(){win.setZoom(2,1);}
function zoomOut(){win.setZoom(1,1);}
`)
    try {
      await f.run('zoomIn')
      await f.mouse('move', 10.2, 10.8)
      await f.run('reset')
      await f.mouse('move', 11.9, 11.2)
      assert.deepEqual(await f.trace(), ['window:move:11,11:0'], 'Same primary pixel emits no Layer move')
      await f.run('zoomOut')
      await f.run('reset')
      await f.mouse('move', 11.9, 11.2)
      assert.deepEqual(await f.trace(), ['window:move:11,11:0', 'a:move:11,11:0'])
    } finally { await f.stop() }
  })

  test(`${mode}: leaving uses primary minus one even when Window origin and zoom would project it inside`, async () => {
    const f = await fixture(binary, 'win.setZoom(2,1);win.setLayerPos(-20,-20);')
    try {
      await f.mouse('move', -30, -30)
      assert.deepEqual(f.view(), { cursor: -3, hint: 'A' })
      await f.run('reset')
      await f.session.input({ type: 'leave', windowId: f.windowId })
      assert.deepEqual(await f.trace(), ['window:leave', 'a:leave'])
      assert.deepEqual(f.view(), { cursor: 0, hint: '' })
      await f.mouse('move', -30, -30)
      await f.mouse('down', -30, -30)
      await f.run('reset')
      await f.session.input({ type: 'leave', windowId: f.windowId })
      assert.deepEqual(await f.trace(), ['window:leave'], 'Captured mouse-out does not enter the manager')
    } finally { await f.stop() }
  })

  test(`${mode}: admitted PaintBox coordinates survive caller mutation and origin changes before callbacks`, async () => {
    const f = await fixture(binary, String.raw`
win.setLayerPos(10,20);win.setZoom(2,1);
win.onMouseDown=function(x,y,button,shift){trace.add("window:down:"+x+","+y);win.setLayerPos(100,200);win.setZoom(1,1);};
`)
    try {
      // This sample was captured against the former PaintBox. Its raw Window
      // point remains available to physical cursor getters, independently.
      const point = { x: 5, y: 6 },
        admitted = f.session.acceptInput({
          type: 'down', windowId: f.windowId, x: 25, y: 46,
          paintBoxPoint: point, shift: 8, button: 0, clicks: 0,
        })
      point.x = point.y = 999
      await admitted.completion
      assert.deepEqual(await f.trace(), ['window:down:5,6', 'a:down:5,6:8'])
      assert.equal(await f.session.evaluate('[win.layerLeft,win.layerTop].join(",")'), '100,200')
      assert.throws(() => f.session.acceptInput({
        type: 'move', windowId: f.windowId, x: 0, y: 0,
        paintBoxPoint: { x: 1.5, y: 0 }, shift: 0, button: 0, clicks: 0,
      }), /Invalid PaintBox mouse coordinates/)
    } finally { await f.stop() }
  })

  test(`${mode}: Session admission snapshots a legacy mouse point before queued origin and zoom changes`, async () => {
    const f = await fixture(binary, String.raw`
function hold(){win.setLayerPos(10,20);win.setZoom(2,1);System.eventDisabled=true;}
function release(){win.setLayerPos(100,200);win.setZoom(1,1);System.eventDisabled=false;}
`)
    let pending: Promise<void> | undefined
    try {
      await f.run('hold')
      const admitted = f.session.acceptInput({
        type: 'down', windowId: f.windowId, x: 25, y: 46, shift: 8, button: 0, clicks: 0,
      })
      assert.equal(admitted.status, 'accepted')
      pending = admitted.completion
      await f.run('release')
      await pending
      assert.deepEqual(await f.trace(), ['window:down:5,6:8', 'a:down:5,6:8'])
    } finally {
      // Attach rejection observation before Stop can cancel a queued receipt.
      const settled = pending ? Promise.allSettled([pending]) : Promise.resolve([])
      await f.stop()
      await settled
    }
  })
}
