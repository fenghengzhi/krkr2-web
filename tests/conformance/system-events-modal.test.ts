import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemEvents, type EventOptions } from '../../src/engine/scheduler/system-events.ts'
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

function setup(options: { bind?: boolean; reportThrows?: boolean } = {}) {
  const clock = new Clock(),
    leases = new Map<number, number>()
  const scheduled: { operation(): HostReply; resolve(): void }[] = []
  const reports: { message: string; handled: boolean }[] = []
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
        scheduled.push({ operation, resolve })
      }),
    () => {},
    (message, handled) => {
      reports.push({ message, handled })
      if (options.reportThrows) throw new Error('reporting failed')
    },
  )
  if (options.bind !== false) events.host('System.bindEvents', [object(1)])
  const pending: Promise<void>[] = []
  const completed: number[] = [],
    rejected: { id: number; error: unknown }[] = []
  const post = (id: number, extra: EventOptions = {}) => {
    const promise = events.post(() => ({ kind: 'invoke', callback: object(id), args: [] }), extra)
    pending.push(
      promise.then(
        () => {
          completed.push(id)
        },
        (error: unknown) => {
          rejected.push({ id, error })
        },
      ),
    )
    return promise
  }
  const next = (round: bigint) => {
    const reply = events.host('System.eventNext', [round])
    assert.equal(reply.kind, 'value')
    return reply.kind === 'value' && reply.value === 1n
  }
  const call = (round: bigint) => events.host('System.eventCall', [round])
  const callback = (round: bigint) => {
    const reply = call(round)
    assert.equal(reply.kind, 'invoke')
    if (reply.kind !== 'invoke') throw new Error('Expected an event invocation')
    assert.equal(reply.statusOnly, true)
    return reply
  }
  const done = (round: bigint) => events.host('System.eventDone', [round])
  const end = (round: bigint) => events.host('System.eventEnd', [round])
  const dispose = async () => {
    events.dispose()
    for (const entry of scheduled) entry.resolve()
    await Promise.all(pending)
    assert.equal(leases.size, 0)
    assert.equal(clock.tasks.size, 0)
  }
  return {
    events,
    clock,
    leases,
    scheduled,
    reports,
    post,
    next,
    call,
    callback,
    done,
    end,
    completed,
    rejected,
    dispose,
  }
}

test('nested readiness is read-only and invalid queued work is consumed once', async (t) => {
  const h = setup({ bind: false })
  t.after(h.dispose)
  let valid = 0,
    taken = 0
  h.post(10, {
    valid: () => {
      valid++
      return false
    },
    onTaken: () => {
      taken++
    },
  })
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  assert.equal(h.scheduled.length, 0)
  h.events.host('System.bindEvents', [object(1)])
  for (let i = 0; i < 10; i++) assert.equal(h.events.hasDispatchableWork(), true)
  assert.equal(valid, 0)
  assert.equal(taken, 0)
  const round = token(h.events.beginNested())
  assert.equal(h.next(round), false)
  assert.equal(valid, 1)
  assert.equal(taken, 1)
  h.end(round)
  await Promise.resolve()
  assert.deepEqual(h.completed, [10])
  assert.equal(h.events.hasDispatchableWork(), false)
  for (let i = 0; i < 10; i++)
    assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  assert.equal(h.scheduled.length, 1)
})

