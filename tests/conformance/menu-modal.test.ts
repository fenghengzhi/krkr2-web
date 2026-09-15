import test from 'node:test'
import assert from 'node:assert/strict'
import { MenuModals } from '../../src/engine/scene/menu-modal.ts'
import type { MenuRecord } from '../../src/engine/scene/menu-items.ts'
import { MenuTree } from '../../src/engine/scene/menus.ts'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type {
  HostContext,
  HostReply,
  ScriptObject,
  ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'

function token(reply: HostReply): number {
  assert.equal(reply.kind, 'invoke')
  if (reply.kind !== 'invoke') throw new Error('Expected a menu modal continuation')
  return Number(reply.args[0])
}

async function fixture() {
  let next = 1
  const object = (): ScriptObject => ({ type: 'object', id: next++, runtime: 1 }),
    weak = (): ScriptWeakObject => ({ type: 'weak-object', id: next++, runtime: 1 }),
    leases = new Set<number>(),
    notifications: number[] = [],
    notificationStates: { scopes: number; popup: boolean }[] = [],
    hooks: { changed?: () => void } = {},
    control = new ExecutionControl(),
    tree = new MenuTree()
  const objects: HostContext = {
    retain() {
      const retained = object()
      leases.add(retained.id)
      return retained
    },
    release(retained) {
      assert.equal(leases.delete(retained.id), true, 'Native lease released twice')
    },
    snapshot() {
      throw new Error('Menu modal bookkeeping must not copy script objects')
    },
  }
  let modals!: MenuModals
  const loop = new ModalLoop(objects, control, {
    hasWork: () => false,
    dispatch: () => ({ kind: 'value', value: undefined }),
    beforeWait: (current) => modals.beforeWait(current),
    changed: () => hooks.changed?.(),
  })
  modals = new MenuModals(tree, loop, (view) => {
    // The adapter is an event producer; no script callback is executed here.
    notifications.push(view)
    notificationStates.push({ scopes: modals.count, popup: tree.hasPopup })
  })
  await loop.host('Modal.bind', [object()])
  const root = tree.create(''),
    view = tree.create('Actions'),
    leaf = tree.create('Choose'),
    second = tree.create('Other')
  tree.setRoot(root, 11)
  tree.insert(root, view, 0)
  tree.insert(view, leaf, 0)
  tree.insert(view, second, 1)
  const item: MenuRecord = {
    id: 101,
    view,
    owner: weak(),
    state: weak(),
    children: new Map(),
    nextSlot: 0,
    closing: false,
    finished: false,
  }
  const popup = () => {
    const current = tree.snapshot(11).popup
    assert.ok(current, 'Expected a visible pending popup')
    return current
  }
  const host = (operation: string, current: number) => loop.host(operation, [BigInt(current)])
  return {
    tree,
    loop,
    modals,
    item,
    leaf,
    second,
    control,
    leases,
    notifications,
    notificationStates,
    hooks,
    popup,
    host,
    show: (identity: string, flags = 0) => token(modals.show(item, identity, flags, 12, 34)),
    async choose(selected = leaf) {
      const current = popup()
      assert.equal(tree.choose(selected, current.windowId, current.requestId), false)
      // Resolve the actual MenuTree result into MenuModals without polling.
      await Promise.resolve()
    },
    async result(current: number, expected: bigint | undefined) {
      assert.deepEqual(await host('Modal.wait', current), { kind: 'value', value: 0n })
      assert.deepEqual(await host('Modal.result', current), { kind: 'value', value: expected })
    },
    stop() {
      control.cancel()
      try {
        loop.dispose()
      } finally {
        tree.clear()
      }
      assert.equal(modals.count, 0)
      assert.equal(loop.depth, 0)
      assert.equal(loop.pendingWaits, 0)
      assert.equal(leases.size, 0)
    },
  }
}

function failures(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(failures) : [error]
}

test('menu selection finishes only at its wait and enqueues notification only after popup cleanup', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const baseline = f.leases.size,
    current = f.show('ordinary')
  assert.equal(baseline, 1, 'Only the shared TJS modal pump is retained')
  assert.equal(f.leases.size, baseline)
  assert.deepEqual(f.popup(), {
    id: f.item.view,
    windowId: 11,
    requestId: 1,
    flags: 0,
    x: 12,
    y: 34,
  })
  await f.choose()
  assert.equal(f.tree.snapshot(11).popup, undefined)
  assert.equal(f.tree.hasPopup, true)
  assert.equal(f.modals.count, 1)
  assert.ok(f.loop.info(current))
  await assert.rejects(f.host('Modal.result', current), /not ready/)
  assert.deepEqual(f.notifications, [])
  await f.result(current, 1n)
  assert.equal(f.tree.hasPopup, true)
  assert.equal(f.modals.count, 1)
  assert.deepEqual(f.notifications, [])
  await f.host('Modal.end', current)
  assert.equal(f.tree.hasPopup, false)
  assert.equal(f.modals.count, 0)
  assert.equal(f.leases.size, baseline)
  assert.deepEqual(f.notifications, [f.leaf])
  assert.deepEqual(f.notificationStates, [{ scopes: 0, popup: false }])
})

