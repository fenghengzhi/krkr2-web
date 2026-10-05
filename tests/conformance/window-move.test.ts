import test from 'node:test'
import assert from 'node:assert/strict'
import { WindowMoves } from '../../src/engine/scene/window-move.ts'
import { WindowState } from '../../src/engine/scene/window.ts'
import type { WindowRecord } from '../../src/engine/scene/windows.ts'
import type { WindowMoveRequest } from '../../src/engine/ports/window-move.ts'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type { HostContext, HostReply, ScriptObject } from '../../src/engine/script/runtime.ts'

function token(reply: HostReply): number {
  assert.equal(reply.kind, 'invoke')
  if (reply.kind !== 'invoke') throw new Error('Expected a native modal continuation')
  return Number(reply.args[0])
}
async function fixture(supported = true) {
  const requests: (WindowMoveRequest | null)[] = [], control = new ExecutionControl(),
    state = new WindowState(), leases = new Set<number>()
  state.visible = true; state.left = 20; state.top = 30
  const window: WindowRecord = { id: 1, state, owner: { type: 'weak-object', id: 2, runtime: 1 },
    cleanup: { type: 'object', id: 3, runtime: 1 }, closing: false, finished: false, resizePending: false, menu: 0 }
  let next = 10, work = false, dispatches = 0, moves!: WindowMoves
  const hooks: { changed?(request: WindowMoveRequest | null): void; position?(): void } = {}
  const objects: HostContext = {
    retain() { const value: ScriptObject = { type: 'object', id: next++, runtime: 1 }; leases.add(value.id); return value },
    release(value) { assert.equal(leases.delete(value.id), true) },
    snapshot() { throw new Error('Move bookkeeping must not copy a script owner') },
  }
  const loop = new ModalLoop(objects, control, {
    changed: () => moves?.present(), beforeWait: (id) => moves.beforeWait(id),
    hasWork: () => work, dispatch: () => { dispatches++; work = false; return { kind: 'value', value: undefined } },
  })
  moves = new WindowMoves(loop, {
    window: (id) => id === 1 && !window.finished ? window : undefined,
    position: (owner, left, top) => { owner.state.set('left', left); owner.state.set('top', top); hooks.position?.() },
    changed: (request) => { requests.push(request); hooks.changed?.(request) },
  }, supported)
  await loop.host('Modal.bind', [{ type: 'object', id: 1, runtime: 1 }])
  return { moves, loop, window, requests, hooks, leases, control,
    work: () => { work = true; loop.notify() }, dispatches: () => dispatches,
    request: () => requests.filter((request): request is WindowMoveRequest => !!request).at(-1)!,
    host: (operation: string, id: number) => loop.host(operation, [BigInt(id)]),
    close: () => loop.dispose() }
}

test('Window movement owns a modal continuation, applies live positions, and commits before returning', async () => {
  const f = await fixture()
  try {
    const id = token(f.moves.begin(1, 'first')), request = f.request()
    assert.deepEqual(request, { requestId: 1, windowId: 1, left: 20, top: 30 })
    assert.equal(f.loop.blockedWindow(1), false, 'A move loop is not a modal Window/dialog and does not clear manager capture')
    assert.equal(f.loop.depth, 1)
    assert.equal(f.leases.size, 1, 'Only the existing shared TJS pump is retained')
    assert.equal(f.moves.receive({ ...request, type: 'update', sequence: 1, left: 45, top: -10 }), true)
    assert.deepEqual([f.window.state.left, f.window.state.top], [45, -10])
    f.work()
    assert.deepEqual(await f.host('Modal.wait', id), { kind: 'value', value: 1n })
    await f.host('Modal.dispatch', id)
    assert.equal(f.dispatches(), 1)
    assert.equal(f.moves.receive({ ...request, type: 'commit', sequence: 2, left: 48, top: -8 }), true)
    f.moves.cancel()
    assert.deepEqual(await f.host('Modal.wait', id), { kind: 'value', value: 0n })
    assert.deepEqual(await f.host('Modal.result', id), { kind: 'value', value: undefined })
    await f.host('Modal.end', id)
    assert.deepEqual([f.window.state.left, f.window.state.top], [48, -8])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.requests.at(-1), null)
  } finally { f.close() }
  assert.equal(f.leases.size, 0)
})

test('only matching monotonic move replies apply, and malformed positions leave the sequence available', async () => {
  const f = await fixture()
  try {
    const id = token(f.moves.begin(1, 'first')), request = f.request()
    assert.equal(f.moves.receive({ ...request, type: 'update', sequence: 2, left: 40, top: 50 }), true)
    assert.equal(f.moves.receive({ ...request, type: 'commit', sequence: 1, left: 800, top: 900 }), false)
    assert.equal(f.moves.receive({ ...request, requestId: request.requestId + 1, type: 'cancel', sequence: 3 }), false)
    assert.equal(f.moves.receive({ ...request, windowId: 2, type: 'cancel', sequence: 3 }), false)
    assert.throws(() => f.moves.receive({ ...request, type: 'update', sequence: 3, left: 0.5, top: 1 }), /position/)
    assert.throws(() => f.moves.receive({ ...request, type: 'error', sequence: 3, message: '' }), /error/)
    assert.equal(f.moves.receive({ ...request, type: 'cancel', sequence: 3 }), true)
    await f.host('Modal.wait', id)
    await f.host('Modal.end', id)
    assert.deepEqual([f.window.state.left, f.window.state.top], [20, 30])
    const next = token(f.moves.begin(1, 'second'))
    assert.notEqual(f.request().requestId, request.requestId)
    assert.equal(f.moves.receive({ ...request, type: 'commit', sequence: 999, left: 900, top: 900 }), false)
    assert.equal(f.moves.abort(1, 'first'), false)
    assert.equal(f.moves.abort(1, 'second'), true)
    assert.equal(f.loop.info(next), undefined)
  } finally { f.close() }
})

