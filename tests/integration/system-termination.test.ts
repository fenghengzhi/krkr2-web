import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readText } from '../../src/backends/files/text-codecs.ts'
import { MemorySaveStore, type SaveFile } from '../../src/engine/ports/saves.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'
import type { Resource } from '../../src/engine/ports/storage.ts'
import type { MenuPopup } from '../../src/engine/scene/menus.ts'

const base = String.raw`
System.exitOnWindowClose=false;
function mark(value){Debug.message("termination:"+value);}
function argument(){mark("argument");return %[];}
function stopNow(){System.exit(argument(),mark("extra"));mark("unreachable");}
function stopLater(){mark("return:"+int(System.terminate(argument(),mark("extra"))===void));System.terminate();Scripts.exec('mark("nested");');mark("after");}
function stopThenFail(){System.terminate();throw new Exception("termination script failed");}
`
async function fixture(binary: boolean, body = '', overrides: Partial<SessionDependencies> = {}, resources: Resource[] = []) {
  const f = await headless({ 'termination.tjs': base + body, 'startup.tjs': binary
    ? 'Scripts.compileStorage("termination.tjs","savedata/termination.cjs",false,true,false);Scripts.execStorage("savedata/termination.cjs");'
    : 'Scripts.execStorage("termination.tjs");' }, overrides)
  try { if (resources.length) f.session.mount(resources); await f.session.start() }
  catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Termination startup and cleanup failed', { cause: error }) }
    throw error
  }
  return { ...f, exec: (program: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(program + ';')})`),
    trace: () => f.logs.filter((line) => line.startsWith('termination:')).map((line) => line.slice(12)) }
}
async function until(condition: () => boolean) {
  const deadline = performance.now() + 10000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('Termination did not reach its observation boundary')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => { release = resolve })
  return { promise, release }
}
function clean(f: Awaited<ReturnType<typeof fixture>>) {
  assert.equal(f.session.snapshot().state, 'stopped')
  assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
}

class MenuClock {
  time = 0
  readonly tasks = new Set<{ at: number; callback(): void }>()
  now = () => this.time
  schedule = (callback: () => void, delay: number) => {
    const task = { at: this.time + delay, callback }
    this.tasks.add(task)
    return () => { this.tasks.delete(task) }
  }
  advance(milliseconds: number) {
    this.time += milliseconds
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.callback()
  }
}
const menuProgram = String.raw`
var owner=new Window();owner.visible=true;
var group=new MenuItem(owner,"Pending termination menu");owner.menu.add(group);group.add(new MenuItem(owner,"Keep waiting"));
function quitTick(){quitTimer.enabled=false;mark("timer-before");System.terminate();mark("timer-after");heldTimer.enabled=true;}
function heldTick(){heldTimer.enabled=false;mark("pending-menu-500");}
var quitTimer=new Timer(global,"quitTick");quitTimer.enabled=false;quitTimer.interval=100;
var heldTimer=new Timer(global,"heldTick");heldTimer.enabled=false;heldTimer.interval=500;
function runMenu(){mark("popup-before");quitTimer.enabled=true;group.popup(0,20,30);mark("popup-after");}
`
async function menuFixture(binary: boolean) {
  const clock = new MenuClock()
  const f = await fixture(binary, menuProgram, { now: clock.now, schedule: clock.schedule })
  let settled = false
  let failed = false
  let failure: unknown
  const opening = f.exec('runMenu()')
  const result = opening.then(
    (value) => { settled = true; return { ok: true as const, value } },
    (error: unknown) => { settled = true; failed = true; failure = error; return { ok: false as const, error } },
  )
  const popup = (): MenuPopup | undefined => {
    const event = [...f.events].reverse().find((entry) => entry.type === 'window-menus')
    return event?.type === 'window-menus' ? event.windows.find((window) => window.menus.popup)?.menus.popup : undefined
  }
  const wait = async (condition: () => boolean) => {
    await until(() => {
      if (failed) throw failure
      if (settled) throw new Error('Menu ended before its required observation: ' + f.trace().join('|'))
      return condition()
    })
  }
  return { ...f, clock, opening, result, popup, wait, settled: () => settled }
}
async function pendingMenu(binary: boolean, body: (f: Awaited<ReturnType<typeof menuFixture>>, popup: MenuPopup) => Promise<void>) {
  const f = await menuFixture(binary), errors: unknown[] = []
  try {
    await f.wait(() => !!f.popup() && f.session.inspectOwnership().modalWaits === 1)
    const popup = f.popup()!
    f.clock.advance(100)
    await f.wait(() => f.trace().includes('timer-after') && f.session.inspectOwnership().modalWaits === 1)
    f.clock.advance(499)
    assert.deepEqual(f.trace(), ['popup-before', 'timer-before', 'timer-after'])
    f.clock.advance(1)
    await f.wait(() => f.trace().includes('pending-menu-500') && f.session.inspectOwnership().modalWaits === 1)
    assert.deepEqual(f.trace(), ['popup-before', 'timer-before', 'timer-after', 'pending-menu-500'])
    assert.equal(f.session.snapshot().state, 'running')
    assert.equal(f.session.inspectOwnership().modalScopes, 1)
    assert.equal(f.settled(), false)
    assert.deepEqual(f.popup(), popup)
    await body(f, popup)
  } catch (error) { errors.push(error) }
  try { await f.session.stop() } catch (error) { errors.push(error) }
  try { await f.result; clean(f); assert.equal(f.clock.tasks.size, 0) } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Pending-menu termination and cleanup failed', { cause: errors[0] })
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: terminate returns void and ignores conversion while exit never resumes its TJS catch or caller`, { timeout: 60000 }, async () => {
    for (const immediate of [false, true]) {
      const f = await fixture(binary, 'function run(){try{' + (immediate ? 'stopNow();' : 'stopLater();') + '}catch(error){mark("caught");}mark("caller");}')
      try {
        // No startup Window: this batch does not invent exitOnNoWindowStartup.
        assert.equal(f.session.snapshot().state, 'running')
        await f.exec('run()')
        await f.session.stop()
        assert.deepEqual(f.trace(), immediate ? ['argument', 'extra'] : ['argument', 'extra', 'return:1', 'nested', 'after', 'caller'])
        clean(f)
      } finally { await f.session.stop() }
    }
    const failed = await fixture(binary)
    try {
      await assert.rejects(failed.exec('stopThenFail()'), /termination script failed/)
      assert.equal(failed.session.snapshot().state, 'failed', 'Posted quit must not hide a later script failure')
      assert(failed.session.snapshot().handles > 0, 'Failure keeps the VM available for diagnostics until explicit Stop')
    } finally { await failed.session.stop() }
  })
  test(`${mode}: pending terminate preserves ordinary I/O and respects user pause before unwinding`, { timeout: 60000 }, async () => {
    const held = gate()
    let entered = false
    const f = await fixture(binary, 'function run(){System.terminate();mark("before-read");var a=[];a.load("held.txt");mark("read:"+a[0]);}', {},
      [{ name: 'held.txt', size: 5, read: async () => { entered = true; await held.promise; return new TextEncoder().encode('value') } }])
    const work = f.exec('run()'), settled = Promise.allSettled([work])
    try {
      await until(() => entered)
      assert.deepEqual(f.trace(), ['before-read'])
      assert.equal(f.session.snapshot().state, 'running')
      f.session.pause(); held.release()
      assert.equal(f.session.snapshot().state, 'paused')
      f.session.resume(); await work; await f.session.stop()
      assert.deepEqual(f.trace(), ['before-read', 'read:value'])
      clean(f)
    } finally { held.release(); await settled; await f.session.stop() }
  })
  test(`${mode}: external Stop cancels a pending terminate and a late I/O reply cannot resume its script`, { timeout: 60000 }, async () => {
    const held = gate()
    let entered = false
    const f = await fixture(binary, 'function run(){System.terminate();var a=[];a.load("held.txt");mark("after-read");}', {},
      [{ name: 'held.txt', size: 1, read: async () => { entered = true; await held.promise; return new Uint8Array([65]) } }])
    const result = Promise.allSettled([f.exec('run()')])
    try {
      await until(() => entered)
      const stopping = f.session.stop()
      held.release(); await stopping; await result
      assert.deepEqual(f.trace(), [])
      clean(f)
    } finally { held.release(); await result; await f.session.stop() }
  })
  test(`${mode}: pending termination ends application dialog and Window continuations through their normal canceled result`, { timeout: 60000 }, async () => {
    // Source proves posted Application.Terminate versus synchronous exit. The
    // pinned SDK companion records the VCL/Win32 loop return ordering separately.
    for (const call of ['System.inform("end")', 'System.inputString("end","body","initial")', 'hidden.showModal()']) {
      const f = await fixture(binary, `var owner=new Window();owner.visible=true;var hidden=new Window();var group=new MenuItem(owner,"group");owner.menu.add(group);group.add(new MenuItem(owner,"item"));function run(){System.terminate();var result=${call};mark("after-modal:"+int(result===void)+":"+int(result===0));}`)
      try {
        await f.exec('run()'); await f.session.stop()
        assert.deepEqual(f.trace(), ['after-modal:1:0'])
        clean(f)
      } finally { await f.session.stop() }
    }
  })
  test(`${mode}: timer termination leaves a real popup waiting for 500ms before an explicit menu dismissal unwinds the outer entry`, { timeout: 60000 }, async () => {
    await pendingMenu(binary, async (f, popup) => {
      f.session.menuDismiss({ windowId: popup.windowId, requestId: popup.requestId })
      const result = await f.result
      if (!result.ok) throw result.error
      await until(() => f.session.snapshot().state === 'stopped')
      assert.deepEqual(f.trace(), ['popup-before', 'timer-before', 'timer-after', 'pending-menu-500', 'popup-after'])
      clean(f)
    })
  })
  test(`${mode}: external Stop cancels a menu with pending termination and ignores its late dismissal`, { timeout: 60000 }, async () => {
    await pendingMenu(binary, async (f, popup) => {
      await f.session.stop()
      await f.result
      clean(f)
      const trace = f.trace()
      assert.deepEqual(trace, ['popup-before', 'timer-before', 'timer-after', 'pending-menu-500'])
      f.session.menuDismiss({ windowId: popup.windowId, requestId: popup.requestId })
      f.clock.advance(1000)
      await Promise.resolve()
      assert.deepEqual(f.trace(), trace)
      clean(f)
      assert.equal(f.clock.tasks.size, 0)
    })
  })
  test(`${mode}: termination preserves the current event round paint tail but cancels subsequent admissions`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, String.raw`
var armed=false;var owner=new Window();owner.setInnerSize(16,16);owner.visible=true;
var root=new Layer(owner,null);owner.add(root);root.setSize(16,16);root.setImageSize(16,16);
root.onPaint=function(){if(armed){mark("paint");root.fillRect(0,0,16,16,0xff123456);}};
System.onDeactivate=function(){armed=true;System.terminate();root.update();mark("event-after");};
`)
    try {
      await f.session.acceptApplicationActivation({ sequence: 1, active: false }).completion
      await f.session.stop()
      assert.deepEqual(f.trace(), ['event-after', 'paint'])
      assert.equal(f.session.acceptApplicationActivation({ sequence: 2, active: true }).status, 'ignored')
      clean(f)
    } finally { await f.session.stop() }
  })
  test(`${mode}: terminate inside a nested application callback unwinds dialog and parent modal before final teardown`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, String.raw`
var owner=new Window();owner.visible=true;var hidden=new Window();
System.onDeactivate=function(){mark("callback-before");System.inform("nested");mark("callback-after");};
System.onActivate=function(){mark("quit-before");System.terminate();mark("quit-after");};
function run(){hidden.showModal();mark("parent-after");}
`)
    const opening = f.exec('run()'), result = Promise.allSettled([opening]), receipts: Promise<unknown>[] = []
    try {
      await until(() => f.session.inspectOwnership().modalScopes === 1)
      const first = f.session.acceptApplicationActivation({ sequence: 1, active: false })
      receipts.push(Promise.allSettled([first.completion]))
      await until(() => f.session.inspectOwnership().modalScopes === 2)
      const second = f.session.acceptApplicationActivation({ sequence: 2, active: true })
      receipts.push(Promise.allSettled([second.completion]))
      await opening; await f.session.stop(); await Promise.all(receipts)
      assert.deepEqual(f.trace(), ['callback-before', 'quit-before', 'quit-after', 'callback-after', 'parent-after'])
      clean(f)
    } finally { await f.session.stop(); await result; await Promise.all(receipts) }
  })
  test(`${mode}: a failed termination save remains exportable and is retried only by explicit Stop`, { timeout: 60000 }, async () => {
    for (const method of ['terminate', 'exit']) {
      class Store extends MemorySaveStore {
        armed = false
        attempts = 0
        closed = 0
        override async commit(files: SaveFile[]) {
          if (this.armed && files.some((file) => file.path === 'savedata/termination.txt')) {
            this.attempts++
            throw new Error('termination persistent failure')
          }
          await super.commit(files)
        }
        override close() { this.closed++ }
      }
      const store = new Store(), f = await fixture(binary, `function run(){["durable"].save("savedata/termination.txt","utf-8");System.${method}();mark("after-call");}`, { saveStore: store })
      try {
        store.armed = true
        const work = await Promise.allSettled([f.exec('run()')])
        await until(() => f.session.snapshot().state === 'failed')
        assert.equal(store.attempts, 1, 'A failed persistent transaction must not be retried by automatic teardown')
        assert.equal(store.closed, 0)
        const saved = f.session.exportSaves().find((file) => file.path === 'savedata/termination.txt')
        assert(saved)
        assert.equal((await readText(saved.bytes, '', 'utf-8')).trim(), 'durable')
        assert.deepEqual(f.trace(), method === 'terminate' ? ['after-call'] : [])
        if (method === 'terminate') assert.equal(work[0]!.status, 'rejected')
        store.armed = false
        await f.session.stop(); clean(f)
        assert.equal(store.closed, 1)
      } finally { store.armed = false; await f.session.stop() }
    }
  })
}
