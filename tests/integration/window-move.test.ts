import test from 'node:test'
import assert from 'node:assert/strict'
import { headless } from '../helpers/headless.ts'
import type { WindowMoveRequest } from '../../src/engine/ports/window-move.ts'
import type { EngineEvent } from '../../src/engine/session.ts'

class Clock {
  time = 1000
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.time + delay, run }
    this.tasks.add(task)
    return () => { this.tasks.delete(task) }
  }
  advance(ms: number) {
    this.time += ms
    for (const task of [...this.tasks]) if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out waiting for Window move observation')), 10000)
    })])
  } finally { clearTimeout(timer) }
}
function track<T>(promise: Promise<T>) {
  let settled = false
  void promise.then(() => { settled = true }, () => { settled = true })
  return { promise, settled: () => settled }
}
const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.visible=true;win.setPos(20,30);win.setInnerSize(120,80);win.borderStyle=bsNone;
var root=new Layer(win,null);root.setSize(120,80);root.fillRect(0,0,120,80,0xff304050);
var button=new Layer(win,root);button.setSize(40,40);button.visible=true;button.fillRect(0,0,40,40,0xffffffff);
var startMove=false,retireOnTimer=false;
button.onMouseDown=function(x,y,b,shift){if(startMove){Debug.message("move:down-before");win.beginMove();Debug.message("move:down-after");}};
button.onMouseMove=function(x,y,shift){Debug.message("move:child-drag:"+x+","+y);};
button.onMouseUp=function(x,y,b,shift){Debug.message("move:child-up:"+x+","+y);};
var timer=new Timer(function(){timer.enabled=false;if(retireOnTimer){invalidate win;Debug.message("move:retired");}else Debug.message("move:timer:"+win.left+","+win.top);},"");timer.interval=10;timer.enabled=false;
`
async function fixture(binary: boolean, supported = true) {
  const events: EngineEvent[] = [], logs: string[] = [], requests: WindowMoveRequest[] = [],
    waiters = new Set<() => void>(), clock = new Clock()
  let requestIndex = 0
  const f = await headless({ 'startup.tjs': binary
    ? 'Scripts.compileStorage("window-move.tjs","savedata/window-move.cjs",false,true,false);Scripts.execStorage("savedata/window-move.cjs");'
    : 'Scripts.execStorage("window-move.tjs");', 'window-move.tjs': source }, {
    windowMoveSupported: supported, now: clock.now, schedule: clock.schedule,
    event: (event) => {
      events.push(event)
      if (event.type === 'log') logs.push(event.text)
      if (event.type === 'window-move' && event.request) requests.push(event.request)
      for (const wake of [...waiters]) wake()
    },
  })
  const until = async (ready: () => boolean) => {
    if (ready()) return
    let wake!: () => void
    try { await bounded(new Promise<void>((resolve) => {
      wake = () => { if (ready()) resolve() }
      waiters.add(wake)
      wake()
    })) } finally { waiters.delete(wake) }
  }
  try {
    await f.session.start()
    const id = Number(await f.session.evaluate('win.__windowId'))
    if (binary) {
      const bytes = f.session.exportSaves().find((file) => file.path === 'savedata/window-move.cjs')?.bytes
      assert(bytes)
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 4)), 'TJS2')
    }
    return { ...f, id, events, logs, clock,
      // Session.evaluate uses the TJS expression compiler. Programs must enter
      // through Scripts.exec so statements after the first are actually run.
      exec: (program: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(`${program};`)})`),
      async request() { await until(() => requestIndex < requests.length); return requests[requestIndex++]! },
      log: (message: string) => until(() => logs.includes(message)),
      position: () => { const view = f.session.snapshot().windows!.find((window) => window.id === id)!.view; return [view.left, view.top] },
    }
  } catch (error) { await f.session.stop(); throw error }
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: beginMove holds its TJS caller, pumps a real Timer and commits independent host updates before return`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const opening = track(f.exec('timer.enabled=true;Debug.message("move:before");win.beginMove();Debug.message("move:after:"+win.left+","+win.top)')),
        request = await f.request()
      assert.equal(opening.settled(), false)
      assert.equal(f.session.inspectOwnership().modalScopes, 1)
      assert.equal(f.session.windowMove({ ...request, type: 'update', sequence: 1, left: 60, top: -10 }), true)
      assert.deepEqual(f.position(), [60, -10])
      f.clock.advance(10)
      await f.log('move:timer:60,-10')
      assert.equal(opening.settled(), false)
      assert.equal(f.session.windowMove({ ...request, type: 'commit', sequence: 2, left: 65, top: -8 }), true)
      await bounded(opening.promise)
      assert(f.logs.includes('move:after:65,-8'))
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert.equal(f.session.windowMove({ ...request, type: 'update', sequence: 3, left: 900, top: 900 }), false)
      assert.deepEqual(f.position(), [65, -8])
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: cancel restores the original Window position and a host failure becomes a catchable TJS exception`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      const first = track(f.exec('win.beginMove();Debug.message("move:cancelled:"+win.left+","+win.top)')),
        request = await f.request()
      f.session.windowMove({ ...request, type: 'update', sequence: 1, left: 70, top: 80 })
      assert.equal(f.session.windowMove({ ...request, type: 'cancel', sequence: 2 }), true)
      await bounded(first.promise)
      assert(f.logs.includes('move:cancelled:20,30'))
      const second = track(f.exec('try{win.beginMove();}catch(e){Debug.message("move:caught:"+e.message);}')),
        next = await f.request()
      assert.notEqual(next.requestId, request.requestId)
      assert.equal(f.session.windowMove({ ...request, type: 'commit', sequence: 999, left: 900, top: 900 }), false)
      f.session.windowMove({ ...next, type: 'error', sequence: 1, message: 'Host pointer capture failed' })
      await bounded(second.promise)
      assert(f.logs.some((line) => line.includes('move:caught:') && line.includes('Host pointer capture failed')))
      assert.deepEqual(f.position(), [20, 30])
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
    } finally { await f.session.stop() }
  })

  test(`${mode}: a Layer onMouseDown can synchronously move the Window without inventing a manager capture release`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    try {
      await f.session.evaluate('startMove=true')
      const down = track(f.session.input({ type: 'down', windowId: f.id, x: 10, y: 10, button: 0, shift: 8, clicks: 0 })),
        request = await f.request()
      assert.equal(down.settled(), false)
      assert(f.logs.includes('move:down-before'))
      assert.equal(f.logs.includes('move:down-after'), false)
      f.session.windowMove({ ...request, type: 'commit', sequence: 1, left: 40, top: 50 })
      await bounded(down.promise)
      assert(f.logs.includes('move:down-after'))
      // A later real engine packet probes the native manager's post-callback
      // acquisition. This is not an assertion that OS drag-up is a game up.
      await f.session.input({ type: 'move', windowId: f.id, x: 80, y: 10, button: 0, shift: 0, clicks: 0 })
      assert(f.logs.includes('move:child-drag:80,10'))
      await f.session.input({ type: 'up', windowId: f.id, x: 80, y: 10, button: 0, shift: 0, clicks: 0 })
      assert(f.logs.includes('move:child-up:80,10'))
    } finally { await f.session.stop() }
    assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
  })

  test(`${mode}: missing presentation and fullscreen fail without a pending loop; Window invalidation wakes an active call`, { timeout: 60000 }, async () => {
    const unsupported = await fixture(binary, false)
    try {
      assert.match(await unsupported.session.evaluate('(function(){try{win.beginMove();return "missing error";}catch(e){return e.message;}})()'), /presentation is unavailable/)
      assert.equal(unsupported.session.inspectOwnership().modalScopes, 0)
      assert.equal(await unsupported.session.evaluate('win.left+","+win.top'), '20,30')
    } finally { await unsupported.session.stop() }
    const f = await fixture(binary)
    try {
      await f.session.evaluate('win.fullScreen=true')
      // An uncaught console exception faults the Session by design. Catch the
      // native error in TJS before probing the same live Window's next move.
      assert.match(await f.session.evaluate('(function(){try{win.beginMove();return "missing error";}catch(e){return e.message;}})()'), /fullscreen/)
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      await f.exec('win.fullScreen=false;retireOnTimer=true')
      const opening = track(f.exec('timer.enabled=true;win.beginMove();Debug.message("move:after-retire")')),
        request = await f.request()
      f.clock.advance(10)
      await f.log('move:retired')
      await bounded(opening.promise)
      assert(f.logs.includes('move:after-retire'))
      assert.equal(f.session.windowMove({ ...request, type: 'commit', sequence: 1, left: 900, top: 900 }), false)
      assert.equal(f.session.inspectOwnership().modalScopes, 0)
      assert(f.events.some((event) => event.type === 'window-move' && event.request === null))
    } finally { await f.session.stop() }
  })

  test(`${mode}: Stop unwinds beginMove without a page reply and no late result resumes the script`, { timeout: 60000 }, async () => {
    const f = await fixture(binary)
    let opening: ReturnType<typeof track<string>> | undefined
    try {
      opening = track(f.exec('win.beginMove();Debug.message("move:after-stop")'))
      const request = await f.request()
      await bounded(f.session.stop())
      await assert.rejects(opening.promise)
      assert.equal(f.session.windowMove({ ...request, type: 'commit', sequence: 1, left: 300, top: 400 }), false)
      assert.equal(f.logs.includes('move:after-stop'), false)
      assert(f.events.some((event) => event.type === 'window-move' && event.request === null))
      assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0))
    } finally { await f.session.stop(); await opening?.promise.catch(() => {}) }
  })
}
