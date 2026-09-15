import test from 'node:test'
import assert from 'node:assert/strict'
import {
  SystemEvents,
  type EventOptions,
  type EventOutcome,
} from '../../src/engine/scheduler/system-events.ts'
import type { HostReply, ScriptObject, ScriptRuntime } from '../../src/engine/script/runtime.ts'

const object = (id: number): ScriptObject => ({ type: 'object', runtime: 1, id })
function roundToken(reply: HostReply): number {
  assert.equal(reply.kind, 'invoke')
  if (reply.kind !== 'invoke') throw new Error('Expected an event round')
  return Number(reply.args[0])
}

function setup(
  options: {
    executeFailure?: 'throw' | 'reject'
    reportThrows?: boolean
    releaseFailures?: ReadonlyMap<number, Error>
  } = {},
) {
  const leases = new Set<number>(),
    wakes = new Set<() => void>()
  const operations: (() => HostReply)[] = [],
    finishes: (() => void)[] = []
  const reports: string[] = []
  const releaseAttempts: number[] = []
  const pending: Promise<unknown>[] = []
  const settlements: { id: number; outcome: EventOutcome; round?: number }[] = []
  let next = 1000
  const objects = {
    retain(_value: ScriptObject) {
      const id = next++
      leases.add(id)
      return object(id)
    },
    release(value: ScriptObject) {
      releaseAttempts.push(value.id)
      assert(leases.delete(value.id), 'Double native lease release')
      const error = options.releaseFailures?.get(value.id)
      if (error) throw error
    },
    objectIdentity(value: ScriptObject) {
      return String(value.id)
    },
  } as ScriptRuntime
  const dispatchError = new Error('VM dispatch rejected')
  const events = new SystemEvents(
    objects,
    {
      now: () => 0,
      schedule(callback) {
        wakes.add(callback)
        return () => {
          wakes.delete(callback)
        }
      },
    },
    (operation) => {
      operations.push(operation)
      if (options.executeFailure === 'throw') throw dispatchError
      if (options.executeFailure === 'reject') return Promise.reject(dispatchError)
      return new Promise<void>((resolve) => {
        finishes.push(resolve)
      })
    },
    () => {},
    (message) => {
      reports.push(message)
      if (options.reportThrows) throw new Error('Error reporting also failed')
    },
  )
  events.host('System.bindEvents', [object(1)])
  const track = <T>(promise: Promise<T>) => {
    pending.push(promise.catch(() => {}))
    return promise
  }
  const enqueue = (id: number, options: EventOptions = {}, prepare?: () => HostReply) => {
    const onSettled = options.onSettled
    const admission = events.enqueue(
      prepare ?? (() => ({ kind: 'invoke', callback: object(id), args: [] })),
      {
        ...options,
        onSettled(outcome, round) {
          settlements.push({ id, outcome, round })
          onSettled?.(outcome, round)
        },
      },
    )
    track(admission.completion)
    return admission
  }
  const begin = () => roundToken(events.beginNested())
  const host = (operation: string, round: number) =>
    events.host(`System.event${operation}`, [BigInt(round)])
  const take = (round: number) => {
    const reply = host('Next', round)
    assert.equal(reply.kind, 'value')
    return reply.kind === 'value' && reply.value === 1n
  }
  const cleanup = async () => {
    events.dispose()
    for (const finish of finishes) finish()
    await Promise.all(pending)
    assert.equal(leases.size, 0)
    assert.equal(wakes.size, 0)
  }
  return {
    events,
    leases,
    wakes,
    operations,
    reports,
    releaseAttempts,
    settlements,
    dispatchError,
    track,
    enqueue,
    begin,
    host,
    take,
    cleanup,
  }
}

