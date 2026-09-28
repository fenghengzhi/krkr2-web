import test from 'node:test'
import assert from 'node:assert/strict'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type { HostContext, HostReply, ScriptObject } from '../../src/engine/script/runtime.ts'

const object = (id: number): ScriptObject => ({ type: 'object', id, runtime: 1 })
const empty: HostReply = { kind: 'value', value: undefined }

/** The real scheduler and execution control, with inert object leases only.
 * No helper executes a TJS continuation or substitutes a simulated event pump. */
function fixture(changed?: (phase: 'open' | 'release', loop: ModalLoop) => void) {
  const control = new ExecutionControl(),
    leases = new Set<number>(),
    changes: string[] = []
  let next = 100,
    retains = 0,
    releases = 0,
    reads = 0,
    dispatches = 0
  const objects: HostContext = {
    retain() {
      retains++
      const lease = object(next++)
      leases.add(lease.id)
      return lease
    },
    release(lease) {
      assert(leases.delete(lease.id), 'A pump lease must retire exactly once')
      releases++
    },
    snapshot() {
      throw new Error('Host scopes must not read script object data')
    },
  }
  const loop: ModalLoop = new ModalLoop(objects, control, {
    hasWork() {
      reads++
      return false
    },
    dispatch() {
      dispatches++
      throw new Error('Host scope must not dispatch TJS work')
    },
    changed(phase) {
      changes.push(phase)
      changed?.(phase, loop)
    },
  })
  return {
    loop,
    control,
    leases,
    changes,
    counts: () => ({ retains, releases, reads, dispatches }),
    bind: () => loop.host('Modal.bind', [object(1)]),
    host: (operation: string, token: number) => loop.host(operation, [BigInt(token)]),
    dispose() {
      try {
        loop.dispose()
      } finally {
        control.cancel()
      }
    },
  }
}

function flattened(error: unknown): unknown[] {
  return error instanceof AggregateError ? error.errors.flatMap(flattened) : [error]
}
function exactErrors(expected: unknown[]) {
  return (error: unknown): boolean => {
    const actual = flattened(error)
    assert.equal(actual.length, expected.length)
    actual.forEach((value, index) => assert.equal(value, expected[index]))
    return true
  }
}
async function checkpoint() {
  await Promise.resolve()
  await Promise.resolve()
}

test('Pad save opens and finishes while execution is paused without a pump or a VM dispatch', async () => {
  const f = fixture(),
    cleanup: string[] = []
  let resumed = false
  f.control.pause()
  f.loop.setPaused(true)
  const paused = f.control.wait().then(() => {
    resumed = true
  })
  try {
    assert.throws(() => f.loop.open({ kind: 'window', ownerId: 1 }), /unavailable/)
    const token = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 1,
      cleanup: () => cleanup.push('save'),
    })
    assert.equal(f.loop.activeToken, token)
    assert.equal(f.loop.hasTjsContinuation, false)
    assert.equal(f.loop.blockedWindow(1), true)
    assert.equal(f.loop.blockedWindow(200), true)
    assert.equal(f.loop.modalWindowId, undefined)
    await checkpoint()
    assert.equal(resumed, false)
    assert.equal(f.loop.finishHost(token), true)
    assert.equal(f.loop.finishHost(token), false, 'A duplicate receipt has no scope to complete')
    assert.equal(f.loop.depth, 0)
    assert.equal(f.loop.blockedWindow(1), false)
    assert.deepEqual(cleanup, ['save'])
    assert.deepEqual(f.changes, ['open', 'release'])
    assert.deepEqual(f.counts(), { retains: 0, releases: 0, reads: 0, dispatches: 0 })
    assert.equal(f.control.paused, true)
    await checkpoint()
    assert.equal(resumed, false, 'Host completion must not resume the VM')
  } finally {
    f.dispose()
    await paused
  }
})

