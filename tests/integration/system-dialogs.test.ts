import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { EngineEvent } from '../../src/engine/session.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
type DialogEvent = Extract<EngineEvent, { type: 'system-dialog' }>
type DialogRequest = NonNullable<DialogEvent['request']>
type Outcome<T> = { ok: true; value: T } | { ok: false; error: unknown }
interface Pending<T> {
  result: Promise<Outcome<T>>
  settled(): boolean
}

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

async function succeeded<T>(pending: Pending<T>, description = 'System dialog'): Promise<T> {
  const result = await bounded(pending.result, description)
  if (!result.ok) throw result.error
  return result.value
}

const definitions = String.raw`
System.exitOnWindowClose=false;
var trace=[];
function mark(text){trace.add(text);Debug.message(text);}
class DialogWindow extends Window {
  var label,queries=0,keyHandler=null;
  function DialogWindow(label,shown=false){
    super.Window();this.label=label;caption=label;setInnerSize(64,48);visible=shown;
  }
  function onKeyDown(key,shift){
    mark(label+":key:"+key);
    if(keyHandler!==null)keyHandler(key);
  }
  function onCloseQuery(canClose){
    queries++;mark(label+":query:"+queries);super.onCloseQuery(true);
  }
  function respond(){super.onCloseQuery(true);}
}
function run(){return int(System.inform("Body","Information")===void);}
`

async function fixture(
  binary: boolean,
  body: string,
  options: { startup?: boolean; windows?: boolean } = {},
) {
  const clock = new Clock(),
    pending: Promise<unknown>[] = []
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
    // Observe immediately: the opening callback can outlive several nested
    // dialogs and can reject when Stop interrupts their shared native stack.
    pending.push(result)
    return { result, settled: () => settled }
  }
  const harness = await headless(
    {
      'startup.tjs':
        (binary
          ? 'Scripts.compileStorage("system-dialogs.tjs","savedata/system-dialogs.cjs",false,true,false);Scripts.execStorage("savedata/system-dialogs.cjs");'
          : 'Scripts.execStorage("system-dialogs.tjs");') +
        (options.startup ? 'run();mark("startup:after");' : ''),
      'system-dialogs.tjs':
        definitions +
        (options.windows === false
          ? ''
          : '\nvar a=new DialogWindow("dialog-A",true),b=new DialogWindow("dialog-B",true),modal=new DialogWindow("dialog-modal");\n') +
        body,
    },
    { now: clock.now, schedule: clock.schedule },
  )
  const { session, logs, events } = harness
  const dialogState = (): DialogEvent | undefined =>
    [...events].reverse().find((event): event is DialogEvent => event.type === 'system-dialog')
  const dialog = () => dialogState()?.request ?? undefined
  const view = (caption: string) => {
    const window = session.snapshot().windows?.find((entry) => entry.view.caption === caption)
    assert.ok(window, `Missing Window ${caption}`)
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
          `System dialog ended before ${description}: ${JSON.stringify(result)}; ${logs.join('|')}`,
        )
      }
      assert.ok(
        performance.now() < deadline,
        `Timed out waiting for ${description}: ${JSON.stringify(session.inspectOwnership())}; ${logs.join('|')}`,
      )
      await new Promise<void>((resolve) => setTimeout(resolve, 1))
    }
  }
  const waitDialog = async (
    caption: string,
    depth: number,
    opening: Pending<unknown>,
    previous?: number,
  ): Promise<DialogRequest> => {
    await until(
      () =>
        dialog()?.caption === caption &&
        dialog()?.id !== previous &&
        session.inspectOwnership().modalScopes === depth &&
        session.inspectOwnership().modalWaits === 1,
      `${caption} at modal depth ${depth}`,
      opening,
    )
    assert.equal(opening.settled(), false)
    return dialog()!
  }
  const settled = async <T>(opening: Pending<T>): Promise<T> => {
    const value = await succeeded(opening)
    await bounded(session.idle(), 'settle dialog event/native/frame cleanup')
    assert.equal(session.inspectOwnership().modalScopes, 0)
    assert.equal(session.inspectOwnership().modalWaits, 0)
    assert.equal(session.inspectOwnership().eventReceipts, 0)
    assert.equal(session.inspectOwnership().eventCheckpoints, 0)
    assert.equal(dialog(), undefined)
    assert.deepEqual(dialogState()?.pendingIds ?? [], [])
    return value
  }
  const stop = async () => {
    await bounded(session.stop(), 'stop System dialog Session')
    await bounded(Promise.all(pending), 'settle cancelled System dialog operations')
    assert.equal(session.snapshot().state, 'stopped')
    assert.equal(session.snapshot().handles, 0)
    assert.ok(
      Object.values(session.inspectOwnership()).every((count) => count === 0),
      JSON.stringify(session.inspectOwnership()),
    )
    assert.equal(clock.tasks.size, 0)
    assert.equal(dialog(), undefined)
    assert.deepEqual(dialogState()?.pendingIds ?? [], [])
  }
  try {
    const starting = track(session.start())
    if (options.startup) {
      await until(
        () => !!dialog() && session.inspectOwnership().modalWaits === 1,
        'startup System dialog',
        starting,
      )
    } else {
      await succeeded(starting, 'start System dialog fixture')
      await bounded(session.idle(), 'settle System dialog fixture startup')
    }
    return {
      ...harness,
      clock,
      track,
      dialogState,
      dialog,
      view,
      until,
      waitDialog,
      settled,
      stop,
      starting,
      open: (expression = 'run()') => track(session.evaluate(expression)),
      select: (request: DialogRequest, value: string | null) =>
        session.selectSystemDialog(request.id, value),
      key(caption: string, key: number) {
        const admission = session.acceptInput({
          type: 'keyDown',
          windowId: view(caption).id,
          key,
          shift: 0,
        })
        return { status: admission.status, ...track(admission.completion) }
      },
    }
  } catch (error) {
    await stop()
    throw error
  }
}

