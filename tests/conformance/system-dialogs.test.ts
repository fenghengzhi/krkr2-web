import test from 'node:test'
import assert from 'node:assert/strict'
import { SystemDialogs, type SystemDialogSnapshot } from '../../src/engine/scene/system-dialogs.ts'
import type { SystemDialogRequest } from '../../src/engine/ports/system-dialogs.ts'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type { HostContext, HostReply, ScriptObject } from '../../src/engine/script/runtime.ts'

function token(reply: HostReply): number {
  assert.equal(reply.kind, 'invoke')
  if (reply.kind !== 'invoke') throw new Error('Expected a system dialog continuation')
  return Number(reply.args[0])
}

function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error]
}

async function fixture() {
  let next = 1
  const object = (): ScriptObject => ({ type: 'object', id: next++, runtime: 1 }),
    leases = new Set<number>(),
    snapshots: SystemDialogSnapshot[] = [],
    entries: number[] = [],
    control = new ExecutionControl(),
    work = { available: false, dispatches: 0 },
    hooks: {
      changed?: (snapshot: SystemDialogSnapshot) => void
      enter?: (id: number) => void
    } = {},
    objects: HostContext = {
      retain() {
        const retained = object()
        leases.add(retained.id)
        return retained
      },
      release(retained) {
        assert.equal(leases.delete(retained.id), true, 'Native pump lease released twice')
      },
      snapshot() {
        throw new Error('System dialog bookkeeping must not copy TJS objects')
      },
    }
  let dialogs!: SystemDialogs
  const loop = new ModalLoop(objects, control, {
    hasWork: () => work.available,
    dispatch: () => {
      work.dispatches++
      return { kind: 'value', value: undefined }
    },
    beforeWait: (current) => dialogs.beforeWait(current),
    changed: () => dialogs.present(),
  })
  dialogs = new SystemDialogs(loop, {
    changed(snapshot) {
      snapshots.push(snapshot)
      hooks.changed?.(snapshot)
    },
    enter(id) {
      entries.push(id)
      hooks.enter?.(id)
    },
  })
  await loop.host('Modal.bind', [object()])
  const host = (operation: string, current: number) => loop.host(operation, [BigInt(current)]),
    snapshot = () => {
      assert.ok(snapshots.length, 'Expected a dialog presentation')
      return snapshots.at(-1)!
    },
    request = () => {
      const current = snapshot().request
      assert.ok(current, 'Expected a visible system dialog')
      return current
    }
  return {
    loop,
    dialogs,
    control,
    leases,
    snapshots,
    entries,
    hooks,
    work,
    host,
    snapshot,
    request,
    show: (
      identity: string,
      kind: SystemDialogRequest['kind'] = 'input-string',
      value = '初始值',
    ) => token(dialogs.show(identity, kind, '标题', '提示内容', value)),
    async result(current: number, expected: string | undefined) {
      assert.deepEqual(await host('Modal.wait', current), { kind: 'value', value: 0n })
      assert.deepEqual(await host('Modal.result', current), { kind: 'value', value: expected })
    },
    stop() {
      delete hooks.changed
      delete hooks.enter
      control.cancel()
      loop.dispose()
      assert.equal(dialogs.count, 0)
      assert.equal(loop.depth, 0)
      assert.equal(loop.pendingWaits, 0)
      assert.equal(leases.size, 0)
    },
  }
}

test('system input confirmation retains Unicode and returns only at its own modal wait', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const baseline = f.leases.size,
    current = f.show('confirm'),
    request = f.request()
  assert.equal(baseline, 1, 'Only the shared modal pump owns a TJS lease')
  assert.equal(f.leases.size, baseline)
  assert.deepEqual(request, {
    id: 1,
    kind: 'input-string',
    caption: '标题',
    text: '提示内容',
    value: '初始值',
  })
  assert.deepEqual(f.entries, [request.id])
  assert.equal(f.dialogs.respond(request.id, '回答\n🌸'), true)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [request.id] })
  assert.equal(f.dialogs.count, 1)
  assert.ok(f.loop.isPending(current))
  await assert.rejects(f.host('Modal.result', current), /not ready/)
  await f.result(current, '回答\n🌸')
  assert.equal(f.dialogs.count, 1)
  assert.equal(f.loop.blockedWindow(11), true)
  await f.host('Modal.end', current)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.leases.size, baseline)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [] })
  assert.equal(f.loop.blockedWindow(11), false)
})