test('host scopes accept only Pad saves and cannot enter the native modal continuation', async () => {
  const f = fixture()
  try {
    for (const kind of ['window', 'menu', 'system-dialog'] as const)
      assert.throws(() => f.loop.openHost({ kind, ownerId: 1 }), /Unsupported host modal scope/)
    assert.equal(f.loop.depth, 0)
    await f.bind()
    const token = f.loop.openHost({ kind: 'pad-save', ownerId: 1 })
    assert.throws(() => f.loop.invoke(token), /current scope exactly once/)
    for (const operation of ['Modal.wait', 'Modal.dispatch', 'Modal.result'])
      await assert.rejects(f.host(operation, token), /continuation is not active/)
    assert.equal(f.loop.isPending(token), true)
    assert.equal(f.loop.pendingWaits, 0)
    assert.equal(f.counts().dispatches, 0)
    assert.equal(f.loop.finishHost(token), true)
    assert.equal(f.leases.size, 1, 'Finishing a host scope must not release the shared TJS pump')
  } finally {
    f.dispose()
  }
  assert.equal(f.counts().releases, 1)
})

test('a Pad receipt cannot complete a native scope even when owner identifiers coincide', async () => {
  const f = fixture(),
    cleanup: string[] = []
  try {
    await f.bind()
    const native = f.loop.open({
      kind: 'window',
      ownerId: 7,
      cleanup: () => cleanup.push('native'),
    })
    assert.equal(f.loop.hasTjsContinuation, false)
    f.loop.invoke(native)
    assert.equal(f.loop.hasTjsContinuation, true)
    const host = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 7,
      cleanup: () => cleanup.push('host'),
    })
    assert.notEqual(host, native)
    assert.equal(f.loop.finishHost(native), false)
    assert.equal(f.loop.isPending(native), true)
    assert.equal(f.loop.isPending(host), true)
    assert.equal(f.loop.activeToken, host)
    assert.equal(f.loop.hasTjsContinuation, true, 'A host child does not replace its TJS caller')
    assert.deepEqual(cleanup, [])
    assert.equal(f.loop.finishHost(host), true)
    assert.deepEqual(cleanup, ['host'])
    assert.equal(f.loop.activeToken, native)
    assert.equal(f.loop.isPending(native), true)
    assert.equal(f.loop.finishHost(native), false)
    f.loop.finish(native, 19n)
    assert.deepEqual(await f.host('Modal.wait', native), { kind: 'value', value: 0n })
    assert.deepEqual(await f.host('Modal.result', native), { kind: 'value', value: 19n })
    assert.equal(f.loop.depth, 1, 'A terminal native result still owns its frame')
    assert.equal(f.loop.hasTjsContinuation, true)
    await f.host('Modal.end', native)
    assert.equal(f.loop.hasTjsContinuation, false)
    assert.deepEqual(cleanup, ['host', 'native'])
  } finally {
    f.dispose()
  }
})

test('deep host and native nesting retires in LIFO order only as native children actually unwind', async () => {
  const f = fixture(),
    cleanup: string[] = []
  try {
    await f.bind()
    const a = f.loop.openHost({ kind: 'pad-save', ownerId: 1, cleanup: () => cleanup.push('a') })
    const b = f.loop.open({ kind: 'window', ownerId: 2, cleanup: () => cleanup.push('b') })
    f.loop.invoke(b)
    const c = f.loop.openHost({ kind: 'pad-save', ownerId: 3, cleanup: () => cleanup.push('c') })
    const d = f.loop.open({ kind: 'system-dialog', ownerId: 4, cleanup: () => cleanup.push('d') })
    f.loop.invoke(d)
    const e = f.loop.openHost({ kind: 'pad-save', ownerId: 5, cleanup: () => cleanup.push('e') })
    assert.equal(f.loop.depth, 5)
    assert.equal(f.loop.info(e)?.parentToken, d)
    assert.equal(f.loop.info(d)?.parentToken, c)
    assert.equal(f.loop.info(c)?.parentToken, b)
    assert.equal(f.loop.info(b)?.parentToken, a)
    assert.equal(f.loop.finishHost(a), true)
    assert.deepEqual(cleanup, ['e'])
    assert.equal(f.loop.depth, 4)
    assert.equal(f.loop.activeToken, d)
    for (const token of [a, b, c, d]) {
      assert(f.loop.info(token), 'Ended native frames and their parents remain represented')
      assert.equal(f.loop.isPending(token), false)
    }
    assert.throws(() => f.loop.release(a), /LIFO/)
    assert.deepEqual(cleanup, ['e'])
    assert.deepEqual(await f.host('Modal.wait', d), { kind: 'value', value: 0n })
    assert.deepEqual(await f.host('Modal.result', d), empty)
    await f.host('Modal.end', d)
    assert.deepEqual(cleanup, ['e', 'd', 'c'])
    assert.equal(f.loop.activeToken, b)
    assert.equal(f.loop.depth, 2)
    assert.equal(f.loop.finishHost(b), false)
    assert.deepEqual(await f.host('Modal.wait', b), { kind: 'value', value: 0n })
    await f.host('Modal.end', b)
    assert.deepEqual(cleanup, ['e', 'd', 'c', 'b', 'a'])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.loop.pendingWaits, 0)
    assert.equal(f.counts().dispatches, 0)
    for (const token of [a, c, e]) assert.equal(f.loop.finishHost(token), false)
  } finally {
    f.dispose()
  }
})

