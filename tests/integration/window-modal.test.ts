import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import { readScript } from '../../src/backends/files/text-codecs.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)

class Clock {
  time = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { run, at: this.time + delay }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(ms: number) {
    this.time += ms
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}

type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
interface Pending<T> {
  result: Promise<Outcome<T>>
  settled(): boolean
}

async function bounded<T>(promise: Promise<T>, description: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${description}`)), 10000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

async function succeeded<T>(pending: Pending<T>, description = 'modal operation'): Promise<T> {
  const result = await bounded(pending.result, description)
  if (!result.ok) throw result.error
  return result.value
}

const definitions = String.raw`
var trace=[];
function mark(text){trace.add(text);Debug.message(text);}
class ModalWindow extends Window {
  var label,queries=0,queryMode="allow",keyHandler=null;
  function ModalWindow(label,shown=false){
    super.Window();this.label=label;caption=label;setInnerSize(64,48);visible=shown;
  }
  function onKeyDown(key,shift){
    mark(label+":key:"+key);
    if(keyHandler!==null)keyHandler(key);
  }
  function onCloseQuery(canClose){
    queries++;mark(label+":query:"+queries);
    if(queryMode=="allow")super.onCloseQuery(true);
    else if(queryMode=="deny")super.onCloseQuery(false);
    // A handler's return value is not the inherited native answer.
    return true;
  }
  function respond(canClose){super.onCloseQuery(canClose);}
}
var parent=new ModalWindow("parent",true),other=new ModalWindow("other",true);
var modal=new ModalWindow("modal"),child=new ModalWindow("child"),next=new ModalWindow("next");
function run(){
  var local=["kept",37];
  mark("run:before");
  var result=modal.showModal();
  mark("run:after:"+int(result===void)+":"+local[0]+":"+local[1]);
  return "complete";
}
`

async function fixture(
  binary: boolean,
  body: string,
  duringStartup = false,
  options: { defaultExitPolicy?: boolean; paintGate?: boolean } = {},
) {
  const clock = new Clock(),
    pending: Promise<unknown>[] = []
  let paintEntered = false,
    releasePaint!: (source: string) => void
  const paintGate = new Promise<string>((resolve) => {
    releasePaint = resolve
  })
  const track = <T>(promise: Promise<T>): Pending<T> => {
    let settled = false
    const result = promise.then<Outcome<T>, Outcome<T>>(
      (value) => {
        settled = true
        return { ok: true, value }
      },
      (error: unknown) => {
        settled = true
        return { ok: false, error }
      },
    )
    // Every rejection is observed immediately, including operations whose
    // callbacks open a child modal and therefore cannot finish until later.
    pending.push(result)
    return { result, settled: () => settled }
  }
  const harness = await headless(
    {
      'startup.tjs':
        (binary
          ? 'Scripts.compileStorage("window-modal.tjs","savedata/window-modal.cjs",false,true,false);Scripts.execStorage("savedata/window-modal.cjs");'
          : 'Scripts.execStorage("window-modal.tjs");') +
        (duringStartup ? 'parent.bringToFront();run();Debug.message("startup:after-modal");' : ''),
      'window-modal.tjs':
        (options.defaultExitPolicy ? '' : 'System.exitOnWindowClose=false;\n') +
        definitions +
        '\n' +
        body,
      'modal-query-paint-gate.tjs': 'window-modal-query-paint-gate',
    },
    {
      now: clock.now,
      schedule: clock.schedule,
      decodeScript(bytes, mode, encoding) {
        if (
          options.paintGate &&
          new TextDecoder().decode(bytes) === 'window-modal-query-paint-gate'
        ) {
          paintEntered = true
          return paintGate
        }
        return readScript(bytes, mode, encoding)
      },
    },
  )
  const { session, logs } = harness
  const view = (label: string) => {
    const window = session.snapshot().windows?.find((window) => window.view.caption === label)
    assert.ok(window, `Missing Window ${label}`)
    return window
  }
  const until = async (
    predicate: () => boolean,
    description: string,
    opening?: Pending<unknown>,
  ) => {
    const deadline = performance.now() + 10000
    while (!predicate()) {
      if (opening?.settled()) {
        const result = await opening.result
        assert.fail(
          `Modal ended before ${description}: ${JSON.stringify(result)}; ${logs.join('|')}`,
        )
      }
      assert.ok(
        performance.now() < deadline,
        `Timed out waiting for ${description}: ${JSON.stringify(session.inspectOwnership())}; ${logs.join('|')}`,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  const waitModal = async (depth: number, opening: Pending<unknown>) => {
    await until(
      () =>
        session.inspectOwnership().modalScopes === depth &&
        session.inspectOwnership().modalWaits === 1,
      `${depth} waiting modal scope(s)`,
      opening,
    )
    assert.equal(opening.settled(), false)
  }
  const stop = async () => {
    releasePaint('0;')
    await bounded(session.stop(), 'stop modal Session')
    await bounded(Promise.all(pending), 'settle cancelled modal operations')
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().handles, 0)
    assert.ok(
      Object.values(session.inspectOwnership()).every((count) => count === 0),
      JSON.stringify(session.inspectOwnership()),
    )
    assert.equal(clock.tasks.size, 0)
  }
  try {
    const starting = track(session.start())
    if (duringStartup) await waitModal(1, starting)
    else {
      await succeeded(starting, 'start modal fixture')
      await bounded(session.idle(), 'settle fixture startup')
      await succeeded(track(session.activateWindow(view('parent').id)), 'activate previous Window')
      await bounded(session.idle(), 'settle fixture activation')
    }
    return {
      ...harness,
      clock,
      track,
      view,
      until,
      waitModal,
      stop,
      starting,
      paintGate: { entered: () => paintEntered, release: releasePaint },
      open: () => track(session.evaluate('run()')),
      key(label: string, key: number) {
        const admission = session.acceptInput({
          type: 'keyDown',
          windowId: view(label).id,
          key,
          shift: 0,
        })
        return { status: admission.status, ...track(admission.completion) }
      },
      close(label: string) {
        const admission = session.acceptCloseWindow(view(label).id)
        return { status: admission.status, ...track(admission.completion) }
      },
      async finished(opening: Pending<string>) {
        assert.equal(await succeeded(opening), 'complete')
        await bounded(session.idle(), 'settle completed modal frame')
        assert.equal(session.inspectOwnership().modalScopes, 0)
        assert.equal(session.inspectOwnership().modalWaits, 0)
        assert.equal(
          session.inspectOwnership().eventReceipts,
          0,
          JSON.stringify({
            snapshot: session.snapshot(),
            logs,
            receipts: [
              ...(
                session as unknown as { eventReceipts: Map<number, unknown> }
              ).eventReceipts.values(),
            ],
          }),
        )
        assert.equal(session.inspectOwnership().eventCheckpoints, 0)
        assert.equal(
          logs.filter((text) => text.startsWith('run:after:')).at(-1),
          'run:after:1:kept:37',
        )
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: startup can remain inside Window.showModal while host input completes its child pump`, async () => {
    const f = await fixture(
      binary,
      'modal.keyHandler=function(key){if(key==13)modal.respond(true);};',
      true,
    )
    try {
      assert.equal(f.starting.settled(), false)
      assert.ok(f.logs.includes('run:before'))
      assert.ok(!f.logs.includes('startup:after-modal'))
      assert.equal(f.view('modal').view.visible, true)
      await succeeded(f.key('modal', 13))
      await succeeded(f.starting, 'resume startup after its modal returns')
      await bounded(f.session.idle(), 'settle resumed startup')
      assert.equal(f.session.snapshot().state, 'running')
      assert.equal(f.view('modal').view.visible, false)
      assert.equal(f.session.snapshot().activeWindow, f.view('parent').id)
      assert.ok(f.logs.includes('run:after:1:kept:37'))
      assert.ok(f.logs.indexOf('run:after:1:kept:37') < f.logs.indexOf('startup:after-modal'))
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.session.inspectOwnership().modalWaits, 0)
      assert.equal(f.session.inspectOwnership().eventReceipts, 0)
      assert.equal(f.session.inspectOwnership().eventCheckpoints, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Window.showModal preserves its caller, blocks other host input and returns void to an eligible previous Window`, async () => {
    const f = await fixture(
      binary,
      'modal.keyHandler=function(key){if(key==13)modal.respond(true);};',
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      assert.equal(f.view('modal').view.visible, true)
      assert.equal(f.session.snapshot().activeWindow, f.view('modal').id)
      assert.equal(f.view('parent').view.blocked, true)
      assert.equal(f.view('other').view.blocked, true)
      assert.equal(f.view('modal').view.blocked, false)
      await succeeded(f.key('parent', 65), 'ignore parent input')
      await succeeded(f.key('other', 66), 'ignore other Window input')
      await succeeded(f.close('parent'), 'ignore blocked parent user close')
      await succeeded(
        f.track(f.session.activateWindow(f.view('other').id)),
        'ignore blocked activation',
      )
      assert.equal(f.session.snapshot().activeWindow, f.view('modal').id)
      assert.ok(!f.logs.some((text) => /^(parent|other):(key|query):/.test(text)))
      assert.ok(!f.logs.some((text) => text.startsWith('run:after:')))
      await succeeded(f.key('modal', 13), 'close modal through real TJS input')
      await f.finished(opening)
      assert.equal(f.view('modal').view.visible, false)
      assert.equal(f.session.snapshot().activeWindow, f.view('parent').id)
      assert.ok(f.session.snapshot().windows?.every((window) => !window.view.blocked))
      assert.equal(await f.session.evaluate('(isvalid modal)+","+modal.visible'), '1,0')
      // Normal completion keeps the same Window reusable, with a fresh scope.
      const again = f.open()
      await f.waitModal(1, again)
      const close = f.session.acceptCloseWindow(f.view('modal').id)
      assert.equal(close.status, 'accepted')
      // Observe in the close Promise's first reaction, before waiting for the
      // outer caller or idle. A body-only receipt must not report success while
      // its accepted modal Window still blocks other Windows.
      const atCompletion = f.track(
        close.completion.then(() => ({
          visible: f.view('modal').view.visible,
          blocked: f.session.snapshot().windows?.some((window) => window.view.blocked),
          scopes: f.session.inspectOwnership().modalScopes,
          waits: f.session.inspectOwnership().modalWaits,
        })),
      )
      assert.deepEqual(await succeeded(atCompletion, 'accepted close after scope release'), {
        visible: false,
        blocked: false,
        scopes: 0,
        waits: 0,
      })
      await f.finished(again)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: accepting the actual main Window shown modally honors default exit policy and stops the whole Session`, async () => {
    const f = await fixture(
      binary,
      String.raw`
parent.finalize=function(){mark("main:finalized");};
function runMain(){
  parent.visible=false;mark("main:before-modal");
  parent.showModal();mark("main:after-modal");return "main-complete";
}
`,
      false,
      { defaultExitPolicy: true },
    )
    try {
      const mainId = f.view('parent').id
      assert.equal(
        await f.session.evaluate('int(System.exitOnWindowClose)+","+(Window.mainWindow===parent)'),
        '1,1',
      )
      const opening = f.track(f.session.evaluate('runMain()'))
      await f.waitModal(1, opening)
      assert.equal(f.session.snapshot().mainWindow, mainId)
      assert.equal(f.session.snapshot().activeWindow, mainId)
      assert.equal(f.view('parent').view.visible, true)
      assert.equal(f.view('other').view.blocked, true)
      const close = f.session.acceptCloseWindow(mainId)
      assert.equal(close.status, 'accepted')
      await succeeded(f.track(close.completion), 'accepted modal main close')
      // Observe automatic termination before calling the fixture's stop helper;
      // cleanup in finally must not turn a missing exit request into a pass.
      await f.until(() => f.session.snapshot().state === 'stopped', 'automatic modal main exit')
      await bounded(opening.result, 'settle main showModal after Session termination')
      assert.ok(f.logs.includes('parent:query:1'))
      assert.ok(f.logs.includes('main:finalized'))
      assert.equal(f.session.snapshot().mainWindow, 0)
      assert.deepEqual(f.session.snapshot().windows, [])
      assert.equal(f.session.snapshot().handles, 0)
      assert.ok(
        Object.values(f.session.inspectOwnership()).every((count) => count === 0),
        JSON.stringify(f.session.inspectOwnership()),
      )
      assert.equal(f.clock.tasks.size, 0)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: Timer and AsyncTrigger callbacks progress inside showModal without unwinding its waiting caller`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var trigger=new AsyncTrigger(function(){mark("trigger:inside");},"");
var timer=new Timer(function(){timer.enabled=false;mark("timer:inside");trigger.trigger();},"");timer.interval=10;
modal.keyHandler=function(key){if(key==13)modal.respond(true);};
run=function(){
  var local=["kept",37];mark("run:before");timer.enabled=true;
  var result=modal.showModal();
  mark("run:after:"+int(result===void)+":"+local[0]+":"+local[1]);return "complete";
};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      f.clock.advance(10)
      await f.until(
        () => f.logs.includes('trigger:inside'),
        'Timer then AsyncTrigger callback',
        opening,
      )
      assert.ok(f.logs.indexOf('timer:inside') < f.logs.indexOf('trigger:inside'))
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.some((text) => text.startsWith('run:after:')))
      await succeeded(f.key('modal', 13))
      await f.finished(opening)
      assert.ok(f.logs.indexOf('trigger:inside') < f.logs.indexOf('modal:key:13'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: hiding a modal does not finish it and a page hidden with pauseWhenHidden=false keeps its Timer pump alive`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("hidden:timer");modal.respond(true);},"");timer.interval=10;
modal.keyHandler=function(key){if(key==72){modal.visible=false;timer.enabled=true;mark("hidden:window");}};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      await succeeded(f.key('modal', 72))
      await f.waitModal(1, opening)
      assert.equal(f.view('modal').view.visible, false)
      assert.equal(f.view('parent').view.blocked, true)
      assert.ok(f.logs.includes('hidden:window'))
      assert.ok(!f.logs.includes('hidden:timer'))
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      assert.equal(f.session.snapshot().state, 'running')
      f.clock.advance(10)
      await f.until(() => f.logs.includes('hidden:timer'), 'hidden-page modal Timer', opening)
      await f.finished(opening)
      f.session.setActivity({ sequence: 2, state: 'visible', pauseWhenHidden: false })
      assert.equal(await f.session.evaluate('(isvalid modal)+","+modal.visible'), '1,0')
    } finally {
      await f.stop()
    }
  })

