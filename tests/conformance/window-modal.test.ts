import test from 'node:test'
import assert from 'node:assert/strict'
import { WindowModals } from '../../src/engine/scene/window-modal.ts'
import { WindowService, type WindowRecord } from '../../src/engine/scene/windows.ts'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type {
  HostContext,
  HostReply,
  ScriptObject,
  ScriptRuntime,
  ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'

function token(reply: HostReply): number {
  assert.equal(reply.kind, 'invoke')
  if (reply.kind !== 'invoke') throw new Error('Expected a modal continuation')
  return Number(reply.args[0])
}

async function fixture() {
  let next = 1
  const object = (): ScriptObject => ({ type: 'object', id: next++, runtime: 1 }),
    leases = new Set<number>(),
    observers = new Set<number>(),
    entered: number[] = [],
    left: { windowId: number; previous: number }[] = [],
    queries: WindowRecord[] = [],
    pending: WindowRecord[] = [],
    notEntered: (() => void)[] = [],
    control = new ExecutionControl(),
    hooks: {
      changed?: () => void
      enter?: (window: WindowRecord) => void
      leave?: (window: WindowRecord) => void
      query?: (window: WindowRecord, onNotEntered: () => void) => void
    } = {}
  const objects: HostContext &
    Pick<ScriptRuntime, 'observe' | 'unobserve' | 'registerNativeLifetime'> = {
    retain() {
      const lease = object()
      leases.add(lease.id)
      return lease
    },
    release(lease) {
      assert.equal(leases.delete(lease.id), true, 'Native lease released twice')
    },
    snapshot() {
      throw new Error('Modal state must not copy TJS objects')
    },
    observe(): ScriptWeakObject {
      const id = next++
      observers.add(id)
      return { type: 'weak-object', id, runtime: 1 }
    },
    unobserve(weak) {
      assert.equal(observers.delete(weak.id), true)
    },
    registerNativeLifetime() {},
  }
  const windows = new WindowService(
    objects as ScriptRuntime,
    () => {},
    async () => {},
    () => {},
  )
  let modals!: WindowModals
  const loop = new ModalLoop(objects, control, {
    hasWork: () => pending.length > 0,
    dispatch: () => {
      pending.shift()
      return { kind: 'value', value: undefined }
    },
    changed: () => hooks.changed?.(),
    beforeWait: (current) => modals.beforeWait(current),
  })
  modals = new WindowModals(windows, loop, {
    enter(window) {
      entered.push(window.id)
      window.state.set('visible', 1)
      windows.activate(window.id)
      hooks.enter?.(window)
    },
    leave(window, previous) {
      left.push({ windowId: window.id, previous })
      if (!window.closing && !window.finished) window.state.set('visible', 0)
      const old = windows.registered().find((entry) => entry.id === previous)
      if (old?.state.visible && old.state.focusable) windows.activate(previous)
      else if (windows.active === window) windows.activate(0)
      hooks.leave?.(window)
    },
    query(window, onNotEntered) {
      hooks.query?.(window, onNotEntered)
      queries.push(window)
      pending.push(window)
      notEntered.push(onNotEntered)
      loop.notify()
    },
  })
  await loop.host('Modal.bind', [object()])
  const add = () => windows.create(object(), object(), objects),
    main = add(),
    parent = add(),
    child = add()
  main.state.set('visible', 1)
  windows.activate(main.id)
  return {
    windows,
    loop,
    modals,
    control,
    hooks,
    leases,
    observers,
    entered,
    left,
    queries,
    pending,
    notEntered,
    main,
    parent,
    child,
    add,
    show: (window: WindowRecord, identity: string) => token(modals.show(window.id, identity)),
    host: (operation: string, current: number) => loop.host(operation, [BigInt(current)]),
    async stop() {
      control.cancel()
      try {
        loop.dispose()
      } finally {
        windows.dispose()
      }
    },
  }
}

async function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  window: WindowRecord,
  current: number,
) {
  assert.equal(f.modals.respond(window.id, true), true)
  assert.deepEqual(await f.host('Modal.wait', current), { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', current), { kind: 'value', value: undefined })
  await f.host('Modal.end', current)
}

function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error]
}

