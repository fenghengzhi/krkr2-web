import test from 'node:test'
import assert from 'node:assert/strict'
import { ModalLoop, type ModalLoopDependencies } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type {
  HostContext,
  HostReply,
  ScriptObject,
  ScriptValue,
} from '../../src/engine/script/runtime.ts'

const object = (id: number): ScriptObject => ({ type: 'object', id, runtime: 1 })
const empty: HostReply = { kind: 'value', value: undefined }

function fixture(hooks: Partial<ModalLoopDependencies> = {}) {
  let next = 1000,
    changes = 0,
    reads = 0,
    dispatches = 0
  const retained: ScriptObject[] = [],
    released: ScriptObject[] = [],
    leases = new Set<number>(),
    control = new ExecutionControl(),
    faults: { retain?: Error; release?: Error } = {},
    work = { available: false },
    continuation: HostReply = { kind: 'invoke', callback: object(900), args: [1n] }
  const objects: HostContext = {
    retain(source) {
      if (faults.retain) throw faults.retain
      retained.push(source)
      const lease = object(next++)
      leases.add(lease.id)
      return lease
    },
    release(lease) {
      assert.equal(leases.delete(lease.id), true, 'A pump lease must be released once')
      released.push(lease)
      if (faults.release) throw faults.release
    },
    snapshot() {
      throw new Error('Modal bookkeeping must not copy script objects')
    },
  }
  const loop = new ModalLoop(objects, control, {
    hasWork() {
      reads++
      return hooks.hasWork?.() ?? work.available
    },
    dispatch() {
      dispatches++
      return hooks.dispatch?.() ?? continuation
    },
    changed(phase) {
      changes++
      hooks.changed?.(phase)
    },
  })
  return {
    loop,
    control,
    faults,
    leases,
    retained,
    released,
    work,
    continuation,
    counts: () => ({ changes, reads, dispatches }),
    bind: (pump = object(1)) => loop.host('Modal.bind', [pump]),
    host: (operation: string, token: number) => loop.host(operation, [BigInt(token)]),
  }
}

function watch<T>(promise: Promise<T>) {
  let settled = false
  void promise.then(
    () => {
      settled = true
    },
    () => {
      settled = true
    },
  )
  return { result: promise, settled: () => settled }
}

async function checkpoint() {
  await Promise.resolve()
  await Promise.resolve()
}

function errors(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(errors) : [error]
}

function assertErrors(error: unknown, expected: unknown[]): void {
  const actual = errors(error)
  assert.equal(actual.length, expected.length)
  actual.forEach((value, index) => assert.equal(value, expected[index]))
}

test('a bound modal pump owns one native lease across every scope and releases it once at shutdown', async () => {
  const f = fixture(),
    pump = object(7)
  assert.throws(() => f.loop.open({ kind: 'window', ownerId: 10 }), /unavailable/)
  await assert.rejects(f.loop.host('Modal.bind', [null]), /callable/)
  assert.equal(f.leases.size, 0)
  await f.bind(pump)
  const parent = f.loop.open({ kind: 'window', ownerId: 10 }),
    first = f.loop.invoke(parent),
    child = f.loop.open({ kind: 'menu', ownerId: 20, windowId: 10 }),
    second = f.loop.invoke(child)
  assert.equal(first.kind, 'invoke')
  assert.equal(second.kind, 'invoke')
  if (first.kind !== 'invoke' || second.kind !== 'invoke')
    throw new Error('Expected modal continuations')
  assert.deepEqual(first.args, [BigInt(parent)])
  assert.deepEqual(second.args, [BigInt(child)])
  assert.equal(first.callback, second.callback)
  assert.notEqual(first.callback, pump)
  assert.deepEqual(f.retained, [pump])
  assert.equal(f.leases.size, 1)
  assert.equal(
    f.counts().dispatches,
    0,
    'Opening and invoking return continuations without executing them',
  )
  f.loop.release(child)
  f.loop.release(parent)
  assert.equal(f.leases.size, 1)
  f.loop.dispose()
  f.loop.dispose()
  assert.equal(f.leases.size, 0)
  assert.equal(f.released.length, 1)
})