test('a nested pump consumes queued priorities while its outer current remains suspended', async (t) => {
  const h = setup()
  t.after(h.dispose)
  h.post(10)
  const outerReply = h.scheduled[0]!.operation(),
    outer = token(outerReply)
  assert.equal(h.next(outer), true)
  assert.equal(h.callback(outer).callback.id, 10)
  assert.equal(h.events.hasDispatchableWork(), false)
  const taken: number[] = []
  for (const [id, priority] of [
    [20, 2],
    [21, 3],
    [22, 1],
    [23, 0],
  ] as const)
    h.post(id, {
      priority,
      onTaken: () => {
        taken.push(id)
      },
    })
  const nestedReply = h.events.beginNested(),
    nested = token(nestedReply)
  assert.notEqual(nested, outer)
  assert.equal(nestedReply.kind, 'invoke')
  assert.equal(outerReply.kind, 'invoke')
  if (nestedReply.kind === 'invoke' && outerReply.kind === 'invoke')
    assert.deepEqual(nestedReply.callback, outerReply.callback)
  const delivered: number[] = []
  while (h.next(nested)) {
    delivered.push(h.callback(nested).callback.id)
    h.done(nested)
  }
  h.end(nested)
  await Promise.resolve()
  assert.deepEqual(delivered, [23, 22, 20, 21])
  assert.deepEqual(taken, delivered)
  assert.deepEqual(h.completed, delivered)
  assert.throws(() => h.next(outer), /Previous event has not completed/)
  h.done(outer)
  assert.equal(h.next(outer), false)
  h.end(outer)
  await Promise.resolve()
  assert.deepEqual(h.completed, [...delivered, 10])
  assert.equal(h.scheduled.length, 1, 'Nested entry must not enqueue another VM execution')
})

test('a handled nested exception preserves the global sequence cutoff for the outer round', async (t) => {
  const h = setup()
  t.after(h.dispose)
  h.post(10)
  const outer = token(h.scheduled[0]!.operation())
  assert.equal(h.next(outer), true)
  h.post(20, { priority: 0 })
  h.post(21)
  const nested = token(h.events.beginNested())
  assert.equal(h.next(nested), true)
  assert.equal(h.callback(nested).callback.id, 20)
  // Mirror the real TJS pump's exception branch: finish the failed callback,
  // report a handled error, then leave this round without taking its normal job.
  h.events.host('System.eventFailed', [nested])
  h.events.report('handled nested failure', true)
  h.end(nested)
  assert.equal(h.events.disabled, false)
  assert.throws(() => h.next(outer), /Previous event has not completed/)
  h.done(outer)
  assert.equal(h.next(outer), true, 'The parent must see the cutoff advanced by its child')
  assert.equal(h.callback(outer).callback.id, 21)
  h.done(outer)
  assert.equal(h.next(outer), false)
  h.end(outer)
  await Promise.resolve()
  assert.deepEqual(h.completed, [20, 10, 21])
  assert.deepEqual(h.reports, [{ message: 'handled nested failure', handled: true }])
})

test('disabled and paused modal readiness preserve synchronous setDisabled(false) nesting', async (t) => {
  const h = setup()
  t.after(h.dispose)
  const readiness: boolean[] = []
  h.events.subscribePending(() => {
    readiness.push(h.events.hasDispatchableWork())
  })
  h.post(10)
  const outer = token(h.scheduled[0]!.operation())
  assert.equal(h.next(outer), true)
  h.events.setDisabled(true)
  assert.equal(readiness.at(-1), false)
  let discarded = 0
  h.post(20, {
    discardable: true,
    onTaken: () => {
      discarded++
    },
  })
  h.post(21)
  assert.equal(discarded, 1)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  h.events.pause()
  assert.equal(readiness.at(-1), false)
  assert.deepEqual(h.events.setDisabled(false), { kind: 'value', value: undefined })
  assert.equal(h.events.hasDispatchableWork(), false)
  h.events.resume()
  assert.equal(h.events.hasDispatchableWork(), true)
  assert.equal(readiness.at(-1), true)
  const nested = token(h.events.setDisabled(false))
  assert.equal(h.next(nested), true)
  assert.equal(h.callback(nested).callback.id, 21)
  h.done(nested)
  assert.equal(h.next(nested), false)
  h.end(nested)
  // Legacy assignment still supplies a synchronous round when already enabled
  // and empty; the modal readiness API itself must not invent such work.
  const emptyLegacy = token(h.events.setDisabled(false))
  assert.equal(h.next(emptyLegacy), false)
  h.end(emptyLegacy)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  h.done(outer)
  assert.equal(h.next(outer), false)
  h.end(outer)
  await Promise.resolve()
  assert.deepEqual(h.completed, [20, 21, 10])
  assert.equal(h.scheduled.length, 1)
})

