import test from 'node:test'
import assert from 'node:assert/strict'
import { headless, createHeadlessRuntime } from '../helpers/headless.ts'

class Clock {
  value = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.value
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.value + delay, run }
    this.tasks.add(task); return () => { this.tasks.delete(task) }
  }
  at(value: number) {
    this.value = value
    for (const task of [...this.tasks]) if (task.at <= value && this.tasks.delete(task)) task.run()
  }
}
async function fixture(binary: boolean, source: string) {
  const clock = new Clock(), compact: number[] = []
  const f = await headless({ 'lifecycle.tjs': source, 'startup.tjs': binary
    ? 'Scripts.compileStorage("lifecycle.tjs","savedata/lifecycle.cjs",false,true,false);Scripts.execStorage("savedata/lifecycle.cjs");'
    : 'Scripts.execStorage("lifecycle.tjs");' }, {
    now: clock.now, schedule: clock.schedule,
    createRuntime: (handler, control, options) => createHeadlessRuntime((operation, args, context) => {
      // Passive observation of the real native SystemCompact import. It does
      // not synthesize collection or replace its captured native callback.
      if (operation === 'System.doCompact') compact.push(Number(args[0]))
      return handler(operation, args, context)
    }, control, options),
  })
  return { ...f, clock, compact,
    exec: (source: string) => f.session.evaluate(`Scripts.exec(${JSON.stringify(source + ';')})`),
    async stop() { await f.session.stop(); assert.equal(clock.tasks.size, 0); assert(Object.values(f.session.inspectOwnership()).every((value) => value === 0)) },
  }
}
async function until(condition: () => boolean) {
  const deadline = performance.now() + 10000
  while (!condition()) {
    if (performance.now() > deadline) throw new Error('System lifecycle did not reach its observation boundary')
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
}
for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'
  test(`${mode}: no-window policy is true by default and the actual visible Web controller preserves the session`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'Debug.message("startup-complete");')
    try {
      await f.session.start()
      assert.equal(await f.session.evaluate('int(System.exitOnNoWindowStartup)+","+int(Debug.controller.visible)'), '1,1')
      await f.exec('Debug.controller.visible=false')
      assert.equal(f.session.snapshot().state, 'running', 'The predicate is startup-only, not every evaluate')
    } finally { await f.stop() }
  })
  test(`${mode}: hidden controller plus no registered Window terminates after the complete successful startup`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'Debug.controller.visible=false;Debug.message("startup-before");Scripts.exec(\'Debug.message("startup-nested");\');Debug.message("startup-after");')
    try {
      await f.session.start(); await until(() => f.session.snapshot().state === 'stopped')
      assert.deepEqual(f.logs, ['startup-before', 'startup-nested', 'startup-after'])
    } finally { await f.stop() }
  })
  test(`${mode}: no-window flag uses native integer conversion and false allows a hidden-controller startup`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'System.exitOnNoWindowStartup=0.5;Debug.controller.visible=false;')
    try {
      await f.session.start()
      assert.equal(await f.session.evaluate('System.exitOnNoWindowStartup'), '0')
      assert.equal(await f.session.evaluate('(System.exitOnNoWindowStartup=-1,int(System.exitOnNoWindowStartup))'), '1')
      assert.equal(await f.session.evaluate('(System.exitOnNoWindowStartup=4294967296,int(System.exitOnNoWindowStartup))'), '0')
      assert.equal(await f.session.evaluate('(System.exitOnNoWindowStartup=void,int(System.exitOnNoWindowStartup))'), '0')
      assert.equal(f.session.snapshot().state, 'running')
    } finally { await f.stop() }
  })
  test(`${mode}: hidden Windows count and startup exceptions are never replaced by no-window termination`, { timeout: 60000 }, async () => {
    const hidden = await fixture(binary, 'Debug.controller.visible=false;var hidden=new Window();')
    try { await hidden.session.start(); assert.equal(hidden.session.snapshot().state, 'running'); assert.equal(await hidden.session.evaluate('int(hidden.visible)'), '0') }
    finally { await hidden.stop() }
    const painted = await fixture(binary, 'System.exitOnWindowClose=false;Debug.controller.visible=false;var w=new Window();w.visible=true;var l=new Layer(w,null);w.add(l);l.setSize(2,2);l.onPaint=function(){invalidate w;};l.update();')
    try { await painted.session.start(); assert.equal(await painted.session.evaluate('isvalid w'), '0'); assert.equal(painted.session.snapshot().state, 'running') }
    finally { await painted.stop() }
    const failed = await fixture(binary, 'Debug.controller.visible=false;throw new Exception("startup-owned-failure");')
    try { await assert.rejects(failed.session.start(), /startup-owned-failure/); assert.equal(failed.session.snapshot().state, 'failed') }
    finally { await failed.stop() }
  })
  test(`${mode}: automatic idle collection is independent of eventDisabled and survives public method replacement`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'var fake=0;System.doCompact=function(){fake++;};System.eventDisabled=true;')
    try {
      await f.session.start(); f.clock.at(4000); await f.session.idle(); assert.deepEqual(f.compact, [])
      await f.exec('var inputActivity=1'); f.clock.at(4050); await f.session.idle()
      assert.deepEqual(f.compact, [5]); assert.equal(await f.session.evaluate('fake'), '0')
      await f.exec('System.eventDisabled=false'); f.clock.at(8050); await f.session.idle(); assert.deepEqual(f.compact, [5])
      f.clock.at(8100); await f.session.idle(); assert.deepEqual(f.compact, [5, 5])
    } finally { await f.stop() }
  })
  test(`${mode}: native continuous handlers and transition hooks suppress idle collection until their cleanup pass`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, String.raw`
var callback=function(){};System.addContinuousHandler(callback);System.eventDisabled=true;
var w=new Window();w.setInnerSize(2,2);w.visible=true;var a=new Layer(w,null);w.add(a);a.setSize(2,2);var b=new Layer(w,a);b.setSize(2,2);
`)
    try {
      await f.session.start(); f.clock.at(5000); await f.session.idle(); assert.deepEqual(f.compact, [])
      await f.exec('System.removeContinuousHandler(callback)'); f.clock.at(5050); await f.session.idle(); assert.deepEqual(f.compact, [])
      await f.exec('System.eventDisabled=false'); f.clock.at(5100); await f.session.idle(); assert.deepEqual(f.compact, [5])
      await f.exec('a.beginTransition("crossfade",false,b,%[time:20000])')
      f.clock.at(10000); await f.session.idle(); assert.deepEqual(f.compact, [5])
      await f.exec('System.eventDisabled=true;a.stopTransition()'); f.clock.at(10050); await f.session.idle(); assert.deepEqual(f.compact, [5])
      await f.exec('System.eventDisabled=false'); f.clock.at(10100); await f.session.idle(); assert.deepEqual(f.compact, [5,5])
    } finally { await f.stop() }
  })
  test(`${mode}: actual application deactivation compacts before delivery even while events are disabled or the VM is paused`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'var calls=0;System.onDeactivate=function(){calls++;Debug.message("deactivated");};System.eventDisabled=true;')
    try {
      await f.session.start()
      const first = f.session.acceptApplicationActivation({ sequence: 1, active: false })
      await f.session.idle(); assert.deepEqual(f.compact, [10]); assert.equal(await f.session.evaluate('calls'), '0')
      await f.exec('System.eventDisabled=false'); await first.completion
      assert.equal(await f.session.evaluate('calls'), '1')
      f.session.pause()
      const second = f.session.acceptApplicationActivation({ sequence: 2, active: false })
      const held = Promise.allSettled([second.completion])
      assert.equal(f.clock.tasks.size, 0); assert.deepEqual(f.compact, [10])
      f.session.resume(); await held; await f.session.idle(); assert.deepEqual(f.compact, [10,10])
      f.session.setActivity({ sequence: 1, state: 'hidden', pauseWhenHidden: false })
      await f.session.idle(); assert(!f.compact.includes(15), 'Page hiding does not prove OS minimization')
    } finally { await f.stop() }
  })
  test(`${mode}: modal maintenance uses the existing TJS continuation and Stop revokes pending native work`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'System.onDeactivate=function(){Debug.message("modal-deactivate");};')
    await f.session.start()
    const opening = Promise.allSettled([f.session.evaluate('System.inform("hold")')])
    try {
      await until(() => f.session.inspectOwnership().modalWaits === 1)
      f.clock.at(4050); await until(() => f.compact.includes(5))
      const receipt = f.session.acceptApplicationActivation({ sequence: 1, active: false })
      await until(() => f.logs.includes('modal-deactivate')); await receipt.completion
      assert.deepEqual(f.compact, [5,10])
      f.session.pause()
      const late = f.session.acceptApplicationActivation({ sequence: 2, active: false }), finished = Promise.allSettled([late.completion])
      await f.stop(); await finished; await opening
      assert.deepEqual(f.compact, [5,10])
    } finally { await f.stop(); await opening }
  })
}
