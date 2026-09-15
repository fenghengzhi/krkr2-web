import test from 'node:test'
import assert from 'node:assert/strict'
import { ModalScopes } from '../../src/engine/scheduler/modal-scopes.ts'

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function observe<T>(promise: Promise<T>) {
  let settled = false
  return {
    result: promise.then((value) => {
      settled = true
      return value
    }),
    settled: () => settled,
  }
}

async function checkpoint() {
  await Promise.resolve()
  await Promise.resolve()
}

test('modal scopes expose numeric ownership and dispatch only the innermost live frame', () => {
  const scopes = new ModalScopes()
  assert.equal(scopes.top, undefined)
  assert.equal(scopes.depth, 0)
  assert.equal(scopes.pendingWaits, 0)
  assert.equal(scopes.stopped, false)
  const parent = scopes.open({ kind: 'window', ownerId: 17, windowId: 17 }),
    child = scopes.open({ kind: 'menu', ownerId: 91, windowId: 17 })
  assert.ok(Number.isSafeInteger(parent) && parent > 0)
  assert.ok(child > parent)
  assert.equal(scopes.info(parent)?.parentToken, undefined)
  assert.deepEqual(scopes.info(child), {
    token: child,
    parentToken: parent,
    kind: 'menu',
    ownerId: 91,
    windowId: 17,
  })
  assert.equal(scopes.depth, 2)
  assert.equal(scopes.top, child)
  assert.equal(scopes.canDispatch(parent), false)
  assert.equal(scopes.canDispatch(child), true)
  scopes.setPaused(true)
  assert.equal(scopes.canDispatch(child), false)
  scopes.setPaused(false)
  assert.equal(scopes.canDispatch(child), true)
  assert.equal(scopes.finish(child), true)
  assert.equal(scopes.canDispatch(child), false)
  assert.equal(scopes.top, child, 'completion retains the frame until its caller unwinds')
  assert.equal(scopes.release(child), true)
  assert.equal(scopes.top, parent)
  assert.equal(scopes.canDispatch(parent), true)
  scopes.release(parent)
})

test('modal nesting uses a default bound and accepts the documented explicit limits', () => {
  const defaults = new ModalScopes()
  for (let index = 0; index < 16; index++) defaults.open({ kind: 'window', ownerId: index + 1 })
  const top = defaults.top
  assert.throws(() => defaults.open({ kind: 'menu', ownerId: 100 }))
  assert.equal(defaults.depth, 16)
  assert.equal(defaults.top, top)
  defaults.stop()

  const single = new ModalScopes({ maxDepth: 1 })
  single.open({ kind: 'menu', ownerId: 1 })
  assert.throws(() => single.open({ kind: 'window', ownerId: 2 }))
  assert.equal(single.depth, 1)
  single.stop()

  const maximum = new ModalScopes({ maxDepth: 64 })
  for (let index = 0; index < 64; index++) maximum.open({ kind: 'window', ownerId: index + 1 })
  assert.throws(() => maximum.open({ kind: 'menu', ownerId: 65 }))
  assert.equal(maximum.depth, 64)
  maximum.stop()
})

test('invalid modal depth and owner identities cannot mutate a live stack', () => {
  for (const maxDepth of [0, -1, 1.5, 65, NaN, Infinity])
    assert.throws(() => new ModalScopes({ maxDepth }))
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: Number.MAX_SAFE_INTEGER })
  for (const identity of [0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => scopes.open({ kind: 'menu', ownerId: identity }))
    assert.throws(() => scopes.open({ kind: 'menu', ownerId: 1, windowId: identity }))
    assert.equal(scopes.top, parent)
    assert.equal(scopes.depth, 1)
  }
  const child = scopes.open({ kind: 'menu', ownerId: 1, windowId: Number.MAX_SAFE_INTEGER })
  assert.equal(scopes.info(child)?.windowId, Number.MAX_SAFE_INTEGER)
  scopes.stop()
})

