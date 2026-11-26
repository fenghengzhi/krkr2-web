import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemEvents, type EventPriority } from '../../src/engine/scheduler/system-events.ts'
import type { HostReply, ScriptObject, ScriptRuntime } from '../../src/engine/script/runtime.ts'

class Clock {
  time = 0
  readonly tasks = new Set<{ at: number; run(): void }>()
  now = () => this.time
  schedule = (run: () => void, delay: number) => {
    const task = { at: this.time + delay, run }
    this.tasks.add(task)
    return () => {
      this.tasks.delete(task)
    }
  }
  advance(ms: number): void {
    this.time += ms
    for (const task of [...this.tasks])
      if (task.at <= this.time && this.tasks.delete(task)) task.run()
  }
}

const object = (id: number): ScriptObject => ({ type: 'object', runtime: 1, id })
function token(reply: HostReply): bigint {
  assert.equal(reply.kind, 'invoke')
  if (reply.kind !== 'invoke') throw new Error('Expected the existing event pump')
  assert.equal(reply.args.length, 1)
  assert.equal(typeof reply.args[0], 'bigint')
  return reply.args[0] as bigint
}

function setup(bind = true) {
  const clock = new Clock(),
    leases = new Map<number, number>()
  const executions: { operation(): HostReply; resolve(): void }[] = []
  const pending: Promise<unknown>[] = []
  let nextLease = 1000
  const objects = {
    retain(value: ScriptObject) {
      const id = nextLease++
      leases.set(id, leases.get(value.id) ?? value.id)
      return object(id)
    },
    release(value: ScriptObject) {
      assert(leases.delete(value.id), 'A scheduler lease was released twice')
    },
    objectIdentity(value: ScriptObject) {
      return String(leases.get(value.id) ?? value.id)
    },
  } as ScriptRuntime
  const events = new SystemEvents(
    objects,
    clock,
    (operation) =>
      new Promise<void>((resolve) => {
        executions.push({ operation, resolve })
      }),
    () => {},
    () => {},
  )
  if (bind) events.host('System.bindEvents', [object(1)])
  const post = (id: number, priority: EventPriority = 2, valid?: () => boolean) => {
    const completion = events.post(() => ({ kind: 'invoke', callback: object(id), args: [] }), {
      priority,
      valid,
    })
    pending.push(completion.catch(() => {}))
    return completion
  }
  const host = (operation: string, round: bigint) =>
    events.host(`System.event${operation}`, [round])
  const value = (operation: string, round: bigint) => {
    const reply = host(operation, round)
    assert.equal(reply.kind, 'value')
    return reply.kind === 'value' ? reply.value : undefined
  }
  const next = (round: bigint) => value('Next', round) === 1n
  const windowUpdate = (round: bigint) => value('WindowUpdate', round)
  const callback = (round: bigint) => {
    const reply = host('Call', round)
    assert.equal(reply.kind, 'invoke')
    if (reply.kind !== 'invoke') throw new Error('Expected an event callback')
    assert.equal(reply.statusOnly, true)
    return leases.get(reply.callback.id) ?? reply.callback.id
  }
  const begin = (windowUpdate = false) => token(events.beginNested({ windowUpdate }))
  const done = (round: bigint) => host('Done', round)
  const end = (round: bigint) => host('End', round)
  const cleanup = async () => {
    events.dispose()
    for (const execution of executions) execution.resolve()
    await Promise.all(pending)
    assert.equal(leases.size, 0)
    assert.equal(clock.tasks.size, 0)
  }
  return {
    events,
    clock,
    executions,
    post,
    host,
    next,
    windowUpdate,
    callback,
    begin,
    done,
    end,
    cleanup,
  }
}

test('a disabled script event queue runs only native continuations and retains ordinary priorities, ticks and paint', async (t) => {
  const h = setup(); t.after(h.cleanup)
  h.events.setDisabled(true)
  h.post(40, 3); h.post(30, 2); h.post(10, 0); h.post(20, 1)
  h.events.add(object(50), 100); h.clock.advance(0)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.equal(h.executions.length, 0)
  const internals = ([3, 1, 2] as const).map((priority) => h.events.enqueue(
    () => ({ kind: 'invoke', callback: object(60 + priority), args: [] }),
    { internal: true, discardable: true, priority },
  ))
  assert.equal(h.executions.length, 1)
  assert(internals.every((entry) => entry.status === 'accepted'))
  const nativeRound = token(h.executions[0]!.operation())
  const native: number[] = []
  while (h.next(nativeRound)) { native.push(h.callback(nativeRound)); h.done(nativeRound) }
  assert.deepEqual(native, [61, 62, 63])
  assert.equal(h.windowUpdate(nativeRound), 0n)
  h.end(nativeRound)
  await Promise.all(internals.map((entry) => entry.completion))
  assert.equal(h.events.hasDispatchableWork(), false)
  const resumed = token(h.events.setDisabled(false)), calls: number[] = []
  while (h.next(resumed)) { calls.push(h.callback(resumed)); h.done(resumed) }
  assert.deepEqual(calls, [10, 20, 30, 40, 50])
  assert.equal(h.windowUpdate(resumed), 1n)
  h.end(resumed)
})