test('pump rebinding preserves the new lease if releasing the old binding reports an error', async () => {
  const f = fixture(),
    failure = new Error('old pump release failed')
  await f.bind(object(1))
  f.faults.retain = new Error('replacement retain failed')
  await assert.rejects(f.bind(object(2)), (error) => error === f.faults.retain)
  assert.equal(f.leases.size, 1)
  delete f.faults.retain
  f.faults.release = failure
  await assert.rejects(f.bind(object(3)), (error) => error === failure)
  assert.equal(f.leases.size, 1)
  const token = f.loop.open({ kind: 'window', ownerId: 5 }),
    reply = f.loop.invoke(token)
  assert.equal(reply.kind, 'invoke')
  if (reply.kind === 'invoke') assert.equal(f.leases.has(reply.callback.id), true)
  delete f.faults.release
  f.loop.dispose()
  assert.equal(f.leases.size, 0)
  assert.equal(f.released.length, 2)
})

test('modal continuations enter once and unwind strictly inside-out without disturbing the blocked parent', async () => {
  const cleanup: string[] = [],
    f = fixture()
  await f.bind()
  const parent = f.loop.open({ kind: 'window', ownerId: 11, cleanup: () => cleanup.push('parent') })
  await assert.rejects(f.host('Modal.wait', parent), /not active/)
  f.loop.invoke(parent)
  const child = f.loop.open({
    kind: 'menu',
    ownerId: 22,
    windowId: 11,
    cleanup: () => cleanup.push('child'),
  })
  assert.throws(() => f.loop.invoke(parent), /current scope exactly once/)
  f.loop.invoke(child)
  assert.throws(() => f.loop.invoke(child), /exactly once/)
  assert.throws(() => f.loop.release(parent), /LIFO/)
  assert.equal(f.loop.depth, 2)
  assert.deepEqual(cleanup, [])
  f.loop.finish(child, 42n)
  assert.deepEqual(await f.host('Modal.wait', child), { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', child), { kind: 'value', value: 42n })
  await f.host('Modal.end', child)
  assert.equal(f.loop.modalWindowId, 11)
  assert.deepEqual(cleanup, ['child'])
  assert.throws(() => f.loop.invoke(parent), /exactly once/)
  f.loop.finish(parent)
  await f.host('Modal.wait', parent)
  await f.host('Modal.end', parent)
  assert.deepEqual(cleanup, ['child', 'parent'])
  assert.equal(f.loop.depth, 0)
  f.loop.dispose()
})

test('waiting observes readiness and notifications without taking work or dispatching a callback', async () => {
  const f = fixture()
  await f.bind()
  const token = f.loop.open({ kind: 'window', ownerId: 4 })
  f.loop.invoke(token)
  const waiting = watch(f.host('Modal.wait', token))
  assert.equal(f.loop.pendingWaits, 1)
  assert.equal(f.counts().reads, 1)
  f.loop.notify()
  await checkpoint()
  assert.equal(waiting.settled(), false)
  assert.equal(f.counts().dispatches, 0)
  f.work.available = true
  f.loop.notify()
  assert.deepEqual(await waiting.result, { kind: 'value', value: 1n })
  assert.equal(f.loop.pendingWaits, 0)
  assert.equal(f.counts().dispatches, 0)
  await assert.rejects(f.host('Modal.result', token), /not ready/)
  assert.equal(await f.host('Modal.dispatch', token), f.continuation)
  assert.equal(f.counts().dispatches, 1)
  f.loop.dispose()
})

test('dispatch rechecks a finished scope after an earlier work notification', async () => {
  const f = fixture()
  await f.bind()
  const token = f.loop.open({ kind: 'menu', ownerId: 8 })
  f.loop.invoke(token)
  f.work.available = true
  assert.deepEqual(await f.host('Modal.wait', token), { kind: 'value', value: 1n })
  assert.equal(f.loop.finish(token, 21n), true)
  assert.deepEqual(await f.host('Modal.dispatch', token), empty)
  assert.equal(f.counts().dispatches, 0)
  assert.deepEqual(await f.host('Modal.wait', token), { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', token), { kind: 'value', value: 21n })
  assert.equal(f.loop.cancel(token), false, 'The first terminal result wins')
  f.loop.dispose()
})

test('pause suppresses dispatch of previously announced work and resume wakes a pending modal wait', async () => {
  const f = fixture()
  await f.bind()
  const token = f.loop.open({ kind: 'window', ownerId: 8 })
  f.loop.invoke(token)
  f.work.available = true
  await f.host('Modal.wait', token)
  f.loop.setPaused(true)
  assert.deepEqual(await f.host('Modal.dispatch', token), empty)
  const reads = f.counts().reads,
    waiting = watch(f.host('Modal.wait', token))
  f.loop.notify()
  await checkpoint()
  assert.equal(waiting.settled(), false)
  assert.equal(f.counts().reads, reads)
  assert.equal(f.counts().dispatches, 0)
  f.loop.setPaused(false)
  assert.deepEqual(await waiting.result, { kind: 'value', value: 1n })
  assert.equal(await f.host('Modal.dispatch', token), f.continuation)
  f.loop.dispose()
})

test('a nested popup keeps its parent Window blocked until every modal frame is released', async () => {
  const f = fixture()
  await f.bind()
  const parent = f.loop.open({ kind: 'window', ownerId: 10, windowId: 100 })
  f.loop.invoke(parent)
  const popup = f.loop.open({ kind: 'menu', ownerId: 20, windowId: 100 })
  f.loop.invoke(popup)
  assert.equal(f.loop.modalWindowId, 100)
  const child = f.loop.open({ kind: 'window', ownerId: 30, windowId: 300 })
  f.loop.invoke(child)
  f.loop.finish(child)
  assert.equal(f.loop.modalWindowId, 300)
  assert.deepEqual(await f.host('Modal.dispatch', parent), empty)
  f.loop.release(child)
  assert.equal(f.loop.modalWindowId, 100)
  f.loop.finish(parent)
  assert.equal(f.loop.modalWindowId, 100)
  await f.host('Modal.wait', popup)
  assert.deepEqual(await f.host('Modal.result', popup), { kind: 'value', value: 0n })
  f.loop.release(popup)
  assert.equal(f.loop.modalWindowId, 100)
  f.loop.release(parent)
  assert.equal(f.loop.modalWindowId, undefined)
  f.loop.dispose()
})

test('cancelOwner targets exact kind and owner identity while leaving ancestors live', async () => {
  const f = fixture()
  await f.bind()
  const parent = f.loop.open({ kind: 'window', ownerId: 7 })
  f.loop.invoke(parent)
  const child = f.loop.open({ kind: 'menu', ownerId: 7, windowId: 7 })
  f.loop.invoke(child)
  const parentWait = watch(f.host('Modal.wait', parent)),
    childWait = watch(f.host('Modal.wait', child))
  f.loop.cancelOwner('menu', 8, 'unrelated')
  await checkpoint()
  assert.equal(childWait.settled(), false)
  f.loop.cancelOwner('menu', 7, 'popup-dismissed')
  assert.deepEqual(await childWait.result, { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', child), { kind: 'value', value: 0n })
  assert.equal(parentWait.settled(), false)
  f.loop.release(child)
  await checkpoint()
  assert.equal(parentWait.settled(), false)
  f.loop.finish(parent, 'parent-kept-running')
  assert.deepEqual(await parentWait.result, { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', parent), {
    kind: 'value',
    value: 'parent-kept-running',
  })
  f.loop.dispose()
})

for (const kind of ['menu', 'window'] as const) {
  test(`${kind} cancellation exposes its native empty result and keeps the frame until end`, async () => {
    const f = fixture()
    await f.bind()
    const token = f.loop.open({ kind, ownerId: 5 })
    f.loop.invoke(token)
    const waiting = f.host('Modal.wait', token)
    f.loop.cancel(token, 'owner-closed')
    assert.deepEqual(await waiting, { kind: 'value', value: 0n })
    assert.deepEqual(await f.host('Modal.result', token), {
      kind: 'value',
      value: kind === 'menu' ? 0n : undefined,
    })
    assert.equal(f.loop.depth, 1)
    await f.host('Modal.end', token)
    assert.equal(f.loop.depth, 0)
    f.loop.dispose()
  })
}

test('completed modal values cross the host boundary as supported primitive ScriptValues', async () => {
  const f = fixture()
  await f.bind()
  for (const [value, expected] of [
    [true, 1n],
    [false, 0n],
    [null, null],
    ['chosen', 'chosen'],
    [2.5, 2.5],
    [12n, 12n],
    [undefined, undefined],
  ] as const) {
    const token = f.loop.open({ kind: 'menu', ownerId: 4 })
    f.loop.invoke(token)
    f.loop.finish(token, value)
    await f.host('Modal.wait', token)
    assert.deepEqual(await f.host('Modal.result', token), { kind: 'value', value: expected })
    f.loop.release(token)
  }
  assert.equal(f.retained.length, 1, 'Primitive results must not create native leases')
  f.loop.dispose()
})

test('releasing an awaited scope prevents its continuation from reinstalling stale result state', async () => {
  const f = fixture()
  await f.bind()
  const old = f.loop.open({ kind: 'window', ownerId: 4 })
  f.loop.invoke(old)
  const waiting = f.host('Modal.wait', old),
    rejected = assert.rejects(waiting, /scope has ended/)
  f.loop.release(old)
  await rejected
  assert.equal(f.loop.pendingWaits, 0)
  assert.equal(f.loop.info(old), undefined)
  await assert.rejects(f.host('Modal.result', old), /not active/)
  const next = f.loop.open({ kind: 'window', ownerId: 4 })
  assert.notEqual(next, old)
  f.loop.invoke(next)
  await assert.rejects(f.host('Modal.result', next), /not ready/)
  f.loop.dispose()
})

test('Stop retires nested scopes, rejects pending waits and releases the pump without relying on TJS cleanup', async () => {
  const cleanup: number[] = [],
    f = fixture()
  await f.bind()
  const parent = f.loop.open({ kind: 'window', ownerId: 1, cleanup: () => cleanup.push(1) })
  f.loop.invoke(parent)
  const child = f.loop.open({ kind: 'menu', ownerId: 2, cleanup: () => cleanup.push(2) })
  f.loop.invoke(child)
  const parentRejected = assert.rejects(f.host('Modal.wait', parent), /Execution cancelled/),
    childRejected = assert.rejects(f.host('Modal.wait', child), /Execution cancelled/)
  assert.equal(f.loop.pendingWaits, 2)
  f.control.cancel()
  f.loop.dispose()
  await Promise.all([parentRejected, childRejected])
  assert.deepEqual(cleanup, [2, 1])
  assert.equal(f.loop.depth, 0)
  assert.equal(f.loop.pendingWaits, 0)
  assert.equal(f.leases.size, 0)
  await f.host('Modal.end', child)
  await f.host('Modal.end', parent)
  f.loop.dispose()
  assert.equal(f.released.length, 1)
  assert.equal(f.counts().dispatches, 0)
})

test('disposing without cancelling the execution control also rejects a pending modal continuation', async () => {
  const f = fixture()
  await f.bind()
  const token = f.loop.open({ kind: 'window', ownerId: 1 })
  f.loop.invoke(token)
  const rejected = assert.rejects(f.host('Modal.wait', token), /scope has ended/)
  f.loop.dispose()
  await rejected
  assert.equal(f.control.cancelled, false)
  assert.equal(f.loop.info(token), undefined)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.loop.pendingWaits, 0)
  assert.equal(f.leases.size, 0)
  await assert.rejects(f.host('Modal.result', token), /unavailable/)
})

test('cleanup failures retire all scope identities and still release the modal pump', async () => {
  const parentFailure = new Error('window cleanup failed'),
    childFailure = new Error('menu cleanup failed'),
    pumpFailure = new Error('pump release failed'),
    cleanup: number[] = [],
    f = fixture()
  await f.bind()
  const parent = f.loop.open({
      kind: 'window',
      ownerId: 1,
      cleanup() {
        cleanup.push(1)
        throw parentFailure
      },
    }),
    child = f.loop.open({
      kind: 'menu',
      ownerId: 2,
      cleanup() {
        cleanup.push(2)
        throw childFailure
      },
    })
  f.faults.release = pumpFailure
  assert.throws(
    () => f.loop.dispose(),
    (error) => {
      assertErrors(error, [childFailure, parentFailure, pumpFailure])
      return true
    },
  )
  assert.deepEqual(cleanup, [2, 1])
  assert.equal(f.loop.info(parent), undefined)
  assert.equal(f.loop.info(child), undefined)
  assert.equal(f.loop.modalWindowId, undefined)
  assert.equal(f.leases.size, 0)
  assert.doesNotThrow(() => f.loop.dispose())
  assert.equal(f.released.length, 1)
})

test('a failed modal-open notification rolls back blocking and preserves opening and cleanup errors', async () => {
  const openingFailure = new Error('blocked presentation failed'),
    cleanupFailure = new Error('scope cleanup failed'),
    changedFailure = new Error('unblocked presentation failed')
  let fail = true,
    changes = 0,
    cleaned = 0
  const f = fixture({
    changed() {
      if (fail) throw ++changes === 1 ? openingFailure : changedFailure
    },
  })
  await f.bind()
  assert.throws(
    () =>
      f.loop.open({
        kind: 'window',
        ownerId: 8,
        cleanup() {
          cleaned++
          assert.equal(f.loop.depth, 0)
          assert.equal(f.loop.modalWindowId, undefined)
          throw cleanupFailure
        },
      }),
    (error) => {
      assertErrors(error, [openingFailure, cleanupFailure, changedFailure])
      return true
    },
  )
  assert.equal(cleaned, 1)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
  fail = false
  const replacement = f.loop.open({ kind: 'window', ownerId: 8 })
  f.loop.invoke(replacement)
  assert.equal(f.loop.modalWindowId, 8)
  f.loop.dispose()
  assert.equal(cleaned, 1)
  assert.equal(f.leases.size, 0)
})

test('invalid and stale tokens cannot operate on a replacement modal scope', async () => {
  const f = fixture()
  await f.bind()
  const old = f.loop.open({ kind: 'window', ownerId: 4 })
  f.loop.invoke(old)
  f.loop.release(old)
  const current = f.loop.open({ kind: 'menu', ownerId: 4 })
  f.loop.invoke(current)
  const invalid: ScriptValue[] = [
    0n,
    -1n,
    1.5,
    NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
    null,
    undefined,
    object(2),
  ]
  for (const token of invalid)
    for (const operation of ['Modal.wait', 'Modal.dispatch', 'Modal.result', 'Modal.end'])
      await assert.rejects(f.loop.host(operation, [token]), /Invalid modal scope token/)
  assert.throws(() => f.loop.invoke(old), /scope has ended/)
  for (const operation of ['Modal.wait', 'Modal.dispatch', 'Modal.result'])
    await assert.rejects(f.host(operation, old), /not active/)
  // End must remain harmless when a terminal disposer already removed a frame.
  await f.host('Modal.end', old)
  assert.equal(f.loop.depth, 1)
  assert.equal(f.loop.info(current)?.ownerId, 4)
  assert.equal(f.loop.finish(old, 1n), false)
  assert.equal(f.loop.cancel(old), false)
  f.loop.dispose()
})