test('released modal tokens stay stale when their owner opens another scope', async () => {
  const scopes = new ModalScopes(),
    old = scopes.open({ kind: 'window', ownerId: 5 })
  scopes.release(old)
  const current = scopes.open({ kind: 'window', ownerId: 5 })
  assert.ok(current > old)
  assert.equal(scopes.info(old), undefined)
  assert.equal(scopes.canDispatch(old), false)
  assert.equal(scopes.finish(old, 1), false)
  assert.equal(scopes.cancel(old), false)
  assert.equal(scopes.release(old), false)
  await assert.rejects(scopes.wait(old, () => true))
  assert.equal(scopes.top, current)
  assert.equal(scopes.canDispatch(current), true)
  assert.equal(scopes.pendingWaits, 0)
  scopes.stop()
})

test('externally retained metadata cannot change modal identity or ancestry', () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    options = { kind: 'menu' as const, ownerId: 2, windowId: 1 },
    child = scopes.open(options),
    info = scopes.info(child)
  assert.ok(info)
  options.ownerId = 200
  options.windowId = 300
  Reflect.set(info, 'token', parent)
  Reflect.set(info, 'parentToken', undefined)
  Reflect.set(info, 'ownerId', 400)
  Reflect.set(info, 'windowId', 500)
  assert.deepEqual(scopes.info(child), {
    token: child,
    parentToken: parent,
    kind: 'menu',
    ownerId: 2,
    windowId: 1,
  })
  assert.equal(scopes.top, child)
  assert.equal(scopes.canDispatch(parent), false)
  scopes.stop()
})

test('an ended top must unwind before another modal scope can be opened', () => {
  for (const end of ['finish', 'cancel'] as const) {
    const scopes = new ModalScopes(),
      parent = scopes.open({ kind: 'window', ownerId: 1 }),
      child = scopes.open({ kind: 'menu', ownerId: 2 })
    scopes[end](child)
    assert.throws(() => scopes.open({ kind: 'menu', ownerId: 3 }))
    assert.equal(scopes.depth, 2)
    assert.equal(scopes.top, child)
    scopes.release(child)
    const replacement = scopes.open({ kind: 'menu', ownerId: 3 })
    assert.equal(scopes.info(replacement)?.parentToken, parent)
    scopes.stop()
  }
})

test('work delivery leaves the scope active and permits the next wait', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  let calls = 0
  const ready = () => {
    calls++
    return true
  }
  assert.deepEqual(await scopes.wait(token, ready), { kind: 'work', token })
  assert.equal(scopes.pendingWaits, 0)
  assert.equal(scopes.top, token)
  assert.equal(scopes.canDispatch(token), true)
  assert.deepEqual(await scopes.wait(token, ready), { kind: 'work', token })
  assert.equal(calls, 2)
  assert.equal(scopes.depth, 1)
  scopes.release(token)
})

test('a producer notification wakes queued work without polling between notifications', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 }),
    producer = gate()
  let ready = false,
    calls = 0
  const waiting = observe(
    scopes.wait(token, () => {
      calls++
      return ready
    }),
  )
  await checkpoint()
  const initialCalls = calls
  assert.equal(initialCalls, 1)
  assert.equal(waiting.settled(), false)
  assert.equal(scopes.pendingWaits, 1)
  await checkpoint()
  assert.equal(calls, initialCalls, 'an idle waiter must not schedule its own polling loop')
  const produced = producer.promise.then(() => {
    ready = true
    scopes.notify()
  })
  producer.resolve()
  await produced
  assert.deepEqual(await waiting.result, { kind: 'work', token })
  assert.equal(scopes.pendingWaits, 0)
  scopes.release(token)
})

test('a duplicate pending wait rejects without detaching the original waiter', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'menu', ownerId: 1 })
  let ready = false,
    duplicateCalls = 0
  const original = scopes.wait(token, () => ready)
  await assert.rejects(
    scopes.wait(token, () => {
      duplicateCalls++
      return true
    }),
  )
  assert.equal(duplicateCalls, 0)
  assert.equal(scopes.pendingWaits, 1)
  ready = true
  scopes.notify()
  assert.deepEqual(await original, { kind: 'work', token })
  assert.equal(scopes.pendingWaits, 0)
  assert.deepEqual(await scopes.wait(token, () => true), { kind: 'work', token })
  scopes.release(token)
})