test('system input distinguishes an empty confirmed string from cancelled void', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  for (const value of ['', null]) {
    const current = f.show(`value-${value}`)
    assert.equal(f.dialogs.respond(f.request().id, value), true)
    await f.result(current, value === null ? undefined : '')
    await f.host('Modal.end', current)
  }
})

test('system inform always returns void for confirmation or dismissal', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  for (const value of ['ignored', null]) {
    const current = f.show(`inform-${value}`, 'inform')
    assert.equal(f.dialogs.respond(f.request().id, value), true)
    await f.result(current, undefined)
    await f.host('Modal.end', current)
  }
})

test('system dialog accepts a response once and rejects stale or malformed request identities', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const first = f.show('first'),
    id = f.request().id
  for (const invalid of [0, -1, 0.5, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, id + 1])
    assert.equal(f.dialogs.respond(invalid, 'bad'), false)
  assert.equal(f.dialogs.respond(id, undefined as unknown as null), false)
  assert.equal(f.dialogs.respond(id, 1 as unknown as string), false)
  assert.equal(f.dialogs.respond(id, 'first result'), true)
  assert.equal(f.dialogs.respond(id, 'replacement'), false)
  await f.result(first, 'first result')
  assert.equal(f.dialogs.respond(id, null), false)
  await f.host('Modal.end', first)
  const second = f.show('second'),
    replacement = f.request()
  assert.ok(replacement.id > id)
  assert.equal(f.dialogs.respond(id, 'stale'), false)
  assert.equal(f.dialogs.respond(replacement.id, 'second result'), true)
  await f.result(second, 'second result')
  await f.host('Modal.end', second)
})

test('system dialog publication contains immutable primitive snapshots', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.show('immutable')
  const snapshot = f.snapshot()
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.request), true)
  assert.equal(Object.isFrozen(snapshot.pendingIds), true)
  assert.throws(() => (snapshot.pendingIds as number[]).push(100), TypeError)
  assert.equal(f.dialogs.respond(f.request().id, 'done'), true)
  assert.equal(snapshot.request?.value, '初始值')
  assert.deepEqual(snapshot.pendingIds, [1])
})

test('system dialog presentation suppresses unchanged snapshots while retrying a failed publication', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.dialogs.present()
  const window = f.loop.open({ kind: 'window', ownerId: 11 })
  assert.equal(f.snapshots.length, 0, 'Unrelated Window scopes do not emit empty dialog events')
  f.loop.release(window)
  f.show('deduplicated')
  const initial = f.snapshots.length
  f.dialogs.present()
  f.dialogs.present()
  assert.equal(f.snapshots.length, initial)
  const failure = new Error('failed response presentation')
  f.hooks.changed = () => {
    throw failure
  }
  assert.throws(
    () => f.dialogs.respond(f.request().id, 'done'),
    (error) => error === failure,
  )
  delete f.hooks.changed
  f.dialogs.present()
  assert.equal(f.snapshots.length, initial + 2, 'A failed snapshot is presented again')
  f.dialogs.present()
  assert.equal(f.snapshots.length, initial + 2)
})

test('nested Window and menu scopes temporarily hide a pending system dialog and reject its UI result', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('covered'),
    request = f.request(),
    child = f.loop.open({ kind: 'window', ownerId: 22, windowId: 22 })
  f.loop.invoke(child)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [request.id] })
  assert.equal(f.loop.blockedWindow(22), false)
  assert.equal(f.loop.blockedWindow(11), true)
  assert.equal(f.dialogs.respond(request.id, 'hidden'), false)
  const menu = f.loop.open({ kind: 'menu', ownerId: 33, windowId: 22 })
  f.loop.invoke(menu)
  assert.equal(f.loop.blockedWindow(22), false)
  assert.equal(f.dialogs.respond(request.id, 'still hidden'), false)
  f.loop.finish(menu)
  await f.result(menu, undefined)
  await f.host('Modal.end', menu)
  f.loop.finish(child)
  await f.result(child, undefined)
  await f.host('Modal.end', child)
  assert.equal(f.request(), request)
  assert.equal(f.loop.activeToken, parent)
  assert.equal(f.loop.blockedWindow(22), true)
  assert.equal(f.dialogs.respond(request.id, 'restored'), true)
  await f.result(parent, 'restored')
  await f.host('Modal.end', parent)
})

