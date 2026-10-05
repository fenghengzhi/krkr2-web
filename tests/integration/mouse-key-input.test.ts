import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { EngineEvent } from '../../src/engine/session.ts'
import type { InputPacket } from '../../src/engine/ports/input.ts'
import type { WindowView } from '../../src/engine/scene/window.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.visible=true;win.setInnerSize(200,100);
var root=new Layer(win,null);root.setSize(200,100);root.fillRect(0,0,200,100,0xff000000);
var events=[],clickPointers=[];
class MouseKeyControl extends Layer {
 function MouseKeyControl(name,x){super.Layer(global.win,global.root);this.name=name;left=x;top=5;setSize(40,30);visible=true;fillRect(0,0,40,30,0xffffffff);}
 function onMouseDown(x,y,button,shift){events.add(name+":down:"+x+","+y+":"+button+":"+shift);}
 function onMouseUp(x,y,button,shift){events.add(name+":up:"+x+","+y+":"+button+":"+shift);}
 function onClick(x,y){events.add(name+":click:"+x+","+y);}
}
var a=new MouseKeyControl("a",10),b=new MouseKeyControl("b",70);
win.onMouseDown=function(x,y,button,shift){events.add("window:down:"+x+","+y+":"+button+":"+shift);};
win.onMouseUp=function(x,y,button,shift){events.add("window:up:"+x+","+y+":"+button+":"+shift);};
win.onClick=function(x,y){events.add("window:click:"+x+","+y);clickPointers.add(root.cursorX+","+root.cursorY);};
win.onKeyDown=function(key,shift){events.add("window:keyDown:"+key);};
win.onKeyUp=function(key,shift){events.add("window:keyUp:"+key);};
win.useMouseKey=true;
`
function latestView(events: EngineEvent[], id: number): WindowView {
  for (let at = events.length - 1; at >= 0; at--) {
    const event = events[at]!
    if (event.type === 'windows') {
      const window = event.windows.find((window) => window.id === id)
      if (window) return window.view
    }
  }
  throw new Error('No actual Window presentation was published')
}
async function fixture(binary: boolean) {
  let now = 1000
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("mouse-key.tjs","savedata/mouse-key.cjs",false,true,false);Scripts.execStorage("savedata/mouse-key.cjs");'
    : 'Scripts.execStorage("mouse-key.tjs");', 'mouse-key.tjs': source }, { now: () => now })
  try {
    await f.session.start()
    const id = Number(await f.session.evaluate('win.__windowId'))
    await f.session.input({ type: 'activate', windowId: id })
    if (binary) {
      const compiled = f.session.exportSaves().find((entry) => entry.path === 'savedata/mouse-key.cjs')
      assert(compiled)
      assert.equal(new TextDecoder().decode(compiled.bytes.subarray(0, 4)), 'TJS2')
    }
    const key = (type: 'keyDown' | 'keyUp', key: number, shift = 0,
      observation?: NonNullable<InputPacket['mouseKeyObservation']>): InputPacket => ({
      type, windowId: id, key, shift, ...(observation ? { mouseKeyObservation: observation } : {}),
    })
    const execute = (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
    return { ...f, id, key, execute, advance: (milliseconds: number) => { now += milliseconds } }
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: mouse keys deliver historical click before up while preserving physical modifier and button state`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      f.session.pointerState(20, 10, f.id, 1)
      f.session.keyState([1, 16, 37])
      await f.session.input(f.key('keyDown', 13, 9))
      f.session.pointerState(80, 15, f.id, 2)
      await f.session.input(f.key('keyUp', 13, 9))
      assert.equal(await f.session.evaluate('events.join("|")'),
        'window:down:20,10:0:0|a:down:10,5:0:0|window:click:20,10|a:click:10,5|window:up:80,15:0:0|a:up:70,10:0:0')
      assert.equal(await f.session.evaluate('clickPointers.join("|")'), '80,15',
        'the historical click coordinates must not overwrite the current cursor observation')
      assert.equal(await f.session.evaluate('[System.getKeyState(VK_LBUTTON),System.getKeyState(VK_RETURN),System.getKeyState(VK_SHIFT),System.getKeyState(VK_LEFT)].join(",")'), '1,0,1,1')
      await f.session.evaluate('events.clear()')
      await f.session.input(f.key('keyUp', 13, 9))
      assert.equal(await f.session.evaluate('events.join("|")'),
        'window:click:20,10|window:up:80,15:0:0|b:up:10,10:0:0',
        'native key-up clicks even without a matching down, but PrimaryClick requires capture for a Layer callback')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: disabling releases at the last move without click, and re-enabling repeats native button reset`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      assert.equal(latestView(f.events, f.id).useMouseKey, true)
      await f.session.input({ type: 'move', windowId: f.id, x: 20, y: 10, button: 0, clicks: 0, shift: 0, pointerSequence: 1 })
      await f.session.input(f.key('keyDown', 13))
      await f.session.input({ type: 'move', windowId: f.id, x: 30, y: 15, button: 0, clicks: 0, shift: 0, pointerSequence: 2 })
      await f.session.input({ type: 'move', windowId: f.id, x: 90, y: 25, button: 0, clicks: 0, shift: 0, pointerSequence: 1 })
      await f.execute('events.clear();win.useMouseKey=false;')
      await f.session.idle()
      assert.equal(latestView(f.events, f.id).useMouseKey, false)
      assert.equal(await f.session.evaluate('events.join("|")'), 'window:up:30,15:0:0|a:up:20,10:0:0')
      await f.execute('win.useMouseKey=true;events.clear();')
      await f.session.input(f.key('keyDown', 32))
      await f.execute('events.clear();win.useMouseKey=0.5;')
      assert.equal(await f.session.evaluate('win.useMouseKey'), '1', 'the native setter uses boolean conversion before integer transport')
      await f.session.evaluate('win.useMouseKey=false')
      await f.session.idle()
      assert.equal(await f.session.evaluate('events.count'), '0',
        'setting true again clears emulated button flags without synthesizing another release')
      await f.session.input({ type: 'cancel', windowId: f.id })
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: mouse-key ticks use CSS distance, the 100+45ms initial gate and the latest physical takeover`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('win.setZoom(2,1);win.setLayerPos(3,4);')
      assert.equal(await f.session.evaluate('win.layerLeft+","+win.layerTop'), '3,4')
      const observed = { windowId: f.id, x: 120, y: 50, scaleX: 2, scaleY: 3, pointerSequence: 1 }
      f.session.pointerState(120, 50, f.id, 1)
      await f.session.input(f.key('keyDown', 37, 0, observed))
      assert.equal(await f.session.evaluate('root.cursorX+","+root.cursorY'), '56,21')
      f.advance(144)
      await f.session.input({ type: 'mouseKeyTick', windowId: f.id, mouseKeyObservation: observed })
      assert.equal(await f.session.evaluate('root.cursorX'), '56')
      f.advance(1)
      await f.session.input({ type: 'mouseKeyTick', windowId: f.id, mouseKeyObservation: observed })
      assert.equal(await f.session.evaluate('root.cursorX'), '54', 'an old observation must not reset the virtual cursor')
      f.session.pointerState(160, 50, f.id, 2)
      f.advance(50)
      await f.session.input({ type: 'mouseKeyTick', windowId: f.id,
        mouseKeyObservation: { ...observed, x: 160, pointerSequence: 2 } })
      assert.equal(await f.session.evaluate('root.cursorX'), '74', 'physical movement replaces the position while acceleration continues')
      await f.session.input(f.key('keyUp', 37))
      assert.equal(await f.session.evaluate('events.join("|")'), 'window:keyUp:37',
        'direction down is consumed but native direction up remains a key event')
      f.advance(50)
      await f.session.input({ type: 'mouseKeyTick', windowId: f.id })
      assert.equal(await f.session.evaluate('root.cursorX'), '74')
      f.advance(50)
      await f.session.input({ type: 'mouseKeyTick', windowId: f.id, mouseKeyKeys: [0x1b7] })
      assert.equal(await f.session.evaluate('root.cursorX'), '75',
        'a queued pre-poll tick uses its admitted PAD snapshot even after physical release')
      assert.equal(await f.session.evaluate('System.getKeyState(VK_PADRIGHT)'), '0',
        'the frozen tick state must not rewrite the live physical state')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: native key trapping selects the conversion Window and script-posted keys bypass mouse emulation`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('win.postInputEvent("onKeyDown",%[key:VK_RETURN,shift:0])')
      await f.session.idle()
      assert.equal(await f.session.evaluate('events.join("|")'), 'window:keyDown:13')
      await f.session.evaluate('events.clear()')
      f.session.pointerState(20, 10, f.id, 1)
      const remapped = { windowId: f.id, x: -40, y: 15, scaleX: 1, scaleY: 1, pointerSequence: 1 }
      // The OS pointer did not move, but the Window moved underneath it. Its
      // same physical observation now projects outside, and must be consumed.
      await f.session.input(f.key('keyDown', 13, 0, remapped))
      await f.session.input(f.key('keyUp', 13, 0, remapped))
      assert.equal(await f.session.evaluate('events.count'), '0')
      await f.session.input(f.key('keyDown', 13, 0, { ...remapped, x: 30 }))
      await f.session.input(f.key('keyUp', 13, 0, { ...remapped, x: 30 }))
      assert.equal(await f.session.evaluate('events.join("|")'),
        'window:down:30,15:0:0|a:down:20,10:0:0|window:click:30,15|a:click:20,10|window:up:30,15:0:0|a:up:20,10:0:0')
      await f.execute(String.raw`