test('parent work is withheld until the child frame is released', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({ kind: 'menu', ownerId: 2, windowId: 1 })
  let parentCalls = 0
  const waiting = observe(
    scopes.wait(parent, () => {
      parentCalls++
      return true
    }),
  )
  scopes.notify()
  await checkpoint()
  assert.equal(parentCalls, 0)
  assert.equal(waiting.settled(), false)
  assert.deepEqual(await scopes.wait(child, () => true), { kind: 'work', token: child })
  scopes.finish(child, 'selected')
  assert.deepEqual(await scopes.wait(child, () => true), { kind: 'completed', value: 'selected' })
  await checkpoint()
  assert.equal(parentCalls, 0, 'a terminal child still owns the unwinding barrier')
  assert.equal(waiting.settled(), false)
  scopes.release(child)
  assert.deepEqual(await waiting.result, { kind: 'work', token: parent })
  assert.equal(parentCalls, 1)
  scopes.release(parent)
})

test('completed modal results retain primitive values without calling the work predicate', async () => {
  for (const value of [
    undefined,
    null,
    false,
    true,
    0,
    -3.5,
    'menu-result',
    9223372036854775807n,
  ]) {
    const scopes = new ModalScopes(),
      token = scopes.open({ kind: 'menu', ownerId: 1 })
    scopes.finish(token, value)
    assert.deepEqual(
      await scopes.wait(token, () => {
        assert.fail('a completed result cannot request more work')
      }),
      { kind: 'completed', value },
    )
    assert.equal(scopes.depth, 1)
    scopes.release(token)
  }
})

test('the first finish or cancellation remains observable until release', async () => {
  const scopes = new ModalScopes(),
    completed = scopes.open({ kind: 'menu', ownerId: 1 })
  assert.equal(scopes.finish(completed, 23n), true)
  assert.equal(scopes.finish(completed, 24n), false)
  assert.equal(scopes.cancel(completed, 'late-cancel'), false)
  assert.deepEqual(await scopes.wait(completed, () => true), { kind: 'completed', value: 23n })
  assert.deepEqual(await scopes.wait(completed, () => true), { kind: 'completed', value: 23n })
  scopes.release(completed)
  const cancelled = scopes.open({ kind: 'window', ownerId: 2 })
  assert.equal(scopes.cancel(cancelled), true)
  assert.equal(scopes.finish(cancelled, 25n), false)
  assert.equal(scopes.cancel(cancelled, 'late-cancel'), false)
  assert.deepEqual(await scopes.wait(cancelled, () => true), {
    kind: 'cancelled',
    reason: 'cancelled',
  })
  scopes.release(cancelled)
})

test('consuming a terminal result cannot mutate the result returned to a later waiter', async () => {
  const scopes = new ModalScopes(),
    completed = scopes.open({ kind: 'menu', ownerId: 1 })
  scopes.finish(completed, 37n)
  const completedResult = await scopes.wait(completed, () => false)
  Reflect.set(completedResult, 'kind', 'work')
  Reflect.set(completedResult, 'value', 99n)
  assert.deepEqual(await scopes.wait(completed, () => false), { kind: 'completed', value: 37n })
  scopes.release(completed)
  const cancelled = scopes.open({ kind: 'menu', ownerId: 2 })
  scopes.cancel(cancelled, 'dismissed')
  const cancelledResult = await scopes.wait(cancelled, () => false)
  Reflect.set(cancelledResult, 'kind', 'completed')
  Reflect.set(cancelledResult, 'reason', 'tampered')
  assert.deepEqual(await scopes.wait(cancelled, () => false), {
    kind: 'cancelled',
    reason: 'dismissed',
  })
  scopes.release(cancelled)
})

