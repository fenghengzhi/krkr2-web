import test from 'node:test'
import assert from 'node:assert/strict'
import { InputControllers } from '../../src/engine/input/controllers.ts'
import { InputService } from '../../src/engine/input/service.ts'
import { LayerTree } from '../../src/engine/scene/layers.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import {
  scriptRecord,
  type HostContext,
  type HostReply,
  type ScriptObject,
  type ScriptRecord,
  type ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import type { SessionDependencies } from '../../src/engine/session.ts'

// Fixed KRKR2 dec49af9 / 2.32stable:
// LayerManager.cpp 356–379 saves ReleaseCaptureCalled after the callback,
// releases a different capture, and only then acquires the down target.
// Its ReleaseCapture (551–563) clears the slot BEFORE Owner->Release().
// This fixture observes the existing InputService ownership seam, with an
// explicit Dictionary-release callback in place of a VM finalizer. It drives
// public packets and reentrant callbacks, never private capture helpers.
function ownershipFixture() {
  const layers = new LayerTree(), window = new WindowState(), second = new WindowState()
  window.visible = second.visible = true
  window.resize(200, 100)
  second.resize(200, 100)
  const root = layers.create(0, 101), replacementRoot = layers.create(0, 202)
  for (const id of [root, replacementRoot]) {
    layers.set(id, 'width', 200)
    layers.set(id, 'height', 100)
  }
  const a = layers.create(root), b = layers.create(root)
  for (const [id, x] of [[a, 0], [b, 100]] as const) {
    layers.set(id, 'width', 40)
    layers.set(id, 'height', 40)
    layers.set(id, 'left', x)
    layers.set(id, 'visible', 1)
    layers.set(id, 'hitThreshold', 0)
  }
  const controllers = new InputControllers(layers, () => 101),
    controller = controllers.create(101, window),
    replacement = controllers.create(202, second),
    weak = (id: number): ScriptWeakObject => ({ type: 'weak-object', id, runtime: 1 }),
    object = (id: number): ScriptObject => ({ type: 'object', id, runtime: 1 }),
    retained: ScriptObject[] = [], released: ScriptObject[] = [],
    context: HostContext = {
      retain(value) { retained.push(value); return value },
      release(value) { released.push(value) },
      snapshot: () => scriptRecord({}),
    },
    service = new InputService(
      controllers, context,
      (id) => layers.has(id) ? weak(1000 + id) : undefined,
      (id) => id ? weak(id) : undefined,
    ),
    owners = new Map<string, ScriptWeakObject>(),
    callbacks: {
      event?: (step: ScriptRecord['entries']) => void
      release?: (layer: number) => void
    } = {}
  service.host('Input.bind', [object(1), object(2)], context)
  const drain = (reply: HostReply) => {
    if (reply.kind !== 'invoke') return
    for (let count = 0; count < 256; count++) {
      const result = service.host('Input.resume', [reply.args[0]], context)
      assert.equal(result.kind, 'value')
      if (result.kind !== 'value') throw new Error('Input step did not return a record')
      const step = (result.value as ScriptRecord).entries
      if (step.done === 1n) return
      if (step.ownership === 1n) {
        const key = String(step.key), old = owners.get(key),
          next = step.sourceKey === undefined
            ? step.target as ScriptWeakObject | null
            : owners.get(String(step.sourceKey))
        if (step.sourceKey !== undefined) assert(next, 'Ownership source must still be held')
        if (next) owners.set(key, next)
        else owners.delete(key)
        if (old && old !== next) callbacks.release?.(old.id - 1000)
      } else callbacks.event?.(step)
    }
    throw new Error('Input ownership fixture exceeded its event budget')
  }
  const down = (x: number, windowId = 101) => drain(service.packet({
    type: 'down', windowId, x, y: 5, shift: 8, button: 0, clicks: 0,
  }))
  return {
    a, b, root, replacementRoot, controller, replacement, controllers,
    service, owners, callbacks, down, drain,
    establishLastMove() {
      drain(service.packet({ type: 'move', windowId: 101, x: 180, y: 80, shift: 0, button: 0, clicks: 0 }))
    },
    close() {
      callbacks.release = undefined
      callbacks.event = undefined
      controllers.clear()
      drain(service.host('Input.synchronize', [], context))
      assert.equal(owners.size, 0)
      service.dispose()
      assert.deepEqual(released.map((value) => value.id).sort(), retained.map((value) => value.id).sort(),
        'Only the existing pump and ownership Dictionary are host-retained')
      layers.clear()
    },
  }
}