function watch(completion: Promise<void>): () => 'pending' | 'fulfilled' | 'rejected' {
  let state: 'pending' | 'fulfilled' | 'rejected' = 'pending'
  void completion.then(
    () => {
      state = 'fulfilled'
    },
    () => {
      state = 'rejected'
    },
  )
  return () => state
}

test('showModal blocks siblings until its accepted frame unwinds, then hides and permits a new request', async () => {
  const f = await fixture()
  const baseline = f.leases.size,
    current = f.show(f.parent, 'first')
  assert.equal(f.modals.count, 1)
  assert.equal(f.modals.has(f.parent.id), true)
  assert.equal(f.parent.state.visible, true)
  assert.equal(f.windows.active, f.parent)
  assert.equal(f.modals.blocked(f.main.id), true)
  assert.equal(f.modals.blocked(f.parent.id), false)
  assert.equal(f.leases.size, baseline, 'Modal bookkeeping must not own another Window lease')
  f.modals.respond(f.parent.id, true)
  await f.host('Modal.wait', current)
  assert.equal(f.modals.has(f.parent.id), true)
  assert.equal(f.modals.blocked(f.main.id), true)
  assert.equal(f.parent.state.visible, true)
  await f.host('Modal.end', current)
  assert.equal(f.parent.state.visible, false)
  assert.equal(f.parent.finished, false)
  assert.equal(f.windows.active, f.main)
  assert.equal(f.modals.count, 0)
  assert.equal(f.modals.blocked(f.main.id), false)
  const second = f.show(f.parent, 'second')
  assert.notEqual(second, current)
  assert.equal(f.modals.abort(f.parent.id, 'first'), false)
  assert.equal(f.loop.activeToken, second)
  // The host returned a continuation, but a native flush can fail before TJS
  // enters that pump. Only this invocation's identity may undo its reservation.
  assert.equal(f.modals.abort(f.parent.id, 'second'), true)
  assert.equal(f.modals.abort(f.parent.id, 'second'), false)
  assert.equal(f.loop.info(second), undefined)
  assert.equal(f.modals.count, 0)
  assert.equal(f.parent.state.visible, false)
  assert.equal(f.windows.active, f.main)
  await f.stop()
  assert.equal(f.leases.size, 0)
})

test('showModal rejects visible, fullscreen, invalidated and unidentified requests before reserving state', async () => {
  const f = await fixture()
  assert.throws(() => f.modals.show(f.main.id, 'visible'), /hidden/)
  f.parent.state.set('fullScreen', 1)
  assert.throws(() => f.modals.show(f.parent.id, 'full'), /fullscreen/)
  f.parent.state.set('fullScreen', 0)
  assert.throws(() => f.modals.show(f.parent.id, ''), /request identity/)
  f.windows.finish(f.child.id)
  assert.throws(() => f.modals.show(f.child.id, 'retired'), /invalidated/)
  assert.throws(() => f.modals.show(999999, 'missing'), /invalidated/)
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.deepEqual(f.entered, [])
  assert.deepEqual(f.left, [])
  assert.equal(f.windows.active, f.main)
  await f.stop()
})

test('same-Window reentry is rejected while publishing the reservation and cannot abort the existing request', async () => {
  const f = await fixture()
  let checked = false
  f.hooks.changed = () => {
    if (checked || !f.modals.has(f.parent.id)) return
    checked = true
    assert.throws(() => f.modals.show(f.parent.id, 'reentrant'), /already modal/)
    assert.equal(f.modals.abort(f.parent.id, 'reentrant'), false)
  }
  const current = f.show(f.parent, 'original')
  assert.equal(checked, true)
  assert.equal(f.modals.count, 1)
  assert.equal(f.loop.depth, 1)
  assert.equal(f.loop.activeToken, current)
  assert.deepEqual(f.entered, [f.parent.id])
  await complete(f, f.parent, current)
  await f.stop()
})

