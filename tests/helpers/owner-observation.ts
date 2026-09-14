import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import {
  isScriptObject,
  type ScriptObject,
  type ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'
import { executionStats } from './execution-budget.ts'

export const ownerObservationCases = [
  'implicit-release',
  'observer-self-remove',
  'observer-other-remove',
  'explicit-retry',
  'explicit-revoke',
  'upgrade-owner',
  'unobserve',
  'vm-isolation',
  'vm-dispose',
  'invalid-owners',
] as const

const setup = (retry: boolean) => `
var ownerFinalizeCount=0,ownerFailFirst=${retry ? 'true' : 'false'};
class ObservedOwner {function finalize(){ownerFinalizeCount++;if(ownerFailFirst&&ownerFinalizeCount===1)throw new Exception("owner-finalize-first");}}
function makeObservedOwner(){return new ObservedOwner();}
function plainOwnerFunction(){return 42;}
`
const cleanup =
  'delete observedOwner;delete makeObservedOwner;delete plainOwnerFunction;delete ObservedOwner;delete ownerFinalizeCount;delete ownerFailFirst;'

export async function exerciseOwnerObservation(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: string,
  debugMode: boolean,
  binary: boolean,
) {
  check(
    ownerObservationCases.some((item) => item === name),
    'Unknown owner observation case',
  )
  const native = observeNative(factory)
  const vm = await TjsWasmRuntime.create(
    native.factory,
    () => {
      throw new Error('Unexpected owner host call')
    },
    { wasmBinary, variant, debugMode },
  )
  const tokens: ScriptWeakObject[] = [],
    handles: ScriptObject[] = []
  const events: { index: number; upgraded: number[]; weakOwners: number }[] = []
  const observed: Record<string, unknown> = { name, variant, debugMode, binary, events }
  let disposed = false,
    disposalReentries = 0
  const stats = () => ({
    ...native.stats(),
    ...vm.inspect(),
    budget: executionStats(native),
    destructionDepth: native.call('krkr_native_lifetime_stat', 1),
    pendingDestructions: native.call('krkr_native_lifetime_stat', 0),
  })
  const execute = async (source: string, expression = false) =>
    vm.execute(
      binary ? await vm.compile(source, 'owner-observation.tjs', expression) : source,
      'owner-observation.tjs',
      expression,
    )
  const acquire = async (source = 'makeObservedOwner()') => {
    const value = await execute(source, true)
    check(isScriptObject(value), 'Fixture did not return an owner handle')
    handles.push(value as ScriptObject)
    return value as ScriptObject
  }
  const reject = (operation: () => unknown, label: string) => {
    let error: unknown
    try {
      operation()
    } catch (failure) {
      error = failure
    }
    check(error instanceof Error, label + ' was accepted')
    return String(error)
  }
  const watch = (owner: ScriptObject, index: number) => {
    const token = vm.observe(owner, () => {
      const upgraded: number[] = []
      for (const other of tokens) {
        const lease = vm.upgrade(other)
        if (lease) {
          upgraded.push(lease.id)
          handles.push(lease)
          vm.release(lease)
        }
      }
      events.push({ index, upgraded, weakOwners: vm.inspect().weakOwners })
      if (name === 'vm-dispose' && disposalReentries === 0) {
        disposalReentries++
        vm.dispose()
      }
      if (name === 'observer-self-remove') vm.unobserve(tokens[index]!)
      if (name === 'observer-other-remove') for (const other of tokens) vm.unobserve(other)
    })
    tokens.push(token)
    return token
  }
  const drain = async () => {
    check(
      (await vm.execute('6*7', 'owner-release-boundary.tjs', true)) === 42n,
      'Owner release poisoned execution',
    )
    const boundary = stats()
    observed.boundary = boundary
    check(
      boundary.pendingHandles === 0 &&
        boundary.budget.depth === 0 &&
        boundary.budget.bytes === 0 &&
        boundary.destructionDepth === 0 &&
        boundary.pendingDestructions === 0,
      'Owner release retained native work',
    )
    return boundary
  }
  try {
    await vm.execute('var ownerWarm=new Exception("warm");delete ownerWarm;')
    const empty = stats()
    await execute(setup(name === 'explicit-retry'))
    const before = stats()
    observed.before = before
    if (name === 'invalid-owners') {
      const failures: Record<string, string> = {}
      for (const [label, expression] of [
        ['function', 'plainOwnerFunction'],
        ['class', 'ObservedOwner'],
        ['different-context', 'makeObservedOwner() incontextof makeObservedOwner()'],
      ]) {
        const owner = await acquire(expression)
        const prior = stats()
        failures[label!] = reject(
          () => vm.observe(owner, () => events.push({ index: -1, upgraded: [], weakOwners: -1 })),
          'Invalid ' + label + ' owner',
        )
        check(
          vm.inspect().weakOwners === 0 && vm.inspect().scriptObjects === prior.scriptObjects,
          'Rejected observation changed native ownership',
        )
        vm.release(owner)
        await drain()
      }
      const released = await acquire()
      vm.release(released)
      failures.released = reject(() => vm.observe(released, () => {}), 'Released owner')
      await drain()
      await execute('var observedOwner=makeObservedOwner();')
      const invalid = await acquire('observedOwner')
      await execute('invalidate observedOwner;', false)
      failures.invalidated = reject(() => vm.observe(invalid, () => {}), 'Invalidated owner')
      vm.release(invalid)
      await vm.execute('delete observedOwner;')
      await drain()
      observed.rejections = failures
      check(events.length === 0, 'Rejected owner registered a notification')
    } else if (name === 'vm-isolation') {
      const otherNative = observeNative(factory)
      const other = await TjsWasmRuntime.create(
        otherNative.factory,
        () => {
          throw new Error('Unexpected isolated owner host call')
        },
        { wasmBinary, variant, debugMode },
      )
      let otherCalls = 0
      try {
        await other.execute(
          binary ? await other.compile(setup(false), 'other-owner.tjs') : setup(false),
        )
        const otherBefore = other.inspect()
        const value = await other.execute('makeObservedOwner()', 'other-owner.tjs', true)
        check(isScriptObject(value), 'Other VM did not return an owner')
        const owner = await acquire(),
          otherOwner = value as ScriptObject
        const token = watch(owner, 0),
          otherToken = other.observe(otherOwner, () => {
            otherCalls++
          })
        observed.rejections = {
          observe: reject(() => other.observe(owner, () => {}), 'Foreign strong owner'),
          reverseObserve: reject(() => vm.observe(otherOwner, () => {}), 'Reverse foreign owner'),
          upgrade: reject(() => other.upgrade(token), 'Foreign weak upgrade'),
          unobserve: reject(() => other.unobserve(token), 'Foreign weak unsubscribe'),
          reverseUpgrade: reject(() => vm.upgrade(otherToken), 'Reverse foreign weak upgrade'),
        }
        vm.release(owner)
        const boundary = await drain()
        check(
          boundary.scriptObjects === before.scriptObjects &&
            events.length === 1 &&
            otherCalls === 0,
          'One VM revoked another VM owner',
        )
        const lease = other.upgrade(otherToken)
        check(lease, 'Other VM lost its independent owner')
        other.release(lease!)
        other.release(otherOwner)
        await other.execute('6*7', 'other-owner-release.tjs', true)
        const otherAfter = other.inspect()
        observed.other = { before: otherBefore, after: otherAfter, calls: otherCalls }
        check(
          otherCalls === 1 &&
            otherAfter.weakOwners === 0 &&
            otherAfter.handles === 0 &&
            otherAfter.pendingHandles === 0 &&
            otherAfter.scriptObjects === otherBefore.scriptObjects,
          'Other VM did not release its owner',
        )
      } finally {
        other.dispose()
      }
    } else {
      const explicit = name === 'explicit-retry' || name === 'explicit-revoke'
      if (explicit) await execute('var observedOwner=makeObservedOwner();')
      const owner = await acquire(explicit ? 'observedOwner' : 'makeObservedOwner()')
      const owned = stats()
      observed.owned = owned
      check(
        owned.scriptObjects === before.scriptObjects + 1 && owned.handles === 1,
        'Fixture did not hold exactly one native instance',
      )
      const first = watch(owner, 0)
      if (!['upgrade-owner', 'unobserve'].includes(name)) watch(owner, 1)
      const watched = stats()
      observed.watched = watched
      check(
        watched.weakOwners === tokens.length &&
          watched.handles === owned.handles &&
          watched.scriptObjects === owned.scriptObjects,
        'Observation acquired strong ownership',
      )
      if (name === 'vm-dispose') {
        vm.dispose()
        disposed = true
        observed.eventsAfterDispose = events.length
        observed.disposalReentries = disposalReentries
        check(disposalReentries === 1, 'Disposal observer did not reenter disposal exactly once')
        check(
          events.length === 2 && events.every((event) => event.upgraded.length === 0),
          'VM disposal did not revoke every observer before callbacks',
        )
        for (const token of tokens) {
          check(vm.upgrade(token) === undefined, 'Disposed VM upgraded an owner')
          vm.unobserve(token)
        }
        vm.dispose()
        check(events.length === 2, 'Repeated VM disposal notified twice')
        return observed
      }
      if (name === 'unobserve') {
        vm.unobserve(first)
        vm.unobserve(first)
        check(
          vm.upgrade(first) === undefined && vm.inspect().weakOwners === 0,
          'Unsubscribed token remained usable',
        )
        const next = vm.observe(owner, () =>
          events.push({ index: 2, upgraded: [], weakOwners: -1 }),
        )
        check(next.id !== first.id, 'Observation token was reused')
        vm.unobserve(next)
      } else if (name === 'upgrade-owner') {
        const identity = vm.objectIdentity(owner),
          lease = vm.upgrade(first)
        check(
          lease && vm.objectIdentity(lease) === identity,
          'Upgrade did not preserve instance identity',
        )
        handles.push(lease!)
        vm.release(owner)
        const leased = await drain()
        check(
          events.length === 0 &&
            leased.weakOwners === 1 &&
            leased.handles === 1 &&
            leased.scriptObjects === owned.scriptObjects,
          'Upgrade did not keep the last owner alive',
        )
        vm.release(lease!)
      } else if (explicit) {
        if (name === 'explicit-retry') {
          let error: unknown
          try {
            await execute('invalidate observedOwner;')
          } catch (failure) {
            error = failure
          }
          observed.retry = { error: String(error), after: stats() }
          check(
            error instanceof Error &&
              error.name === 'ScriptError' &&
              error.message.includes('owner-finalize-first'),
            'Failed explicit finalizer changed its error',
          )
          check(
            events.length === 0 && vm.inspect().weakOwners === 2,
            'Failed finalizer revoked a still-valid owner',
          )
          const lease = vm.upgrade(first)
          check(lease, 'Failed finalizer made a live owner impossible to upgrade')
          handles.push(lease!)
          vm.release(lease!)
          await drain()
          check(
            (await vm.execute('isvalid observedOwner', 'owner-valid.tjs', true)) === 1n,
            'Failed finalizer invalidated its owner',
          )
        }
        await execute('invalidate observedOwner;')
        const revoked = stats()
        observed.revoked = revoked
        check(
          events.length === 2 &&
            revoked.weakOwners === 0 &&
            revoked.handles === 1 &&
            revoked.scriptObjects === owned.scriptObjects,
          'Explicit invalidation did not revoke observers while retaining the strong object',
        )
        check(vm.upgrade(first) === undefined, 'Invalidated object was upgraded')
        observed.invalidatedObserve = reject(
          () => vm.observe(owner, () => {}),
          'Invalidated observed owner',
        )
        await vm.execute('delete observedOwner;')
      }
      vm.release(owner)
      const boundary = await drain()
      const expected =
        name === 'unobserve'
          ? 0
          : name === 'observer-other-remove' || name === 'upgrade-owner'
            ? 1
            : 2
      check(
        events.length === expected && events.every((event) => event.upgraded.length === 0),
        'Observer callback count or revocation ordering changed',
      )
      check(
        boundary.weakOwners === 0 &&
          boundary.handles === 0 &&
          boundary.scriptObjects === before.scriptObjects,
        'Weak observation retained the released instance',
      )
      for (const token of tokens)
        check(vm.upgrade(token) === undefined, 'Released observation could still upgrade')
      observed.finalizeCount = String(
        await vm.execute('ownerFinalizeCount', 'owner-finalize-count.tjs', true),
      )
      check(
        observed.finalizeCount === (name === 'explicit-retry' ? '2' : '1'),
        'Owner finalized an unexpected number of times',
      )
    }
    check(vm.inspect().weakOwners === 0, 'Owner case left a live observer')
    for (const handle of handles) vm.release(handle)
    await vm.execute(cleanup, 'owner-observation-cleanup.tjs')
    const after = stats()
    observed.after = after
    check(
      after.blocks === empty.blocks &&
        after.contexts === empty.contexts &&
        after.scriptObjects === empty.scriptObjects &&
        after.handles === 0 &&
        after.pendingHandles === 0,
      'Owner observation cleanup retained resources',
    )
    return observed
  } catch (error) {
    throw new Error(`${String(error)}; owner observations=${JSON.stringify(observed)}`)
  } finally {
    if (!disposed) vm.dispose()
  }
}