test('nearest modal scope controls Window blocking while the legacy modalWindowId still finds the Window', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const window = f.loop.open({ kind: 'window', ownerId: 11 })
  f.loop.invoke(window)
  assert.equal(f.loop.modalWindowId, 11)
  assert.equal(f.loop.blockedWindow(11), false)
  const dialog = f.show('above-window'),
    request = f.request(),
    menu = f.loop.open({ kind: 'menu', ownerId: 44, windowId: 11 })
  f.loop.invoke(menu)
  assert.equal(f.loop.modalWindowId, 11)
  assert.equal(f.loop.blockedWindow(11), true)
  assert.equal(f.loop.blockedWindow(22), true)
  f.loop.release(menu)
  assert.equal(f.dialogs.respond(request.id, null), true)
  await f.result(dialog, undefined)
  await f.host('Modal.end', dialog)
  assert.equal(f.loop.blockedWindow(11), false)
  f.loop.release(window)
  assert.equal(f.loop.modalWindowId, undefined)
  assert.equal(f.loop.blockedWindow(22), false)
})

test('a ready system dialog preserves a subsequently nested Window until that child fully unwinds', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('ready-parent'),
    id = f.request().id
  assert.equal(f.dialogs.respond(id, 'parent result'), true)
  const child = f.loop.open({ kind: 'window', ownerId: 22 })
  f.loop.invoke(child)
  f.dialogs.beforeWait(parent)
  assert.equal(f.loop.isPending(parent), true)
  assert.equal(f.loop.isPending(child), true)
  assert.equal(f.loop.depth, 2)
  const grandchild = f.loop.open({ kind: 'window', ownerId: 33 })
  f.loop.invoke(grandchild)
  f.loop.finish(grandchild)
  await f.result(grandchild, undefined)
  await f.host('Modal.end', grandchild)
  f.loop.finish(child)
  await f.result(child, undefined)
  await f.host('Modal.end', child)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [id] })
  await f.result(parent, 'parent result')
  await f.host('Modal.end', parent)
})

test('nested system dialogs keep independent values and unwind strictly in LIFO order', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('outer', 'input-string', 'outer initial'),
    outer = f.request(),
    child = f.show('inner', 'input-string', 'inner initial'),
    inner = f.request()
  assert.notEqual(inner.id, outer.id)
  assert.deepEqual(f.snapshot().pendingIds, [outer.id, inner.id])
  assert.equal(f.dialogs.respond(outer.id, 'hidden parent'), false)
  assert.equal(f.dialogs.respond(inner.id, 'inner answer'), true)
  assert.equal(f.snapshot().request, null, 'Ready child must not reveal its pending parent')
  assert.throws(() => f.loop.release(parent), /LIFO/)
  await f.result(child, 'inner answer')
  await f.host('Modal.end', child)
  assert.equal(f.request(), outer)
  assert.equal(f.dialogs.respond(outer.id, 'outer answer'), true)
  await f.result(parent, 'outer answer')
  await f.host('Modal.end', parent)
})

test('system dialogs allow the shared event pump to dispatch work while awaiting a result', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const current = f.show('cooperative'),
    id = f.request().id,
    waiting = f.host('Modal.wait', current)
  assert.equal(f.loop.pendingWaits, 1)
  f.work.available = true
  f.loop.notify()
  assert.deepEqual(await waiting, { kind: 'value', value: 1n })
  assert.equal(f.work.dispatches, 0)
  await f.host('Modal.dispatch', current)
  assert.equal(f.work.dispatches, 1)
  f.work.available = false
  assert.equal(f.dialogs.respond(id, 'after work'), true)
  await f.result(current, 'after work')
  await f.host('Modal.end', current)
})

test('system dialog pause delays completion until the shared scope resumes', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const current = f.show('paused'),
    id = f.request().id
  f.loop.setPaused(true)
  const waiting = f.host('Modal.wait', current)
  assert.equal(f.dialogs.respond(id, 'paused answer'), true)
  assert.equal(f.loop.pendingWaits, 1)
  assert.equal(f.loop.isPending(current), true)
  f.loop.setPaused(false)
  assert.deepEqual(await waiting, { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', current), { kind: 'value', value: 'paused answer' })
  await f.host('Modal.end', current)
})

test('system dialog abort releases only the exact request and cannot remove its replacement', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const first = f.show('identity'),
    id = f.request().id
  assert.throws(() => f.show('identity'), /identity/)
  assert.throws(() => f.show(''), /identity/)
  assert.equal(f.dialogs.abort('IDENTITY'), false)
  assert.equal(f.dialogs.abort('identity'), true)
  assert.equal(f.dialogs.abort('identity'), false)
  assert.equal(f.loop.info(first), undefined)
  assert.equal(f.dialogs.respond(id, 'stale'), false)
  const second = f.show('replacement')
  assert.equal(f.dialogs.abort('identity'), false)
  assert.equal(f.loop.activeToken, second)
  assert.equal(f.dialogs.count, 1)
})