test('fullscreen, missing host support and nested moves fail explicitly without replacing the active interaction', async () => {
  const unsupported = await fixture(false), f = await fixture()
  try {
    assert.throws(() => unsupported.moves.begin(1, 'first'), /presentation is unavailable/)
    assert.equal(unsupported.loop.depth, 0)
    f.window.state.fullScreen = true
    assert.throws(() => f.moves.begin(1, 'first'), /fullscreen/)
    f.window.state.fullScreen = false
    f.window.state.borderStyle = 0
    f.window.state.focusable = false
    token(f.moves.begin(1, 'first'))
    assert.throws(() => f.moves.begin(1, 'second'), /already active/)
    assert.equal(f.moves.abort(1, 'second'), false)
    assert.equal(f.loop.depth, 1)
    f.moves.abort(1, 'first')
  } finally { f.close(); unsupported.close() }
})

test('a child modal retires host dragging without cancelling its own TJS scope', async () => {
  const f = await fixture()
  try {
    const parent = token(f.moves.begin(1, 'first')), request = f.request()
    f.moves.receive({ ...request, type: 'update', sequence: 1, left: 70, top: 80 })
    const child = f.loop.open({ kind: 'system-dialog', ownerId: 2 })
    f.loop.invoke(child)
    assert.equal(f.requests.at(-1), null)
    assert.equal(f.loop.isPending(child), true)
    assert.equal(f.moves.receive({ ...request, type: 'commit', sequence: 2, left: 90, top: 100 }), false)
    f.loop.finish(child)
    await f.host('Modal.wait', child)
    await f.host('Modal.end', child)
    await f.host('Modal.wait', parent)
    await f.host('Modal.end', parent)
    assert.deepEqual([f.window.state.left, f.window.state.top], [20, 30])
    assert.equal(f.loop.depth, 0)
  } finally { f.close() }
})

test('host failure returns a script-visible error and restores position; invalidation and Stop retire pending scopes', async () => {
  const f = await fixture()
  try {
    const id = token(f.moves.begin(1, 'first')), request = f.request()
    f.moves.receive({ ...request, type: 'update', sequence: 1, left: 70, top: 80 })
    f.moves.receive({ ...request, type: 'error', sequence: 2, message: 'Unable to capture pointer' })
    await f.host('Modal.wait', id)
    assert.deepEqual(await f.host('Modal.result', id), { kind: 'value', value: 'Unable to capture pointer' })
    await f.host('Modal.end', id)
    assert.deepEqual([f.window.state.left, f.window.state.top], [20, 30])
    const retired = token(f.moves.begin(1, 'second'))
    f.window.closing = true
    f.moves.invalidate(1)
    await f.host('Modal.wait', retired)
    await f.host('Modal.end', retired)
    assert.equal(f.loop.depth, 0)
    f.window.closing = false
    token(f.moves.begin(1, 'third'))
    f.control.cancel()
    f.close()
    assert.equal(f.requests.at(-1), null)
    assert.equal(f.loop.depth, 0)
  } finally { f.close() }
})

test('synchronous completion/reentry during publication and publication/cleanup failures cannot strand a move scope', async () => {
  const f = await fixture()
  try {
    f.hooks.changed = (request) => {
      if (request) f.moves.receive({ ...request, type: 'commit', sequence: 1, left: 25, top: 35 })
    }
    const id = token(f.moves.begin(1, 'first'))
    assert.equal(f.requests.at(-1), null)
    await f.host('Modal.wait', id)
    await f.host('Modal.end', id)
    assert.deepEqual([f.window.state.left, f.window.state.top], [25, 35])
    f.hooks.changed = undefined
    const reentrant = token(f.moves.begin(1, 'reentrant')), request = f.request()
    f.hooks.position = () => {
      f.hooks.position = undefined
      assert.equal(f.moves.receive({ ...request, type: 'update', sequence: 2, left: 90, top: 100 }), true)
    }
    assert.equal(f.moves.receive({ ...request, type: 'commit', sequence: 1, left: 70, top: 80 }), true)
    assert.equal(f.loop.isPending(reentrant), true, 'The earlier commit cannot override a newer synchronous reply')
    assert.deepEqual([f.window.state.left, f.window.state.top], [90, 100])
    f.moves.receive({ ...request, type: 'commit', sequence: 3, left: 95, top: 105 })
    await f.host('Modal.wait', reentrant)
    await f.host('Modal.end', reentrant)
    assert.deepEqual([f.window.state.left, f.window.state.top], [95, 105])
    const first = new Error('publication'), second = new Error('null publication'), third = new Error('rollback')
    f.hooks.changed = (request) => { throw request ? first : second }
    f.hooks.position = () => { throw third }
    let caught: unknown
    try { f.moves.begin(1, 'second') } catch (error) { caught = error }
    const flatten = (error: unknown): unknown[] => error instanceof AggregateError ? error.errors.flatMap(flatten) : [error]
    const failures = flatten(caught)
    for (const failure of [first, second, third]) assert(failures.includes(failure))
    assert.equal(f.loop.depth, 0)
  } finally { f.hooks.changed = undefined; f.hooks.position = undefined; f.close() }
})