test('accepted events synchronously settle once before their completion Promise resumes', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  const order: string[] = []
  const admission = h.enqueue(10, {
    onTaken: () => {
      order.push('taken')
    },
    onSettled: () => {
      order.push('settled')
    },
  })
  assert.equal(admission.status, 'accepted')
  const completed = admission.completion.then(() => {
    order.push('promise')
  })
  assert.deepEqual(order, [])
  const round = h.begin()
  assert.equal(h.take(round), true)
  assert.deepEqual(order, ['taken'])
  const call = h.host('Call', round)
  assert.equal(call.kind, 'invoke')
  if (call.kind === 'invoke') assert.equal(call.statusOnly, true)
  h.host('Done', round)
  assert.deepEqual(order, ['taken', 'settled'])
  assert.deepEqual(h.settlements, [{ id: 10, outcome: { kind: 'delivered' }, round }])
  h.host('Done', round)
  h.host('Invalid', round)
  h.host('Failed', round)
  assert.equal(h.take(round), false)
  h.host('End', round)
  assert.equal(h.settlements.length, 1)
  await completed
  assert.deepEqual(order, ['taken', 'settled', 'promise'])
})

test('disabled discard is explicit and owns synchronous cleanup without a round', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  h.events.setDisabled(true)
  let taken = 0,
    prepared = 0,
    released = 0
  const admission = h.enqueue(
    10,
    {
      discardable: true,
      onTaken: () => {
        taken++
      },
      onSettled: () => {
        released++
      },
    },
    () => {
      prepared++
      return { kind: 'value', value: undefined }
    },
  )
  assert.equal(admission.status, 'discarded')
  assert.equal(taken, 1)
  assert.equal(released, 1)
  assert.equal(prepared, 0)
  assert.equal(h.operations.length, 0)
  assert.deepEqual(h.settlements, [
    { id: 10, outcome: { kind: 'dropped', reason: 'disabled' }, round: undefined },
  ])
  await admission.completion
})

test('disposed admission throws before ownership while post preserves Promise rejection', async () => {
  const h = setup()
  h.events.dispose()
  let settlements = 0
  const options = {
    onSettled: () => {
      settlements++
    },
  }
  const prepare = (): HostReply => ({ kind: 'value', value: undefined })
  assert.throws(() => h.events.enqueue(prepare, options), { name: 'AbortError' })
  let rejected!: Promise<void>
  assert.doesNotThrow(() => {
    rejected = h.events.post(prepare, options)
  })
  await assert.rejects(rejected, { name: 'AbortError' })
  assert.equal(settlements, 0)
  await h.cleanup()
})

test('queue budget rejection keeps new ownership with the caller and replacement makes space', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  const source = {},
    prepare = (): HostReply => ({ kind: 'value', value: undefined })
  const original = h.enqueue(10, { source })
  for (let i = 0; i < 65535; i++) h.track(h.events.enqueue(prepare).completion)
  let rejectedHook = 0
  const options = {
    onSettled: () => {
      rejectedHook++
    },
  }
  assert.throws(() => h.events.enqueue(prepare, options), /Event queue budget exceeded/)
  await assert.rejects(h.events.post(prepare, options), /Event queue budget exceeded/)
  assert.equal(rejectedHook, 0)
  const replacement = h.enqueue(11, { source, replace: true })
  assert.equal(replacement.status, 'accepted')
  assert.deepEqual(h.settlements, [
    { id: 10, outcome: { kind: 'dropped', reason: 'source' }, round: undefined },
  ])
  await original.completion
  h.events.dispose()
  await assert.rejects(replacement.completion, { name: 'AbortError' })
  assert.equal(rejectedHook, 0)
})

test('source cancellation detaches its batch before hooks post or cancel more work', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  const first = {},
    other = {}
  const taken: number[] = []
  let added: ReturnType<typeof h.enqueue> | undefined
  h.enqueue(10, {
    source: first,
    onTaken: () => {
      taken.push(10)
    },
    onSettled: () => {
      added = h.enqueue(13, { source: first })
      h.events.cancelSource(other)
    },
  })
  h.enqueue(11, {
    source: first,
    onTaken: () => {
      taken.push(11)
    },
  })
  h.enqueue(12, {
    source: other,
    onTaken: () => {
      taken.push(12)
    },
  })
  h.events.cancelSource(first)
  assert.deepEqual(
    h.settlements.map(({ id }) => id),
    [10, 12, 11],
  )
  assert.deepEqual(taken, [10, 12, 11])
  assert(
    h.settlements.every((entry) => entry.round === undefined && entry.outcome.kind === 'dropped'),
  )
  assert(added)
  const round = h.begin()
  assert.equal(h.take(round), true)
  const reply = h.host('Call', round)
  assert.equal(reply.kind, 'invoke')
  if (reply.kind === 'invoke') assert.equal(reply.callback.id, 13)
  h.host('Done', round)
  assert.equal(h.take(round), false)
  h.host('End', round)
  await added.completion
  assert.deepEqual(h.settlements.at(-1), { id: 13, outcome: { kind: 'delivered' }, round })
})

