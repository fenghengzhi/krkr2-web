import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'

const source = String.raw`
var originalSystem=System,appTrace=[];
function appMark(value){appTrace.add(value);Debug.message("application:"+value);}
System.onActivate=function(args*){appMark("activate:"+args.count);};
System.onDeactivate=function(args*){appMark("deactivate:"+args.count);};
var first=new Window();first.visible=true;var second=new Window();second.visible=true;
`
async function fixture(binary: boolean, extra = '') {
  const f = await headless({ 'application.tjs': source + extra,
    'startup.tjs': binary
      ? 'Scripts.compileStorage("application.tjs","savedata/application.cjs",false,true,false);Scripts.execStorage("savedata/application.cjs");'
      : 'Scripts.execStorage("application.tjs");' })
  try { await f.session.start(); await f.session.idle() }
  catch (error) { await f.session.stop(); throw error }
  let sequence = 0
  return { ...f, post: (active: boolean) => f.session.acceptApplicationActivation({ sequence: ++sequence, active }),
    exec: (program: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(program + ';')})`),
    trace: () => f.session.evaluate('appTrace.join("|")') }
}
async function until(test: () => boolean): Promise<void> {
  const deadline = performance.now() + 10000
  while (!test()) {
    if (performance.now() > deadline) throw new Error('Application event did not reach its modal boundary')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: System application events are independent of Window and page-control popup focus`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const id = Number(await f.session.evaluate('first.__windowId'))
      await f.session.activateWindow(id)
      await f.session.acceptWindowPopup({ type: 'application', active: false }).completion
      await f.session.acceptWindowPopup({ type: 'window', windowId: id }).completion
      assert.equal(await f.trace(), '')
      await f.post(false).completion; await f.post(true).completion
      assert.equal(await f.trace(), 'deactivate:0|activate:0')
      assert.equal(await f.session.evaluate('typeof originalSystem.__applicationEvent'), 'undefined')
      if (binary) assert.equal(new TextDecoder().decode(f.session.exportSaves().find((file) => file.path === 'savedata/application.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
  test(`${mode}: disabled application posts replace one shared native source and reject stale observations`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('System.eventDisabled=true')
      const receipts = [f.post(false), f.post(true), f.post(false)]
      assert.equal(f.session.acceptApplicationActivation({ sequence: 1, active: true }).status, 'ignored')
      assert.equal(await f.trace(), '')
      await f.exec('System.eventDisabled=false')
      await Promise.all(receipts.map((receipt) => receipt.completion))
      assert.equal(await f.trace(), 'deactivate:0')
      await f.post(false).completion
      assert.equal(await f.trace(), 'deactivate:0|deactivate:0', 'The native input source permits a repeated delivered state')
      assert.throws(() => f.session.acceptApplicationActivation({ sequence: -1, active: false }), /Invalid application/)
    } finally { await f.session.stop() }
  })
  test(`${mode}: application delivery reads the current global System and preserves bound callback context`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('System.eventDisabled=true;var owner=%[label:"bound"];function bound(args*){appMark(this.label+":"+args.count);}')
      const pending = f.post(false)
      await f.exec('originalSystem.onDeactivate=bound incontextof owner;originalSystem.eventDisabled=false')
      await pending.completion
      await f.exec('global.System=%[onActivate:function(args*){appMark("replacement:"+args.count);}];')
      await f.post(true).completion
      await f.exec('global.System=7')
      await f.post(false).completion
      await f.exec('delete global.System')
      await f.post(true).completion
      await f.exec('global.System=originalSystem;System.onDeactivate=null')
      await f.post(false).completion
      assert.equal(await f.trace(), 'bound:0|replacement:0')
      assert.equal(f.logs.filter((line) => line.startsWith('Error in retrieving System.')).length, 0)
    } finally { await f.session.stop() }
  })
  test(`${mode}: application getter failures are logged once while actual callback failures use the event exception handler`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.exec('var reads=0;property brokenSlot{getter(){reads++;throw new Exception("application getter failed");}};&System.onDeactivate=&brokenSlot;System.exceptionHandler=function(error){appMark("handled:"+error.message);return true;}')
      await f.post(false).completion
      assert.equal(await f.session.evaluate('reads'), '1')
      assert.equal(await f.trace(), '')
      assert.equal(f.logs.filter((line) => line === 'Error in retrieving System.onActivate/onDeactivate : application getter failed').length, 1)
      assert.equal(f.session.snapshot().eventDisabled, false)
      await f.exec('var globalReads=0;property brokenSystem{getter(){globalReads++;throw new Exception("global System getter failed");}};&global.System=&brokenSystem;')
      await f.post(true).completion
      await f.exec('&global.System=originalSystem')
      assert.equal(await f.session.evaluate('globalReads'), '1')
      assert.equal(f.logs.filter((line) => line === 'Error in retrieving System.onActivate/onDeactivate : global System getter failed').length, 1)
      await f.exec('&System.onDeactivate=function(){throw new Exception("application callback failed");}')
      await f.post(false).completion
      assert.equal(await f.trace(), 'handled:application callback failed')
      assert.equal(f.session.snapshot().eventDisabled, false)
      await f.exec('System.exceptionHandler=null')
      await f.post(false).completion
      assert.equal(f.session.snapshot().eventDisabled, true)
      assert(f.logs.some((line) => line === 'application callback failed'))
    } finally { await f.session.stop() }
  })
  test(`${mode}: user pause preserves only the latest application input and Stop revokes pending delivery`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      f.session.pause()
      const old = f.post(false), current = f.post(true)
      f.session.resume()
      await Promise.all([old.completion, current.completion])
      assert.equal(await f.trace(), 'activate:0')
      await f.exec('System.eventDisabled=true')
      const cancelled = f.post(false), completion = Promise.allSettled([cancelled.completion])
      await f.session.stop(); await completion
      assert.equal(f.logs.filter((line) => line === 'application:deactivate:0').length, 0)
      assert.equal(f.session.acceptApplicationActivation({ sequence: 999, active: true }).status, 'ignored')
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
  test(`${mode}: application callbacks use the existing nested modal event pump and Stop unwinds their native closure`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'System.onDeactivate=function(){appMark("before-dialog");System.inform("application modal");appMark("after-dialog");};')
    const completion = Promise.allSettled([f.post(false).completion])
    try {
      await until(() => f.events.some((event) => event.type === 'system-dialog' && event.request?.kind === 'inform'))
      const activation = f.post(true)
      await until(() => f.logs.includes('application:activate:0'))
      await activation.completion
      await f.session.stop(); await completion
      assert(f.logs.includes('application:before-dialog'))
      assert(!f.logs.includes('application:after-dialog'))
    } finally { await f.session.stop(); await completion }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })
}