test('cancelling a Pad owner preserves its native child frame until release while paused', async () => {
  const f = fixture(),
    cleanup: string[] = []
  try {
    await f.bind()
    const parent = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 8,
      cleanup: () => cleanup.push('parent'),
    })
    const child = f.loop.open({ kind: 'window', ownerId: 8, cleanup: () => cleanup.push('child') })
    f.loop.invoke(child)
    f.control.pause()
    f.loop.setPaused(true)
    const waiting = f.host('Modal.wait', child)
    assert.equal(f.loop.pendingWaits, 1)
    f.loop.cancelOwner('pad-save', 9, 'unrelated')
    assert.equal(f.loop.isPending(parent), true)
    f.loop.cancelOwner('pad-save', 8, 'hidden')
    assert.deepEqual(await waiting, { kind: 'value', value: 0n })
    assert.equal(f.loop.depth, 2)
    assert.deepEqual(cleanup, [])
    assert.equal(f.loop.finishHost(parent), false, 'A late receipt cannot replace cancellation')
    assert.equal(f.loop.activeToken, child)
    assert.deepEqual(await f.host('Modal.dispatch', child), empty)
    await f.host('Modal.end', child)
    assert.deepEqual(cleanup, ['child', 'parent'])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.control.paused, true)
    assert.deepEqual(f.counts(), { retains: 1, releases: 0, reads: 0, dispatches: 0 })
  } finally {
    f.dispose()
  }
})

test('cancelling a native ancestor automatically retires only its host descendants', async () => {
  const f = fixture(),
    cleanup: string[] = []
  try {
    await f.bind()
    const native = f.loop.open({
      kind: 'window',
      ownerId: 1,
      cleanup: () => cleanup.push('native'),
    })
    f.loop.invoke(native)
    const first = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 2,
      cleanup: () => cleanup.push('first'),
    })
    const second = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 3,
      cleanup: () => cleanup.push('second'),
    })
    assert.equal(f.loop.cancel(native, 'closed'), true)
    assert.deepEqual(cleanup, ['second', 'first'])
    assert.equal(f.loop.activeToken, native)
    assert.equal(f.loop.depth, 1)
    assert.equal(f.loop.finishHost(first), false)
    assert.equal(f.loop.finishHost(second), false)
    await f.host('Modal.wait', native)
    await f.host('Modal.end', native)
    assert.deepEqual(cleanup, ['second', 'first', 'native'])
  } finally {
    f.dispose()
  }
})