test('all invalid jobs skipped by one eventNext publish settlement against the same round', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  h.enqueue(10, { valid: () => false })
  h.enqueue(11, { valid: () => false })
  h.enqueue(12)
  const round = h.begin()
  assert.equal(h.take(round), true)
  assert.deepEqual(h.settlements, [
    { id: 10, outcome: { kind: 'invalid' }, round },
    { id: 11, outcome: { kind: 'invalid' }, round },
  ])
  // These records already exist before eventNext returns to the native caller.
  h.host('Done', round)
  assert.equal(h.take(round), false)
  h.host('End', round)
  assert.deepEqual(
    h.settlements.map(({ id }) => id),
    [10, 11, 12],
  )
})

test('late invalidation settles once and retains the input exclusive-event boundary', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  let live = true
  h.enqueue(10, { priority: 1, valid: () => live })
  const round = h.begin()
  assert.equal(h.take(round), true)
  h.enqueue(11, { priority: 0 })
  live = false
  assert.deepEqual(h.host('Call', round), { kind: 'value', value: undefined })
  assert.deepEqual(h.settlements, [{ id: 10, outcome: { kind: 'invalid' }, round }])
  h.host('Done', round)
  h.host('Invalid', round)
  assert.equal(h.take(round), false)
  h.host('End', round)
  const later = h.begin()
  assert.equal(h.take(later), true)
  h.host('Done', later)
  assert.equal(h.take(later), false)
  h.host('End', later)
  assert.equal(h.settlements.filter(({ id }) => id === 10).length, 1)
})

for (const phase of ['onTaken', 'valid'] as const)
  test(`a throwing ${phase} cannot strand the job removed from the queue`, async (t) => {
    const h = setup()
    t.after(h.cleanup)
    const failure = new Error(`${phase} failed`)
    let taken = 0,
      valid = 0
    const admission = h.enqueue(10, {
      onTaken: () => {
        taken++
        if (phase === 'onTaken') throw failure
      },
      valid: () => {
        valid++
        throw failure
      },
    })
    h.enqueue(11)
    const round = h.begin()
    assert.throws(
      () => h.take(round),
      (error) => error === failure,
    )
    assert.equal(taken, 1)
    assert.equal(valid, phase === 'valid' ? 1 : 0)
    assert.deepEqual(h.settlements, [
      { id: 10, outcome: { kind: 'aborted', error: failure }, round },
    ])
    await assert.rejects(admission.completion, (error) => error === failure)
    h.host('End', round)
    assert.equal(h.settlements.length, 1)
    const later = h.begin()
    assert.equal(h.take(later), true)
    h.host('Done', later)
    assert.equal(h.take(later), false)
    h.host('End', later)
  })

test('eventFailed resolves the old body promise but exposes failed settlement before error handling', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  const failure = new Error('prepare callback failed')
  const admission = h.enqueue(10, {}, () => {
    throw failure
  })
  const round = h.begin()
  assert.equal(h.take(round), true)
  assert.throws(
    () => h.host('Call', round),
    (error) => error === failure,
  )
  h.host('Failed', round)
  assert.deepEqual(h.settlements, [{ id: 10, outcome: { kind: 'failed' }, round }])
  assert.deepEqual(h.reports, [], 'The script exception handler has not reported its decision yet')
  await admission.completion
  h.events.report('handled script exception', true)
  h.host('End', round)
  assert.equal(h.settlements.length, 1)
})

