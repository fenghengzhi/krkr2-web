import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { PhysicalPointerScreen } from '../../src/engine/ports/input.ts'

async function fixture(binary: boolean) {
  const source = `System.exitOnWindowClose=false;
var a=new Window();a.setInnerSize(80,60);a.visible=true;
var root=new Layer(a,null);a.add(root);root.setSize(160,120);
var b=new Window();b.setInnerSize(80,60);b.visible=true;
var other=new Layer(b,null);b.add(other);other.setSize(80,60);
function hide(){a.hideMouseCursor();}
function hideAgain(){a.mouseCursorState=mcsTempHidden;}
function permanent(){a.mouseCursorState=mcsHidden;}
function visible(){a.mouseCursorState=mcsVisible;}
function moveScript(){root.setCursorPos(12,14);}
function relocate(){a.setPos(25,30);a.setLayerPos(8,12);a.setZoom(3,2);}
function state(){return a.mouseCursorState;}
function retire(){invalidate a;}`,
    f = await headless({ 'startup.tjs': binary
      ? 'Scripts.compileStorage("hidden.tjs","savedata/hidden.cjs",false,true,false);Scripts.execStorage("savedata/hidden.cjs");'
      : 'Scripts.execStorage("hidden.tjs");', 'hidden.tjs': source })
  try {
    await f.session.start(); await f.session.idle()
    if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves().find((x) => x.path === 'savedata/hidden.cjs')!.bytes.subarray(0,4)), 'TJS2')
    const a = Number(await f.session.evaluate('a.__windowId')), b = Number(await f.session.evaluate('b.__windowId'))
    return { ...f, a, b, run: (name: string) => f.session.evaluate(name+'()'),
      state: () => f.session.evaluate('state()'),
      screen: (sequence: number, x: number, y: number, restoreWindowId?: number): PhysicalPointerScreen =>
        ({ sequence, x, y, ...(restoreWindowId === undefined ? {} : { restoreWindowId }) }),
      async stop() { await f.session.stop(); assert(Object.values(f.session.inspectOwnership()).every((n) => n === 0)) } }
  } catch (error) {
    try { await f.session.stop() } catch (cleanup) { throw new AggregateError([error,cleanup], 'Cursor setup and cleanup failed') }
    throw error
  }
}
async function finish(f: Awaited<ReturnType<typeof fixture>>, failures: unknown[]) {
  try { await f.stop() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Cursor scenario or cleanup failed')
}
for (const binary of [false,true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: temp-hidden cursor requires screen displacement, independently of physical button/wheel authority`, { timeout: 60000 }, async () => {
    const f = await fixture(binary), failures: unknown[] = []
    try {
      f.session.pointerState(10,20,f.a,1,f.screen(1,400,300,f.a)); await f.run('moveScript')
      const scripted = f.events.filter((e) => e.type === 'window-input' && e.windowId === f.a).at(-1)!
      assert(scripted.type === 'window-input' && scripted.input.virtualCursor)
      await f.run('hide')
      f.session.pointerState(10,20,f.a,2,f.screen(2,400,300))
      assert.equal(await f.state(), '1')
      const input = f.events.filter((e) => e.type === 'window-input' && e.windowId === f.a).at(-1)!
      assert.equal(input.type, 'window-input')
      if (input.type === 'window-input') assert.equal(input.input.virtualCursor ?? null, null)
      await f.session.acceptInput({ type: 'wheel', windowId: f.a, x: 10, y: 20, shift: 0, delta: 120,
        pointerSequence: 3, physicalScreen: f.screen(3,400,300) }, false).completion
      f.session.screenPointerState(f.screen(4,400,300,f.a))
      assert.equal(await f.state(), '1')
      f.session.screenPointerState(f.screen(5,401,300,f.a))
      assert.equal(await f.state(), '0')
    } catch (error) { failures.push(error) } finally { await finish(f, failures) }
  })
  test(`${mode}: Window projection changes cannot masquerade as movement of the screen pointer`, { timeout: 60000 }, async () => {
    const f = await fixture(binary), failures: unknown[] = []
    try {
      f.session.pointerState(10,20,f.a,1,f.screen(1,-40,300,f.a)); await f.run('hide'); await f.run('relocate')
      f.session.pointerState(-15,-10,f.a,2,f.screen(2,-40,300,f.a))
      assert.equal(await f.state(), '1')
      f.session.screenPointerState(f.screen(3,-40,300.9,f.a))
      assert.equal(await f.state(), '1', 'Native screen coordinates are integral')
      f.session.screenPointerState(f.screen(4,-40,301,f.a))
      assert.equal(await f.state(), '0')
    } catch (error) { failures.push(error) } finally { await finish(f, failures) }
  })
  test(`${mode}: global screen baseline, per-Window restore target and repeated hide follow the original latch`, { timeout: 60000 }, async () => {
    const f = await fixture(binary), failures: unknown[] = []
    try {
      f.session.screenPointerState(f.screen(1,400,300,f.a)); await f.run('hide')
      f.session.screenPointerState(f.screen(2,500,320,f.b)); await f.run('hideAgain')
      assert.equal(await f.state(), '1')
      f.session.screenPointerState(f.screen(3,500,320,f.a))
      assert.equal(await f.state(), '0', 'Repeated temp-hidden does not move its original hide baseline')
      await f.run('hide')
      f.session.screenPointerState(f.screen(4,500,320,f.a))
      assert.equal(await f.state(), '1', 'A new hide uses the latest global position, including another Window')
    } catch (error) { failures.push(error) } finally { await finish(f, failures) }
  })
  test(`${mode}: packet-first and RPC-first observations settle once and late copies cannot restore a later hide`, { timeout: 60000 }, async () => {
    const f = await fixture(binary), failures: unknown[] = []
    try {
      f.session.screenPointerState(f.screen(1,400,300,f.a)); await f.run('hide')
      const moved = f.screen(2,401,300,f.a)
      await f.session.acceptInput({ type: 'move', windowId: f.a, x: 11, y: 20, button: 0, clicks: 0, shift: 0,
        pointerSequence: 1, physicalScreen: moved }, false).completion
      assert.equal(await f.state(), '0'); await f.run('hide')
      f.session.screenPointerState(moved); f.session.pointerState(11,20,f.a,1,moved)
      f.session.screenPointerState(f.screen(1,999,999,f.a))
      assert.equal(await f.state(), '1')
      f.session.screenPointerState(f.screen(3,402,300,f.a)); assert.equal(await f.state(), '0')
      await f.run('hide')
      await f.session.acceptInput({ type: 'move', windowId: f.a, x: 12, y: 20, button: 0, clicks: 0, shift: 0,
        pointerSequence: 2, physicalScreen: f.screen(3,402,300,f.a) }, false).completion
      assert.equal(await f.state(), '1')
    } catch (error) { failures.push(error) } finally { await finish(f, failures) }
  })
  test(`${mode}: script cursor writes force temporary visibility but preserve permanent hidden state`, { timeout: 60000 }, async () => {
    const f = await fixture(binary), failures: unknown[] = []
    try {
      f.session.screenPointerState(f.screen(1,400,300,f.a)); await f.run('hide'); await f.run('moveScript')
      assert.equal(await f.state(), '0'); await f.run('permanent'); await f.run('moveScript')
      f.session.screenPointerState(f.screen(2,410,310,f.a))
      assert.equal(await f.state(), '2')
    } catch (error) { failures.push(error) } finally { await finish(f, failures) }
  })
  test(`${mode}: missing screen history establishes a baseline; invalid/retired/stopped observations cannot revive state`, { timeout: 60000 }, async () => {
    const f = await fixture(binary), failures: unknown[] = []
    try {
      await f.run('hide'); f.session.screenPointerState(f.screen(1,400,300,f.a))
      assert.equal(await f.state(), '1')
      assert.throws(() => f.session.pointerState(100,100,f.a,100,f.screen(100,NaN,300,f.a)), /screen observation/)
      f.session.pointerState(11,20,f.a,1,f.screen(2,401,300,f.a))
      assert.equal(await f.state(), '0', 'A rejected observation does not consume either sequence')
      await f.run('hide'); await f.run('retire')
      f.session.screenPointerState(f.screen(3,402,300,f.a))
      assert.equal(f.session.snapshot().windows!.some((x) => x.id === f.a), false)
      await f.session.stop()
      const count = f.events.length
      f.session.screenPointerState(f.screen(4,403,300,f.b))
      assert.equal(f.events.length, count)
    } catch (error) { failures.push(error) } finally { await finish(f, failures) }
  })
}
