import test from 'node:test'
import assert from 'node:assert/strict'
import type { EngineSession } from '../../src/engine/session.ts'
import { headless, createHeadlessRuntime } from '../helpers/headless.ts'

class Clock {
  value = 0
  tasks = new Set<{ at: number; run(): void }>()
  now = () => this.value
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.value + delay, run }
    this.tasks.add(task)
    return () => { this.tasks.delete(task) }
  }
  advance(value: number) {
    this.value = value
    for (const task of [...this.tasks]) if (task.at <= value && this.tasks.delete(task)) task.run()
  }
}
const source = String.raw`
var win=new Window(),fakeCompacts=0,applicationCalls=0;
System.doCompact=function(){fakeCompacts++;};
System.onDeactivate=function(){applicationCalls++;Debug.message("after-compact");};
var timer=new Timer(function(){timer.enabled=false;Debug.message("inside-pump");},"");
timer.interval=10;timer.enabled=true;
`
for (const binary of [false, true]) test(`${binary ? 'bytecode' : 'source'}: deactivation admitted inside a running event round compacts before its callback`, { timeout: 60000 }, async () => {
  const clock = new Clock(), order: string[] = [], failures: unknown[] = []
  let session: EngineSession | undefined,
    receipt: ReturnType<EngineSession['acceptApplicationActivation']> | undefined
  const observedReceipt = (): ReturnType<EngineSession['acceptApplicationActivation']> | undefined => receipt
  const f = await headless({ 'compact-order.tjs': source, 'startup.tjs': binary
    ? 'Scripts.compileStorage("compact-order.tjs","savedata/compact-order.cjs",false,true,false);Scripts.execStorage("savedata/compact-order.cjs");'
    : 'Scripts.execStorage("compact-order.tjs");' }, {
    now: clock.now, schedule: clock.schedule,
    createRuntime: (handler, control, options) => createHeadlessRuntime(async (operation, args, context) => {
      if (operation === 'System.doCompact') order.push('compact:' + args[0])
      return handler(operation, args, context)
    }, control, options),
    event(event) {
      if (event.type !== 'log') return
      if (event.text === 'inside-pump') {
        order.push('inside-pump')
        // Actual host input arrives before this Timer host call returns to
        // its current native event pump. No second VM invocation is injected.
        receipt = session!.acceptApplicationActivation({ active: false, sequence: 1 })
      } else if (event.text === 'after-compact') order.push('after-compact')
    },
  })
  session = f.session
  try {
    await session.start()
    if (binary) assert.equal(new TextDecoder().decode(session.exportSaves()
      .find((file) => file.path === 'savedata/compact-order.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    clock.advance(10)
    await session.idle()
    const admitted = observedReceipt()
    assert(admitted)
    await admitted.completion
    assert.deepEqual(order, ['inside-pump', 'compact:10', 'after-compact'])
    assert.equal(await session.evaluate('fakeCompacts+","+applicationCalls'), '0,1')
    assert.equal(session.snapshot().eventDisabled, false)
  } catch (error) { failures.push(error) }
  try {
    await session.stop()
    assert.equal(clock.tasks.size, 0)
    assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Compact order or cleanup failed', { cause: failures[0] })
})