test('an aborted opening reservation is unwound after its scope token becomes available', async () => {
  const f = await fixture()
  let aborted = false
  f.hooks.changed = () => {
    if (aborted || !f.modals.has(f.parent.id)) return
    aborted = f.modals.abort(f.parent.id, 'opening')
  }
  assert.throws(() => f.modals.show(f.parent.id, 'opening'), /opening has ended/)
  assert.equal(aborted, true)
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.deepEqual(f.entered, [])
  assert.deepEqual(f.left, [{ windowId: f.parent.id, previous: f.main.id }])
  assert.equal(f.parent.state.visible, false)
  await f.stop()
})

test('partial enter failure rolls back visibility, activation and the reserved modal scope', async () => {
  const f = await fixture(),
    failure = new Error('surface activation failed')
  f.hooks.enter = () => {
    throw failure
  }
  assert.throws(
    () => f.modals.show(f.parent.id, 'failed-enter'),
    (error) => error === failure,
  )
  assert.equal(f.parent.state.visible, false)
  assert.equal(f.windows.active, f.main)
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.left.length, 1)
  delete f.hooks.enter
  const replacement = f.show(f.parent, 'retry')
  await complete(f, f.parent, replacement)
  await f.stop()
})

test('a failed scope publication rolls back the Window reservation without entering it', async () => {
  const f = await fixture(),
    failure = new Error('modal publication failed')
  let failed = false
  f.hooks.changed = () => {
    if (!failed) {
      failed = true
      throw failure
    }
  }
  assert.throws(
    () => f.modals.show(f.parent.id, 'failed-publish'),
    (error) => error === failure,
  )
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.deepEqual(f.entered, [])
  assert.equal(f.left.length, 1)
  delete f.hooks.changed
  const retry = f.show(f.parent, 'retry-publish')
  await complete(f, f.parent, retry)
  await f.stop()
})

test('opening and leave failures preserve both errors after removing modal identity', async () => {
  const f = await fixture(),
    primary = new Error('enter failed'),
    cleanup = new Error('leave failed')
  f.hooks.enter = () => {
    throw primary
  }
  f.hooks.leave = () => {
    throw cleanup
  }
  assert.throws(
    () => f.modals.show(f.parent.id, 'errors'),
    (error) => {
      const list = failures(error)
      assert.equal(list.length, 2)
      assert.equal(list[0], primary)
      assert.equal(list[1], cleanup)
      return true
    },
  )
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.parent.state.visible, false)
  assert.equal(f.modals.abort(f.parent.id, 'errors'), false)
  await f.stop()
})

test('modal Close queues one query only on its own wait boundary and a refusal permits another request', async () => {
  const f = await fixture(),
    current = f.show(f.parent, 'close-cycle')
  assert.equal(f.modals.requestClose(f.parent.id), true)
  f.modals.requestClose(f.parent.id)
  assert.deepEqual(f.queries, [])
  assert.deepEqual(await f.host('Modal.wait', current), { kind: 'value', value: 1n })
  assert.deepEqual(f.queries, [f.parent])
  await f.host('Modal.dispatch', current)
  f.modals.requestClose(f.parent.id)
  f.modals.beforeWait(current)
  assert.deepEqual(f.queries, [f.parent], 'An override without a base answer remains pending')
  f.modals.respond(f.parent.id, false)
  assert.equal(f.parent.state.visible, true)
  assert.equal(f.modals.count, 1)
  f.modals.requestClose(f.parent.id)
  await f.host('Modal.wait', current)
  assert.deepEqual(f.queries, [f.parent, f.parent])
  await f.host('Modal.dispatch', current)
  await complete(f, f.parent, current)
  await f.stop()
})

test('synchronous close-query admission failure preserves the request for retry even while hidden', async () => {
  const f = await fixture(),
    failure = new Error('query admission failed'),
    current = f.show(f.parent, 'query-retry')
  f.hooks.query = () => {
    throw failure
  }
  f.parent.state.set('visible', 0)
  f.modals.requestClose(f.parent.id)
  assert.throws(
    () => f.modals.beforeWait(current),
    (error) => error === failure,
  )
  assert.deepEqual(f.queries, [])
  assert.equal(f.modals.has(f.parent.id), true)
  delete f.hooks.query
  await f.host('Modal.wait', current)
  assert.deepEqual(f.queries, [f.parent])
  await f.host('Modal.dispatch', current)
  await complete(f, f.parent, current)
  await f.stop()
})