test('round abort rejects the current job once without cancelling later queued events', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  const first = h.enqueue(10)
  const round = h.begin()
  assert.equal(h.take(round), true)
  h.enqueue(11)
  h.host('End', round)
  assert.equal(h.settlements.length, 1)
  assert.equal(h.settlements[0]!.round, round)
  assert.equal(h.settlements[0]!.outcome.kind, 'aborted')
  await assert.rejects(first.completion, /System event round aborted/)
  const later = h.begin()
  assert.equal(h.take(later), true)
  h.host('Done', later)
  assert.equal(h.take(later), false)
  h.host('End', later)
})

test('throwing settlement and accounting hooks do not interrupt the remaining cancellation cleanup', async (t) => {
  const h = setup({ reportThrows: true })
  t.after(h.cleanup)
  const source = {}
  let released = 0
  h.enqueue(10, {
    source,
    onTaken: () => {
      throw new Error('accounting failed')
    },
    onSettled: () => {
      released++
      throw new Error('settlement failed')
    },
  })
  h.enqueue(11, {
    source,
    onSettled: () => {
      released++
    },
  })
  assert.doesNotThrow(() => h.events.cancelSource(source))
  assert.equal(released, 2)
  assert.equal(h.settlements.length, 2)
  assert(h.settlements.every(({ outcome }) => outcome.kind === 'dropped'))
  assert.deepEqual(h.reports, ['Error: accounting failed', 'Error: settlement failed'])
  h.events.cancelSource(source)
  h.events.dispose()
  assert.equal(released, 2)
})

test('dispose detaches every round and queue before reentrant settlement hooks run', async (t) => {
  const h = setup()
  t.after(h.cleanup)
  let rejectedOwnership = 0
  const first = h.enqueue(10, {
    onSettled: () => {
      h.events.dispose()
      assert.throws(
        () =>
          h.events.enqueue(() => ({ kind: 'value', value: undefined }), {
            onSettled: () => {
              rejectedOwnership++
            },
          }),
        { name: 'AbortError' },
      )
      assert.equal(h.events.hasDispatchableWork(), false)
    },
  })
  const outer = h.begin()
  assert.equal(h.take(outer), true)
  const second = h.enqueue(11)
  const nested = h.begin()
  assert.equal(h.take(nested), true)
  const queued = h.enqueue(12)
  h.events.add(object(50), 100)
  h.events.dispose()
  assert.equal(h.settlements.length, 3)
  assert.equal(h.settlements.find(({ id }) => id === 10)!.round, outer)
  assert.equal(h.settlements.find(({ id }) => id === 11)!.round, nested)
  assert.equal(h.settlements.find(({ id }) => id === 12)!.round, undefined)
  assert(h.settlements.every(({ outcome }) => outcome.kind === 'disposed'))
  assert.equal(rejectedOwnership, 0)
  assert.equal(h.leases.size, 0)
  assert.equal(h.wakes.size, 0)
  assert.deepEqual(h.reports, [])
  await Promise.all(
    [first, second, queued].map(({ completion }) =>
      assert.rejects(completion, { name: 'AbortError' }),
    ),
  )
  h.events.dispose()
  assert.equal(h.settlements.length, 3)
})