test('finishing an ancestor cancels descendants but preserves every unwind barrier', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({ kind: 'window', ownerId: 2 }),
    grandchild = scopes.open({ kind: 'menu', ownerId: 3, windowId: 2 }),
    parentWait = observe(scopes.wait(parent, () => false)),
    childWait = observe(scopes.wait(child, () => false)),
    grandchildWait = scopes.wait(grandchild, () => false)
  assert.equal(scopes.pendingWaits, 3)
  assert.equal(scopes.finish(parent, 'closed'), true)
  assert.deepEqual(await grandchildWait, { kind: 'cancelled', reason: 'ancestor-ended' })
  assert.equal(scopes.depth, 3)
  assert.equal(parentWait.settled(), false)
  assert.equal(childWait.settled(), false)
  assert.equal(scopes.canDispatch(parent), false)
  assert.equal(scopes.canDispatch(child), false)
  assert.equal(scopes.canDispatch(grandchild), false)
  assert.throws(() => scopes.release(parent))
  assert.throws(() => scopes.release(child))
  scopes.release(grandchild)
  assert.deepEqual(await childWait.result, { kind: 'cancelled', reason: 'ancestor-ended' })
  assert.equal(parentWait.settled(), false)
  scopes.release(child)
  assert.deepEqual(await parentWait.result, { kind: 'completed', value: 'closed' })
  assert.equal(scopes.depth, 1)
  assert.equal(scopes.pendingWaits, 0)
  scopes.release(parent)
})

test('ancestor cancellation keeps its reason local and does not overwrite a finished child', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({ kind: 'menu', ownerId: 2 }),
    parentWait = observe(scopes.wait(parent, () => false))
  scopes.finish(child, 'accepted')
  assert.equal(scopes.cancel(parent, 'owner-invalidated'), true)
  assert.deepEqual(await scopes.wait(child, () => true), { kind: 'completed', value: 'accepted' })
  assert.equal(parentWait.settled(), false)
  scopes.release(child)
  assert.deepEqual(await parentWait.result, { kind: 'cancelled', reason: 'owner-invalidated' })
  scopes.release(parent)
})

test('cancelled child unwinding restores its still-active parent', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({ kind: 'menu', ownerId: 2 }),
    parentWait = observe(scopes.wait(parent, () => true)),
    childWait = scopes.wait(child, () => false)
  scopes.cancel(child, 'dismissed')
  assert.deepEqual(await childWait, { kind: 'cancelled', reason: 'dismissed' })
  assert.equal(parentWait.settled(), false)
  assert.equal(scopes.canDispatch(parent), false)
  scopes.release(child)
  assert.deepEqual(await parentWait.result, { kind: 'work', token: parent })
  assert.equal(scopes.canDispatch(parent), true)
  scopes.release(parent)
})

test('out-of-order release changes neither waiters nor cleanup ownership', async () => {
  const cleanup: number[] = [],
    scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1, cleanup: () => cleanup.push(1) }),
    child = scopes.open({ kind: 'menu', ownerId: 2, cleanup: () => cleanup.push(2) }),
    parentWait = observe(scopes.wait(parent, () => true)),
    childWait = scopes.wait(child, () => false)
  assert.throws(() => scopes.release(parent))
  assert.equal(scopes.depth, 2)
  assert.equal(scopes.top, child)
  assert.equal(scopes.pendingWaits, 2)
  assert.deepEqual(cleanup, [])
  assert.equal(scopes.release(child), true)
  assert.deepEqual(await childWait, { kind: 'cancelled', reason: 'released' })
  assert.deepEqual(await parentWait.result, { kind: 'work', token: parent })
  assert.deepEqual(cleanup, [2])
  assert.equal(scopes.release(child), false)
  scopes.release(parent)
  assert.deepEqual(cleanup, [2, 1])
})