for (const retireWindow of [false, true]) {
  test(`reentrant down releases the old capture with an empty slot${retireWindow ? ' and cannot reacquire after Window retirement' : ' before acquiring its own target'}`, () => {
    const f = ownershipFixture(), observations: number[] = []
    try {
      f.establishLastMove()
      let enterNested = true
      f.callbacks.event = (step) => {
        if (step.method !== 'onMouseDown' ||
          (step.target as ScriptWeakObject).id !== 1000 + f.a || !enterNested) return
        enterNested = false
        // Reentrant B down takes capture. A second B down leaves the native
        // ReleaseCaptureCalled flag false because it already owns that slot.
        // Outer A down must release B before acquiring A, not retain B merely
        // because the callback changed the capture owner.
        f.down(105)
        f.down(105)
        assert.equal(f.controller.capture, f.b)
      }
      f.callbacks.release = (layer) => {
        if (layer !== f.b) return
        observations.push(f.controller.capture)
        assert.equal(f.controller.capture, 0)
        // A finalizer's public cursor notification also observes no capture:
        // the last actual move hit root, so its setter must reach the Window.
        f.drain(f.service.start(f.controller.setCursor(f.root, -21), f.controller))
        assert.equal(f.controller.view().cursor, -21)
        if (retireWindow) {
          f.controllers.remove(101)
          f.down(5, 202)
        }
      }
      f.down(5)
      assert.deepEqual(observations, [0])
      if (retireWindow) {
        assert.equal(f.controllers.get(101), undefined)
        assert.equal(f.controller.capture, 0)
        assert.equal(f.replacement.capture, f.replacementRoot)
        assert.equal(f.owners.has(`${f.root}:capture`), false)
        assert.equal(f.owners.get(`${f.replacementRoot}:capture`)?.id, 1000 + f.replacementRoot)
      } else {
        assert.equal(f.controller.capture, f.a)
        assert.equal(f.owners.get(`${f.root}:capture`)?.id, 1000 + f.a)
      }
    } finally { f.close() }
  })
}

const source = String.raw`
System.exitOnWindowClose=false;
var trace=[];
var win=new Window();win.setInnerSize(160,80);win.visible=true;
var root=new Layer(win,null);root.setSize(160,80);root.fillRect(0,0,160,80,0xff203040);
root.onMouseDown=function(){trace.add("root-down");};
root.onMouseUp=function(){trace.add("root-up");};
root.onMouseEnter=function(){trace.add("root-enter");};
root.onMouseMove=function(){trace.add("root-move");};
var upper=new Layer(win,root);upper.setSize(30,30);upper.fillRect(0,0,30,30,0xffffffff);upper.visible=true;
upper.onMouseDown=function(){trace.add("upper-down");};
upper.onMouseUp=function(){trace.add("invalid-up");};
upper.onMouseMove=function(){trace.add("invalid-move");};
function retireUpper(){invalidate upper;delete global.upper;trace.clear();}
function unrelatedChange(){root.enabled=root.enabled;}
function clearTrace(){trace.clear();}
function events(){return trace.join("|");}
function retireWindow(){invalidate win;delete global.win;delete global.root;}
`