test('system dialog rejects invalid request primitives before publishing or retaining any object', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  assert.throws(
    () => f.dialogs.show('bad-kind', 'unknown' as 'inform', '', '', ''),
    /Invalid system dialog request/,
  )
  assert.throws(
    () => f.dialogs.show('bad-caption', 'inform', null as unknown as string, '', ''),
    /Invalid system dialog request/,
  )
  assert.equal(f.snapshots.length, 0)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
})

test('system dialog opening publication can synchronously abort before open returns its token', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  let aborted = false
  f.hooks.changed = (snapshot) => {
    if (snapshot.request && !aborted) aborted = f.dialogs.abort('opening')
  }
  assert.throws(() => f.show('opening'), /opening has ended/)
  assert.equal(aborted, true)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
  assert.deepEqual(f.entries, [])
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [] })
})

test('system dialog opening publication can Stop before open returns without leaking request identity', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.hooks.changed = (snapshot) => {
    if (snapshot.request) {
      f.control.cancel()
      f.loop.dispose()
    } else {
      assert.equal(f.dialogs.count, 0)
      assert.equal(f.dialogs.respond(1, 'late'), false)
    }
  }
  assert.throws(() => f.show('opening-stop'), /opening has ended/)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 0)
  assert.deepEqual(f.entries, [])
})

test('an opening abort can replace the same caller identity without old cleanup removing the replacement', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  let replaced = false,
    replacement = 0
  f.hooks.changed = (snapshot) => {
    if (snapshot.request && !replaced) {
      replaced = true
      assert.equal(f.dialogs.abort('reused'), true)
      replacement = f.show('reused')
    }
  }
  assert.throws(() => f.show('reused'), /opening has ended/)
  assert.equal(f.dialogs.count, 1)
  assert.equal(f.loop.depth, 1)
  assert.equal(f.loop.activeToken, replacement)
  const id = f.request().id
  assert.equal(id, 2)
  assert.equal(f.dialogs.respond(id, 'replacement answer'), true)
  await f.result(replacement, 'replacement answer')
  await f.host('Modal.end', replacement)
})

test('system dialog enter may abort its own request and show must not invoke the ended scope', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.hooks.enter = () => assert.equal(f.dialogs.abort('enter-abort'), true)
  assert.throws(() => f.show('enter-abort'), /opening has ended/)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
})

test('system dialog enter may Stop and cannot leave a stale request available for input', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.hooks.enter = () => {
    f.control.cancel()
    f.loop.dispose()
  }
  assert.throws(() => f.show('enter-stop'), /opening has ended/)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 0)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [] })
})

test('system dialog preserves opening and cleanup publication failures after removing its identity', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const opening = new Error('dialog publish failed'),
    cleanup = new Error('dialog cleanup publish failed')
  let calls = 0
  f.hooks.changed = () => {
    if (++calls === 1) throw opening
    assert.equal(f.dialogs.count, 0)
    assert.equal(f.dialogs.abort('publish-error'), false)
    throw cleanup
  }
  assert.throws(
    () => f.show('publish-error'),
    (error) => {
      assert.deepEqual(failures(error), [opening, cleanup])
      return true
    },
  )
  assert.equal(f.loop.depth, 0)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.leases.size, 1)
})

test('system dialog enter failure is preserved together with cleanup publication failure', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const entering = new Error('dialog enter failed'),
    cleanup = new Error('dialog cleanup failed')
  f.hooks.enter = () => {
    throw entering
  }
  f.hooks.changed = (snapshot) => {
    if (!snapshot.request) {
      assert.equal(f.dialogs.count, 0)
      throw cleanup
    }
  }
  assert.throws(
    () => f.show('enter-error'),
    (error) => {
      assert.deepEqual(failures(error), [entering, cleanup])
      return true
    },
  )
  assert.equal(f.loop.depth, 0)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.leases.size, 1)
})

test('a response publication failure still wakes the modal wait with the already accepted value', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const current = f.show('response-error'),
    id = f.request().id,
    waiting = f.host('Modal.wait', current),
    failure = new Error('response publication failed')
  f.hooks.changed = () => {
    throw failure
  }
  assert.throws(
    () => f.dialogs.respond(id, 'accepted'),
    (error) => error === failure,
  )
  assert.equal(f.dialogs.respond(id, 'duplicate'), false)
  assert.deepEqual(await waiting, { kind: 'value', value: 0n })
  assert.deepEqual(await f.host('Modal.result', current), { kind: 'value', value: 'accepted' })
  delete f.hooks.changed
  await f.host('Modal.end', current)
})