function before(logs: string[], first: string, second: string) {
  assert.ok(logs.includes(first), `Missing ${first}: ${logs.join('|')}`)
  assert.ok(logs.includes(second), `Missing ${second}: ${logs.join('|')}`)
  assert.ok(
    logs.indexOf(first) < logs.indexOf(second),
    `${first} must precede ${second}: ${logs.join('|')}`,
  )
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`${mode}: System dialogs reject missing required arguments without opening a modal`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){
  var rejected=[];
  try{System.inform();}catch(error){rejected.add("inform");}
  try{System.inputString();}catch(error){rejected.add("input0");}
  try{System.inputString("caption");}catch(error){rejected.add("input1");}
  try{System.inputString("caption","prompt");}catch(error){rejected.add("input2");}
  return rejected.join(",");
};
`,
    )
    try {
      assert.equal(await f.settled(f.open()), 'inform,input0,input1,input2')
      assert.ok(!f.events.some((event) => event.type === 'system-dialog' && event.request))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: System.inform distinguishes an omitted or void caption from an explicit empty caption and always returns void`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var results=[];
  results.add(int(System.inform(17)===void));
  results.add(int(System.inform(void,void)===void));
  results.add(int(System.inform("Message","")===void));
  results.add(int(System.inform(29,31)===void));
  return results.join(",");
};
`,
    )
    try {
      const opening = f.open()
      let previous: number | undefined
      for (const [caption, text] of [
        ['Information', '17'],
        ['Information', ''],
        ['', 'Message'],
        ['31', '29'],
      ]) {
        const request = await f.waitDialog(caption!, 1, opening, previous)
        assert.equal(request.kind, 'inform')
        assert.equal(request.text, text)
        assert.equal(request.value, '')
        assert.deepEqual(f.dialogState()?.pendingIds, [request.id])
        previous = request.id
        assert.equal(f.select(request, 'host text is not an inform return value'), true)
      }
      assert.equal(await f.settled(opening), '1,1,1,1')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: System.inputString converts every supplied argument, including explicit void, before presenting the request`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var first=System.inputString(void,void,void);
  var second=System.inputString(17,29,31);return first+"|"+second;};
