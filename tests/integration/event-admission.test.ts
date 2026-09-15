import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

function gate() {
  let enter!: () => void, release!: (source: string) => void
  const entered = new Promise<void>((resolve) => {
      enter = resolve
    }),
    result = new Promise<string>((resolve) => {
      release = resolve
    })
  return { entered, result, enter, release: (source = '0;') => release(source) }
}

const source = String.raw`
System.exitOnWindowClose=false;
var trace=[],closeCalls=0,windowDeaths=0,menuCalls=0,menuDeaths=0,tailEnabled=false,tailPending=false;
class AdmissionWindow extends Window {
  var name,holdDeactivation=false,dropOnClose=false;
  function AdmissionWindow(name){super.Window();this.name=name;caption=name;}
  function onKeyDown(key,shift){
    trace.add("input:"+key+":begin");
    if(key==65)Scripts.execStorage("input-gate.tjs");
    if(key==66 && tailEnabled){tailPending=true;root.update();}
    trace.add("input:"+key+":end");
  }
  function onActivate(){trace.add(name+":activate");}
  function onDeactivate(){
    trace.add(name+":deactivate:begin");
    if(holdDeactivation){holdDeactivation=false;Scripts.execStorage("activate-gate.tjs");}
    trace.add(name+":deactivate:end");
  }
  function onCloseQuery(canClose){
    closeCalls++;Debug.message("close-begin");
    if(dropOnClose)delete global.b;
    Scripts.execStorage("close-gate.tjs");
    Debug.message("close-end:"+caption);super.onCloseQuery(false);
  }
  function finalize(){if(name=="B"){windowDeaths++;Debug.message("window-finalized");}}
}
class AdmissionMenu extends MenuItem {
  function AdmissionMenu(){super.MenuItem(null,"admission-menu");}
  function onClick(){
    menuCalls++;a.menu.remove(this);delete global.item;Debug.message("menu-begin");
    Scripts.execStorage("menu-gate.tjs");Debug.message("menu-end:"+caption);
  }
  function finalize(){menuDeaths++;Debug.message("menu-finalized");}
}
var a=new AdmissionWindow("A"),b=new AdmissionWindow("B"),c=new AdmissionWindow("C");
a.visible=b.visible=c.visible=true;
var root=new Layer(a,null);root.setSize(2,2);
root.onPaint=function(){
  if(tailPending){
    tailPending=false;Debug.message("execution-tail-begin");
    Scripts.execStorage("tail-gate.tjs");Debug.message("execution-tail-end");
  }
};
var item=new AdmissionMenu();a.menu.add(item);
Debug.getLastLog();try{throw new Exception("admission-warmup");}catch(error){}
`

