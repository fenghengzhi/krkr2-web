import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function gate() {
  let enter!: () => void, release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve }),
    result = new Promise<void>((resolve) => { release = resolve })
  return { enter, entered, result, release }
}

async function enteredGate(entered: Promise<void>, producer: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      entered,
      producer.then(() => { throw new Error('Cursor operation completed before entering its gate') }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Cursor operation did not enter its gate')), 10000)
      }),
    ])
  } finally { clearTimeout(timer) }
}

const scene = String.raw`
System.exitOnWindowClose=false;
var trace=[];
var win=new Window();win.setInnerSize(160,120);win.visible=true;
var root=new Layer(win,null);root.setSize(160,120);
var parent=new Layer(win,root);parent.setSize(100,90);parent.setPos(20,10);parent.visible=true;
var child=new Layer(win,parent);child.setSize(40,30);child.setPos(3,4);child.visible=true;
child.fillRect(0,0,40,30,0xffffffff);
var other=new Layer(win,root);other.setSize(40,30);other.setPos(90,40);other.visible=true;
other.fillRect(0,0,40,30,0xffffffff);
function position(){return [root.cursorX,root.cursorY].join(",");}
function childPosition(){return [child.cursorX,child.cursorY].join(",");}
`

// All operation bodies are loaded as source or compiled into real TJS bytecode.
// Assertions use public Layer getters, normal callbacks and Window input views.
// A decoder gate suspends the actual native stack without replacing input logic.
async function fixture(binary: boolean, body: string) {
  const blocked = gate()
  const f = await headless({
    'startup.tjs': '',
    'layer-cursor.tjs': scene + body,
    'cursor-gate.tjs': 'cursor-test:gate',
  }, {
    async decodeScript(bytes, mode, encoding) {
      if (new TextDecoder().decode(bytes) === 'cursor-test:gate') {
        blocked.enter()
        await blocked.result
        return '0;'
      }
      return readScript(bytes, mode, encoding)
    },
  })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("layer-cursor.tjs","savedata/layer-cursor.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/layer-cursor.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("layer-cursor.tjs")')
    await f.session.idle()
    const windowId = Number(await f.session.evaluate('win.__windowId'))
    return {
      ...f, blocked, windowId,
      run: (name: string) => f.session.evaluate(`${name}()`),
      trace: () => f.session.evaluate('trace.join("|")'),
      view(id = windowId): InputView {
        for (let index = f.events.length - 1; index >= 0; index--) {
          const event = f.events[index]!
          if (event.type === 'window-input' && event.windowId === id) return event.input
        }
        throw new Error(`No input view for Window ${id}`)
      },
      async stop() {
        const stopped = f.session.stop()
        blocked.release()
        await stopped
        assert.equal(f.session.snapshot().handles, 0)
        assert.equal(f.session.snapshot().bitmapBytes, 0)
        assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    blocked.release()
    try { await f.session.stop() }
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Cursor fixture startup and cleanup both failed', { cause: error })
    }
    throw error
  }
}

function cursor(view: InputView) {
  const value = view.virtualCursor
  assert(value, 'An accepted script cursor must be published by its Window')
  return value
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: cursorX stages independently per Layer and cursorY commits without setCursorPos replacing staged X`, async () => {
    const f = await fixture(binary, String.raw`
function exercise(){
  var states=[position()];
  child.cursorX=17;other.cursorX=29;states.add(position());
  child.cursorY=19;states.add(position());states.add(childPosition());
  child.setCursorPos(2,3);states.add(childPosition());
  child.cursorY=5;states.add(childPosition());
  other.cursorY=7;states.add(position());
  parent.cursorY=11;states.add(position());
  return states.join("|");
}
`)
    try {
      f.session.pointerState(5, 6, f.windowId, 1)
      assert.equal(await f.run('exercise'), '5,6|5,6|40,33|17,19|2,3|17,5|119,47|20,21')
      await f.session.idle()
      const marker = cursor(f.view())
      assert.deepEqual([marker.x, marker.y, marker.basePhysicalSequence], [20, 21, 1])
    } finally { await f.stop() }
  })

  test(`${mode}: setCursorPos checks arity and converts both int32 coordinates before moving`, async () => {
    const f = await fixture(binary, String.raw`
function exercise(){
  var states=[],errors=0,extra=0;
  child.cursorX=12;child.setCursorPos(8,9);
  try{child.setCursorPos();}catch(e){errors++;}
  try{child.setCursorPos(1);}catch(e){errors++;}
  try{child.setCursorPos(99,%[]);}catch(e){errors++;}
  try{child.setCursorPos(%[],88);}catch(e){errors++;}
  states.add(childPosition());
  var value=child.setCursorPos(-8.9,"12.9",extra++);
  states.add(childPosition());states.add(typeof value);states.add(extra);
  child.setCursorPos(0x20000000000001,-0xffffffff);states.add(childPosition());
  child.cursorY=6;states.add(childPosition());
  child.cursorX=0x100000002;child.cursorY=0x1ffffffff;states.add(childPosition());
  states.add(errors);return states.join("|");
}
`)
    try {
      assert.equal(await f.run('exercise'), '8,9|-8,12|void|1|1,1|12,6|2,-1|4')
      await f.session.idle()
      assert.deepEqual([cursor(f.view()).x, cursor(f.view()).y], [25, 13])
    } finally { await f.stop() }
  })

  test(`${mode}: cursor projection uses ancestor offsets and Window drawing zoom, independently of image or desktop offsets`, async () => {
    const f = await fixture(binary, String.raw`
function project(){
  win.left=90;win.top=-80;win.setLayerPos(-7,5);win.setZoom(2,3);
  parent.setPos(10,-5);child.setPos(-3,4);
  child.setImagePos(-2,-1);child.setClip(2,3,10,11);
  child.setCursorPos(-1,7);return childPosition();
}
function fractional(){win.setZoom(1,2);child.setCursorPos(-10,-2);}
`)
    try {
      assert.equal(await f.run('project'), '-1,7')
      await f.session.idle()
      assert.deepEqual([cursor(f.view()).x, cursor(f.view()).y], [-3, 9])
      await f.run('fractional')
      await f.session.idle()
      // Primary (-3,-3) at half zoom truncates before adding layerLeft/Top.
      assert.deepEqual([cursor(f.view()).x, cursor(f.view()).y], [-8, 4])
    } finally { await f.stop() }
  })

  test(`${mode}: detached Layer cursor reads zero and cannot move its former Window but keeps its own staged X`, async () => {
    const f = await fixture(binary, String.raw`
function seed(){root.setCursorPos(8,9);}
function secondaryManager(){
  var secondary=new Layer(win,null),nested=new Layer(win,secondary);nested.setPos(5,7);
  nested.cursorX=8;nested.cursorY=9;nested.setCursorPos(30,40);
  return [secondary.cursorX,secondary.cursorY,nested.cursorX,nested.cursorY,root.cursorX,root.cursorY].join(",");
}
function detach(){
  child.parent=null;child.cursorX=7;child.cursorY=9;child.setCursorPos(30,40);
  return [child.cursorX,child.cursorY,root.cursorX,root.cursorY].join(",");
}
function attach(){child.parent=parent;child.hasImage=false;child.cursorY=6;return childPosition();}
function invalidated(){var saved=child.setCursorPos;invalidate child;try{saved(1,2);}catch(e){return "rejected";}return "accepted";}
`)
    try {
      await f.run('seed')
      await f.session.idle()
      const before = structuredClone(cursor(f.view()))
      assert.equal(await f.run('secondaryManager'), '0,0,-5,-7,8,9')
      assert.deepEqual(cursor(f.view()), before)
      assert.equal(await f.run('detach'), '0,0,8,9')
      assert.deepEqual(cursor(f.view()), before)
      assert.equal(await f.run('attach'), '7,6')
      await f.session.idle()
      assert.deepEqual([cursor(f.view()).x, cursor(f.view()).y], [30, 20])
      assert.equal(await f.run('invalidated'), 'rejected')
    } finally { await f.stop() }
  })

  test(`${mode}: script cursor changes deliver ordinary hover and mouseMove after the calling script returns`, async () => {
    const f = await fixture(binary, String.raw`
var setting=false,reentered=0;
win.onMouseMove=function(x,y,shift){if(setting)reentered++;trace.add("window:"+x+","+y);};
child.onMouseEnter=function(){if(setting)reentered++;trace.add("child-enter");};
child.onMouseLeave=function(){trace.add("child-leave");};
child.onMouseMove=function(x,y,shift){if(setting)reentered++;trace.add("child:"+x+","+y);};
other.onMouseEnter=function(){trace.add("other-enter");};
other.onMouseMove=function(x,y,shift){trace.add("other:"+x+","+y);};
function first(){trace.clear();setting=true;child.setCursorPos(7,8);trace.add("returned");setting=false;}
function second(){trace.clear();other.cursorX=4;other.cursorY=5;trace.add("returned");}
`)
    try {
      await f.run('first')
      await f.session.idle()
      const first = (await f.trace()).split('|')
      assert.deepEqual(first, ['returned', 'window:30,22', 'child-enter', 'child:7,8'])
      assert.equal(await f.session.evaluate('reentered'), '0')
      await f.run('second')
      await f.session.idle()
      const second = (await f.trace()).split('|')
      assert.deepEqual(second, ['returned', 'window:94,45', 'child-leave', 'other-enter', 'other:4,5'])
    } finally { await f.stop() }
  })

  test(`${mode}: same-sequence or older physical delivery cannot undo a newer script cursor and fresh physical input takes over`, async () => {
    const f = await fixture(binary, String.raw`
win.onMouseMove=function(x,y,shift){trace.add(x+","+y);};
function move(){trace.clear();child.setCursorPos(6,8);}
function resetTrace(){trace.clear();}
`)
    const move = (sequence: number, x: number, y: number) => f.session.input({
      type: 'move', windowId: f.windowId, pointerSequence: sequence, x, y, shift: 0, button: 0, clicks: 0,
    })
    try {
      f.session.pointerState(4, 5, f.windowId, 1)
      await f.run('move')
      await f.session.idle()
      const before = structuredClone(cursor(f.view()))
      assert.equal(before.basePhysicalSequence, 1)
      await f.run('resetTrace')
      f.session.pointerState(4, 5, f.windowId, 1)
      await move(1, 4, 5)
      assert.equal(await f.run('position'), '29,22')
      assert.deepEqual(cursor(f.view()), before)
      assert.equal(await f.trace(), '')
      f.session.pointerState(40, 50, f.windowId, 2)
      await move(2, 40, 50)
      assert.equal(await f.run('position'), '40,50')
      assert.equal(f.view().virtualCursor ?? null, null)
      assert.equal(await f.trace(), '40,50')
      f.session.pointerState(1, 2, f.windowId, 1)
      await move(1, 1, 2)
      assert.equal(await f.run('position'), '40,50')
      assert.equal(await f.trace(), '40,50')
      await f.run('move')
      await f.session.idle()
      // Worker admissions do not repeat key observation. Their packet must
      // still take physical authority when its pointerState RPC arrives later.
      await f.session.acceptInput({
        type: 'move', windowId: f.windowId, pointerSequence: 3,
        x: 50, y: 60, shift: 0, button: 0, clicks: 0,
      }, false).completion
      assert.equal(await f.run('position'), '50,60')
      assert.equal(f.view().virtualCursor ?? null, null)
      await f.run('move')
      await f.session.idle()
      const latest = structuredClone(cursor(f.view()))
      assert.equal(latest.basePhysicalSequence, 3)
      f.session.pointerState(50, 60, f.windowId, 3)
      assert.equal(await f.run('position'), '29,22')
      assert.deepEqual(cursor(f.view()), latest)
    } finally { await f.stop() }
  })

  for (const action of ['pause', 'stop'] as const) {
    test(`${mode}: ${action} retires a virtual mouseMove queued behind a suspended script`, async () => {
      const f = await fixture(binary, String.raw`
win.onMouseMove=function(x,y,shift){Debug.message("cursor-move:"+x+","+y);};
function held(){child.setCursorPos(6,8);Debug.message("cursor-held");Scripts.execStorage("cursor-gate.tjs");Debug.message("cursor-tail");}
function fresh(){child.setCursorPos(9,10);}
`)
      let pending: Promise<string> | undefined
      try {
        pending = f.run('held')
        await enteredGate(f.blocked.entered, pending)
        assert.deepEqual(f.logs, ['cursor-held'])
        if (action === 'pause') {
          f.session.pause()
          assert.equal(f.view().virtualCursor ?? null, null)
          f.session.pointerState(100, 100, f.windowId, 1)
          f.session.resume()
          f.blocked.release()
          await pending
          await f.session.idle()
          assert.deepEqual(f.logs, ['cursor-held', 'cursor-tail'])
          assert.equal(f.view().virtualCursor ?? null, null)
          await f.run('fresh')
          await f.session.idle()
          assert.deepEqual(f.logs, ['cursor-held', 'cursor-tail', 'cursor-move:32,24'])
        } else {
          const cancelled = assert.rejects(pending, /Execution cancelled/)
          await f.stop()
          await cancelled
          f.session.pointerState(100, 100, f.windowId, 1)
          assert.deepEqual(f.logs, ['cursor-held'])
          assert.equal(f.session.snapshot().state, 'stopped')
        }
      } finally {
        await f.stop()
        await Promise.allSettled(pending ? [pending] : [])
      }
    })
  }

  test(`${mode}: cursor state and physical sequences stay with their Window across inactive writes and retirement`, async () => {
    const f = await fixture(binary, String.raw`
var second=new Window();second.setInnerSize(140,90);second.visible=true;
var secondRoot=new Layer(second,null);secondRoot.setSize(140,90);
function firstCursor(){child.setCursorPos(4,5);}
function secondCursor(){secondRoot.setCursorPos(11,13);}
function positions(){return [root.cursorX,root.cursorY,secondRoot.cursorX,secondRoot.cursorY].join(",");}
function retireFirst(){invalidate win;child.cursorX=99;child.cursorY=98;return [child.cursorX,child.cursorY,secondRoot.cursorX,secondRoot.cursorY].join(",");}
`)
    try {
      const secondId = Number(await f.session.evaluate('second.__windowId'))
      await f.session.activateWindow(secondId)
      f.session.pointerState(2, 3, f.windowId, 5)
      f.session.pointerState(80, 70, secondId, 1)
      await f.run('firstCursor')
      await f.session.idle()
      assert.equal(await f.run('positions'), '27,19,80,70')
      assert.deepEqual([cursor(f.view()).x, cursor(f.view()).y, cursor(f.view()).basePhysicalSequence], [27, 19, 5])
      assert.equal(f.session.snapshot().activeWindow, secondId)
      await f.run('secondCursor')
      await f.session.idle()
      assert.equal(await f.run('positions'), '27,19,11,13')
      const before = structuredClone(cursor(f.view(secondId)))
      assert.equal(before.basePhysicalSequence, 1)
      assert.equal(await f.run('retireFirst'), '0,0,11,13')
      assert.deepEqual(cursor(f.view(secondId)), before)
      f.session.pointerState(1, 1, f.windowId, 6)
      assert.equal(await f.session.evaluate('[secondRoot.cursorX,secondRoot.cursorY].join(",")'), '11,13')
      assert.equal(f.session.snapshot().activeWindow, secondId)
    } finally { await f.stop() }
  })
}