test('modal readiness cannot reenter continuous delivery or invent a replacement notification', async (t) => {
  const h = setup()
  t.after(h.dispose)
  const continuous = object(50)
  const readiness: boolean[] = []
  h.events.subscribePending(() => {
    readiness.push(h.events.hasDispatchableWork())
  })
  h.events.add(continuous, 100)
  assert.equal(h.events.hasDispatchableWork(), false)
  h.clock.advance(0)
  assert.equal(readiness.at(-1), true)
  const outer = token(h.scheduled[0]!.operation())
  assert.equal(h.next(outer), true)
  const first = h.callback(outer)
  assert.deepEqual(first.args, [0n])
  h.clock.advance(10)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.equal(readiness.at(-1), false)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  h.post(20)
  const nested = token(h.events.beginNested())
  assert.equal(h.next(nested), true)
  assert.equal(h.callback(nested).callback.id, 20)
  h.done(nested)
  assert.equal(h.next(nested), false, 'A child may not acquire the active continuous walk')
  h.end(nested)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.throws(() => h.next(outer), /Previous event has not completed/)
  h.done(outer)
  assert.equal(h.next(outer), false)
  h.end(outer)
  // The child performed real work and reached the continuous stage. Native
  // TVP consumes that pending notification before rejecting continuous reentry.
  assert.equal(readiness.at(-1), false)
  assert.equal(h.clock.tasks.size, 1)
  h.clock.advance(10)
  assert.equal(readiness.at(-1), true)
  const nextTick = token(h.events.beginNested())
  assert.equal(h.next(nextTick), true)
  const second = h.callback(nextTick)
  assert.deepEqual(second.callback, first.callback)
  assert.deepEqual(second.args, [20n])
  h.events.remove(continuous)
  h.done(nextTick)
  assert.equal(h.next(nextTick), false)
  h.end(nextTick)
  assert.equal(h.events.hasDispatchableWork(), false)
  // Self-removal leaves a native-style tombstone until the next empty walk.
  h.clock.advance(10)
  const cleanup = token(h.events.beginNested())
  assert.equal(h.next(cleanup), false)
  h.end(cleanup)
  assert.equal(h.clock.tasks.size, 0)
})

test('setDisabled(false) retains its native consume-before-continuous-reentry behavior', async (t) => {
  const h = setup()
  t.after(h.dispose)
  const continuous = object(50)
  h.events.add(continuous, 100)
  h.clock.advance(0)
  const outer = token(h.scheduled[0]!.operation())
  assert.equal(h.next(outer), true)
  h.clock.advance(10)
  assert.equal(h.events.hasDispatchableWork(), false)
  const nested = token(h.events.setDisabled(false))
  assert.equal(h.next(nested), false)
  h.end(nested)
  h.done(outer)
  assert.equal(h.next(outer), false)
  h.end(outer)
  assert.equal(h.events.hasDispatchableWork(), false)
  assert.equal(h.clock.tasks.size, 1)
  h.clock.advance(10)
  assert.equal(h.events.hasDispatchableWork(), true)
  const future = token(h.events.beginNested())
  assert.equal(h.next(future), true)
  assert.deepEqual(h.callback(future).args, [20n])
  h.events.remove(continuous)
  h.done(future)
  assert.equal(h.next(future), false)
  h.end(future)
  h.clock.advance(10)
  const cleanup = token(h.events.beginNested())
  assert.equal(h.next(cleanup), false)
  h.end(cleanup)
  assert.equal(h.clock.tasks.size, 0)
})