  // These close-query ordering cases exercise the selected 052 contract. The
  // delayed VCL query timing is a documented inference, not an original-runtime
  // execution result (see window-modal-close-contract.md in verification evidence).
  test(`${mode}: script modal close returns before its deferred query, coalesces requests and preserves a vetoed Window`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.queryMode="deny";
modal.keyHandler=function(key){
  if(key==65){modal.close();modal.close();mark("close:first-return:"+modal.queries);}
  if(key==66){modal.queryMode="allow";modal.close();mark("close:second-return:"+modal.queries);}
};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      await succeeded(f.key('modal', 65))
      await f.until(() => f.logs.includes('modal:query:1'), 'first close query', opening)
      await f.waitModal(1, opening)
      assert.ok(f.logs.includes('close:first-return:0'))
      assert.ok(f.logs.indexOf('close:first-return:0') < f.logs.indexOf('modal:query:1'))
      assert.equal(f.view('modal').view.visible, true)
      assert.equal(f.logs.filter((text) => text.startsWith('modal:query:')).length, 1)
      // A denied host close completes its own query without waiting forever
      // for the still-open modal scope.
      await succeeded(f.close('modal'), 'host close veto completes while modal stays open')
      await f.waitModal(1, opening)
      assert.equal(f.view('modal').view.visible, true)
      assert.ok(f.logs.includes('modal:query:2'))
      await succeeded(f.key('modal', 66))
      await f.finished(opening)
      assert.ok(f.logs.includes('close:second-return:2'))
      assert.ok(f.logs.indexOf('close:second-return:2') < f.logs.indexOf('modal:query:3'))
      assert.equal(
        await f.session.evaluate('(isvalid modal)+","+modal.visible+","+modal.queries'),
        '1,0,3',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a modal query returning true still waits for an inherited answer and supports a later veto and new close`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.queryMode="defer";
modal.keyHandler=function(key){
  if(key==65 || key==67)modal.close();
  if(key==66){modal.respond(false);mark("answer:denied");}
  if(key==68){modal.respond(true);mark("answer:accepted");}
};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      await succeeded(f.close('modal'), 'host query without an inherited answer completes')
      await f.until(() => f.logs.includes('modal:query:1'), 'deferred query', opening)
      await f.waitModal(1, opening)
      assert.equal(f.view('modal').view.visible, true)
      await succeeded(f.key('modal', 66))
      await f.waitModal(1, opening)
      assert.ok(f.logs.includes('answer:denied'))
      await succeeded(f.key('modal', 67))
      await f.until(() => f.logs.includes('modal:query:2'), 'new query after veto', opening)
      await f.waitModal(1, opening)
      await succeeded(f.key('modal', 68))
      await f.finished(opening)
      assert.equal(await f.session.evaluate('(isvalid modal)+","+modal.queries'), '1,2')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: accepting a non-main parent from its child cannot end that child or prevent a later child in the same callback`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.keyHandler=function(key){
  if(key==65){
    mark("parent:before-child");child.showModal();mark("parent:after-child");
    next.showModal();mark("parent:after-next");
  }
};
child.keyHandler=function(key){
  if(key==66){modal.respond(true);mark("parent:accepted-in-child");}
  if(key==67){child.respond(true);mark("child:accepted");}
};
next.keyHandler=function(key){if(key==68){next.respond(true);mark("next:accepted");}};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      const callback = f.key('modal', 65)
      await f.waitModal(2, opening)
      await succeeded(f.key('child', 66))
      await f.waitModal(2, opening)
      assert.ok(f.logs.includes('parent:accepted-in-child'))
      assert.equal(callback.settled(), false)
      assert.ok(!f.logs.includes('parent:after-child'))
      assert.equal(f.view('child').view.visible, true)
      assert.equal(f.view('modal').view.blocked, true)
      await succeeded(f.key('child', 67))
      await f.until(() => f.logs.includes('parent:after-child'), 'first child return', opening)
      await f.waitModal(2, opening)
      assert.equal(callback.settled(), false)
      assert.equal(f.view('child').view.visible, false)
      assert.equal(f.view('next').view.visible, true)
      assert.equal(f.session.snapshot().activeWindow, f.view('next').id)
      await succeeded(f.key('next', 68))
      await succeeded(callback, 'parent callback after both children')
      await f.finished(opening)
      assert.ok(f.logs.indexOf('child:accepted') < f.logs.indexOf('parent:after-child'))
      assert.ok(f.logs.indexOf('next:accepted') < f.logs.indexOf('parent:after-next'))
      assert.ok(f.logs.indexOf('parent:after-next') < f.logs.indexOf('run:after:1:kept:37'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: an accepted close-query callback can still enter and finish a child before its modal returns`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.keyHandler=function(key){if(key==65){modal.close();mark("close:returned");}};
modal.onCloseQuery=function(canClose){
  modal.queries++;modal.respond(true);mark("query:accepted");
  child.showModal();mark("query:after-child");
};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      const request = f.key('modal', 65)
      await f.until(() => f.logs.includes('query:accepted'), 'accepted query callback', opening)
      await f.waitModal(2, opening)
      assert.equal(f.view('child').view.visible, true)
      assert.ok(!f.logs.includes('query:after-child'))
      await succeeded(f.close('child'), 'close nested Window through host query')
      await succeeded(request)
      await f.finished(opening)
      assert.ok(f.logs.indexOf('close:returned') < f.logs.indexOf('query:accepted'))
      assert.ok(f.logs.indexOf('query:accepted') < f.logs.indexOf('child:query:1'))
      assert.ok(f.logs.indexOf('child:query:1') < f.logs.indexOf('query:after-child'))
      assert.equal(
        await f.session.evaluate(
          '(isvalid modal)+","+(isvalid child)+","+modal.visible+","+child.visible',
        ),
        '1,1,0,0',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: requesting parent close inside a child delays the parent query until its own loop resumes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.keyHandler=function(key){if(key==65){child.showModal();mark("parent:after-child:"+modal.queries);}};
child.keyHandler=function(key){
  if(key==66){modal.close();mark("parent:requested:"+modal.queries);}
  if(key==67)child.respond(true);
};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      const callback = f.key('modal', 65)
      await f.waitModal(2, opening)
      await succeeded(f.key('child', 66))
      await f.waitModal(2, opening)
      assert.ok(f.logs.includes('parent:requested:0'))
      assert.ok(!f.logs.includes('modal:query:1'))
      assert.equal(callback.settled(), false)
      await succeeded(f.key('child', 67))
      await succeeded(callback)
      await f.finished(opening)
      assert.ok(f.logs.includes('parent:after-child:0'))
      assert.ok(f.logs.indexOf('parent:after-child:0') < f.logs.indexOf('modal:query:1'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: an internal close query cancelled before entry by a child modal is retried after that child returns`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var queryPaintArmed=false;
var modalRoot=new Layer(modal,null);modalRoot.setSize(64,48);modalRoot.fillRect(0,0,64,48,0xff202020);
modalRoot.onPaint=function(){
  if(global.queryPaintArmed){
    global.queryPaintArmed=false;mark("query-paint:begin");
    Scripts.execStorage("modal-query-paint-gate.tjs");mark("query-paint:end");
  }
};
modal.keyHandler=function(key){
  if(key==65){modal.close();queryPaintArmed=true;modalRoot.update();mark("request-return:"+modal.queries);}
  if(key==66){mark("child-before:"+modal.queries);child.showModal();mark("child-after:"+modal.queries);}
};
`,
      false,
      { paintGate: true },
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      const request = f.key('modal', 65)
      await f.until(f.paintGate.entered, 'close-request round onPaint storage gate', opening)
      assert.equal(request.settled(), false)
      assert.ok(f.logs.includes('request-return:0'))
      assert.ok(!f.logs.includes('modal:query:1'))
      // This event precedes the query that the next beforeWait will append.
      // Its child.showModal clears the not-yet-entered parent query.
      const childCall = f.key('modal', 66)
      assert.equal(childCall.status, 'accepted')
      assert.equal(childCall.settled(), false)
      f.paintGate.release('0;')
      await f.waitModal(2, opening)
      assert.ok(f.logs.includes('child-before:0'))
      assert.ok(!f.logs.includes('modal:query:1'))
      assert.equal(childCall.settled(), false)
      await succeeded(f.close('child'), 'finish child that removed the queued parent query')
      await succeeded(childCall)
      await succeeded(request)
      // No new parent close/respond request follows the child: the original
      // request must be restored by cancellation of its unentered query.
      await f.finished(opening)
      assert.ok(f.logs.indexOf('query-paint:begin') < f.logs.indexOf('query-paint:end'))
      assert.ok(f.logs.indexOf('query-paint:end') < f.logs.indexOf('child-before:0'))
      assert.ok(f.logs.includes('child-after:0'))
      assert.ok(f.logs.indexOf('child-after:0') < f.logs.indexOf('modal:query:1'))
      assert.ok(f.logs.indexOf('modal:query:1') < f.logs.indexOf('run:after:1:kept:37'))
      assert.deepEqual(
        f.logs.filter((text) => text.startsWith('modal:query:')),
        ['modal:query:1'],
      )
      assert.equal(
        await f.session.evaluate(
          '(isvalid modal)+","+(isvalid child)+","+modal.visible+","+child.visible',
        ),
        '1,1,0,0',
      )
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: visible, fullscreen and duplicate modal failures preserve the active scope and a fresh child attempt succeeds`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var rejected=[];
modal.keyHandler=function(key){
  if(key==65){
    try{other.showModal();}catch(error){rejected.add("visible");}
    child.fullScreen=true;
    try{child.showModal();}catch(error){rejected.add("fullscreen");}
    child.fullScreen=false;
    try{modal.showModal();}catch(error){rejected.add("duplicate");}
    mark("rejected:"+rejected.join(","));
    child.showModal();mark("retry:child-returned");
  }
  if(key==66)modal.respond(true);
};
`,
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      const callback = f.key('modal', 65)
      await f.until(
        () => f.logs.includes('rejected:visible,fullscreen,duplicate'),
        'three rejected attempts',
        opening,
      )
      await f.waitModal(2, opening)
      assert.equal(f.view('modal').view.visible, true)
      assert.equal(f.view('child').view.visible, true)
      assert.equal(f.view('other').view.visible, true)
      assert.equal(f.view('child').view.fullScreen, false)
      await succeeded(f.close('child'))
      await succeeded(callback)
      await f.waitModal(1, opening)
      assert.ok(f.logs.includes('retry:child-returned'))
      assert.equal(f.session.snapshot().activeWindow, f.view('modal').id)
      await succeeded(f.key('modal', 66))
      await f.finished(opening)
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: explicit modal invalidation releases its waiting frame and leaves other Windows usable`, async () => {
    const f = await fixture(
      binary,
      String.raw`
modal.keyHandler=function(key){if(key==65){invalidate modal;mark("modal:invalidated");}};
`,
    )
    try {
      const modalId = f.view('modal').id,
        opening = f.open()
      await f.waitModal(1, opening)
      await succeeded(f.key('modal', 65))
      await f.finished(opening)
      assert.ok(f.logs.includes('modal:invalidated'))
      assert.ok(!f.session.snapshot().windows?.some((window) => window.id === modalId))
      assert.equal(await f.session.evaluate('(isvalid modal)+","+(isvalid parent)'), '0,1')
      await succeeded(f.key('parent', 66))
      assert.ok(f.logs.includes('parent:key:66'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: stopping nested Window modals settles callers and receipts and releases every ownership counter`, async () => {
    const f = await fixture(
      binary,
      'modal.keyHandler=function(key){if(key==65)child.showModal();};',
    )
    try {
      const opening = f.open()
      await f.waitModal(1, opening)
      const callback = f.key('modal', 65)
      await f.waitModal(2, opening)
      assert.equal(callback.settled(), false)
      assert.equal(f.view('parent').view.blocked, true)
      assert.equal(f.view('modal').view.blocked, true)
      assert.equal(f.view('child').view.blocked, false)
      await f.stop()
      assert.equal((await bounded(opening.result, 'cancel outer modal')).ok, false)
      assert.equal(callback.settled(), true)
      assert.equal((await bounded(callback.result, 'cancel parent input receipt')).ok, false)
      assert.ok(!f.logs.some((text) => text.startsWith('run:after:')))
      assert.deepEqual(f.session.snapshot().windows, [])
    } finally {
      await f.stop()
    }
  })

  for (const property of ['visible', 'focusable'] as const) {
    test(`${mode}: modal return does not reactivate a previous Window whose ${property} became false`, async () => {
      const f = await fixture(
        binary,
        `modal.keyHandler=function(key){if(key==65){parent.${property}=false;modal.respond(true);}};`,
      )
      try {
        const parentId = f.view('parent').id,
          opening = f.open()
        await f.waitModal(1, opening)
        await succeeded(f.key('modal', 65))
        await f.finished(opening)
        assert.equal(f.view('parent').view[property], false)
        assert.notEqual(f.session.snapshot().activeWindow, parentId)
        assert.equal(f.view('modal').view.visible, false)
        await succeeded(f.track(f.session.activateWindow(f.view('other').id)))
        await succeeded(f.key('other', 66))
        assert.ok(f.logs.includes('other:key:66'))
      } finally {
        await f.stop()
      }
    })
  }
}