test('return-command popup preserves its selected Word command when the view is later removed', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const current = f.show('return-command', 0x100),
    command = f.tree.command(f.leaf)
  assert.ok(command > 0 && command <= 0xffff)
  await f.choose()
  f.tree.destroy(f.leaf)
  await f.result(current, BigInt(command))
  assert.equal(f.tree.hasPopup, true)
  await f.host('Modal.end', current)
  assert.deepEqual(f.notifications, [])
})

test('N alone retains the observed original command notification while N|R returns a command without notification', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  // The pinned original SDK delivered N-only keyboard selections after popup
  // returned in 34995723956. Its incomplete cases remain preserved separately.
  for (const flags of [0x80, 0x180]) {
    const current = f.show(`no-notify-${flags}`, flags)
    await f.choose()
    await f.result(current, flags & 0x100 ? BigInt(f.tree.command(f.leaf)) : 1n)
    await f.host('Modal.end', current)
    assert.deepEqual(f.notifications, [f.leaf])
  }
})

test('explicit dismissal returns BOOL success without R and zero with R, with no selection notification', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  for (const flags of [0, 0x100]) {
    const current = f.show(`dismiss-${flags}`, flags),
      popup = f.popup()
    f.tree.dismiss(popup.windowId, popup.requestId)
    await Promise.resolve()
    await f.result(current, flags & 0x100 ? 0n : 1n)
    await f.host('Modal.end', current)
    assert.deepEqual(f.notifications, [])
  }
})

test('lifecycle unavailability returns zero and a nested popup without Q leaves its caller untouched', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  for (const flags of [0, 0x100]) {
    const current = f.show(`unavailable-${flags}`, flags),
      popup = f.popup()
    assert.deepEqual(f.modals.show(f.item, `denied-${flags}`, 0, 0, 0), {
      kind: 'value',
      value: 0n,
    })
    assert.equal(f.modals.abort(`denied-${flags}`), false)
    assert.equal(f.modals.count, 1)
    assert.equal(f.loop.activeToken, current)
    assert.deepEqual(f.popup(), popup)
    f.tree.dismiss(popup.windowId, popup.requestId, 'unavailable')
    await Promise.resolve()
    await f.result(current, 0n)
    await f.host('Modal.end', current)
  }
  assert.deepEqual(f.notifications, [])
})

test('a ready ancestor menu does not finish or cancel a child Window before that Window unwinds', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('ancestor-menu'),
    child = f.loop.open({ kind: 'window', ownerId: 22, windowId: 22 })
  f.loop.invoke(child)
  await f.choose()
  f.modals.beforeWait(parent)
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.loop.modalWindowId, 22)
  assert.equal(f.loop.depth, 2)
  assert.equal(f.modals.count, 1)
  assert.deepEqual(f.notifications, [])
  // The accepted ancestor must not mark its scope terminal early: a child
  // Window can still run another nested modal before returning.
  const grandchild = f.loop.open({ kind: 'window', ownerId: 33, windowId: 33 })
  f.loop.invoke(grandchild)
  f.loop.finish(grandchild)
  await f.result(grandchild, undefined)
  await f.host('Modal.end', grandchild)
  f.loop.finish(child)
  await f.result(child, undefined)
  await f.host('Modal.end', child)
  assert.equal(f.loop.activeToken, parent)
  await f.result(parent, 1n)
  assert.deepEqual(f.notifications, [])
  await f.host('Modal.end', parent)
  assert.deepEqual(f.notifications, [f.leaf])
})

