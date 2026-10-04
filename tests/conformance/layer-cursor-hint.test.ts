import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { InputView } from '../../src/engine/ports/input.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

const scene = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.setInnerSize(160,100);win.visible=true;
var root=new Layer(win,null);root.setSize(160,100);root.fillRect(0,0,160,100,0xff000000);
root.cursor=crArrow;root.hint="root";
var parent=new Layer(win,root);parent.setSize(80,80);parent.setPos(10,10);parent.visible=true;
parent.cursor=crCross;parent.hint="parent";
var child=new Layer(win,parent);child.setSize(30,30);child.setPos(5,5);child.visible=true;
child.fillRect(0,0,30,30,0xffffffff);
var other=new Layer(win,root);other.setSize(30,30);other.setPos(110,10);other.visible=true;
other.fillRect(0,0,30,30,0xffffffff);other.cursor=crIBeam;other.hint="other";
`

// Exercise the real Session/native input pump in both source and bytecode.
// Expected notification points come from fixed KRKR2 LayerIntf/LayerManager,
// not from a live traversal of the Web tree at assertion time.
async function fixture(binary: boolean, body = '') {
  const f = await headless({ 'startup.tjs': '', 'cursor-hint.tjs': scene + body })
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("cursor-hint.tjs","savedata/cursor-hint.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/cursor-hint.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("cursor-hint.tjs")')
    await f.session.idle()
    const windowId = Number(await f.session.evaluate('win.__windowId'))
    return {
      ...f, windowId,
      async run(name: string) {
        const result = await f.session.evaluate(`${name}()`)
        await f.session.idle()
        return result
      },
      async move(x = 20, y = 20, id = windowId, shift = 0) {
        await f.session.input({ type: 'move', x, y, windowId: id, shift, button: 0, clicks: 0 })
        await f.session.idle()
      },
      view(id = windowId): Pick<InputView, 'cursor' | 'hint'> {
        for (let i = f.events.length - 1; i >= 0; i--) {
          const event = f.events[i]!
          if (event.type === 'window-input' && event.windowId === id)
            return { cursor: event.input.cursor, hint: event.input.hint }
        }
        throw new Error(`No input view for Window ${id}`)
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
    catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Cursor/hint startup and cleanup both failed', { cause: error })
    }
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: cursor inherits on entry and same-value child assignment, not parent changes or same-target moves`, async () => {
    const f = await fixture(binary, String.raw`
function changeParent(){parent.cursor=crHandPoint;return child.cursor;}
function refreshChild(){child.cursor=0;return child.cursor;}
function changeAgain(){parent.cursor=crIBeam;}
`)
    try {
      await f.move()
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      assert.equal(await f.run('changeParent'), '0')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      await f.move(21, 21)
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      assert.equal(await f.run('refreshChild'), '0')
      assert.equal(f.view().cursor, -21)
      await f.run('changeAgain')
      assert.equal(f.view().cursor, -21)
      await f.move(120, 20)
      await f.move()
      assert.deepEqual(f.view(), { cursor: -4, hint: 'parent' })
    } finally { await f.stop() }
  })

  test(`${mode}: hint assignment disables inheritance even when empty, and showParentHint changes only future entry`, async () => {
    const f = await fixture(binary, String.raw`
function empty(){child.hint="";return child.showParentHint;}
function own(){child.hint="own";}
function inherit(){child.showParentHint=0.5;return [child.hint,child.showParentHint].join("|");}
function changeParent(){parent.hint="new-parent";}
function stopInheriting(){child.showParentHint=false;}
`)
    try {
      await f.move()
      assert.equal(f.view().hint, 'parent')
      assert.equal(await f.run('empty'), '0')
      assert.equal(f.view().hint, '')
      await f.move(120, 20)
      await f.move()
      assert.equal(f.view().hint, '')
      await f.run('own')
      assert.equal(f.view().hint, 'own')
      assert.equal(await f.run('inherit'), 'own|1')
      await f.move(21, 21)
      assert.equal(f.view().hint, 'own')
      await f.move(120, 20)
      await f.move()
      assert.equal(f.view().hint, 'parent', 'Inheritance ignores the nonempty raw child hint')
      await f.run('changeParent')
      assert.equal(f.view().hint, 'parent')
      await f.run('stopInheriting')
      assert.equal(f.view().hint, 'parent')
      await f.move(120, 20)
      await f.move()
      assert.equal(f.view().hint, 'own')
    } finally { await f.stop() }
  })

  test(`${mode}: cursor notification samples before hit callbacks and shares its reentry guard with hint`, async () => {
    const f = await fixture(binary, String.raw`
var armed=false,hits=0;
child.onHitTest=function(x,y,hit){
  if(armed){armed=false;hits++;child.cursor=crIBeam;child.hint="nested-hint";}
};
function notify(){armed=true;child.cursor=0;return [child.cursor,child.hint,child.showParentHint,hits].join("|");}
function refreshCursor(){child.cursor=child.cursor;}
function refreshHint(){child.hint=child.hint;}
`)
    try {
      await f.move()
      assert.equal(await f.run('notify'), '-4|nested-hint|0|1')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      await f.move(21, 21)
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      await f.run('refreshCursor')
      assert.deepEqual(f.view(), { cursor: -4, hint: 'parent' })
      await f.run('refreshHint')
      assert.deepEqual(f.view(), { cursor: -4, hint: 'nested-hint' })
    } finally { await f.stop() }
  })

  test(`${mode}: hint notification retains its argument across hit callbacks and suppresses nested cursor notification`, async () => {
    const f = await fixture(binary, String.raw`
var armed=false,hits=0;
child.onHitTest=function(x,y,hit){
  if(armed){armed=false;hits++;child.hint="inner";child.cursor=crHandPoint;}
};
function notify(){armed=true;child.hint="outer";return [child.hint,child.cursor,hits].join("|");}
function refresh(){child.hint=child.hint;child.cursor=child.cursor;}
`)
    try {
      await f.move()
      assert.equal(await f.run('notify'), 'inner|-21|1')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'outer' })
      await f.move(21, 21)
      assert.deepEqual(f.view(), { cursor: -3, hint: 'outer' })
      await f.run('refresh')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'inner' })
    } finally { await f.stop() }
  })

  test(`${mode}: failing hit callbacks preserve assigned properties and old display, then release the notification guard`, async () => {
    const f = await fixture(binary, String.raw`
var armed=false;
child.onHitTest=function(x,y,hit){if(armed){armed=false;throw new Exception("notification-hit-fault");}};
function cursorFault(){armed=true;try{child.cursor=crHandPoint;}catch(e){return "caught";}return "missed";}
function hintFault(){armed=true;try{child.hint="failed-hint";}catch(e){return "caught";}return "missed";}
function raw(){return [child.cursor,child.hint,child.showParentHint].join("|");}
function recover(){child.cursor=child.cursor;child.hint=child.hint;}
`)
    try {
      await f.move()
      assert.equal(await f.run('cursorFault'), 'caught')
      assert.equal(await f.run('hintFault'), 'caught')
      assert.equal(await f.run('raw'), '-21|failed-hint|0')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      await f.run('recover')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'failed-hint' })
    } finally { await f.stop() }
  })

  test(`${mode}: entry samples final ancestor values after callbacks and before onMouseMove`, async () => {
    const f = await fixture(binary, String.raw`
var entered=0,moved=0;
child.onMouseEnter=function(){entered++;parent.cursor=crHandPoint;parent.hint="entry-parent";};
child.onMouseMove=function(x,y,shift){moved++;parent.cursor=crIBeam;parent.hint="move-parent";};
function raw(){return [entered,moved,parent.cursor,parent.hint,child.cursor,child.showParentHint].join("|");}
`)
    try {
      await f.move()
      assert.equal(await f.run('raw'), '1|1|-4|move-parent|0|1')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'entry-parent' })
      await f.move(21, 21)
      assert.deepEqual(f.view(), { cursor: -21, hint: 'entry-parent' })
    } finally { await f.stop() }
  })

  test(`${mode}: entry callback failure does not commit cursor or hint and a later entry recovers`, async () => {
    const f = await fixture(binary, String.raw`
var armed=true,caught=[];
System.exceptionHandler=function(error){caught.add(error.message);return true;};
child.onMouseEnter=function(){parent.cursor=crHandPoint;parent.hint="entry";if(armed){armed=false;throw new Exception("entry-fault");}};
function errors(){return caught.join("|");}
`)
    try {
      await f.move(120, 20)
      assert.deepEqual(f.view(), { cursor: -4, hint: 'other' })
      await f.move()
      assert.match(await f.run('errors'), /entry-fault/)
      assert.equal(f.session.snapshot().eventDisabled, false)
      assert.deepEqual(f.view(), { cursor: -4, hint: 'other' })
      await f.move()
      assert.deepEqual(f.view(), { cursor: -21, hint: 'entry' })
    } finally { await f.stop() }
  })

  test(`${mode}: notification uses the last mouse-move sample instead of newer physical observation`, async () => {
    const f = await fixture(binary, String.raw`
function childChange(){child.cursor=crHandPoint;child.hint="child-notified";}
function otherChange(){other.cursor=crArrow;other.hint="other-notified";}
`)
    try {
      await f.move()
      f.session.pointerState(120, 20, f.windowId, 1)
      await f.run('childChange')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'child-notified' })
      await f.run('otherChange')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'child-notified' })
      await f.move(120, 20)
      assert.deepEqual(f.view(), { cursor: -2, hint: 'other-notified' })
    } finally { await f.stop() }
  })

  test(`${mode}: capture chooses the notified Layer even while the pointer lies over another Layer`, async () => {
    const f = await fixture(binary, String.raw`
function otherChange(){other.cursor=crArrow;other.hint="not-captured";}
function childChange(){child.cursor=crHandPoint;child.hint="captured";}
`)
    try {
      await f.move()
      await f.session.input({ type: 'down', x: 20, y: 20, windowId: f.windowId, shift: 8, button: 0, clicks: 0 })
      await f.move(120, 20, f.windowId, 8)
      await f.run('otherChange')
      assert.deepEqual(f.view(), { cursor: -3, hint: '' })
      await f.run('childChange')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'captured' })
      await f.session.input({ type: 'up', x: 120, y: 20, windowId: f.windowId, shift: 0, button: 0, clicks: 0 })
      assert.deepEqual(f.view(), { cursor: -2, hint: 'not-captured' })
    } finally { await f.stop() }
  })

  test(`${mode}: zoom and forced rechecks preserve the last primary sample until another mouse move`, async () => {
    const f = await fixture(binary, String.raw`
function zoom(){win.setZoom(4,1);parent.cursor=crHandPoint;parent.hint="zoom-parent";root.name="force-recheck";}
function notify(){child.cursor=0;child.hint="still-child";}
`)
    try {
      await f.move()
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      await f.run('zoom')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      await f.run('notify')
      assert.deepEqual(f.view(), { cursor: -21, hint: 'still-child' })
      // A delivered client (20,20) at 4x zoom is now primary (5,5), on root.
      await f.move()
      assert.deepEqual(f.view(), { cursor: -2, hint: 'root' })
    } finally { await f.stop() }
  })

  test(`${mode}: mouse-down clears the hint after callbacks and same-target mouse-up does not restore it`, async () => {
    const f = await fixture(binary, String.raw`
child.onMouseDown=function(x,y,button,shift){child.hint="during-down";};
function refresh(){child.hint=child.hint;}
`)
    try {
      await f.move()
      await f.session.input({ type: 'down', x: 20, y: 20, windowId: f.windowId, shift: 8, button: 0, clicks: 0 })
      assert.deepEqual(f.view(), { cursor: -3, hint: '' })
      await f.session.input({ type: 'up', x: 20, y: 20, windowId: f.windowId, shift: 0, button: 0, clicks: 0 })
      assert.equal(f.view().hint, '')
      await f.move(21, 21)
      assert.equal(f.view().hint, '')
      await f.run('refresh')
      assert.equal(f.view().hint, 'during-down')
    } finally { await f.stop() }
  })

  test(`${mode}: cursor and hint notifications are isolated by displayed Window and ignore detached layers`, async () => {
    const f = await fixture(binary, String.raw`
var win2=new Window();win2.setInnerSize(80,80);win2.visible=true;
var root2=new Layer(win2,null);root2.setSize(80,80);root2.fillRect(0,0,80,80,0xff808080);
root2.cursor=crIBeam;root2.hint="second";
function second(){return win2.__windowId;}
function changeSecond(){root2.cursor=crHandPoint;root2.hint="second-changed";}
function detach(){child.parent=null;child.cursor=crNone;child.hint="detached";}
`)
    try {
      const second = Number(await f.run('second'))
      await f.move()
      await f.move(20, 20, second)
      await f.run('changeSecond')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      assert.deepEqual(f.view(second), { cursor: -21, hint: 'second-changed' })
      await f.run('detach')
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' })
      assert.deepEqual(f.view(second), { cursor: -21, hint: 'second-changed' })
      await f.move(-10, -10)
      assert.deepEqual(f.view(), { cursor: -3, hint: 'parent' }, 'Force-leave did not itself clear the display')
      await f.move(120, 20)
      await f.move(-10, -10)
      assert.deepEqual(f.view(), { cursor: 0, hint: '' })
      assert.deepEqual(f.view(second), { cursor: -21, hint: 'second-changed' })
    } finally { await f.stop() }
  })

  test(`${mode}: numeric cursor stores int32 values and a no-hit transition restores default display`, async () => {
    const f = await fixture(binary, String.raw`
function wrapped(){child.cursor=0x1fffffffd;return child.cursor;}
function none(){child.cursor=crNone;return child.cursor;}
`)
    try {
      assert.deepEqual(f.view(), { cursor: 0, hint: '' })
      await f.move()
      assert.equal(await f.run('wrapped'), '-3')
      assert.equal(f.view().cursor, -3)
      assert.equal(await f.run('none'), '-1')
      assert.equal(f.view().cursor, -1)
      await f.move(-10, -10)
      assert.deepEqual(f.view(), { cursor: 0, hint: '' })
    } finally { await f.stop() }
  })
}