test('release removes the frame before cleanup and preserves a reentrant replacement', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 })
  let replacement: number | undefined,
    cleanupCalls = 0,
    parentCalls = 0
  const child = scopes.open({
      kind: 'menu',
      ownerId: 2,
      cleanup() {
        cleanupCalls++
        assert.equal(scopes.info(child), undefined)
        assert.equal(scopes.top, parent)
        assert.equal(scopes.depth, 1)
        assert.equal(scopes.release(child), false)
        replacement = scopes.open({ kind: 'menu', ownerId: 2 })
      },
    }),
    parentWait = observe(
      scopes.wait(parent, () => {
        parentCalls++
        return true
      }),
    ),
    childWait = scopes.wait(child, () => false)
  scopes.release(child)
  assert.deepEqual(await childWait, { kind: 'cancelled', reason: 'released' })
  assert.ok(replacement !== undefined && replacement > child)
  assert.equal(scopes.top, replacement)
  assert.equal(parentWait.settled(), false)
  assert.equal(parentCalls, 0)
  assert.equal(cleanupCalls, 1)
  scopes.release(replacement)
  assert.deepEqual(await parentWait.result, { kind: 'work', token: parent })
  scopes.release(parent)
  assert.equal(cleanupCalls, 1)
})

test('a throwing release cleanup still settles its waiter and wakes the parent', async () => {
  const failure = new Error('menu cleanup failed'),
    scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({
      kind: 'menu',
      ownerId: 2,
      cleanup() {
        throw failure
      },
    }),
    parentWait = scopes.wait(parent, () => true),
    childWait = scopes.wait(child, () => false)
  assert.throws(
    () => scopes.release(child),
    (error) => error === failure,
  )
  assert.equal(scopes.info(child), undefined)
  assert.equal(scopes.top, parent)
  assert.deepEqual(await childWait, { kind: 'cancelled', reason: 'released' })
  assert.deepEqual(await parentWait, { kind: 'work', token: parent })
  assert.equal(scopes.pendingWaits, 0)
  assert.equal(scopes.release(child), false)
  scopes.release(parent)
})

test('pause suppresses readiness and notifications until resume', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  let calls = 0
  scopes.setPaused(true)
  const waiting = observe(
    scopes.wait(token, () => {
      calls++
      return true
    }),
  )
  scopes.notify()
  scopes.notify()
  await checkpoint()
  assert.equal(calls, 0)
  assert.equal(waiting.settled(), false)
  assert.equal(scopes.pendingWaits, 1)
  scopes.setPaused(false)
  assert.deepEqual(await waiting.result, { kind: 'work', token })
  assert.equal(calls, 1)
  scopes.release(token)
})

test('pausing an existing waiter withholds newly available work', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  let ready = false,
    calls = 0
  const waiting = observe(
    scopes.wait(token, () => {
      calls++
      return ready
    }),
  )
  await checkpoint()
  assert.equal(calls, 1)
  scopes.setPaused(true)
  ready = true
  scopes.notify()
  await checkpoint()
  assert.equal(calls, 1)
  assert.equal(waiting.settled(), false)
  scopes.setPaused(false)
  assert.deepEqual(await waiting.result, { kind: 'work', token })
  scopes.release(token)
})

test('terminal outcomes bypass pause while preserving descendant unwind order', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({ kind: 'menu', ownerId: 2 })
  let calls = 0
  const ready = () => {
    calls++
    return true
  }
  scopes.setPaused(true)
  const parentWait = observe(scopes.wait(parent, ready)),
    childWait = scopes.wait(child, ready)
  scopes.finish(parent, 'shutdown')
  assert.deepEqual(await childWait, { kind: 'cancelled', reason: 'ancestor-ended' })
  assert.equal(parentWait.settled(), false)
  scopes.notify()
  scopes.release(child)
  assert.deepEqual(await parentWait.result, { kind: 'completed', value: 'shutdown' })
  assert.equal(calls, 0)
  scopes.release(parent)
})

test('a notification issued by readiness before returning false is not lost', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  let calls = 0
  const result = await scopes.wait(token, () => {
    calls++
    if (calls === 1) {
      scopes.notify()
      return false
    }
    return true
  })
  assert.deepEqual(result, { kind: 'work', token })
  assert.equal(calls, 2)
  assert.equal(scopes.pendingWaits, 0)
  scopes.release(token)
})

test('a readiness callback that completes its scope cannot subsequently deliver work', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'menu', ownerId: 1 })
  assert.deepEqual(
    await scopes.wait(token, () => {
      scopes.finish(token, 'chosen')
      return true
    }),
    { kind: 'completed', value: 'chosen' },
  )
  assert.equal(scopes.pendingWaits, 0)
  assert.equal(scopes.canDispatch(token), false)
  scopes.release(token)
})