test('aborting an ancestor system dialog cancels children but preserves every record until LIFO unwind', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('abort-parent'),
    outer = f.request(),
    child = f.show('abort-child'),
    inner = f.request()
  assert.equal(f.dialogs.abort('abort-parent'), true)
  assert.equal(f.loop.depth, 2)
  assert.equal(f.dialogs.count, 2)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [outer.id, inner.id] })
  assert.equal(f.dialogs.respond(inner.id, 'cancelled child'), false)
  assert.equal(f.dialogs.respond(outer.id, 'aborted parent'), false)
  await f.result(child, undefined)
  await f.host('Modal.end', child)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [outer.id] })
  await f.result(parent, undefined)
  await f.host('Modal.end', parent)
  assert.equal(f.dialogs.count, 0)
})

test('a cancelled Window ancestor suppresses its nested system dialog before its caller unwinds', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.loop.open({ kind: 'window', ownerId: 11 })
  f.loop.invoke(parent)
  const child = f.show('cancelled-with-window'),
    id = f.request().id
  f.loop.cancel(parent, 'Window closed')
  f.dialogs.present()
  assert.equal(f.dialogs.respond(id, 'late answer'), false)
  assert.deepEqual(f.snapshot(), { request: null, pendingIds: [id] })
  await f.result(child, undefined)
  await f.host('Modal.end', child)
  await f.result(parent, undefined)
  await f.host('Modal.end', parent)
})

test('Stop clears pending, ready and returning dialog identities before any shutdown publication', async () => {
  for (const phase of ['pending', 'ready', 'returning']) {
    const f = await fixture()
    try {
      f.show('stop-parent')
      const parentId = f.request().id,
        child = f.show('stop-child'),
        childId = f.request().id
      if (phase !== 'pending') f.dialogs.respond(childId, 'selected')
      if (phase === 'returning') await f.result(child, 'selected')
      const changes: SystemDialogSnapshot[] = []
      f.hooks.changed = (snapshot) => {
        changes.push(snapshot)
        assert.equal(f.dialogs.count, 0)
        assert.equal(f.dialogs.abort('stop-parent'), false)
        assert.equal(f.dialogs.abort('stop-child'), false)
        assert.equal(f.dialogs.respond(parentId, 'late'), false)
        assert.equal(f.dialogs.respond(childId, 'late'), false)
        assert.deepEqual(snapshot, { request: null, pendingIds: [] })
      }
      f.control.cancel()
      f.loop.dispose()
      assert.equal(changes.length, 1)
      assert.equal(f.leases.size, 0)
      assert.equal(f.loop.depth, 0)
      assert.equal(f.loop.pendingWaits, 0)
    } finally {
      f.stop()
    }
  }
})

test('Stop wakes a pending dialog wait and retains no host or TJS ownership', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const current = f.show('waiting-stop'),
    waiting = f.host('Modal.wait', current),
    rejected = assert.rejects(waiting, { name: 'AbortError' })
  assert.equal(f.loop.pendingWaits, 1)
  f.control.cancel()
  f.loop.dispose()
  await rejected
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.loop.pendingWaits, 0)
  assert.equal(f.leases.size, 0)
})

test('Stop revokes dialog identities before a nested Window or menu publishes its own cleanup', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.show('below-window')
  const id = f.request().id,
    window = f.loop.open({ kind: 'window', ownerId: 22 }),
    menu = f.loop.open({ kind: 'menu', ownerId: 33, windowId: 22 })
  assert.ok(f.loop.info(window))
  assert.ok(f.loop.info(menu))
  let changes = 0
  f.hooks.changed = (snapshot) => {
    changes++
    assert.equal(f.dialogs.count, 0)
    assert.equal(f.dialogs.abort('below-window'), false)
    assert.equal(f.dialogs.respond(id, 'stale'), false)
    assert.deepEqual(snapshot, { request: null, pendingIds: [] })
  }
  f.control.cancel()
  f.loop.dispose()
  assert.equal(changes, 1)
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 0)
})

test('throwing Stop publication does not retain any dialog identity or prevent release of the modal pump', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  f.show('stop-error-parent')
  f.show('stop-error-child')
  const failure = new Error('shutdown publication failed')
  f.hooks.changed = () => {
    assert.equal(f.dialogs.count, 0)
    throw failure
  }
  f.control.cancel()
  assert.throws(
    () => f.loop.dispose(),
    (error) => {
      assert.deepEqual(failures(error), [failure, failure])
      return true
    },
  )
  assert.equal(f.dialogs.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 0)
})