test('an older synchronous admission failure cannot reset a reentrant query generation or replacement scope', async () => {
  for (const replace of [false, true]) {
    const f = await fixture(),
      failure = new Error('old admission failed'),
      old = f.show(f.parent, 'old-admission')
    let current = old
    try {
      f.hooks.query = () => {
        delete f.hooks.query
        if (replace) {
          assert.equal(f.modals.abort(f.parent.id, 'old-admission'), true)
          current = f.show(f.parent, 'replacement-admission')
        } else {
          f.modals.respond(f.parent.id, false)
        }
        f.modals.requestClose(f.parent.id)
        f.modals.beforeWait(current)
        throw failure
      }
      f.modals.requestClose(f.parent.id)
      assert.throws(
        () => f.modals.beforeWait(old),
        (error) => error === failure,
      )
      assert.deepEqual(f.queries, [f.parent])
      assert.deepEqual(f.pending, [f.parent])
      f.modals.beforeWait(current)
      assert.deepEqual(f.queries, [f.parent], 'The newer admitted query must remain pending')
      assert.equal(f.loop.activeToken, current)
      assert.equal(f.modals.count, 1)
      await f.host('Modal.dispatch', current)
      await complete(f, f.parent, current)
    } finally {
      delete f.hooks.query
      await f.stop()
    }
  }
})

test('resume and a delayed answer wake the owning modal wait without duplicating its query', async () => {
  const f = await fixture(),
    current = f.show(f.parent, 'paused-query')
  f.loop.setPaused(true)
  f.modals.requestClose(f.parent.id)
  const query = f.host('Modal.wait', current)
  assert.equal(f.loop.pendingWaits, 1)
  assert.deepEqual(f.queries, [])
  f.modals.requestClose(f.parent.id)
  f.loop.setPaused(false)
  assert.deepEqual(await query, { kind: 'value', value: 1n })
  assert.deepEqual(f.queries, [f.parent])
  await f.host('Modal.dispatch', current)
  const answer = f.host('Modal.wait', current)
  assert.equal(f.loop.pendingWaits, 1)
  f.modals.respond(f.parent.id, true)
  assert.deepEqual(await answer, { kind: 'value', value: 0n })
  assert.deepEqual(f.queries, [f.parent])
  assert.equal(f.parent.state.visible, true)
  await f.host('Modal.end', current)
  assert.equal(f.parent.state.visible, false)
  await f.stop()
})

test('a query cancelled before entry stays pending after its child unwinds until an explicit base answer', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'cancelled-query')
  f.modals.requestClose(f.parent.id)
  await f.host('Modal.wait', parent)
  const firstCancelled = f.notEntered[0]!
  const child = f.show(f.child, 'clears-parent-input')
  assert.equal(f.pending.shift(), f.parent)
  firstCancelled()
  firstCancelled()
  f.modals.beforeWait(parent)
  assert.deepEqual(f.queries, [f.parent])
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.child.state.visible, true)
  await complete(f, f.child, child)
  assert.equal(f.child.state.visible, false)
  assert.equal(f.child.finished, false)
  assert.equal(f.loop.activeToken, parent)
  f.modals.beforeWait(parent)
  assert.deepEqual(f.queries, [f.parent], 'Cancelling input does not clear native Closing')
  assert.deepEqual(f.pending, [])
  assert.equal(f.modals.requestClose(f.parent.id), true)
  f.modals.beforeWait(parent)
  assert.deepEqual(f.queries, [f.parent], 'Close remains a no-op while Closing is set')
  assert.equal(f.modals.count, 1)
  assert.equal(f.parent.state.visible, true)
  firstCancelled()
  f.modals.beforeWait(parent)
  assert.equal(f.queries.length, 1)
  f.modals.respond(f.parent.id, false)
  firstCancelled()
  f.modals.beforeWait(parent)
  assert.equal(f.queries.length, 1, 'A base refusal clears Closing without making another request')
  f.modals.requestClose(f.parent.id)
  await f.host('Modal.wait', parent)
  assert.deepEqual(f.queries, [f.parent, f.parent])
  firstCancelled()
  f.modals.beforeWait(parent)
  assert.equal(f.queries.length, 2, 'An old cancellation cannot modify the new pending query')
  await f.host('Modal.dispatch', parent)
  f.modals.respond(f.parent.id, true)
  f.notEntered[1]!()
  await f.host('Modal.wait', parent)
  assert.equal(f.queries.length, 2)
  await f.host('Modal.end', parent)
  await f.stop()
})