test('Stop retires host and native scopes once, wakes pending waits, and ignores late receipts even when cleanup throws', async () => {
  const f = fixture(),
    cleanup: string[] = [],
    failure = new Error('host cleanup failed')
  await f.bind()
  const parent = f.loop.openHost({
    kind: 'pad-save',
    ownerId: 1,
    cleanup: () => cleanup.push('parent'),
  })
  const native = f.loop.open({ kind: 'window', ownerId: 2, cleanup: () => cleanup.push('native') })
  f.loop.invoke(native)
  const child = f.loop.openHost({
    kind: 'pad-save',
    ownerId: 3,
    cleanup: () => {
      cleanup.push('child')
      throw failure
    },
  })
  const waiting = assert.rejects(f.host('Modal.wait', native), /Execution cancelled/)
  f.control.cancel()
  assert.throws(() => f.loop.dispose(), exactErrors([failure]))
  await waiting
  assert.deepEqual(cleanup, ['child', 'native', 'parent'])
  assert.equal(f.loop.depth, 0)
  assert.equal(f.loop.pendingWaits, 0)
  assert.equal(f.leases.size, 0)
  assert.equal(f.counts().releases, 1)
  assert.equal(f.loop.finishHost(parent), false)
  assert.equal(f.loop.finishHost(child), false)
  assert.equal(f.loop.cancel(parent, 'late'), false)
  await f.host('Modal.end', native)
  f.dispose()
  assert.deepEqual(cleanup, ['child', 'native', 'parent'])
  assert.equal(f.counts().releases, 1)
  assert.equal(f.counts().dispatches, 0)
})

test('host retirement drains all ended host ancestors and preserves every cleanup error', () => {
  const f = fixture(),
    cleanup: string[] = [],
    first = new Error('parent cleanup'),
    second = new Error('child cleanup')
  try {
    const parent = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 1,
      cleanup: () => {
        cleanup.push('parent')
        throw first
      },
    })
    const child = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 2,
      cleanup: () => {
        cleanup.push('child')
        throw second
      },
    })
    assert.throws(() => f.loop.finishHost(parent), exactErrors([second, first]))
    assert.deepEqual(cleanup, ['child', 'parent'])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.loop.finishHost(parent), false)
    assert.equal(f.loop.finishHost(child), false)
    assert.deepEqual(f.changes, ['open', 'open', 'release', 'release'])
  } finally {
    f.dispose()
  }
})

test('native release and automatic host ancestor cleanup both survive and report their errors', async () => {
  const f = fixture(),
    cleanup: string[] = [],
    nativeFailure = new Error('native cleanup'),
    hostFailure = new Error('host cleanup')
  try {
    await f.bind()
    const parent = f.loop.openHost({
      kind: 'pad-save',
      ownerId: 1,
      cleanup: () => {
        cleanup.push('host')
        throw hostFailure
      },
    })
    const child = f.loop.open({
      kind: 'window',
      ownerId: 2,
      cleanup: () => {
        cleanup.push('native')
        throw nativeFailure
      },
    })
    f.loop.invoke(child)
    assert.equal(f.loop.finishHost(parent), true)
    assert.deepEqual(cleanup, [])
    await f.host('Modal.wait', child)
    await assert.rejects(f.host('Modal.end', child), exactErrors([nativeFailure, hostFailure]))
    assert.deepEqual(cleanup, ['native', 'host'])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.loop.finishHost(parent), false)
  } finally {
    f.dispose()
  }
})

test('failed Pad publication removes its scope, preserves publication and cleanup errors, and leaves its native parent live', async () => {
  const publication = new Error('publish failed'),
    cleanup = new Error('cleanup failed'),
    release = new Error('release publication failed')
  let failOpen = false,
    failRelease = false,
    failedToken: number | undefined,
    cleanups = 0
  const f = fixture((phase, loop) => {
    if (phase === 'open' && failOpen) {
      failedToken = loop.activeToken
      throw publication
    }
    if (phase === 'release' && failRelease) {
      failRelease = false
      throw release
    }
  })
  try {
    await f.bind()
    const parent = f.loop.open({ kind: 'window', ownerId: 1 })
    f.loop.invoke(parent)
    failOpen = failRelease = true
    assert.throws(
      () =>
        f.loop.openHost({
          kind: 'pad-save',
          ownerId: 2,
          cleanup: () => {
            cleanups++
            throw cleanup
          },
        }),
      exactErrors([publication, cleanup, release]),
    )
    assert.notEqual(failedToken, undefined)
    assert.equal(f.loop.finishHost(failedToken!), false)
    assert.equal(f.loop.info(failedToken!), undefined)
    assert.equal(f.loop.activeToken, parent)
    assert.equal(f.loop.isPending(parent), true)
    assert.equal(f.loop.depth, 1)
    assert.equal(cleanups, 1)
    failOpen = false
    const next = f.loop.openHost({ kind: 'pad-save', ownerId: 2 })
    assert.notEqual(next, failedToken)
    assert.equal(f.loop.finishHost(failedToken!), false)
    assert.equal(f.loop.isPending(next), true)
    assert.equal(f.loop.finishHost(next), true)
  } finally {
    failOpen = failRelease = false
    f.dispose()
  }
})