test('failed and invalid continuous events detach before propagating native release failures', async (t) => {
  for (const operation of ['Failed', 'Invalid']) {
    const releaseFailure = new Error(`${operation} continuous lease release failed`)
    const h = setup({ releaseFailures: new Map([[1001, releaseFailure]]) })
    t.after(h.cleanup)
    h.events.add(object(50), 100)
    h.events.add(object(51), 100)
    const wake = [...h.wakes][0]!
    h.wakes.delete(wake)
    wake()
    const round = h.begin()
    assert.equal(h.take(round), true)
    const call = h.host('Call', round)
    assert.equal(call.kind, 'invoke')
    if (call.kind === 'invoke') assert.equal(call.callback.id, 1001)
    let notifications = 0
    h.events.subscribePending(() => {
      notifications++
    })
    assert.throws(
      () => h.host(operation, round),
      (error) => error === releaseFailure,
    )
    assert.equal(h.events.has(object(50)), false)
    assert.equal(h.events.has(object(51)), true)
    assert(notifications > 0, 'Pending observers must wake even when native release throws')
    assert.deepEqual(h.reports, [], 'Internal resource failures must propagate to the caller')
    assert.deepEqual(h.releaseAttempts, [1001])
    // A release may consume its lease and still throw. Neither duplicate host
    // completion nor explicit removal may retry that now-detached reference.
    h.host(operation, round)
    h.host('Done', round)
    h.events.remove(object(50))
    assert.deepEqual(h.releaseAttempts, [1001])
    assert.equal(h.take(round), true, 'The failed current job must no longer block this round')
    const next = h.host('Call', round)
    assert.equal(next.kind, 'invoke')
    if (next.kind === 'invoke') assert.equal(next.callback.id, 1002)
    h.host('Done', round)
    assert.equal(h.take(round), false)
    h.host('End', round)
    h.events.dispose()
    assert.deepEqual(h.releaseAttempts, [1001, 1002, 1000])
    assert.equal(h.leases.size, 0)
    assert.equal(h.wakes.size, 0)
    assert.doesNotThrow(() => h.events.dispose())
    assert.deepEqual(h.releaseAttempts, [1001, 1002, 1000])
  }
})

test('dispose attempts every resource release and propagates original failures after waiter cleanup', async (t) => {
  for (const multiple of [false, true]) {
    const firstFailure = new Error('First continuous lease release failed')
    const pumpFailure = new Error('Pump lease release failed')
    const releaseFailures = new Map([[1001, firstFailure]])
    if (multiple) releaseFailures.set(1000, pumpFailure)
    const h = setup({ releaseFailures })
    t.after(h.cleanup)
    const first = h.enqueue(10)
    const round = h.begin()
    assert.equal(h.take(round), true)
    const queued = h.enqueue(11)
    h.events.add(object(50), 100)
    h.events.add(object(51), 100)
    const readiness: boolean[] = []
    h.events.subscribePending(() => {
      readiness.push(h.events.hasDispatchableWork())
    })
    assert.throws(
      () => h.events.dispose(),
      (error) => {
        if (!multiple) return error === firstFailure
        assert(error instanceof AggregateError)
        assert.deepEqual(error.errors, [firstFailure, pumpFailure])
        return true
      },
    )
    assert.deepEqual(h.releaseAttempts, [1001, 1002, 1000])
    assert.equal(h.leases.size, 0)
    assert.equal(h.wakes.size, 0)
    assert.deepEqual(readiness, [false])
    assert.deepEqual(h.reports, [], 'Resource failures must reach the disposer, not only logging')
    assert.equal(h.settlements.length, 2)
    assert(h.settlements.every(({ outcome }) => outcome.kind === 'disposed'))
    await Promise.all(
      [first, queued].map(({ completion }) => assert.rejects(completion, { name: 'AbortError' })),
    )
    assert.doesNotThrow(() => h.events.dispose())
    h.events.cancelSource({})
    assert.deepEqual(h.releaseAttempts, [1001, 1002, 1000])
    assert.deepEqual(
      readiness,
      [false],
      'Disposal must detach the pending observers before throwing',
    )
  }
})

for (const executeFailure of ['throw', 'reject'] as const)
  test(`a dispatcher ${executeFailure} aborts an accepted job without making admission ambiguous`, async (t) => {
    const h = setup({ executeFailure })
    t.after(h.cleanup)
    let admission!: ReturnType<typeof h.enqueue>
    assert.doesNotThrow(() => {
      admission = h.enqueue(10)
    })
    assert.equal(admission.status, 'accepted')
    await assert.rejects(admission.completion, (error) => error === h.dispatchError)
    assert.deepEqual(h.settlements, [
      { id: 10, outcome: { kind: 'aborted', error: h.dispatchError }, round: undefined },
    ])
    assert.equal(h.events.disabled, true)
    assert.equal(h.events.hasDispatchableWork(), false)
    assert.equal(h.operations.length, 1)
    assert.deepEqual(h.reports, ['Error: VM dispatch rejected'])
  })