// LayerIntf.cpp 455–508 clears Manager before Part on explicit invalidation;
// it does not clear Owner. A non-primary manager capture therefore survives,
// while FireMouse* suppresses callbacks because Shutdown is true. These tests
// use the real native VM and source/bytecode invalidation, not a detached mock.
for (const binary of [false, true]) {
  for (const retireWindow of [false, true]) {
    test(`${binary ? 'bytecode' : 'source'}: invalidated capture suppresses underlay input and ${retireWindow ? 'retires both owned roles with its Window' : 'releases through the successful up path'}`, { timeout: 60000 }, async () => {
      const f = await headless({ 'startup.tjs': '', 'capture-lifetime.tjs': source }), primary: unknown[] = []
      try {
        await f.session.start()
        if (binary) {
          await f.session.evaluate('Scripts.compileStorage("capture-lifetime.tjs","savedata/capture-lifetime.cjs",false,true,false)')
          await f.session.evaluate('Scripts.execStorage("savedata/capture-lifetime.cjs")')
        } else await f.session.evaluate('Scripts.execStorage("capture-lifetime.tjs")')
        const windowId = Number(await f.session.evaluate('win.__windowId')),
          mouse = async (type: 'down' | 'move' | 'up', shift = type === 'down' ? 8 : 0) => {
            await f.session.input({ type, windowId, x: 5, y: 5, shift, button: 0, clicks: 0 })
            await f.session.idle()
          }
        await mouse('down')
        assert.equal(await f.session.evaluate('events()'), 'upper-down')
        await f.session.evaluate('retireUpper()')
        assert.equal(f.session.inspectOwnership().layerSources, 1, 'The invalidated tree registration has actually ended')
        await mouse('move', 8)
        await f.session.evaluate('unrelatedChange()')
        await mouse('down')
        assert.equal(await f.session.evaluate('events()'), '', 'Shutdown capture cannot redirect into the live root')
        if (retireWindow) {
          await f.session.evaluate('retireWindow()')
          await f.session.input({ type: 'move', windowId, x: 5, y: 5, shift: 0, button: 0, clicks: 0 })
          assert.equal(await f.session.evaluate('events()'), '')
          assert.equal(f.session.inspectOwnership().layerSources, 0)
          assert.equal(f.session.inspectOwnership().windowSources, 0)
        } else {
          await mouse('up')
          assert.equal(await f.session.evaluate('events()'), 'root-enter', 'Up rechecks the same primary point only after releasing the shutdown capture')
          await f.session.evaluate('clearTrace()')
          await mouse('down')
          assert.equal(await f.session.evaluate('events()'), 'root-down')
          await mouse('up')
          assert.equal(await f.session.evaluate('events()'), 'root-down|root-up')
        }
      } catch (error) { primary.push(error); throw error }
      finally {
        try {
          await f.session.stop()
          assert.equal(f.session.snapshot().handles, 0)
          assert.equal(f.session.snapshot().bitmapBytes, 0)
          assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
        } catch (cleanup) {
          if (primary.length) throw new AggregateError([...primary, cleanup], 'Capture scenario and cleanup failed')
          throw cleanup
        }
      }
    })
  }
}