events.clear();var receiver=new Window();receiver.visible=true;receiver.setInnerSize(100,50);
receiver.useMouseKey=true;receiver.trapKey=true;
receiver.onMouseDown=function(x,y,button,shift){events.add("receiver:down:"+x+","+y);};
receiver.onMouseUp=function(x,y,button,shift){events.add("receiver:up:"+x+","+y);};
receiver.onClick=function(x,y){events.add("receiver:click:"+x+","+y);};
`)
      const receiverId = Number(await f.session.evaluate('receiver.__windowId'))
      await f.session.input({ type: 'activate', windowId: f.id })
      const observed = { windowId: receiverId, x: 10, y: 15, scaleX: 1, scaleY: 1, pointerSequence: 1 }
      await f.session.input(f.key('keyUp', 13, 0, observed))
      assert.equal(await f.session.evaluate('events.count'), '0', 'a newly enabled trap ignores its first unmatched key-up')
      await f.session.input(f.key('keyDown', 13, 0, observed))
      await f.session.input(f.key('keyUp', 13, 0, observed))
      assert.equal(await f.session.evaluate('events.join("|")'),
        'receiver:down:10,15|receiver:click:10,15|receiver:up:10,15')
      assert.equal(await f.session.evaluate('System.getKeyState(VK_RETURN)'), '0')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: derived mouse-key input is discarded when its Window retires before delivery`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      f.session.pointerState(20, 10, f.id, 1)
      await f.execute('events.clear();System.eventDisabled=true;')
      assert.equal(await f.session.evaluate('System.eventDisabled'), '1')
      const down = f.session.input(f.key('keyDown', 13)), up = f.session.input(f.key('keyUp', 13))
      await f.execute('invalidate win;System.eventDisabled=false;')
      await Promise.all([down, up])
      assert.equal(await f.session.evaluate('events.count'), '0')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
}