test('source cancellation and predicate invalidation settle child jobs without invoking callbacks', async (t) => {
  const h = setup()
  t.after(h.dispose)
  h.post(10)
  const outer = token(h.scheduled[0]!.operation())
  assert.equal(h.next(outer), true)
  const source = {},
    taken: number[] = []
  let live = true
  h.post(20, {
    source,
    onTaken: () => {
      taken.push(20)
    },
  })
  h.post(21, {
    valid: () => live,
    onTaken: () => {
      taken.push(21)
    },
  })
  h.events.cancelSource(source)
  const nested = token(h.events.beginNested())
  assert.equal(h.next(nested), true)
  live = false
  assert.deepEqual(h.call(nested), { kind: 'value', value: undefined })
  h.events.host('System.eventInvalid', [nested])
  assert.equal(h.next(nested), false)
  h.end(nested)
  h.done(outer)
  assert.equal(h.next(outer), false)
  h.end(outer)
  await Promise.resolve()
  assert.deepEqual(taken, [20, 21])
  assert.deepEqual(h.completed, [20, 21, 10])
})

test('pending observers may detach each other and failed observers cannot orphan a posted job', async (t) => {
  const h = setup({ reportThrows: true })
  t.after(h.dispose)
  let failures = 0,
    removed = 0,
    active = 0
  const stopFailed = h.events.subscribePending(() => {
    failures++
    throw new Error('wake failed')
  })
  let stopRemoved = () => {}
  const stopSelf = h.events.subscribePending(() => {
    stopRemoved()
    stopSelf()
  })
  stopRemoved = h.events.subscribePending(() => {
    removed++
  })
  h.events.subscribePending(() => {
    active++
  })
  assert.doesNotThrow(() => h.post(10))
  assert.equal(failures, 1)
  assert.equal(removed, 0)
  assert.equal(active, 1)
  const round = token(h.events.beginNested())
  assert.equal(h.next(round), true)
  h.done(round)
  assert.equal(h.next(round), false)
  h.end(round)
  await Promise.resolve()
  assert.deepEqual(h.completed, [10])
  assert.equal(failures, 1)
  assert.equal(removed, 0)
  assert.deepEqual(h.reports, [{ message: 'Error: wake failed', handled: false }])
  stopFailed()
  h.events.dispose()
  const afterDisposal = active
  h.events.subscribePending(() => {
    active++
  })
  h.events.cancelSource({})
  h.events.pause()
  h.events.resume()
  assert.equal(active, afterDisposal)
  assert.equal(h.events.hasDispatchableWork(), false)
})

test('disposal rejects outer, nested and queued jobs once and detaches readiness observers', async (t) => {
  const h = setup()
  t.after(h.dispose)
  const readiness: boolean[] = []
  const unsubscribe = h.events.subscribePending(() => {
    readiness.push(h.events.hasDispatchableWork())
  })
  h.post(10)
  const outer = token(h.scheduled[0]!.operation())
  assert.equal(h.next(outer), true)
  h.post(20)
  const nested = token(h.events.beginNested())
  assert.equal(h.next(nested), true)
  h.post(21)
  h.events.add(object(50), 100)
  h.events.dispose()
  assert.equal(readiness.at(-1), false)
  assert.equal(h.leases.size, 0)
  assert.equal(h.clock.tasks.size, 0)
  assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  assert.throws(() => h.done(outer), /round has ended/)
  assert.throws(() => h.done(nested), /round has ended/)
  await Promise.resolve()
  assert.deepEqual(h.rejected.map(({ id }) => id).sort(), [10, 20, 21])
  assert(h.rejected.every(({ error }) => error instanceof Error && error.name === 'AbortError'))
  assert.deepEqual(h.completed, [])
  const notifications = readiness.length
  unsubscribe()
  h.events.dispose()
  assert.equal(readiness.length, notifications)
})

test('nested entry enforces the existing depth limit without allocating empty rounds', async (t) => {
  const h = setup()
  t.after(h.dispose)
  for (let i = 0; i < 100; i++)
    assert.deepEqual(h.events.beginNested(), { kind: 'value', value: undefined })
  h.post(10)
  const rounds = Array.from({ length: 64 }, () => token(h.events.beginNested()))
  assert.equal(new Set(rounds).size, 64)
  assert.throws(() => h.events.beginNested(), /nesting limit exceeded/)
  for (const round of rounds.reverse()) h.end(round)
  await Promise.resolve()
  assert.equal(h.scheduled.length, 1)
  assert.equal(h.events.hasDispatchableWork(), true)
})