test('native work while disabled does not admit later user jobs into a suspended script round', async (t) => {
  const h = setup(); t.after(h.cleanup)
  h.post(10)
  const outer = h.begin()
  assert.equal(h.next(outer), true); assert.equal(h.callback(outer), 10)
  h.post(20)
  h.events.setDisabled(true)
  const completion = h.events.post(() => ({ kind: 'value', value: undefined }), { internal: true })
  const inner = h.begin()
  assert.equal(h.next(inner), true); h.host('Call', inner); h.done(inner)
  assert.equal(h.next(inner), false); h.end(inner)
  await completion
  h.done(outer)
  assert.equal(h.next(outer), false, 'The original normal-event cutoff is still in force')
  h.end(outer)
  const resumed = token(h.events.setDisabled(false))
  assert.equal(h.next(resumed), true); assert.equal(h.callback(resumed), 20); h.done(resumed)
  assert.equal(h.next(resumed), false); h.end(resumed)
})

test('pausing and cancelling a pending native continuation leaves the disabled queue asleep', async (t) => {
  const h = setup(); t.after(h.cleanup)
  h.events.setDisabled(true); h.events.pause(); h.post(20)
  let called = 0
  const internal = () => { called++; return { kind: 'value' as const, value: undefined } }
  const source = {}, first = h.events.enqueue(internal, { internal: true, source })
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.deepEqual(h.events.beginNested({ windowUpdate: true }), { kind: 'value', value: undefined })
  h.events.cancelSource(source); await first.completion
  h.events.resume()
  assert.equal(h.executions.length, 0); assert.equal(called, 0)
  const next = h.events.enqueue(internal, { internal: true })
  assert.equal(h.events.hasDispatchableWork(), true)
  const round = token(h.executions[0]!.operation())
  assert.equal(h.next(round), true); h.host('Call', round); h.done(round); h.end(round)
  await next.completion
  assert.equal(called, 1); assert.equal(h.events.hasDispatchableWork(), false)
})

test('window update is allowed only after exclusive, input, normal, idle and continuous delivery', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  h.post(30, 2)
  h.post(40, 3)
  h.post(10, 0)
  h.post(20, 1)
  h.events.add(object(50), 100)
  h.clock.advance(0)
  const round = h.begin()
  assert.equal(h.windowUpdate(round), 0n)
  const delivered: number[] = []
  while (h.next(round)) {
    assert.equal(h.windowUpdate(round), 0n)
    delivered.push(h.callback(round))
    h.done(round)
    assert.equal(h.windowUpdate(round), 0n, 'A completed body is not an exhausted event round')
  }
  assert.deepEqual(delivered, [10, 20, 30, 40, 50])
  assert.equal(h.windowUpdate(round), 1n)
  assert.equal(h.windowUpdate(round), 1n, 'The permission query must remain read-only')
  assert.equal(h.executions.length, 1)
  h.end(round)
  assert.throws(() => h.windowUpdate(round), /round has ended/)
})

test('exclusive events posted before tail entry suppress window update at every prefix boundary', async (t) => {
  for (const priority of [0, 1, 2] as const) {
    const h = setup()
    t.after(h.cleanup)
    h.post(10, priority)
    h.post(40, 3)
    const round = h.begin()
    assert.equal(h.next(round), true)
    assert.equal(h.callback(round), 10)
    h.post(99, 0)
    h.done(round)
    assert.equal(h.next(round), false)
    assert.equal(h.windowUpdate(round), 0n)
    h.end(round)
    const later = h.begin()
    const delivered: number[] = []
    while (h.next(later)) {
      delivered.push(h.callback(later))
      h.done(later)
    }
    assert.deepEqual(delivered, [99, 40])
    assert.equal(h.windowUpdate(later), 1n)
    h.end(later)
  }
})

test('exclusive events posted inside the idle tail do not revoke that round window update', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  h.post(40, 3)
  h.post(41, 3)
  h.events.add(object(50), 100)
  h.events.add(object(51), 100)
  h.clock.advance(0)
  const round = h.begin()
  assert.equal(h.next(round), true)
  assert.equal(h.callback(round), 40)
  h.post(99, 0)
  h.done(round)
  assert.equal(h.windowUpdate(round), 0n, 'Tail entry alone does not finish the remaining jobs')
  assert.equal(h.next(round), true)
  assert.equal(h.callback(round), 41)
  h.done(round)
  assert.equal(h.next(round), true)
  assert.equal(
    h.callback(round),
    50,
    'Native continuous delivery checks exclusive after a callback',
  )
  h.done(round)
  assert.equal(
    h.next(round),
    false,
    'The new exclusive event stops the remaining continuous callbacks',
  )
  assert.equal(h.windowUpdate(round), 1n, 'Tail admission must not recheck the new exclusive event')
  h.end(round)
})

