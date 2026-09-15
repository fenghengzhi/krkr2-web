import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'
import { LifetimeVideoBackend, videoGate } from '../helpers/video-lifetime-backend.ts'
import type { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import type { HostHandler } from '../../src/engine/script/runtime.ts'

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

function watch<T>(promise: Promise<T>) {
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

async function within<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const definitions = String.raw`
System.exitOnWindowClose=false;
var updates=0,holdPaint=false,throwHandler=false,simpleClose=false;
class CheckpointWindow extends Window {
  var name;
  function CheckpointWindow(name){super.Window();this.name=name;caption=name;}
  function onKeyDown(key,shift){
    Debug.message("input:"+name+":"+key+":begin");
    if(key==65)Scripts.execStorage("input-gate.tjs");
    if(key==70){delete global.b;Scripts.execStorage("input-gate.tjs");}
    if(key==71)delete global.movie;
    if(key==81 || key==82){updates++;root.update();}
    if(key==69){root.update();throw new Exception("checkpoint-body-failure");}
    Debug.message("input:"+name+":"+key+":end");
  }
  function onCloseQuery(canClose){
    if(simpleClose){super.onCloseQuery(true);return;}
    Debug.message("close:begin");delete global.b;
    Scripts.execStorage("close-gate.tjs");
    Debug.message("close:end:"+caption);super.onCloseQuery(false);
  }
  function finalize(){Debug.message("window:finalized:"+name);}
}
class CheckpointMenu extends MenuItem {
  function CheckpointMenu(){super.MenuItem(null,"checkpoint-menu");}
  function onClick(){
    a.menu.remove(this);delete global.item;Debug.message("menu:begin");
    Scripts.execStorage("menu-gate.tjs");Debug.message("menu:end:"+caption);
  }
  function finalize(){Debug.message("menu:finalized");}
}
function installExceptionHandler(){
  System.exceptionHandler=function(error){
    Debug.message("handler:begin:"+error.message);
    Scripts.execStorage("handler-gate.tjs");Debug.message("handler:end");
    if(throwHandler)throw new Exception("checkpoint-handler-failure");
    return true;
  };
}
function runHiddenCheckpointModal(){
  Scripts.execStorage("block-gate.tjs");delete global.b;root.update();
  Debug.message("modal:before");__host("CheckpointTest.modal",a.__windowId);
  Debug.message("modal:after");
}
function closeMainWithoutModal(){
  a.close();System.eventDisabled=false;Debug.message("after");
}
var a=new CheckpointWindow("A"),b=new CheckpointWindow("B");
a.visible=b.visible=true;a.setInnerSize(2,2);
var root=new Layer(a,null);root.setSize(2,2);root.fillRect(0,0,2,2,0xff000000);
root.onPaint=function(){
  Debug.message("paint:begin:"+updates);
  if(holdPaint)Scripts.execStorage("paint-gate.tjs");
  root.fillRect(0,0,2,2,0xff000000+updates);Debug.message("paint:end:"+updates);
};
var item=new CheckpointMenu();a.menu.add(item);
Debug.getLastLog();try{throw new Exception("checkpoint-warmup");}catch(error){}
`

async function fixture(binary: boolean) {
  const gates = {
      input: gate(),
      close: gate(),
      menu: gate(),
      paint: gate(),
      handler: gate(),
      block: gate(),
      after: gate(),
    },
    video = new LifetimeVideoBackend()
  let rendererCloses = 0,
    pixel: number[] = []
  const harness = await headless(
    {
      'startup.tjs': '',
      'session-checkpoints.tjs': definitions,
      'movie.mp4': new Uint8Array([1, 2, 3]),
      ...Object.fromEntries(
        Object.keys(gates).map((name) => [`${name}-gate.tjs`, `checkpoint:${name}`]),
      ),
    },
    {
      now: () => 0,
      video,
      decodeScript(bytes, mode, encoding) {
        const marker = new TextDecoder().decode(bytes)
        for (const [name, held] of Object.entries(gates))
          if (marker === `checkpoint:${name}`) {
            held.enter()
            return held.result
          }
        return readScript(bytes, mode, encoding)
      },
      renderer: {
        present(layers) {
          if (layers[0]) pixel = Array.from(layers[0].pixels.data.subarray(0, 4))
        },
        dispose() {
          rendererCloses++
        },
      },
    },
  )
  const { session } = harness,
    execute = (source: string) => session.evaluate(`Scripts.exec(${JSON.stringify(source)})`)
  try {
    await session.start()
    if (binary) {
      await session.evaluate(
        'Scripts.compileStorage("session-checkpoints.tjs","savedata/session-checkpoints.cjs",false,true,false)',
      )
      await session.evaluate('Scripts.execStorage("savedata/session-checkpoints.cjs")')
    } else await session.evaluate('Scripts.execStorage("session-checkpoints.tjs")')
    await session.idle()
    const a = Number(await session.evaluate('a.__windowId')),
      b = Number(await session.evaluate('b.__windowId')),
      item = Number(await session.evaluate('item.__menuId'))
    await session.activateWindow(a)
    await session.idle()
    harness.logs.length = 0
    return {
      ...harness,
      gates,
      video,
      execute,
      a,
      b,
      item,
      pixel: () => pixel,
      async stop() {
        const stopping = session.stop()
        for (const held of Object.values(gates)) held.release()
        await stopping
        assert.equal(session.snapshot().state, 'stopped')
        assert.equal(session.snapshot().handles, 0)
        assert.ok(Object.values(session.inspectOwnership()).every((value) => value === 0))
        assert.equal(video.movies.size, 0)
        assert.equal(rendererCloses, 1)
      },
    }
  } catch (error) {
    for (const held of Object.values(gates)) held.release()
    await session.stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: two inputs share one round paint and both completions wait for that paint`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('holdPaint=true;')
      const first = f.session.acceptInput({ type: 'keyDown', key: 81, shift: 0, windowId: f.a }),
        second = f.session.acceptInput({ type: 'keyDown', key: 82, shift: 0, windowId: f.a }),
        firstState = watch(first.completion),
        secondState = watch(second.completion)
      assert.equal(first.status, 'accepted')
      assert.equal(second.status, 'accepted')
      await within(f.gates.paint.entered, 'the shared round paint')
      assert.equal(firstState(), 'pending')
      assert.equal(secondState(), 'pending')
      assert.deepEqual(f.logs, [
        'input:A:81:begin',
        'input:A:81:end',
        'input:A:82:begin',
        'input:A:82:end',
        'paint:begin:2',
      ])
      f.gates.paint.release()
      await within(Promise.all([first.completion, second.completion]), 'both painted inputs')
      assert.deepEqual(f.pixel(), [0, 0, 2, 255])
      await f.session.idle()
      assert.deepEqual(
        f.logs.filter((line) => line.startsWith('paint:')),
        ['paint:begin:2', 'paint:end:2'],
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: an input completion does not wait for a later unrelated top-level script`, async () => {
    const f = await fixture(binary)
    try {
      const admission = f.session.acceptInput({
          type: 'keyDown',
          key: 83,
          shift: 0,
          windowId: f.a,
        }),
        unrelated = f.session.evaluate('Scripts.execStorage("after-gate.tjs")'),
        unrelatedState = watch(unrelated)
      watch(admission.completion)
      assert.equal(admission.status, 'accepted')
      await within(f.gates.after.entered, 'the later top-level script')
      await within(admission.completion, 'the earlier input completion while later work is held')
      assert.equal(unrelatedState(), 'pending')
      assert.deepEqual(f.logs, ['input:A:83:begin', 'input:A:83:end'])
      f.gates.after.release()
      await unrelated
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a hidden unpaused modal completes an outside cancelled receipt with a skipped paint tail`, async () => {
    const f = await fixture(binary),
      internal = f.session as unknown as { host: HostHandler; modalLoop: ModalLoop },
      originalHost = internal.host,
      forward = originalHost.bind(f.session),
      entered = gate(),
      parked = gate()
    let token = 0,
      dispatches = 0,
      evaluating: Promise<string> | undefined
    // Isolate the checkpoint contract from Window.showModal's visibility and
    // close-query policy. This host operation enters the real Session ModalLoop
    // through its native continuation, without creating a second VM entry.
    internal.host = (operation, args, context) => {
      if (operation === 'CheckpointTest.modal') {
        const windowId = Number(args[0])
        token = internal.modalLoop.open({ kind: 'window', ownerId: windowId, windowId })
        const continuation = internal.modalLoop.invoke(token)
        entered.enter()
        return continuation
      }
      if (operation === 'Modal.dispatch') dispatches++
      const reply = forward(operation, args, context)
      // ModalScopes.wait installs its pending wake before its first await.
      // Observe that real parked state; receipt commit can finish before TJS
      // returns through the event pump and reaches the next Modal.wait.
      if (
        operation === 'Modal.wait' &&
        Number(args[0]) === token &&
        internal.modalLoop.pendingWaits === 1 &&
        !f.session.hasModalWork()
      )
        parked.enter()
      return reply
    }
    try {
      evaluating = f.session.evaluate('runHiddenCheckpointModal()')
      const modalState = watch(evaluating)
      await within(f.gates.block.entered, 'the script before modal entry')
      const admission = f.session.acceptCloseWindow(f.b)
      watch(admission.completion)
      assert.equal(admission.status, 'accepted')
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      assert.equal(f.session.snapshot().state, 'running')
      f.gates.block.release()
      await within(entered.entered, 'the real modal continuation')
      await within(admission.completion, 'the outside receipt and its hidden skipped tail')
      await within(parked.entered, 'the modal wait after the completed hidden receipt')
      // No subsequent evaluate/idle can repair this receipt: its parent TJS
      // operation is still inside Modal.wait with the Window scope open.
      assert.equal(modalState(), 'pending')
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(f.session.inspectOwnership().modalWaits, 1)
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      assert.equal(f.session.inspectOwnership().pendingHandles, 0)
      assert.equal(f.session.hasModalWork(), false)
      assert.ok(dispatches > 0)
      assert.ok(f.logs.includes('window:finalized:B'))
      assert.equal(f.logs.includes('close:begin'), false)
      assert.equal(f.logs.includes('modal:after'), false)
      assert.equal(
        f.logs.some((line) => line.startsWith('paint:')),
        false,
      )
      const completedDispatches = dispatches
      await new Promise<void>((resolve) => setImmediate(resolve))
      assert.equal(
        dispatches,
        completedDispatches,
        'Hidden dirty pixels must not spin the modal pump',
      )
      assert.equal(f.session.hasModalWork(), false)
      assert.equal(internal.modalLoop.finish(token), true)
      await within(evaluating, 'the finished modal parent')
      assert.ok(f.logs.includes('modal:after'))
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
    } finally {
      await f.stop()
      await evaluating?.catch(() => {})
      internal.host = originalHost
    }
  })

  test(`${mode}: closing the main Window outside a modal preserves code after a nested empty event round`, async () => {
    const f = await fixture(binary)
    try {
      await f.execute('simpleClose=true;System.exitOnWindowClose=true;')
      await f.session.evaluate('closeMainWithoutModal()')
      assert.ok(f.logs.includes('window:finalized:A'))
      assert.ok(f.logs.indexOf('after') > f.logs.indexOf('window:finalized:A'))
      assert.ok(['stopping', 'stopped'].includes(f.session.snapshot().state))
      assert.equal(
        f.logs.some((line) => line.includes('Execution cancelled')),
        false,
      )
    } finally {
      await f.stop()
    }
  })

  for (const target of ['input', 'menu', 'close'] as const) {
    test(`${mode}: ${target} completion includes last-reference cleanup before another VM entry`, async () => {
      const f = await fixture(binary)
      try {
        const before = f.session.inspectOwnership(),
          admission =
            target === 'input'
              ? f.session.acceptInput({ type: 'keyDown', key: 70, shift: 0, windowId: f.b })
              : target === 'menu'
                ? f.session.acceptMenuClick(f.item)
                : f.session.acceptCloseWindow(f.b),
          state = watch(admission.completion),
          source = target === 'menu' ? 'menuSources' : 'windowSources',
          finalized = target === 'menu' ? 'menu:finalized' : 'window:finalized:B',
          bodyEnd =
            target === 'input'
              ? 'input:B:70:end'
              : target === 'menu'
                ? 'menu:end:checkpoint-menu'
                : 'close:end:B'
        assert.equal(admission.status, 'accepted')
        await within(f.gates[target].entered, `${target} callback suspension`)
        assert.equal(state(), 'pending')
        assert.equal(f.session.inspectOwnership()[source], before[source])
        assert.equal(f.logs.includes(finalized), false)
        f.gates[target].release()
        await within(admission.completion, `${target} ownership checkpoint`)
        // No evaluate or idle here: either could hide a receipt that left its
        // receiver in the VM's deferred release list.
        assert.equal(f.session.inspectOwnership()[source], before[source] - 1)
        assert.equal(f.session.inspectOwnership().pendingHandles, 0)
        assert.equal(f.session.inspectOwnership().pendingInvalidations, 0)
        assert.ok(f.logs.indexOf(bodyEnd) >= 0)
        assert.ok(f.logs.indexOf(finalized) > f.logs.indexOf(bodyEnd))
        assert.equal(f.logs.filter((line) => line === finalized).length, 1)
      } finally {
        await f.stop()
      }
    })
  }

  test(`${mode}: several invalid inputs and menus plus cancelled closes settle before later queued work`, async () => {
    const f = await fixture(binary)
    try {
      const reading = f.session.evaluate('Scripts.execStorage("block-gate.tjs")')
      watch(reading)
      await within(f.gates.block.entered, 'the admission blocker')
      const admissions = [
        f.session.acceptInput({ type: 'keyDown', key: 83, shift: 0, windowId: f.a }),
        f.session.acceptInput({ type: 'keyDown', key: 84, shift: 0, windowId: f.a }),
        f.session.acceptInput({ type: 'keyDown', key: 85, shift: 0, windowId: f.a }),
        f.session.acceptMenuClick(f.item),
        f.session.acceptMenuClick(f.item),
        f.session.acceptCloseWindow(f.b),
        f.session.acceptCloseWindow(f.b),
      ]
      for (const admission of admissions) watch(admission.completion)
      for (const admission of admissions) assert.equal(admission.status, 'accepted')
      // Pause resets the captured input epochs; resume permits a round to
      // consume those invalid jobs. Dropping B separately cancels its source.
      f.session.pause()
      f.session.resume()
      const unrelated = f.session.evaluate('Scripts.execStorage("after-gate.tjs")'),
        unrelatedState = watch(unrelated)
      f.gates.block.release('delete global.b;')
      await within(f.gates.after.entered, 'work after the invalid admission round')
      await within(
        Promise.all(admissions.map((admission) => admission.completion)),
        'all invalid and source-cancelled completions',
      )
      assert.equal(unrelatedState(), 'pending')
      assert.equal(f.session.inspectOwnership().windowSources, 1)
      assert.equal(f.session.inspectOwnership().pendingHandles, 0)
      assert.deepEqual(f.logs, ['window:finalized:B'])
      f.gates.after.release()
      await Promise.all([reading, unrelated])
    } finally {
      await f.stop()
    }
  })

  for (const throws of [false, true]) {
    test(`${mode}: completion waits for a ${throws ? 'throwing' : 'handled'} exception handler boundary`, async () => {
      const f = await fixture(binary)
      try {
        await f.execute(`throwHandler=${throws};installExceptionHandler();`)
        const admission = f.session.acceptInput({
            type: 'keyDown',
            key: 69,
            shift: 0,
            windowId: f.a,
          }),
          state = watch(admission.completion),
          unrelated = f.session.evaluate('Scripts.execStorage("after-gate.tjs")'),
          unrelatedState = watch(unrelated)
        await within(f.gates.handler.entered, 'the exception handler')
        assert.equal(state(), 'pending')
        assert.equal(f.logs.includes('handler:end'), false)
        f.gates.handler.release()
        await within(f.gates.after.entered, 'work after exception handling')
        await within(admission.completion, 'the exception handling checkpoint')
        assert.equal(unrelatedState(), 'pending')
        assert.equal(f.session.snapshot().state, 'running')
        assert.equal(f.session.snapshot().eventDisabled, throws)
        assert.ok(f.logs.includes('handler:begin:checkpoint-body-failure'))
        assert.ok(f.logs.includes('handler:end'))
        assert.equal(f.session.inspectOwnership().pendingHandles, 0)
        const errors = f.events.filter((event) => event.type === 'log' && event.level === 'error')
        if (throws) {
          assert.ok(
            errors.some(
              (event) =>
                event.type === 'log' &&
                event.text.includes('checkpoint-body-failure') &&
                event.text.includes('checkpoint-handler-failure'),
            ),
          )
          assert.equal(
            f.logs.some((line) => line.startsWith('paint:')),
            false,
          )
        } else assert.deepEqual(errors, [])
        f.gates.after.release()
        await unrelated
      } finally {
        await f.stop()
      }
    })
  }

  test(`${mode}: a deferred native close failure rejects its input completion after cleanup settles`, async () => {
    const f = await fixture(binary),
      closing = videoGate()
    try {
      await f.execute('var movie=new VideoOverlay(a);movie.open("movie.mp4");')
      f.video.nextClose = closing
      f.video.failClose = new Error('checkpoint-close-failure')
      const admission = f.session.acceptInput({
          type: 'keyDown',
          key: 71,
          shift: 0,
          windowId: f.a,
        }),
        state = watch(admission.completion),
        rejected = assert.rejects(admission.completion, /checkpoint-close-failure/)
      watch(rejected)
      await within(closing.entered, 'deferred video closure')
      assert.equal(state(), 'pending')
      assert.equal(f.session.inspectOwnership().videoSources, 0)
      assert.equal(f.session.inspectOwnership().pendingVideoCloses, 1)
      assert.equal(f.video.movies.size, 1)
      closing.release()
      await within(rejected, 'the cleanup failure on the owning completion')
      assert.equal(f.session.inspectOwnership().pendingVideoCloses, 0)
      assert.equal(f.video.movies.size, 0)
    } finally {
      closing.release()
      await f.stop()
    }
  })

  test(`${mode}: stop settles an active callback and all queued admissions with no retained resources`, async () => {
    const f = await fixture(binary)
    try {
      const active = f.session.acceptInput({ type: 'keyDown', key: 65, shift: 0, windowId: f.a })
      watch(active.completion)
      await within(f.gates.input.entered, 'the active input')
      const admissions = [
        active,
        f.session.acceptInput({ type: 'keyDown', key: 83, shift: 0, windowId: f.a }),
        f.session.acceptMenuClick(f.item),
        f.session.acceptCloseWindow(f.b),
      ]
      for (const admission of admissions) watch(admission.completion)
      for (const admission of admissions) assert.equal(admission.status, 'accepted')
      const rejected = admissions.map((admission) =>
        assert.rejects(admission.completion, /Execution cancelled/),
      )
      for (const rejection of rejected) watch(rejection)
      const stopping = f.session.stop()
      f.gates.input.release()
      await within(Promise.all([stopping, ...rejected]), 'stop and every admission')
      assert.equal(f.logs.includes('input:A:65:end'), false)
      assert.equal(
        f.logs.some((line) => /^(menu|close):begin$/.test(line)),
        false,
      )
      await f.stop()
    } finally {
      await f.stop()
    }
  })
}