test('a selected nested menu keeps its own command until release while its unavailable parent waits', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('outer'),
    parentPopup = f.popup(),
    child = f.show('inner', 0x101),
    command = f.tree.command(f.second)
  await f.choose(f.second)
  f.tree.dismiss(parentPopup.windowId, parentPopup.requestId, 'unavailable')
  await Promise.resolve()
  f.modals.beforeWait(parent)
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.modals.count, 2)
  await f.result(child, BigInt(command))
  assert.deepEqual(f.modals.show(f.item, 'while-child-returning', 0, 0, 0), {
    kind: 'value',
    value: 0n,
  })
  assert.equal(f.modals.count, 2)
  assert.equal(f.tree.hasPopup, true)
  assert.deepEqual(await f.host('Modal.result', child), {
    kind: 'value',
    value: BigInt(command),
  })
  await f.host('Modal.end', child)
  assert.equal(f.modals.count, 1)
  assert.equal(f.loop.activeToken, parent)
  await f.result(parent, 0n)
  await f.host('Modal.end', parent)
  assert.deepEqual(f.notifications, [])
})

test('popup abort matches only its exact request identity and cannot tear down a replacement invocation', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const first = f.show('first'),
    popup = f.popup()
  assert.throws(() => f.modals.show(f.item, 'first', 1, 0, 0), /identity/)
  assert.equal(f.modals.abort('FIRST'), false)
  assert.equal(f.modals.abort('missing'), false)
  assert.deepEqual(f.popup(), popup)
  assert.equal(f.loop.activeToken, first)
  assert.equal(f.modals.abort('first'), true)
  assert.equal(f.modals.count, 0)
  assert.equal(f.tree.hasPopup, false)
  const second = f.show('second')
  assert.notEqual(second, first)
  assert.equal(f.modals.abort('first'), false)
  assert.equal(f.loop.activeToken, second)
  assert.equal(f.modals.count, 1)
  assert.equal(f.modals.abort('second'), true)
  assert.equal(f.modals.abort('second'), false)
  await Promise.resolve()
  assert.equal(f.modals.count, 0)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
  assert.deepEqual(f.notifications, [])
})

test('an abort during opening publication releases the popup once the scope token becomes available', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  let aborted = false
  f.hooks.changed = () => {
    if (!aborted) aborted = f.modals.abort('opening')
  }
  assert.throws(() => f.show('opening'), /opening has ended/)
  assert.equal(aborted, true)
  assert.equal(f.modals.count, 0)
  assert.equal(f.tree.hasPopup, false)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
  assert.deepEqual(f.notifications, [])
  delete f.hooks.changed
})

test('opening and cleanup publication errors are preserved after removing the menu scope and popup', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const primary = new Error('opening publication failed'),
    cleanup = new Error('cleanup publication failed')
  let calls = 0
  f.hooks.changed = () => {
    throw ++calls === 1 ? primary : cleanup
  }
  assert.throws(
    () => f.show('failed-publication'),
    (error) => {
      assert.deepEqual(failures(error), [primary, cleanup])
      return true
    },
  )
  assert.equal(f.modals.count, 0)
  assert.equal(f.tree.hasPopup, false)
  assert.equal(f.loop.depth, 0)
  assert.equal(f.leases.size, 1)
  assert.equal(f.modals.abort('failed-publication'), false)
  assert.deepEqual(f.notifications, [])
  delete f.hooks.changed
})

test('Stop drops pending, selected and returning menu frames without enqueueing a selection notification', async () => {
  for (const phase of ['pending', 'selected', 'returning']) {
    const f = await fixture()
    try {
      const current = f.show(`stop-${phase}`)
      if (phase !== 'pending') await f.choose()
      if (phase === 'returning') await f.result(current, 1n)
      f.stop()
      await Promise.resolve()
      assert.equal(f.tree.hasPopup, false)
      assert.equal(f.modals.abort(`stop-${phase}`), false)
      assert.deepEqual(f.notifications, [], phase)
    } finally {
      f.stop()
    }
  }
})

test('aborting a selected ancestor cancels its child but retains LIFO cleanup until both callers unwind', async (t) => {
  const f = await fixture()
  t.after(() => f.stop())
  const parent = f.show('abort-ancestor'),
    child = f.loop.open({ kind: 'window', ownerId: 22, windowId: 22 })
  f.loop.invoke(child)
  await f.choose()
  assert.equal(f.modals.abort('abort-ancestor'), true)
  assert.equal(f.loop.activeToken, child)
  assert.equal(f.modals.count, 1)
  assert.equal(f.tree.hasPopup, true)
  await f.result(child, undefined)
  await f.host('Modal.end', child)
  assert.equal(f.loop.activeToken, parent)
  assert.equal(f.modals.count, 1)
  await f.result(parent, 0n)
  await f.host('Modal.end', parent)
  assert.equal(f.modals.count, 0)
  assert.equal(f.tree.hasPopup, false)
  assert.deepEqual(f.notifications, [])
})