test('a readiness callback opening a child must yield to that child before delivering work', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 })
  let child: number | undefined,
    calls = 0
  const waiting = observe(
    scopes.wait(parent, () => {
      calls++
      if (child === undefined) child = scopes.open({ kind: 'menu', ownerId: 2 })
      return true
    }),
  )
  await checkpoint()
  assert.ok(child !== undefined)
  assert.equal(scopes.top, child)
  assert.equal(waiting.settled(), false)
  assert.equal(calls, 1)
  assert.deepEqual(await scopes.wait(child, () => true), { kind: 'work', token: child })
  scopes.release(child)
  assert.deepEqual(await waiting.result, { kind: 'work', token: parent })
  assert.equal(calls, 2)
  scopes.release(parent)
})

test('a readiness callback that pauses the scopes cannot return work until resume', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  let calls = 0
  const waiting = observe(
    scopes.wait(token, () => {
      calls++
      if (calls === 1) scopes.setPaused(true)
      return true
    }),
  )
  await checkpoint()
  assert.equal(waiting.settled(), false)
  assert.equal(calls, 1)
  scopes.notify()
  await checkpoint()
  assert.equal(calls, 1)
  scopes.setPaused(false)
  assert.deepEqual(await waiting.result, { kind: 'work', token })
  assert.equal(calls, 2)
  scopes.release(token)
})

test('a readiness callback may release its own scope without leaving a pending wait', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'menu', ownerId: 1 })
  assert.deepEqual(
    await scopes.wait(token, () => {
      scopes.release(token)
      return true
    }),
    { kind: 'cancelled', reason: 'released' },
  )
  assert.equal(scopes.depth, 0)
  assert.equal(scopes.pendingWaits, 0)
  assert.equal(scopes.info(token), undefined)
})

test('a throwing readiness callback rejects only its wait and permits a retry', async () => {
  const failure = new Error('event queue inspection failed'),
    scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  await assert.rejects(
    scopes.wait(token, () => {
      throw failure
    }),
    (error) => error === failure,
  )
  assert.equal(scopes.pendingWaits, 0)
  assert.equal(scopes.canDispatch(token), true)
  assert.deepEqual(await scopes.wait(token, () => true), { kind: 'work', token })
  scopes.release(token)
})

test('a readiness failure after notification clears the pending slot without ending the scope', async () => {
  const failure = new Error('resumed event inspection failed'),
    scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  let fail = false
  const waiting = scopes.wait(token, () => {
    if (fail) throw failure
    return false
  })
  await checkpoint()
  fail = true
  const rejection = assert.rejects(waiting, (error) => error === failure)
  assert.doesNotThrow(() => scopes.notify())
  await rejection
  assert.equal(scopes.pendingWaits, 0)
  scopes.finish(token, 'recovered')
  assert.deepEqual(await scopes.wait(token, () => false), { kind: 'completed', value: 'recovered' })
  scopes.release(token)
})

test('stop settles waiters from child to parent and retires all frames before cleanup', async () => {
  const scopes = new ModalScopes(),
    cleanup: number[] = [],
    delivered: number[] = [],
    tokens: number[] = []
  for (let ownerId = 1; ownerId <= 3; ownerId++) {
    const token = scopes.open({
      kind: ownerId === 3 ? 'menu' : 'window',
      ownerId,
      cleanup() {
        cleanup.push(ownerId)
        assert.equal(scopes.stopped, true)
        assert.equal(scopes.depth, 0)
        assert.equal(scopes.top, undefined)
        for (const removed of tokens) assert.equal(scopes.info(removed), undefined)
        assert.throws(() => scopes.open({ kind: 'window', ownerId: 100 }))
        scopes.stop('reentrant-stop')
      },
    })
    tokens.push(token)
  }
  const waits = tokens.map((token) =>
    scopes
      .wait(token, () => false)
      .then((value) => {
        delivered.push(token)
        return value
      }),
  )
  assert.equal(scopes.pendingWaits, 3)
  scopes.stop('session-ended')
  assert.deepEqual(cleanup, [3, 2, 1])
  assert.deepEqual(await Promise.all(waits), [
    { kind: 'cancelled', reason: 'session-ended' },
    { kind: 'cancelled', reason: 'session-ended' },
    { kind: 'cancelled', reason: 'session-ended' },
  ])
  assert.deepEqual(delivered, [...tokens].reverse())
  assert.equal(scopes.pendingWaits, 0)
  scopes.setPaused(false)
  scopes.notify()
  scopes.stop('second-stop')
  assert.deepEqual(cleanup, [3, 2, 1])
  for (const token of tokens) {
    assert.equal(scopes.finish(token), false)
    assert.equal(scopes.cancel(token), false)
    assert.equal(scopes.release(token), false)
    assert.equal(scopes.canDispatch(token), false)
    await assert.rejects(scopes.wait(token, () => true))
  }
})