test('a cancelled query from an aborted attempt cannot modify a new attempt for the same Window', async () => {
  const f = await fixture(),
    old = f.show(f.parent, 'old-query')
  f.modals.requestClose(f.parent.id)
  await f.host('Modal.wait', old)
  const cancelled = f.notEntered[0]!
  f.pending.shift()
  assert.equal(f.modals.abort(f.parent.id, 'old-query'), true)
  cancelled()
  const current = f.show(f.parent, 'new-query')
  f.modals.requestClose(f.parent.id)
  await f.host('Modal.wait', current)
  cancelled()
  f.modals.beforeWait(current)
  assert.equal(f.queries.length, 2)
  await f.host('Modal.dispatch', current)
  await complete(f, f.parent, current)
  await f.stop()
})

test('acceptedCompletion waits for the accepted attempt to hide and release its modal blocking', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'accepted-completion')
  assert.equal(f.modals.acceptedCompletion(f.parent.id), undefined)
  f.modals.respond(f.parent.id, false)
  assert.equal(f.modals.acceptedCompletion(f.parent.id), undefined)
  const child = f.show(f.child, 'still-active-child')
  f.modals.respond(f.parent.id, true)
  const completion = f.modals.acceptedCompletion(f.parent.id)!
  assert.ok(completion instanceof Promise)
  assert.equal(f.modals.acceptedCompletion(f.parent.id), completion)
  const state = watch(completion)
  await complete(f, f.child, child)
  assert.equal(state(), 'pending')
  await f.host('Modal.wait', parent)
  assert.equal(state(), 'pending')
  assert.equal(f.parent.state.visible, true)
  assert.equal(f.modals.blocked(f.main.id), true)
  let cleanupFinished = false
  f.hooks.leave = (window) => {
    assert.equal(window, f.parent)
    assert.equal(f.modals.acceptedCompletion(window.id), undefined)
    assert.equal(f.loop.info(parent), undefined)
    assert.equal(f.modals.blocked(f.main.id), false)
    cleanupFinished = true
  }
  await f.host('Modal.end', parent)
  await completion
  assert.equal(state(), 'fulfilled')
  assert.equal(cleanupFinished, true)
  assert.equal(f.parent.state.visible, false)
  assert.equal(f.windows.active, f.main)
  await f.stop()
})

test('acceptedCompletion rejects the same leave failure that unwinding reports after removing identity', async () => {
  const f = await fixture(),
    current = f.show(f.parent, 'cleanup-rejection'),
    failure = new Error('accepted cleanup failed')
  f.modals.respond(f.parent.id, true)
  const completion = f.modals.acceptedCompletion(f.parent.id)!
  const rejected = assert.rejects(completion, (error) => error === failure)
  f.hooks.leave = () => {
    throw failure
  }
  await f.host('Modal.wait', current)
  await assert.rejects(f.host('Modal.end', current), (error) => error === failure)
  await rejected
  assert.equal(f.modals.has(f.parent.id), false)
  assert.equal(f.modals.acceptedCompletion(f.parent.id), undefined)
  assert.equal(f.loop.depth, 0)
  await f.stop()
})