test('failed publication with a reentrant host child rolls back both invisible scopes in LIFO order', () => {
  const failure = new Error('parent publication failed'),
    cleanup: string[] = []
  let reenter = true,
    child: number | undefined,
    parent: number | undefined
  const f = fixture((phase, loop) => {
    if (phase !== 'open' || !reenter) return
    reenter = false
    parent = loop.activeToken
    child = loop.openHost({ kind: 'pad-save', ownerId: 2, cleanup: () => cleanup.push('child') })
    throw failure
  })
  try {
    assert.throws(
      () =>
        f.loop.openHost({ kind: 'pad-save', ownerId: 1, cleanup: () => cleanup.push('parent') }),
      exactErrors([failure]),
    )
    assert.deepEqual(cleanup, ['child', 'parent'])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.loop.finishHost(parent!), false)
    assert.equal(f.loop.finishHost(child!), false)
    assert.equal(f.counts().dispatches, 0)
  } finally {
    f.dispose()
  }
})

test('failed host publication preserves an entered native child until its explicit frame end', async () => {
  const failure = new Error('host publication failed after native entry'),
    cleanup: string[] = []
  let reenter = true,
    child: number | undefined,
    parent: number | undefined
  const f = fixture((phase, loop) => {
    if (phase !== 'open' || !reenter) return
    reenter = false
    parent = loop.activeToken
    child = loop.open({ kind: 'system-dialog', ownerId: 2, cleanup: () => cleanup.push('native') })
    assert.equal(loop.invoke(child).kind, 'invoke')
    throw failure
  })
  try {
    await f.bind()
    assert.throws(
      () => f.loop.openHost({ kind: 'pad-save', ownerId: 1, cleanup: () => cleanup.push('host') }),
      exactErrors([failure]),
    )
    assert.equal(f.loop.depth, 2)
    assert.equal(f.loop.activeToken, child)
    assert.equal(f.loop.isPending(parent!), false)
    assert.equal(f.loop.isPending(child!), false)
    assert.deepEqual(cleanup, [])
    assert.equal(f.loop.finishHost(parent!), false)
    assert.equal(f.loop.depth, 2)
    assert.deepEqual(await f.host('Modal.wait', child!), { kind: 'value', value: 0n })
    await f.host('Modal.end', child!)
    assert.deepEqual(cleanup, ['native', 'host'])
    assert.equal(f.loop.depth, 0)
    assert.equal(f.loop.finishHost(parent!), false)
    assert.equal(f.counts().dispatches, 0)
  } finally {
    f.dispose()
  }
})

for (const mode of ['finish', 'stop'] as const)
  test(`publication cannot return a live host token after synchronously retiring via ${mode}`, () => {
    let retire = true,
      retired: number | undefined,
      cleanups = 0
    const f = fixture((phase, loop) => {
      if (phase === 'open' && retire) {
        retire = false
        retired = loop.activeToken!
        if (mode === 'finish') loop.finishHost(retired)
        else loop.dispose()
      }
    })
    try {
      assert.throws(
        () =>
          f.loop.openHost({
            kind: 'pad-save',
            ownerId: 1,
            cleanup: () => {
              cleanups++
            },
          }),
        /ended|unavailable|retired/i,
      )
      assert.equal(f.loop.depth, 0)
      assert.equal(cleanups, 1)
      assert.equal(f.loop.finishHost(retired!), false)
      if (mode === 'finish') {
        const next = f.loop.openHost({ kind: 'pad-save', ownerId: 1 })
        assert.notEqual(next, retired)
        assert.equal(f.loop.finishHost(retired!), false)
        assert.equal(f.loop.isPending(next), true)
        f.loop.finishHost(next)
      } else {
        assert.equal(f.loop.stopped, true)
        assert.throws(() => f.loop.openHost({ kind: 'pad-save', ownerId: 1 }), /unavailable/)
      }
    } finally {
      f.dispose()
    }
  })