`,
    )
    try {
      const opening = f.open(),
        empty = await f.waitDialog('', 1, opening)
      assert.equal(empty.kind, 'input-string')
      assert.equal(empty.text, '')
      assert.equal(empty.value, '')
      assert.equal(f.select(empty, 'first'), true)
      const numeric = await f.waitDialog('17', 1, opening, empty.id)
      assert.equal(numeric.kind, 'input-string')
      assert.equal(numeric.text, '29')
      assert.equal(numeric.value, '31')
      assert.equal(f.select(numeric, 'second'), true)
      assert.equal(await f.settled(opening), 'first|second')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: System.inputString preserves Unicode and empty confirmations, returns void on cancel and ignores stale or duplicate results`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var first=System.inputString("First","姓名を入力","初期😀");
  mark("first:"+first);var second=System.inputString("Second","Empty is valid","seed");
  var third=System.inputString("Third","Cancel","unused");
  return first+"|"+int(second===void)+":"+second.length+"|"+int(third===void);};
`,
    )
    try {
      const opening = f.open(),
        first = await f.waitDialog('First', 1, opening)
      assert.equal(first.value, '初期😀')
      assert.equal(first.text, '姓名を入力')
      assert.equal(f.select(first, '你好・名前😀'), true)
      assert.equal(f.select(first, 'duplicate'), false)
      const second = await f.waitDialog('Second', 1, opening)
      assert.notEqual(second.id, first.id)
      assert.equal(f.select(first, null), false)
      assert.equal(f.dialog()?.id, second.id)
      assert.equal(opening.settled(), false)
      assert.equal(f.select(second, ''), true)
      const third = await f.waitDialog('Third', 1, opening)
      assert.equal(f.select(second, 'stale'), false)
      assert.equal(f.dialog()?.id, third.id)
      assert.equal(f.select(third, null), true)
      assert.equal(await f.settled(opening), '你好・名前😀|0:0|1')
      assert.ok(f.logs.includes('first:你好・名前😀'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a System dialog can suspend startup without a Window while its Timer and AsyncTrigger continue on the owning TJS stack`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var trigger=new AsyncTrigger(function(){mark("trigger:inside");},"");
var timer=new Timer(function(){timer.enabled=false;mark("timer:inside");trigger.trigger();},"");timer.interval=10;
run=function(){var local=["kept",37];mark("run:before");timer.enabled=true;
  var result=System.inform("Startup body","Startup");
  mark("run:after:"+int(result===void)+":"+local[0]+":"+local[1]);};
