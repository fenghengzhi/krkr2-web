import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { WindowMoveRequest } from '../../src/engine/ports/window-move.ts'

const originalMessage = 'フルスクリーン中では操作できないメソッドを呼び出そうとしました'
const source = String.raw`
System.exitOnWindowClose=false;
var owner=new Window();owner.caption="Owner";owner.setInnerSize(80,48);owner.visible=true;
class TargetWindow extends Window {
 function TargetWindow(){super.Window();caption="Target";setInnerSize(80,48);setPos(30,40);visible=true;}
 function onKeyDown(key,shift){Debug.message("method-key:"+key);}
}
var target=new TargetWindow();
function stage(shown){if(target.fullScreen)target.fullScreen=false;target.visible=shown;target.fullScreen=true;return state();}
function normal(shown){target.fullScreen=false;target.visible=shown;return state();}
function methodFailure(which){
 try{if(which==0)target.beginMove();else target.showModal();}catch(error){return error.message;}
 return "NO_ERROR";
}
function propertyFailure(){try{target.width=target.width+1;}catch(error){return error.message;}return "NO_ERROR";}
function translate(){
 System.assignMessage("TVPInvalidMethodInFullScreen","method-live:%%:%1");
 System.assignMessage("TVPInvalidPropertyInFullScreen","property-live:%%:%1");return 1;
}
function queueInput(){System.eventDisabled=true;target.postInputEvent("onKeyDown",%[key:65,shift:0]);return 1;}
function resumeInput(){System.eventDisabled=false;return 1;}
function state(){return [target.visible,target.fullScreen,target.left,target.top,target.width,target.height].join(",");}
function runModal(){target.showModal();Debug.message("method-modal-return");return 17;}
function runMove(){target.beginMove();Debug.message("method-move-return");return 23;}
`
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Window method observation timed out')), 10000)
  })]) } finally { clearTimeout(timer) }
}
async function until(condition: () => boolean) {
  const end = performance.now() + 10000
  while (!condition()) {
    if (performance.now() > end) throw new Error('Window method state was not observed')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
async function fixture(binary: boolean, supported: boolean) {
  const f = await headless({ 'window-methods.tjs': source, 'startup.tjs': binary
    ? 'Scripts.compileStorage("window-methods.tjs","savedata/window-methods.cjs",false,true,false);Scripts.execStorage("savedata/window-methods.cjs");'
    : 'Scripts.execStorage("window-methods.tjs");' }, { windowMoveSupported: supported })
  try {
    await f.session.start(); await f.session.idle()
    if (binary) {
      const saved = f.session.exportSaves().find((file) => file.path === 'savedata/window-methods.cjs')
      assert(saved); assert.equal(new TextDecoder().decode(saved.bytes.subarray(0, 4)), 'TJS2')
    }
    const id = Number(await f.session.evaluate('target.__windowId')),
      pending: Promise<{ value?: string; error?: unknown }>[] = []
    return { ...f, id,
      run: (expression: string) => bounded(f.session.evaluate(expression)),
      begin(expression: string) {
        const result = f.session.evaluate(expression).then((value) => ({ value }), (error: unknown) => ({ error }))
        pending.push(result); return result
      },
      view: () => f.session.snapshot().windows!.find((window) => window.id === id)!.view,
      moves: () => f.events.flatMap((event) => event.type === 'window-move' && event.request ? [event.request] : []),
      async close() {
        await f.session.stop(); await Promise.all(pending)
        assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
      },
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Window methods setup and cleanup failed', { cause: error }) }
    throw error
  }
}
async function using(binary: boolean, supported: boolean, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary, supported), errors: unknown[] = []
  try { await body(f) } catch (error) { errors.push(error) }
  try { await f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Window method regression and cleanup failed', { cause: errors[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: fullscreen methods precede visibility checks, preserve queued input and resolve the real method holder separately from properties`, { timeout: 60000 }, async () => {
    await using(binary, true, async (f) => {
      await f.run('stage(true)')
      assert.equal(await f.run('methodFailure(0)'), originalMessage)
      assert.equal(await f.run('methodFailure(1)'), originalMessage, 'Fullscreen wins over the visible-window modal error')
      await f.run('translate()'); await f.run('queueInput()')
      const before = await f.run('state()')
      assert.equal(await f.run('methodFailure(0)'), 'method-live:%%:%1')
      assert.equal(await f.run('methodFailure(1)'), 'method-live:%%:%1')
      assert.equal(await f.run('propertyFailure()'), 'property-live:%%:%1')
      assert.equal(await f.run('state()'), before)
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.moves().length, 0)
      await f.run('resumeInput()')
      await until(() => f.logs.includes('method-key:65'))
      assert.equal(f.logs.filter((value) => value === 'method-key:65').length, 1,
        'Rejected showModal did not enter its input-clearing phase')
      await f.run('stage(false)')
      const hidden = await f.run('state()')
      assert.equal(await f.run('methodFailure(0)'), 'method-live:%%:%1')
      assert.equal(await f.run('methodFailure(1)'), 'method-live:%%:%1')
      assert.equal(await f.run('state()'), hidden)
      assert.equal(f.view().visible, false)
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.moves().length, 0)
    })
  })

  test(`${mode}: fullscreen rejection precedes missing move presentation while windowed visibility and host errors remain distinct`, { timeout: 60000 }, async () => {
    await using(binary, false, async (f) => {
      await f.run('translate()'); await f.run('stage(true)')
      assert.equal(await f.run('methodFailure(0)'), 'method-live:%%:%1')
      assert.equal(await f.run('methodFailure(1)'), 'method-live:%%:%1')
      await f.run('normal(true)')
      assert.equal(await f.run('methodFailure(0)'), 'Window moving presentation is unavailable')
      assert.equal(await f.run('methodFailure(1)'), 'A modal Window must be hidden before showModal')
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.moves().length, 0)
    })
  })

  test(`${mode}: after leaving fullscreen a real Window modal and independent move request complete normally`, { timeout: 60000 }, async () => {
    await using(binary, true, async (f) => {
      await f.run('translate()'); await f.run('stage(true)')
      assert.equal(await f.run('methodFailure(0)'), 'method-live:%%:%1')
      assert.equal(await f.run('methodFailure(1)'), 'method-live:%%:%1')
      await f.run('normal(false)')
      const modal = f.begin('runModal()')
      await until(() => f.session.inspectOwnership().modalWaits === 1 && f.view().visible)
      await bounded(f.session.closeWindow(f.id))
      assert.deepEqual(await bounded(modal), { value: '17' })
      assert.equal(f.view().visible, false)
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      await f.run('normal(true)')
      const move = f.begin('runMove()')
      await until(() => f.moves().length === 1 && f.session.inspectOwnership().modalWaits === 1)
      const request: WindowMoveRequest = f.moves()[0]!
      assert.equal(f.session.windowMove({ ...request, type: 'commit', sequence: 1, left: 50, top: 60 }), true)
      assert.deepEqual(await bounded(move), { value: '23' })
      assert.equal(await f.run('state()'), '1,0,50,60,80,48')
      assert.equal(f.session.windowMove({ ...request, type: 'commit', sequence: 2, left: 900, top: 900 }), false)
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.logs.filter((value) => value === 'method-modal-return').length, 1)
      assert.equal(f.logs.filter((value) => value === 'method-move-return').length, 1)
    })
  })
}