test('a frame-only nested round can finish its tail without reentering outer continuous delivery', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  h.events.add(object(50), 100)
  h.events.add(object(51), 100)
  h.clock.advance(0)
  const outer = h.begin()
  assert.equal(h.next(outer), true)
  assert.equal(h.callback(outer), 50)
  h.clock.advance(10)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  const nested = h.begin(true)
  assert.equal(h.windowUpdate(nested), 0n)
  assert.equal(h.next(nested), false)
  assert.equal(h.windowUpdate(nested), 1n)
  assert.equal(h.windowUpdate(outer), 0n)
  h.end(nested)
  assert.equal(
    h.events.hasDispatchableWork(),
    false,
    'The nested legacy round consumes the pending tick',
  )
  assert.equal(h.callback(outer), 50)
  h.done(outer)
  assert.equal(h.next(outer), true)
  assert.equal(h.callback(outer), 51)
  h.done(outer)
  assert.equal(h.next(outer), false)
  assert.equal(h.windowUpdate(outer), 1n)
  h.end(outer)
  assert.equal(h.executions.length, 1, 'Frame entry returns the existing pump continuation only')
})

test('an empty frame round requires opt-in and a bound pump without scheduling VM execution', async (t) => {
  const h = setup(false)
  t.after(h.cleanup)
  assert.deepEqual(h.events.beginNested({ windowUpdate: true }), {
    kind: 'value',
    value: undefined,
  })
  h.events.host('System.bindEvents', [object(1)])
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  assert.deepEqual(h.events.beginNested({ windowUpdate: false }), {
    kind: 'value',
    value: undefined,
  })
  const round = h.begin(true)
  assert.equal(h.windowUpdate(round), 0n)
  assert.equal(h.next(round), false)
  assert.equal(h.windowUpdate(round), 1n)
  h.end(round)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  assert.equal(h.executions.length, 0)
  assert.equal(h.clock.tasks.size, 0)
})

test('disabled, paused and disposed schedulers cannot grant frame entry or window update', async (t) => {
  for (const gate of ['disabled', 'paused'] as const) {
    const h = setup()
    t.after(h.cleanup)
    const admitted = h.begin(true)
    assert.equal(h.next(admitted), false)
    assert.equal(h.windowUpdate(admitted), 1n)
    const interrupted = h.begin(true)
    if (gate === 'disabled') h.events.setDisabled(true)
    else h.events.pause()
    assert.equal(h.windowUpdate(admitted), 0n)
    assert.deepEqual(h.events.beginNested({ windowUpdate: true }), {
      kind: 'value',
      value: undefined,
    })
    assert.equal(h.next(interrupted), false)
    assert.equal(h.windowUpdate(interrupted), 0n)
    if (gate === 'disabled') {
      const resumed = token(h.events.setDisabled(false))
      h.end(resumed)
    } else h.events.resume()
    assert.equal(h.windowUpdate(admitted), 1n)
    assert.equal(
      h.windowUpdate(interrupted),
      0n,
      'A gate closed at tail entry cannot be admitted retroactively',
    )
    h.events.dispose()
    assert.equal(h.windowUpdate(admitted), 0n)
    assert.equal(h.windowUpdate(interrupted), 0n)
    assert.deepEqual(h.events.beginNested({ windowUpdate: true }), {
      kind: 'value',
      value: undefined,
    })
  }
})

test('frame-only rounds obey the same 64-round nesting limit and release depth on end', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  const rounds: bigint[] = []
  for (let i = 0; i < 64; i++) rounds.push(h.begin(true))
  assert.throws(() => h.begin(true), /nesting limit/)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  const last = rounds.pop()!
  assert.equal(h.windowUpdate(last), 0n)
  assert.equal(h.next(last), false)
  assert.equal(h.windowUpdate(last), 1n)
  h.end(last)
  const replacement = h.begin(true)
  assert.notEqual(replacement, last)
  assert.equal(h.next(replacement), false)
  assert.equal(h.windowUpdate(replacement), 1n)
  h.end(replacement)
  for (const round of rounds.reverse()) h.end(round)
  assert.equal(h.executions.length, 0)
})

test('taking more work resets exhaustion while skipped invalid jobs still reach the tail', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  let invalidChecks = 0
  h.post(40, 3, () => {
    invalidChecks++
    return false
  })
  h.post(41, 3, () => {
    invalidChecks++
    return false
  })
  h.events.add(object(50), 100)
  const round = h.begin()
  assert.equal(h.next(round), false)
  assert.equal(invalidChecks, 2)
  assert.equal(h.windowUpdate(round), 1n)
  h.clock.advance(0)
  assert.equal(h.next(round), true)
  assert.equal(h.windowUpdate(round), 0n)
  assert.equal(h.callback(round), 50)
  h.host('Failed', round)
  assert.equal(
    h.windowUpdate(round),
    0n,
    'A failed body must not inherit an earlier exhausted result',
  )
  assert.equal(h.next(round), false)
  assert.equal(
    h.windowUpdate(round),
    0n,
    'Continuing after failure must not grant a normal tail checkpoint',
  )
  h.end(round)
})