test('stop aggregates cleanup failures after all scopes and waiters have been retired', async () => {
  const parentFailure = new Error('window cleanup failed'),
    childFailure = new Error('popup cleanup failed'),
    cleanup: number[] = [],
    scopes = new ModalScopes(),
    parent = scopes.open({
      kind: 'window',
      ownerId: 1,
      cleanup() {
        cleanup.push(1)
        throw parentFailure
      },
    }),
    middle = scopes.open({ kind: 'window', ownerId: 2, cleanup: () => cleanup.push(2) }),
    child = scopes.open({
      kind: 'menu',
      ownerId: 3,
      cleanup() {
        cleanup.push(3)
        throw childFailure
      },
    }),
    waits = [parent, middle, child].map((token) => scopes.wait(token, () => false))
  assert.throws(
    () => scopes.stop(),
    (error) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [childFailure, parentFailure])
      return true
    },
  )
  assert.deepEqual(cleanup, [3, 2, 1])
  assert.equal(scopes.stopped, true)
  assert.equal(scopes.depth, 0)
  assert.deepEqual(await Promise.all(waits), [
    { kind: 'cancelled', reason: 'stopped' },
    { kind: 'cancelled', reason: 'stopped' },
    { kind: 'cancelled', reason: 'stopped' },
  ])
  assert.equal(scopes.pendingWaits, 0)
  assert.doesNotThrow(() => scopes.stop())
  assert.deepEqual(cleanup, [3, 2, 1])
})

test('stop preserves an existing terminal result while cancelling unfinished ancestors', async () => {
  const scopes = new ModalScopes(),
    parent = scopes.open({ kind: 'window', ownerId: 1 }),
    child = scopes.open({ kind: 'menu', ownerId: 2 }),
    parentWait = scopes.wait(parent, () => false)
  scopes.finish(child, 41n)
  const childWait = scopes.wait(child, () => false)
  scopes.stop('exit')
  assert.deepEqual(await childWait, { kind: 'completed', value: 41n })
  assert.deepEqual(await parentWait, { kind: 'cancelled', reason: 'exit' })
  assert.equal(scopes.depth, 0)
  assert.equal(scopes.pendingWaits, 0)
})

test('stop cancels a paused wait without evaluating its readiness', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  scopes.setPaused(true)
  const waiting = scopes.wait(token, () => {
    assert.fail('stopping must not resume paused event dispatch')
  })
  scopes.stop()
  assert.deepEqual(await waiting, { kind: 'cancelled', reason: 'stopped' })
  assert.equal(scopes.pendingWaits, 0)
  assert.throws(() => scopes.open({ kind: 'window', ownerId: 2 }))
})

test('a readiness callback stopping the stack cannot deliver stale work afterward', async () => {
  const scopes = new ModalScopes(),
    token = scopes.open({ kind: 'window', ownerId: 1 })
  assert.deepEqual(
    await scopes.wait(token, () => {
      scopes.stop('exit-during-dispatch')
      return true
    }),
    { kind: 'cancelled', reason: 'exit-during-dispatch' },
  )
  assert.equal(scopes.stopped, true)
  assert.equal(scopes.depth, 0)
  assert.equal(scopes.pendingWaits, 0)
})