test('an old accepted completion cannot adopt a replacement opened during its cleanup', async () => {
  const f = await fixture(),
    old = f.show(f.parent, 'old-completion')
  f.modals.respond(f.parent.id, true)
  const oldCompletion = f.modals.acceptedCompletion(f.parent.id)!
  let current: number | undefined, newCompletion: Promise<void> | undefined
  f.hooks.leave = (window) => {
    if (current !== undefined) return
    current = f.show(window, 'new-completion')
    f.modals.respond(window.id, true)
    newCompletion = f.modals.acceptedCompletion(window.id)
  }
  await f.host('Modal.wait', old)
  await f.host('Modal.end', old)
  await oldCompletion
  assert.ok(current !== undefined && newCompletion)
  assert.notEqual(newCompletion, oldCompletion)
  assert.equal(f.modals.acceptedCompletion(f.parent.id), newCompletion)
  const state = watch(newCompletion)
  assert.equal(state(), 'pending')
  assert.equal(f.loop.activeToken, current)
  assert.equal(f.parent.state.visible, true)
  await f.host('Modal.wait', current)
  await f.host('Modal.end', current)
  await newCompletion
  assert.equal(state(), 'fulfilled')
  await f.stop()
})

test('an accepted main Window still exposes its unwind completion after native invalidation starts', async () => {
  const f = await fixture()
  f.main.state.set('visible', 0)
  const current = f.show(f.main, 'invalidated-main')
  f.modals.respond(f.main.id, true)
  const completion = f.modals.acceptedCompletion(f.main.id)!,
    state = watch(completion)
  f.windows.finish(f.main.id)
  f.modals.invalidate(f.main.id)
  assert.equal(f.modals.acceptedCompletion(f.main.id), completion)
  assert.equal(state(), 'pending')
  await f.host('Modal.wait', current)
  await f.host('Modal.end', current)
  await completion
  assert.equal(state(), 'fulfilled')
  assert.equal(f.modals.acceptedCompletion(f.main.id), undefined)
  await f.stop()
})

test('a parent Close waits for the child to unwind before preparing the parent query', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'parent'),
    child = f.show(f.child, 'child')
  f.modals.requestClose(f.parent.id)
  f.modals.beforeWait(parent)
  f.modals.beforeWait(child)
  assert.deepEqual(f.queries, [])
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.modals.blocked(f.parent.id), true)
  await complete(f, f.child, child)
  assert.equal(f.child.finished, false)
  assert.equal(f.loop.activeToken, parent)
  await f.host('Modal.wait', parent)
  assert.deepEqual(f.queries, [f.parent])
  await f.host('Modal.dispatch', parent)
  await complete(f, f.parent, parent)
  await f.stop()
})

test('direct parent acceptance and a later refusal preserve the child and the accepted parent result', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'accepted-parent'),
    child = f.show(f.child, 'live-child')
  f.modals.respond(f.parent.id, true)
  f.modals.respond(f.parent.id, false)
  f.modals.beforeWait(parent)
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.loop.depth, 2)
  assert.equal(f.child.state.visible, true)
  assert.equal(f.modals.blocked(f.parent.id), true)
  await complete(f, f.child, child)
  assert.deepEqual(await f.host('Modal.wait', parent), { kind: 'value', value: 0n })
  assert.deepEqual(f.queries, [], 'The refusal must not clear an already accepted ModalResult')
  await f.host('Modal.end', parent)
  assert.equal(f.parent.finished, false)
  assert.equal(f.child.finished, false)
  await f.stop()
})

test('an accepting query callback may open another modal child before the parent reaches its next wait', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'callback-parent')
  f.modals.requestClose(f.parent.id)
  await f.host('Modal.wait', parent)
  await f.host('Modal.dispatch', parent)
  f.modals.respond(f.parent.id, true)
  const child = f.show(f.child, 'opened-after-acceptance')
  assert.equal(f.loop.depth, 2)
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.parent.state.visible, true)
  await complete(f, f.child, child)
  await f.host('Modal.wait', parent)
  await f.host('Modal.end', parent)
  assert.deepEqual(f.queries, [f.parent])
  await f.stop()
})

test('a further modal Close replaces an accepted but unconsumed result with another confirmation request', async () => {
  const f = await fixture(),
    current = f.show(f.parent, 'reclose')
  f.modals.respond(f.parent.id, true)
  // This request timing follows the documented VCL-based inference; the fixed
  // KRKR wrapper alone does not include the old TForm::Close implementation.
  f.modals.requestClose(f.parent.id)
  assert.deepEqual(await f.host('Modal.wait', current), { kind: 'value', value: 1n })
  assert.deepEqual(f.queries, [f.parent])
  await f.host('Modal.dispatch', current)
  f.modals.respond(f.parent.id, false)
  f.modals.beforeWait(current)
  assert.equal(f.modals.count, 1)
  assert.equal(f.parent.state.visible, true)
  await complete(f, f.parent, current)
  await f.stop()
})