const identitySource = String.raw`
System.exitOnWindowClose=false;
var trace=[],caught=[];
System.exceptionHandler=function(error){caught.add(error.message);return true;};
var win=new Window();win.setInnerSize(160,80);win.visible=true;
var root=new Layer(win,null);root.setSize(160,80);root.fillRect(0,0,160,80,0xff203040);
root.onMouseDown=function(){trace.add("root-down");};
root.onMouseUp=function(){trace.add("root-up");};
root.onMouseEnter=function(){trace.add("root-enter");};
root.onMouseMove=function(){trace.add("root-move");};
class IdentityDownLayer extends Layer {
  function IdentityDownLayer(){
    super.Layer(global.win,global.root);setSize(30,30);
    fillRect(0,0,30,30,0xffffffff);visible=true;
  }
  function finalize(){global.trace.add("upper-final");}
  function onMouseDown(){
    global.trace.add("upper-down");
    if(global.identityMode=="drop"){
      delete global.upper;
      global.trace.add("upper-return");
      return;
    }
    invalidate this;
    global.trace.add("upper-invalid");
    if(global.identityMode=="release")global.root.releaseCapture();
    if(global.identityMode=="throw")throw new global.Exception("identity-down-fault");
    if(global.identityMode=="retire-window"){
      invalidate global.win;delete global.win;delete global.root;
    }
    if(global.identityMode=="stop")global.Scripts.evalStorage("hold-identity.tjs");
    global.trace.add("upper-return");
  }
  function onMouseMove(){global.trace.add("invalid-move");}
  function onMouseUp(){global.trace.add("invalid-up");}
}
var upper=new IdentityDownLayer();
function events(){return trace.join("|");}
function errors(){return caught.join("|");}
function reset(){trace.clear();}
function dropInvalidOwner(){delete global.upper;}
`