async function fixture(binary: boolean) {
  const gates = {
    input: gate(),
    activate: gate(),
    close: gate(),
    menu: gate(),
    block: gate(),
    tail: gate(),
  }
  let rendererCloses = 0
  const harness = await headless(
    {
      'startup.tjs': '',
      'event-admission.tjs': source,
      ...Object.fromEntries(
        Object.keys(gates).map((name) => [`${name}-gate.tjs`, `admission:${name}`]),
      ),
    },
    {
      decodeScript(bytes, mode, encoding) {
        const marker = new TextDecoder().decode(bytes)
        for (const [name, held] of Object.entries(gates))
          if (marker === `admission:${name}`) {
            held.enter()
            return held.result
          }
        return readScript(bytes, mode, encoding)
      },
      renderer: {
        present() {},
        dispose() {
          rendererCloses++
        },
      },
    },
  )
  const { session } = harness
  const execute = (code: string) => session.evaluate(`Scripts.exec(${JSON.stringify(code)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("event-admission.tjs","savedata/event-admission.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/event-admission.cjs")')
    } else await session.evaluate('Scripts.execStorage("event-admission.tjs")')
    await session.idle()
    const a = Number(await session.evaluate('a.__windowId')),
      b = Number(await session.evaluate('b.__windowId')),
      c = Number(await session.evaluate('c.__windowId')),
      item = Number(await session.evaluate('item.__menuId'))
    await session.activateWindow(a)
    await execute('trace.clear();')
    return {
      ...harness,
      gates,
      execute,
      a,
      b,
      c,
      item,
      async stop() {
        const stopping = session.stop()
        for (const held of Object.values(gates)) held.release()
        await stopping
      },
      assertStopped() {
        assert.equal(session.snapshot().state, 'stopped')
        assert.equal(session.snapshot().handles, 0)
        assert.ok(Object.values(session.inspectOwnership()).every((value) => value === 0))
        assert.equal(rendererCloses, 1)
      },
    }
  } catch (error) {
    for (const held of Object.values(gates)) held.release()
    await session.stop()
    throw error
  }
}

function watch(promise: Promise<void>) {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  void promise.then(
    () => {
      state = 'fulfilled'
    },
    () => {
      state = 'rejected'
    },
  )
  return () => state
}

const hostTurn = () => new Promise<void>((resolve) => setImmediate(resolve))

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: input admission is synchronous while callbacks remain FIFO and completion includes the current execution tail`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('tailEnabled=true;')
      const first = f.session.acceptInput({ type: 'keyDown', key: 65, shift: 0, windowId: f.a }),
        firstState = watch(first.completion)
      assert.equal(first.status, 'accepted')
      assert.equal('then' in first, false, 'Admission must not wait for its callback')
      await f.gates.input.entered
      const second = f.session.acceptInput({ type: 'keyDown', key: 66, shift: 0, windowId: f.a }),
        secondState = watch(second.completion),
        legacy = f.session.input({ type: 'keyDown', key: 67, shift: 0, windowId: f.a }),
        legacyState = watch(legacy)
      assert.equal(second.status, 'accepted')
      await hostTurn()
      assert.equal(firstState(), 'pending')
      assert.equal(secondState(), 'pending')
      assert.equal(legacyState(), 'pending')
      f.gates.input.release()
      await f.gates.tail.entered
      assert.equal(firstState(), 'pending')
      assert.equal(secondState(), 'pending')
      assert.equal(legacyState(), 'pending')
      assert.equal(f.logs.includes('execution-tail-end'), false)
      f.gates.tail.release()
      await Promise.all([first.completion, second.completion, legacy])
      assert.equal(firstState(), 'fulfilled')
      assert.equal(secondState(), 'fulfilled')
      assert.equal(legacyState(), 'fulfilled')
      assert.equal(f.logs.includes('execution-tail-end'), true)
      assert.equal(
        await f.session.evaluate('trace.join("|")'),
        'input:65:begin|input:65:end|input:66:begin|input:66:end|input:67:begin|input:67:end',
      )
    } finally {
      await f.stop()
      f.assertStopped()
    }
  })

  test(`${mode}: activation admission accepts a newer Window before an earlier deactivation body returns`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('a.holdDeactivation=true;')
      const first = f.session.acceptActivateWindow(f.b),
        firstState = watch(first.completion)
      assert.equal(first.status, 'accepted')
      await f.gates.activate.entered
      const second = f.session.acceptActivateWindow(f.c),
        secondState = watch(second.completion)
      assert.equal(second.status, 'accepted')
      assert.equal(f.session.snapshot().activeWindow, f.c)
      await hostTurn()
      assert.equal(firstState(), 'pending')
      assert.equal(secondState(), 'pending')
      f.gates.activate.release()
      await Promise.all([first.completion, second.completion])
      assert.equal(f.session.snapshot().activeWindow, f.c)
      assert.equal(
        await f.session.evaluate('trace.join("|")'),
        'A:deactivate:begin|A:deactivate:end|B:activate|B:deactivate:begin|B:deactivate:end|C:activate',
      )
    } finally {
      await f.stop()
      f.assertStopped()
    }
  })

  test(`${mode}: ignored admissions complete without a VM entry and invalid input throws synchronously without ownership changes`, async () => {
    const f = await fixture(binary)
    try {
      const baseline = f.session.inspectOwnership(),
        handles = f.session.snapshot().handles
      const ignored = [
        f.session.acceptInput({ type: 'keyDown', key: 65, shift: 0, windowId: 999999 }),
        f.session.acceptActivateWindow(999999),
        f.session.acceptCloseWindow(999999),
        f.session.acceptMenuClick(999999),
        f.session.acceptMenuClick(f.item, { windowId: f.b, requestId: 1 }),
      ]
      for (const admission of ignored) assert.equal(admission.status, 'ignored')
      await Promise.all(ignored.map((admission) => admission.completion))
      assert.deepEqual(f.session.inspectOwnership(), baseline)
      assert.equal(f.session.snapshot().handles, handles)
      for (const key of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])
        assert.throws(
          () => f.session.acceptInput({ type: 'keyDown', key, shift: 0, windowId: f.a }),
          /Invalid input/,
        )
      await assert.rejects(
        f.session.input({ type: 'keyDown', key: NaN, shift: 0, windowId: f.a }),
        /Invalid input/,
      )
      assert.deepEqual(f.session.inspectOwnership(), baseline)
      assert.equal(f.session.snapshot().handles, handles)
      f.session.pause()
      const pausedOwnership = f.session.inspectOwnership(),
        pausedHandles = f.session.snapshot().handles
      const paused = [
        f.session.acceptInput({ type: 'keyDown', key: 66, shift: 0, windowId: f.a }),
        f.session.acceptActivateWindow(f.b),
        f.session.acceptMenuClick(f.item),
      ]
      for (const admission of paused) assert.equal(admission.status, 'ignored')
      await Promise.all(paused.map((admission) => admission.completion))
      assert.equal(f.session.snapshot().state, 'paused')
      assert.equal(f.session.snapshot().activeWindow, f.a)
      assert.deepEqual(f.session.inspectOwnership(), pausedOwnership)
      assert.equal(f.session.snapshot().handles, pausedHandles)
      f.session.resume()
      assert.equal(await f.session.evaluate('trace.join("|")'), '')
    } finally {
      await f.stop()
      f.assertStopped()
    }
  })

  for (const target of ['close', 'menu'] as const) {
    test(`${mode}: ${target} admission preserves the receiver during host suspension and releases it before completion`, async () => {
      const f = await fixture(binary)
      try {
        if (target === 'close') await f.execute('b.dropOnClose=true;')
        const before = f.session.inspectOwnership(),
          admission =
            target === 'close'
              ? f.session.acceptCloseWindow(f.b)
              : f.session.acceptMenuClick(f.item),
          state = watch(admission.completion)
        assert.equal(admission.status, 'accepted')
        await f.gates[target].entered
        assert.equal(state(), 'pending')
        assert.equal(f.session.inspectOwnership().windowSources, before.windowSources)
        assert.equal(f.session.inspectOwnership().menuSources, before.menuSources)
        assert.equal(
          f.logs.includes(target === 'close' ? 'window-finalized' : 'menu-finalized'),
          false,
        )
        f.gates[target].release()
        await admission.completion
        // Check native ownership before another evaluate could collect a lease
        // that completion incorrectly left behind.
        assert.equal(f.session.inspectOwnership().pendingHandles, 0)
        assert.equal(
          f.session.inspectOwnership()[target === 'close' ? 'windowSources' : 'menuSources'],
          before[target === 'close' ? 'windowSources' : 'menuSources'] - 1,
        )
        const end = target === 'close' ? 'close-end:B' : 'menu-end:admission-menu',
          finalized = target === 'close' ? 'window-finalized' : 'menu-finalized'
        assert.ok(f.logs.indexOf(end) >= 0)
        assert.ok(f.logs.indexOf(finalized) > f.logs.indexOf(end))
        assert.equal(
          await f.session.evaluate(
            target === 'close' ? 'closeCalls+","+windowDeaths' : 'menuCalls+","+menuDeaths',
          ),
          '1,1',
        )
      } finally {
        await f.stop()
        f.assertStopped()
      }
    })

    test(`${mode}: queued ${target} admission does not retain a target whose last script reference is removed`, async () => {
      const f = await fixture(binary)
      try {
        const before = f.session.inspectOwnership(),
          reading = f.session.evaluate('Scripts.execStorage("block-gate.tjs")')
        await f.gates.block.entered
        const admission =
            target === 'close'
              ? f.session.acceptCloseWindow(f.b)
              : f.session.acceptMenuClick(f.item),
          state = watch(admission.completion)
        assert.equal(admission.status, 'accepted')
        assert.equal(state(), 'pending')
        // Explicit invalidation would also invalidate a mistakenly retained
        // target. Destruction here depends solely on releasing script owners.
        f.gates.block.release(
          target === 'close' ? 'delete global.b;' : 'a.menu.remove(item);delete global.item;',
        )
        await Promise.all([reading, admission.completion])
        assert.equal(
          f.session.inspectOwnership()[target === 'close' ? 'windowSources' : 'menuSources'],
          before[target === 'close' ? 'windowSources' : 'menuSources'] - 1,
        )
        assert.equal(f.session.inspectOwnership().pendingHandles, 0)
        assert.equal(f.logs.includes(target === 'close' ? 'close-begin' : 'menu-begin'), false)
        assert.equal(
          await f.session.evaluate(
            target === 'close' ? 'closeCalls+","+windowDeaths' : 'menuCalls+","+menuDeaths',
          ),
          '0,1',
        )
      } finally {
        await f.stop()
        f.assertStopped()
      }
    })

    test(`${mode}: Stop settles an executing ${target} admission and a later queued input without retaining callback resources`, async () => {
      const f = await fixture(binary)
      try {
        if (target === 'close') await f.execute('b.dropOnClose=true;')
        const first =
          target === 'close' ? f.session.acceptCloseWindow(f.b) : f.session.acceptMenuClick(f.item)
        assert.equal(first.status, 'accepted')
        await f.gates[target].entered
        const second = f.session.acceptInput({ type: 'keyDown', key: 66, shift: 0, windowId: f.a })
        assert.equal(second.status, 'accepted')
        const firstRejected = assert.rejects(first.completion, /Execution cancelled/),
          secondRejected = assert.rejects(second.completion, /Execution cancelled/)
        // This fixture's decoder deliberately owns an external I/O gate. Stop
        // cancels admissions first, then that I/O is allowed to settle.
        const stopping = f.session.stop()
        f.gates[target].release()
        await Promise.all([stopping, firstRejected, secondRejected])
        f.assertStopped()
        assert.equal(
          f.logs.includes(target === 'close' ? 'close-end:B' : 'menu-end:admission-menu'),
          false,
        )
      } finally {
        await f.stop()
        f.assertStopped()
      }
    })
  }
}