`,
      { startup: true, windows: false },
    )
    try {
      const request = await f.waitDialog('Startup', 1, f.starting)
      assert.deepEqual(f.session.snapshot().windows, [])
      f.clock.advance(10)
      await f.until(
        () => f.logs.includes('trigger:inside'),
        'startup Timer and trigger',
        f.starting,
      )
      assert.equal(f.starting.settled(), false)
      assert.ok(!f.logs.includes('startup:after'))
      assert.equal(f.select(request, ''), true)
      await f.settled(f.starting)
      before(f.logs, 'run:before', 'timer:inside')
      before(f.logs, 'timer:inside', 'trigger:inside')
      before(f.logs, 'trigger:inside', 'run:after:1:kept:37')
      before(f.logs, 'run:after:1:kept:37', 'startup:after')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a System dialog entered from a Window callback blocks all Window input until its original callback resumes`, async () => {
    const f = await fixture(
      binary,
      String.raw`
a.keyHandler=function(key){if(key==65){mark("input:before");
  var result=System.inputString("Callback","Name","initial");mark("input:after:"+result);}};
`,
    )
    try {
      const callback = f.key('dialog-A', 65)
      assert.equal(callback.status, 'accepted')
      const request = await f.waitDialog('Callback', 1, callback)
      for (const caption of ['dialog-A', 'dialog-B']) {
        assert.equal(f.view(caption).view.blocked, true)
        const input = f.key(caption, 66)
        assert.equal(input.status, 'ignored')
        await succeeded(input)
        const close = f.session.acceptCloseWindow(f.view(caption).id)
        assert.equal(close.status, 'ignored')
        await succeeded(f.track(close.completion))
      }
      assert.ok(!f.logs.some((entry) => entry.endsWith(':key:66') || entry.includes(':query:')))
      assert.equal(callback.settled(), false)
      assert.equal(f.select(request, 'accepted'), true)
      await f.settled(callback)
      before(f.logs, 'input:before', 'input:after:accepted')
      for (const caption of ['dialog-A', 'dialog-B'])
        assert.equal(f.view(caption).view.blocked, false)
      await succeeded(f.key('dialog-B', 67))
      assert.ok(f.logs.includes('dialog-B:key:67'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a Timer can nest a System dialog and only the current child accepts a response before the parent is restored`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("child:before");
  var result=System.inputString("Child","Child prompt","child seed");mark("child:after:"+result);},"");timer.interval=10;
run=function(){timer.enabled=true;System.inform("Parent body","Parent");mark("parent:after");return "complete";};
`,
    )
    try {
      const opening = f.open(),
        parent = await f.waitDialog('Parent', 1, opening)
      f.clock.advance(10)
      const child = await f.waitDialog('Child', 2, opening)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id, child.id])
      assert.equal(f.select(parent, ''), false)
      assert.equal(f.dialog()?.id, child.id)
      assert.equal(opening.settled(), false)
      assert.equal(f.select(child, 'child value'), true)
      assert.equal(f.select(child, null), false)
      const restored = await f.waitDialog('Parent', 1, opening)
      assert.equal(restored.id, parent.id)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id])
      assert.ok(f.logs.includes('child:after:child value'))
      assert.ok(!f.logs.includes('parent:after'))
      assert.equal(f.select(child, 'stale child'), false)
      assert.equal(f.dialog()?.id, parent.id)
      assert.equal(f.select(parent, ''), true)
      assert.equal(await f.settled(opening), 'complete')
      before(f.logs, 'child:before', 'child:after:child value')
      before(f.logs, 'child:after:child value', 'parent:after')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: a Timer can enter a child Window while a System dialog retains its identity and waits for that Window to return`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;mark("window:before");
  modal.showModal();mark("window:after");},"");timer.interval=10;
modal.keyHandler=function(key){if(key==13){modal.respond();mark("window:accepted");}};
run=function(){timer.enabled=true;System.inform("Parent body","Parent");mark("dialog:after");return "complete";};
`,
    )
    try {
      const opening = f.open(),
        parent = await f.waitDialog('Parent', 1, opening)
      f.clock.advance(10)
      await f.until(
        () =>
          f.session.inspectOwnership().modalScopes === 2 &&
          f.session.inspectOwnership().modalWaits === 1 &&
          f.view('dialog-modal').view.visible,
        'child Window inside System dialog',
        opening,
      )
      assert.equal(f.dialog(), undefined)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id])
      assert.equal(f.view('dialog-A').view.blocked, true)
      assert.equal(f.view('dialog-B').view.blocked, true)
      assert.equal(f.view('dialog-modal').view.blocked, false)
      assert.equal(f.select(parent, ''), false)
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.includes('dialog:after'))
      await succeeded(f.key('dialog-modal', 13))
      const restored = await f.waitDialog('Parent', 1, opening)
      assert.equal(restored.id, parent.id)
      assert.equal(f.view('dialog-modal').view.visible, false)
      assert.ok(f.logs.includes('window:after'))
      assert.equal(f.select(parent, ''), true)
      assert.equal(await f.settled(opening), 'complete')
      before(f.logs, 'window:accepted', 'window:after')
      before(f.logs, 'window:after', 'dialog:after')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: requesting a modal parent Window close inside a System dialog waits for the dialog and its callback to return`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;modal.close();mark("parent:requested:"+modal.queries);},"");timer.interval=10;
modal.keyHandler=function(key){if(key==65){timer.enabled=true;
  System.inform("Question is pending","Inside Window");mark("callback:after:"+modal.queries);}};
run=function(){modal.showModal();mark("window:after");return "complete";};
`,
    )
    try {
      const opening = f.open()
      await f.until(
        () =>
          f.session.inspectOwnership().modalScopes === 1 &&
          f.session.inspectOwnership().modalWaits === 1 &&
          f.view('dialog-modal').view.visible,
        'parent modal Window',
        opening,
      )
      const callback = f.key('dialog-modal', 65),
        request = await f.waitDialog('Inside Window', 2, opening)
      assert.equal(callback.status, 'accepted')
      assert.equal(f.view('dialog-modal').view.blocked, true)
      f.clock.advance(10)
      await f.until(() => f.logs.includes('parent:requested:0'), 'parent close request', opening)
      assert.equal(callback.settled(), false)
      assert.ok(!f.logs.includes('dialog-modal:query:1'))
      assert.ok(!f.logs.includes('window:after'))
      assert.equal(f.select(request, ''), true)
      await succeeded(callback)
      assert.equal(await f.settled(opening), 'complete')
      before(f.logs, 'parent:requested:0', 'callback:after:0')
      before(f.logs, 'callback:after:0', 'dialog-modal:query:1')
      before(f.logs, 'dialog-modal:query:1', 'window:after')
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: pausing rejects a System dialog response and resuming preserves the same request for a new response`, async () => {
    const f = await fixture(
      binary,
      String.raw`
run=function(){var result=System.inputString("Pause","Prompt","initial");mark("after:"+result);return result;};
`,
    )
    try {
      const opening = f.open(),
        request = await f.waitDialog('Pause', 1, opening)
      f.session.pause()
      await f.until(() => f.session.snapshot().state === 'paused', 'paused System dialog')
      assert.equal(f.select(request, 'ignored while paused'), false)
      assert.equal(f.select(request, null), false)
      assert.equal(opening.settled(), false)
      assert.ok(!f.logs.some((entry) => entry.startsWith('after:')))
      f.session.resume()
      const restored = await f.waitDialog('Pause', 1, opening)
      assert.equal(restored.id, request.id)
      assert.equal(f.select(restored, 'accepted after resume'), true)
      assert.equal(await f.settled(opening), 'accepted after resume')
      assert.ok(f.logs.includes('after:accepted after resume'))
    } finally {
      await f.stop()
    }
  })

  test(`${mode}: stopping nested System dialogs cancels their suspended input receipt and releases every modal and native owner`, async () => {
    const f = await fixture(
      binary,
      String.raw`
var timer=new Timer(function(){timer.enabled=false;
  System.inputString("Stop child","Child prompt","seed");mark("child:after-stop");},"");timer.interval=10;
a.keyHandler=function(key){if(key==65){timer.enabled=true;
  System.inform("Parent body","Stop parent");mark("parent:after-stop");}};
`,
    )
    try {
      const callback = f.key('dialog-A', 65)
      assert.equal(callback.status, 'accepted')
      const parent = await f.waitDialog('Stop parent', 1, callback)
      f.clock.advance(10)
      const child = await f.waitDialog('Stop child', 2, callback)
      assert.deepEqual(f.dialogState()?.pendingIds, [parent.id, child.id])
      assert.ok(f.session.inspectOwnership().eventReceipts > 0)
      assert.ok(f.session.snapshot().handles > 0)
      assert.equal(callback.settled(), false)
      await f.stop()
      assert.equal((await bounded(callback.result, 'cancel opening input callback')).ok, false)
      assert.ok(!f.logs.includes('child:after-stop'))
      assert.ok(!f.logs.includes('parent:after-stop'))
      assert.equal(f.select(child, 'stale after Stop'), false)
      assert.equal(f.select(parent, ''), false)
      assert.equal(f.dialog(), undefined)
      assert.deepEqual(f.session.snapshot().windows, [])
    } finally {
      await f.stop()
    }
  })
}