async function identityFixture(binary: boolean, mode: string, overrides: Partial<SessionDependencies> = {}) {
  const f = await headless({
    'startup.tjs': '',
    'capture-identity.tjs': `var identityMode=${JSON.stringify(mode)};\n${identitySource}`,
    'hold-identity.tjs': 'hold-capture-identity',
  }, overrides)
  try {
    await f.session.start()
    if (binary) {
      await f.session.evaluate('Scripts.compileStorage("capture-identity.tjs","savedata/capture-identity.cjs",false,true,false)')
      await f.session.evaluate('Scripts.execStorage("savedata/capture-identity.cjs")')
    } else await f.session.evaluate('Scripts.execStorage("capture-identity.tjs")')
    const windowId = Number(await f.session.evaluate('win.__windowId'))
    await f.session.idle()
    assert.equal(f.session.inspectOwnership().objectIdentities, 0)
    return {
      ...f, windowId,
      async mouse(type: 'down' | 'move' | 'up', shift = type === 'down' ? 8 : 0) {
        await f.session.input({ type, windowId, x: 5, y: 5, shift, button: 0, clicks: 0 })
        await f.session.idle()
        assert.equal(f.session.inspectOwnership().objectIdentities, 0,
          'Input operation identities end even when a VM capture slot survives')
      },
    }
  } catch (error) {
    try { await f.session.stop() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Identity fixture startup and cleanup failed') }
    throw error
  }
}

async function finishIdentityFixture(f: Awaited<ReturnType<typeof identityFixture>>, failures: unknown[]) {
  try {
    await f.session.stop()
    assert.equal(f.session.snapshot().handles, 0)
    assert.equal(f.session.snapshot().bitmapBytes, 0)
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  } catch (cleanup) {
    if (failures.length) throw new AggregateError([...failures, cleanup], 'Identity scenario and cleanup failed')
    throw cleanup
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: first down self-invalidation acquires an externally alive Owner without retaining an identity token`, { timeout: 60000 }, async () => {
    const f = await identityFixture(binary, 'capture'), failures: unknown[] = []
    try {
      await f.mouse('down')
      assert.equal(await f.session.evaluate('events()'), 'upper-down|upper-final|upper-invalid|upper-return')
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.session.evaluate('dropInvalidOwner()')
      await f.session.evaluate('reset()')
      await f.mouse('down')
      await f.mouse('move', 8)
      assert.equal(await f.session.evaluate('events()'), '', 'The new capture owns the invalid object after its external reference is gone')
      await f.mouse('up')
      assert.equal(await f.session.evaluate('events()'), 'root-enter')
      await f.session.evaluate('reset()')
      await f.mouse('down')
      assert.equal(await f.session.evaluate('events()'), 'root-down')
    } catch (error) { failures.push(error); throw error }
    finally { await finishIdentityFixture(f, failures) }
  })

  test(`${mode}: dropping the last callback reference finalizes before a new capture can be acquired`, { timeout: 60000 }, async () => {
    const f = await identityFixture(binary, 'drop'), failures: unknown[] = []
    try {
      await f.mouse('down')
      assert.equal(await f.session.evaluate('events()'), 'upper-down|upper-return|upper-final',
        'Weak observation must not extend the callback temporary into capture acquisition')
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      await f.session.evaluate('reset()')
      await f.mouse('move')
      assert.equal(await f.session.evaluate('events()'), 'root-enter|root-move',
        'A null VM acquisition cannot leave a nonzero numeric capture')
    } catch (error) { failures.push(error); throw error }
    finally { await finishIdentityFixture(f, failures) }
  })

  for (const action of ['release', 'throw'] as const) {
    test(`${mode}: self-invalidating down ${action === 'release' ? 'respects releaseCapture' : 'does not acquire after a callback exception'}`, { timeout: 60000 }, async () => {
      const f = await identityFixture(binary, action), failures: unknown[] = []
      try {
        await f.mouse('down')
        assert.equal(await f.session.evaluate('events()'), action === 'release'
          ? 'upper-down|upper-final|upper-invalid|upper-return'
          : 'upper-down|upper-final|upper-invalid')
        assert.equal(await f.session.evaluate('errors()'), action === 'throw' ? 'identity-down-fault' : '')
        assert.equal(f.session.inspectOwnership().layerSources, 1)
        await f.session.evaluate('reset()')
        await f.mouse('move')
        assert.equal(await f.session.evaluate('events()'), 'root-enter|root-move')
      } catch (error) { failures.push(error); throw error }
      finally { await finishIdentityFixture(f, failures) }
    })
  }

  test(`${mode}: Window retirement during self-invalidating down revokes the operation identity`, { timeout: 60000 }, async () => {
    const f = await identityFixture(binary, 'retire-window'), failures: unknown[] = []
    try {
      await f.mouse('down')
      assert.equal(await f.session.evaluate('events()'), 'upper-down|upper-final|upper-invalid|upper-return')
      assert.equal(f.session.inspectOwnership().windowSources, 0)
      assert.equal(f.session.inspectOwnership().layerSources, 0)
      await f.session.evaluate('reset()')
      await f.mouse('move')
      assert.equal(await f.session.evaluate('events()'), '')
    } catch (error) { failures.push(error); throw error }
    finally { await finishIdentityFixture(f, failures) }
  })

  test(`${mode}: Stop during a suspended invalidating down releases its operation identity`, { timeout: 60000 }, async () => {
    let entered!: () => void, release!: (source: string) => void
    const ready = new Promise<void>((resolve) => { entered = resolve }),
      held = new Promise<string>((resolve) => { release = resolve }),
      f = await identityFixture(binary, 'stop', {
        async decodeScript(bytes, streamMode, encoding) {
          const source = await readScript(bytes, streamMode, encoding)
          if (source === 'hold-capture-identity') { entered(); return held }
          return source
        },
      }), failures: unknown[] = []
    let outcome: Promise<unknown> | undefined
    try {
      outcome = f.mouse('down').then(() => undefined, (error: unknown) => error)
      await Promise.race([
        ready,
        outcome.then((error) => {
          throw new Error('Invalidating down ended before reaching the suspended storage read', { cause: error })
        }),
      ])
      assert.equal(f.session.inspectOwnership().objectIdentities, 1,
        'Only the currently suspended down operation observes the invalid object identity')
      assert.equal(f.session.inspectOwnership().layerSources, 1)
      const stopping = f.session.stop()
      release('0')
      await stopping
      const error = await outcome
      assert(error instanceof Error && error.name === 'AbortError')
      assert.equal(f.session.snapshot().state, 'stopped')
      assert.equal(f.session.inspectOwnership().objectIdentities, 0)
    } catch (error) { failures.push(error); throw error }
    finally {
      release('0')
      await outcome
      await finishIdentityFixture(f, failures)
    }
  })
}
