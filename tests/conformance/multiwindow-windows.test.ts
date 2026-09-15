import test from 'node:test'
import assert from 'node:assert/strict'
import { WindowService, type WindowRecord } from '../../src/engine/scene/windows.ts'
import type {
  HostContext,
  ScriptObject,
  ScriptRuntime,
  ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'

function fixture(
  hooks: {
    created?: (window: WindowRecord) => void
    beginning?: (window: WindowRecord) => Promise<void>
    finished?: (window: WindowRecord) => void
    register?: (owner: ScriptObject, operation: string, id: number) => void
  } = {},
) {
  let nextHandle = 1
  const object = (): ScriptObject => ({ type: 'object', id: nextHandle++, runtime: 1 }),
    leases = new Set<ScriptObject>(),
    retainedSources: ScriptObject[] = [],
    released: ScriptObject[] = [],
    unobserved: ScriptWeakObject[] = [],
    observations = new Map<ScriptWeakObject, { owner: ScriptObject; expired: () => void }>(),
    registrations: { owner: ScriptObject; operation: string; id: number }[] = [],
    finished: number[] = []
  const release = (lease: ScriptObject) => {
    assert.equal(leases.delete(lease), true, 'a cleanup lease must be released exactly once')
    released.push(lease)
  }
  const context: HostContext = {
    retain(source) {
      retainedSources.push(source)
      const lease = object()
      leases.add(lease)
      return lease
    },
    release,
    snapshot() {
      throw new Error('Window registration must not snapshot script objects')
    },
  }
  // Only lifetime operations belong in this unit fixture. Executing script is
  // the caller's responsibility after it receives the cleanup invocation.
  const lifetime: Pick<
    ScriptRuntime,
    'observe' | 'unobserve' | 'registerNativeLifetime' | 'release'
  > = {
    observe(owner, expired) {
      const weak: ScriptWeakObject = { type: 'weak-object', id: nextHandle++, runtime: 1 }
      observations.set(weak, { owner, expired })
      return weak
    },
    unobserve(weak) {
      assert.equal(observations.delete(weak), true, 'each observation must be revoked once')
      unobserved.push(weak)
    },
    registerNativeLifetime(owner, operation, id) {
      hooks.register?.(owner, operation, id)
      registrations.push({ owner, operation, id })
    },
    release,
  }
  const service = new WindowService(
    lifetime as ScriptRuntime,
    (window) => hooks.created?.(window),
    (window) => hooks.beginning?.(window) ?? Promise.resolve(),
    (window) => {
      finished.push(window.id)
      hooks.finished?.(window)
    },
  )
  return {
    service,
    leases,
    retainedSources,
    released,
    unobserved,
    observations,
    registrations,
    finished,
    add() {
      const owner = object(),
        cleanup = object(),
        record = service.create(owner, cleanup, context)
      return { owner, cleanup, record }
    },
    expire(owner: ScriptObject) {
      for (const observation of [...observations.values()])
        if (observation.owner === owner) observation.expired()
    },
  }
}

function gate() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('the first registered window remains main independently of visibility and activation', () => {
  const f = fixture(),
    a = f.add(),
    b = f.add()
  assert.equal(a.record.state.visible, false)
  assert.equal(f.service.main, a.record.owner)
  assert.equal(f.service.mainId, a.record.id)
  assert.equal(f.service.active, a.record)
  assert.deepEqual(f.service.registered(), [a.record, b.record])
  assert.equal(f.service.activate(b.record.id), a.record)
  assert.equal(f.service.active, b.record)
  assert.equal(f.service.main, a.record.owner)
  assert.equal(f.service.activate(0), b.record)
  assert.equal(f.service.active, undefined)
  assert.equal(f.service.main, a.record.owner)
  assert.deepEqual(f.registrations, [
    { owner: a.owner, operation: 'Window.invalidate', id: a.record.id },
    { owner: b.owner, operation: 'Window.invalidate', id: b.record.id },
  ])
  assert.deepEqual(f.retainedSources, [a.cleanup, b.cleanup])
  f.service.dispose()
})

test('retiring main never promotes another window until the registration set becomes empty', () => {
  const f = fixture(),
    a = f.add(),
    b = f.add()
  b.record.state.set('visible', 1)
  f.service.finish(a.record.id)
  assert.equal(f.service.main, null)
  assert.equal(f.service.mainId, 0)
  assert.equal(f.service.active, b.record)
  const c = f.add()
  assert.equal(f.service.main, null)
  assert.deepEqual(f.service.registered(), [b.record, c.record])
  f.service.finish(b.record.id)
  f.service.finish(c.record.id)
  assert.deepEqual(f.service.registered(), [])
  assert.equal(f.service.count, 3, 'finished owners can outlive their registration')
  const d = f.add()
  assert.equal(f.service.main, d.record.owner)
  assert.equal(f.service.active, d.record)
  assert.ok(d.record.id > c.record.id)
  f.service.dispose()
})

test('invalidation unregisters before awaiting resource cleanup and preserves other windows', async () => {
  const pending = gate()
  let began: WindowRecord | undefined
  const f = fixture({
      beginning(window) {
        began = window
        assert.equal(f.service.main, null)
        assert.equal(f.service.active, b.record)
        assert.deepEqual(f.service.registered(), [b.record])
        return pending.promise
      },
    }),
    a = f.add(),
    b = f.add()
  b.record.state.set('visible', 1)
  const invalidation = f.service.invalidate(a.record.id, a.owner)
  assert.equal(began, a.record)
  assert.equal(a.record.closing, true)
  assert.equal(a.record.finished, false)
  assert.equal(f.service.closing, 1)
  assert.equal(f.leases.size, 2)
  const c = f.add()
  assert.equal(f.service.main, null)
  pending.resolve()
  assert.deepEqual(await invalidation, {
    kind: 'invoke',
    callback: a.record.cleanup,
    args: [a.owner, BigInt(a.record.id)],
  })
  f.service.finish(a.record.id)
  assert.deepEqual(f.service.registered(), [b.record, c.record])
  assert.equal(f.service.active, b.record)
  f.service.dispose()
})

test('a new main survives the previous main completing delayed cleanup and weak retirement', async () => {
  const pending = gate(),
    f = fixture({ beginning: () => pending.promise }),
    a = f.add(),
    invalidation = f.service.invalidate(a.record.id, a.owner)
  assert.equal(f.service.active, undefined)
  const b = f.add()
  assert.equal(f.service.main, b.record.owner)
  assert.equal(f.service.active, b.record)
  pending.resolve()
  await invalidation
  f.service.finish(a.record.id)
  f.expire(a.owner)
  assert.equal(f.service.main, b.record.owner)
  assert.equal(f.service.mainId, b.record.id)
  assert.equal(f.service.active, b.record)
  assert.deepEqual(f.service.registered(), [b.record])
  assert.equal(f.service.count, 1)
  f.service.dispose()
})

test('active retirement falls back only to a visible focusable registered window', () => {
  const f = fixture(),
    a = f.add(),
    b = f.add(),
    c = f.add(),
    d = f.add()
  b.record.state.set('visible', 1)
  c.record.state.set('visible', 1)
  c.record.state.set('focusable', 0)
  f.service.finish(a.record.id)
  assert.equal(f.service.active, b.record)
  assert.throws(() => f.service.activate(a.record.id), /invalidated/)
  assert.equal(f.service.active, b.record)
  assert.throws(() => f.service.activate(d.record.id + 100), /invalidated/)
  assert.equal(f.service.active, b.record)
  f.service.finish(b.record.id)
  assert.equal(f.service.active, undefined)
  assert.deepEqual(f.service.registered(), [c.record, d.record])
  f.service.dispose()
})

test('window ownership is weak while the cleanup lease lasts until actual retirement', async () => {
  const f = fixture(),
    a = f.add(),
    weak = a.record.owner,
    expired = f.observations.get(weak)!.expired
  assert.notEqual(weak.type, a.owner.type)
  assert.deepEqual(f.retainedSources, [a.cleanup])
  f.service.finish(a.record.id)
  f.service.finish(a.record.id)
  assert.equal(f.leases.has(a.record.cleanup), true)
  assert.equal(f.observations.has(weak), true)
  assert.deepEqual(f.finished, [a.record.id])
  assert.deepEqual(await f.service.invalidate(a.record.id, a.owner), {
    kind: 'value',
    value: undefined,
  })
  expired()
  expired()
  assert.equal(f.service.count, 0)
  assert.deepEqual(f.released, [a.record.cleanup])
  assert.deepEqual(f.unobserved, [weak])
  assert.deepEqual(f.finished, [a.record.id])
  assert.throws(() => f.service.get(a.record.id), /invalidated/)
  f.service.dispose()
})

test('a finish callback can register a successor before the previous owner is released', () => {
  let successor: WindowRecord | undefined
  const f = fixture({
      finished(window) {
        if (window.id === a.record.id) successor = f.add().record
      },
    }),
    a = f.add()
  f.expire(a.owner)
  assert.ok(successor)
  assert.equal(f.service.main, successor.owner)
  assert.equal(f.service.active, successor)
  assert.deepEqual(f.service.registered(), [successor])
  assert.equal(f.service.count, 1)
  assert.deepEqual(f.released, [a.record.cleanup])
  f.service.dispose()
})

test('native lifetime registration failure revokes its weak observation and cleanup lease', () => {
  const failure = new Error('native registration failed')
  let fail = true
  const f = fixture({
    register() {
      if (fail) throw failure
    },
  })
  assert.throws(
    () => f.add(),
    (error) => error === failure,
  )
  assert.equal(f.service.count, 0)
  assert.equal(f.service.main, null)
  assert.equal(f.service.active, undefined)
  assert.equal(f.observations.size, 0)
  assert.equal(f.leases.size, 0)
  assert.equal(f.unobserved.length, 1)
  assert.equal(f.released.length, 1)
  fail = false
  const a = f.add()
  assert.equal(f.service.main, a.record.owner)
  assert.ok(a.record.id > 1, 'failed identities cannot be reused by stale notifications')
  f.service.dispose()
})

test('a failed creation rolls back its resources without disturbing an existing main', () => {
  const failure = new Error('surface registration failed'),
    f = fixture({
      created(window) {
        if (window.id === 2) throw failure
      },
    }),
    a = f.add()
  assert.throws(
    () => f.add(),
    (error) => error === failure,
  )
  assert.equal(f.service.main, a.record.owner)
  assert.equal(f.service.active, a.record)
  assert.deepEqual(f.service.registered(), [a.record])
  assert.equal(f.observations.size, 1)
  assert.equal(f.leases.size, 1)
  assert.equal(f.released.length, 1)
  const c = f.add()
  assert.ok(c.record.id > 2)
  f.service.dispose()
})

test('creation rollback leaves a reentrantly registered and activated successor intact', () => {
  const failure = new Error('outer creation failed')
  let successor: WindowRecord | undefined
  const f = fixture({
    created(window) {
      if (window.id !== 1) return
      f.service.finish(window.id)
      successor = f.add().record
      f.service.activate(successor.id)
      throw failure
    },
  })
  assert.throws(
    () => f.add(),
    (error) => error === failure,
  )
  assert.ok(successor)
  assert.equal(f.service.main, successor.owner)
  assert.equal(f.service.active, successor)
  assert.deepEqual(f.service.registered(), [successor])
  assert.equal(f.observations.size, 1)
  assert.equal(f.leases.size, 1)
  f.service.dispose()
})

test('creation rollback cannot restore an active window invalidated by the creation callback', () => {
  const failure = new Error('new window failed'),
    f = fixture({
      created(window) {
        if (window.id !== 2) return
        f.service.activate(window.id)
        f.service.finish(a.record.id)
        throw failure
      },
    }),
    a = f.add()
  assert.throws(
    () => f.add(),
    (error) => error === failure,
  )
  assert.deepEqual(f.service.registered(), [])
  assert.equal(f.service.main, null)
  assert.equal(f.service.active, undefined)
  const c = f.add()
  assert.equal(f.service.main, c.record.owner)
  assert.equal(f.service.active, c.record)
  f.service.dispose()
})

test('a failed resource cleanup leaves the invalidated window unregistered and releasable', async () => {
  const failure = new Error('media cleanup failed'),
    f = fixture({
      beginning: async () => {
        throw failure
      },
    }),
    a = f.add()
  await assert.rejects(f.service.invalidate(a.record.id, a.owner), (error) => error === failure)
  assert.equal(f.service.main, null)
  assert.equal(f.service.active, undefined)
  assert.deepEqual(f.service.registered(), [])
  assert.equal(f.leases.has(a.record.cleanup), true)
  const b = f.add()
  f.expire(a.owner)
  assert.equal(f.service.main, b.record.owner)
  assert.equal(f.service.active, b.record)
  assert.deepEqual(f.released, [a.record.cleanup])
  f.service.dispose()
})

test('dispose releases every window even when a finish observer throws and remains idempotent', () => {
  const firstFailure = new Error('first finish failed'),
    secondFailure = new Error('second finish failed'),
    f = fixture({
      finished(window) {
        throw window.id === 1 ? firstFailure : secondFailure
      },
    }),
    a = f.add(),
    b = f.add()
  assert.throws(
    () => f.service.dispose(),
    (error) => error === firstFailure,
  )
  assert.equal(f.service.count, 0)
  assert.equal(f.service.main, null)
  assert.equal(f.service.active, undefined)
  assert.equal(f.observations.size, 0)
  assert.equal(f.leases.size, 0)
  assert.deepEqual(f.finished, [a.record.id, b.record.id])
  assert.deepEqual(f.released, [a.record.cleanup, b.record.cleanup])
  assert.doesNotThrow(() => f.service.dispose())
  assert.throws(() => f.add(), /disposed/)
  assert.equal(f.retainedSources.length, 2)
})

test('dispose forbids reentrant creation before it begins retiring any window', () => {
  const f = fixture({
    finished() {
      assert.throws(() => f.add(), /disposed/)
    },
  })
  f.add()
  f.add()
  f.service.dispose()
  assert.equal(f.service.count, 0)
  assert.equal(f.leases.size, 0)
  assert.equal(f.retainedSources.length, 2)
})