test('changing visible alone neither ends a modal Window nor prepares a close query', async () => {
  const f = await fixture(),
    current = f.show(f.parent, 'hidden-modal')
  f.parent.state.set('visible', 0)
  f.modals.beforeWait(current)
  assert.equal(f.modals.count, 1)
  assert.equal(f.modals.has(f.parent.id), true)
  assert.equal(f.modals.blocked(f.main.id), true)
  assert.equal(f.loop.depth, 1)
  assert.deepEqual(f.queries, [])
  f.parent.state.set('visible', 1)
  await complete(f, f.parent, current)
  await f.stop()
})

test('explicit Window invalidation cancels its modal descendants while leaving native child objects intact', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'invalid-parent'),
    child = f.show(f.child, 'unwound-child')
  f.modals.requestClose(f.child.id)
  f.windows.finish(f.parent.id)
  f.modals.invalidate(f.parent.id)
  assert.equal(f.modals.requestClose(f.parent.id), false)
  assert.deepEqual(await f.host('Modal.wait', child), { kind: 'value', value: 0n })
  assert.deepEqual(f.queries, [], 'A cancelled child must unwind without issuing a new query')
  await f.host('Modal.end', child)
  await f.host('Modal.wait', parent)
  await f.host('Modal.end', parent)
  assert.equal(f.modals.count, 0)
  assert.equal(f.child.finished, false)
  assert.equal(f.child.state.visible, false)
  await f.stop()
})

test('failed opening cleanup cannot abort a replacement opened by its leave observer', async () => {
  const f = await fixture(),
    failure = new Error('first enter failed')
  let replacement: number | undefined
  f.hooks.enter = () => {
    delete f.hooks.enter
    throw failure
  }
  f.hooks.leave = (window) => {
    if (replacement !== undefined) return
    replacement = f.show(window, 'replacement')
  }
  assert.throws(
    () => f.modals.show(f.parent.id, 'failed'),
    (error) => error === failure,
  )
  assert.ok(replacement !== undefined)
  assert.equal(f.modals.abort(f.parent.id, 'failed'), false)
  assert.equal(f.modals.count, 1)
  assert.equal(f.loop.depth, 1)
  assert.equal(f.loop.activeToken, replacement)
  assert.equal(f.parent.state.visible, true)
  await complete(f, f.parent, replacement)
  await f.stop()
})

test('Stop removes modal request identities even when leave reports errors', async () => {
  const f = await fixture(),
    parent = f.show(f.parent, 'stop-parent'),
    child = f.show(f.child, 'stop-child'),
    failure = new Error('host surface cleanup failed')
  f.hooks.leave = () => {
    throw failure
  }
  f.modals.respond(f.parent.id, true)
  f.modals.respond(f.child.id, true)
  const parentCompletion = assert.rejects(
      f.modals.acceptedCompletion(f.parent.id)!,
      (error) => error === failure,
    ),
    childCompletion = assert.rejects(
      f.modals.acceptedCompletion(f.child.id)!,
      (error) => error === failure,
    )
  f.control.cancel()
  assert.throws(
    () => f.loop.dispose(),
    (error) => {
      const list = failures(error)
      assert.equal(list.length, 2)
      assert.ok(list.every((entry) => entry === failure))
      return true
    },
  )
  await Promise.all([parentCompletion, childCompletion])
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.loop.info(parent), undefined)
  assert.equal(f.loop.info(child), undefined)
  assert.equal(f.modals.abort(f.parent.id, 'stop-parent'), false)
  assert.equal(f.modals.abort(f.child.id, 'stop-child'), false)
  f.windows.dispose()
  assert.equal(f.leases.size, 0)
  assert.equal(f.observers.size, 0)
  assert.doesNotThrow(() => f.loop.dispose())
})
