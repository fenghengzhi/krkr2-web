import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  isScriptObject,
  type ScriptObject,
  type ScriptDependent,
} from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'

export const dependentRevocationCases = [
  'preserve-instance',
  'last-reference',
  'last-reference-error',
  'after-owner-expired',
  'during-invalidation',
  'rebind',
  'independent-bindings',
  'foreign-token',
  'dispose-pending',
] as const

/** Revocation detaches notifications synchronously; native references drain cooperatively. */
export async function exerciseDependentRevocation(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: (typeof dependentRevocationCases)[number],
  debugMode: boolean,
  binary: boolean,
) {
  const native = observeNative(factory),
    marks: string[] = [],
    held: ScriptObject[] = []
  let vm!: TjsWasmRuntime,
    owner: ScriptObject | undefined,
    child: ScriptObject | undefined,
    binding: ScriptDependent | undefined,
    disposed = false,
    notified = 0,
    queuedBeforeRevoke = 0
  const observations: Record<string, unknown> = { name, variant, debugMode, binary, marks }
  vm = await TjsWasmRuntime.create(
    native.factory,
    async (operation, args) => {
      if (operation === 'Mark') {
        await Promise.resolve()
        const mark = String(args[0])
        marks.push(mark)
        if (mark === 'child' && name === 'during-invalidation') {
          check(
            vm.inspect().dependents === 0,
            'Active invalidation still exposed a revocable token',
          )
          vm.unbindDependent(binding!)
        }
        if (mark === 'child' && name === 'last-reference-error')
          throw new Error('revoked-child-finalizer')
        return { kind: 'value', value: undefined }
      }
      check(operation === 'Child' && child, 'Unexpected revocation host operation')
      return { kind: 'value', value: child }
    },
    { wasmBinary, variant, debugMode },
  )
  const execute = async (source: string, expression = false) =>
    vm.execute(
      binary ? await vm.compile(source, 'dependent-revocation.tjs', expression) : source,
      'dependent-revocation.tjs',
      expression,
    )
  const acquire = async (source: string) => {
    const value = await execute(source, true)
    check(isScriptObject(value), 'Missing revocation instance')
    held.push(value as ScriptObject)
    return value as ScriptObject
  }
  const release = (value: ScriptObject) => {
    vm.release(value)
    held.splice(held.indexOf(value), 1)
  }
  const childValid = async (expected: bigint) =>
    check(
      (await execute('isvalid __host("Child")', true)) === expected,
      'Revocation changed the wrong dependent lifetime',
    )
  try {
    await execute(`
try{throw new Exception("warm revocation");}catch(e){}
class RevocationOwner {function finalize(){__host("Mark","owner");}}
class RevocationChild {var marker=42;function finalize(){__host("Mark","child");}}
`)
    const baseline = vm.inspect()
    observations.baseline = baseline
    owner = await acquire('new RevocationOwner()')
    child = await acquire('new RevocationChild()')
    if (name === 'after-owner-expired') {
      // Native observers notify newest first. Register the host observation
      // before the dependent so this callback sees an already queued binding.
      vm.observe(owner, () => {
        notified++
        queuedBeforeRevoke = vm.inspect().pendingInvalidations
        vm.unbindDependent(binding!)
      })
    }
    binding = vm.bindDependent(owner, child)
    check(binding.type === 'dependent' && binding.id > 0, 'Binding returned no VM token')
    observations.bound = vm.inspect()
    if (
      name === 'last-reference' ||
      name === 'last-reference-error' ||
      name === 'dispose-pending'
    ) {
      release(child)
      child = undefined
      await vm.collect()
      check(marks.length === 0, 'The dependent native lease did not keep its object alive')
    }

    if (
      name === 'preserve-instance' ||
      name === 'last-reference' ||
      name === 'last-reference-error' ||
      name === 'dispose-pending'
    ) {
      vm.unbindDependent(binding)
      vm.unbindDependent(binding)
      observations.revoked = vm.inspect()
      check(
        vm.inspect().dependents === 1 &&
          vm.inspect().pendingInvalidations === 1 &&
          marks.length === 0,
        'Synchronous revocation executed a finalizer or discarded its pending release',
      )
      if (name === 'dispose-pending') {
        vm.dispose()
        disposed = true
        vm.unbindDependent(binding)
        vm.dispose()
        observations.disposed = {
          scriptObjects: native.call('krkr_native_lifetime_stat', 4),
          marks: [...marks],
        }
        check(
          native.call('krkr_native_lifetime_stat', 4) === 0 && marks.length === 0,
          'Terminal revocation disposal executed script or retained objects',
        )
        return observations
      }
      let error: unknown
      try {
        await vm.collect()
      } catch (caught) {
        error = caught
      }
      observations.error = error ? String(error) : null
      check(
        name === 'last-reference-error'
          ? String(error).includes('revoked-child-finalizer')
          : !error,
        'Revoked reference cleanup lost its suspended finalizer outcome',
      )
      check(
        vm.inspect().dependents === 0 && vm.inspect().pendingInvalidations === 0,
        'Revocation did not drain its native lease',
      )
      if (child) {
        await childValid(1n)
        check(
          (await execute('__host("Child").marker', true)) === 42n,
          'Revocation changed child members',
        )
      }
      release(owner)
      owner = undefined
      await vm.collect()
      if (child) await childValid(1n)
    } else if (name === 'after-owner-expired') {
      release(owner)
      owner = undefined
      await vm.collect()
      check(
        notified === 1 && queuedBeforeRevoke === 1,
        'Did not revoke an already queued owner retirement',
      )
      observations.ownerNotification = { notified, queuedBeforeRevoke }
      await childValid(1n)
      check(
        vm.inspect().dependents === 0 && marks.join(',') === 'owner',
        'Revoked dependent was invalidated after its owner expired',
      )
    } else if (name === 'rebind') {
      vm.unbindDependent(binding)
      const replacement = vm.bindDependent(owner, child!)
      check(replacement.id !== binding.id, 'Rebinding reused a live token')
      vm.unbindDependent(binding)
      await vm.collect()
      check(
        vm.inspect().dependents === 1 && vm.inspect().pendingInvalidations === 0,
        'Old token revoked its replacement',
      )
      observations.replacement = { differentToken: true, bound: vm.inspect() }
      release(owner)
      owner = undefined
      await vm.collect()
      vm.unbindDependent(binding)
      vm.unbindDependent(replacement)
      await childValid(0n)
    } else if (name === 'independent-bindings') {
      const secondOwner = await acquire('new RevocationOwner()')
      const otherBinding = vm.bindDependent(secondOwner, child!)
      check(otherBinding.id !== binding.id, 'Independent binding reused its token')
      vm.unbindDependent(binding)
      release(owner)
      owner = undefined
      await vm.collect()
      await childValid(1n)
      check(vm.inspect().dependents === 1, 'Revocation removed another owner binding')
      release(secondOwner)
      await vm.collect()
      await childValid(0n)
    } else {
      if (name === 'foreign-token') {
        const other = await TjsWasmRuntime.create(
          factory,
          () => {
            throw new Error('Unexpected foreign host operation')
          },
          { wasmBinary, variant },
        )
        try {
          const foreignOwner = await other.execute('%[]', '', true),
            foreignChild = await other.execute('%[]', '', true)
          check(
            isScriptObject(foreignOwner) && isScriptObject(foreignChild),
            'No foreign instances',
          )
          const foreignBinding = other.bindDependent(
            foreignOwner as ScriptObject,
            foreignChild as ScriptObject,
          )
          check(
            foreignBinding.id === binding.id,
            'Foreign fixture must exercise colliding native token numbers',
          )
          let rejected: unknown
          try {
            vm.unbindDependent(foreignBinding)
          } catch (error) {
            rejected = error
          }
          observations.foreignError = String(rejected)
          check(
            String(rejected).includes('different TJS runtime'),
            'Foreign token crossed runtime ownership',
          )
          check(
            vm.inspect().dependents === 1 &&
              vm.inspect().pendingInvalidations === 0 &&
              other.inspect().dependents === 1,
            'Foreign revocation mutated a native binding',
          )
          other.unbindDependent(foreignBinding)
          other.release(foreignOwner as ScriptObject)
          other.release(foreignChild as ScriptObject)
          await other.collect()
        } finally {
          other.dispose()
        }
      }
      release(owner)
      owner = undefined
      await vm.collect()
      await childValid(0n)
    }

    for (const object of [...held]) release(object)
    child = owner = undefined
    await vm.collect()
    const after = vm.inspect()
    observations.after = after
    for (const field of [
      'handles',
      'scriptObjects',
      'weakOwners',
      'dependents',
      'pendingInvalidations',
      'pendingHandles',
    ] as const)
      check(after[field] === baseline[field], `Dependent revocation retained ${field}`)
    const expected =
      name === 'last-reference' || name === 'last-reference-error'
        ? ['child', 'owner']
        : name === 'independent-bindings'
          ? ['owner', 'owner', 'child']
          : ['owner', 'child']
    check(
      JSON.stringify(marks) === JSON.stringify(expected),
      'Dependent revocation changed finalizer order or count',
    )
    check((await execute('6*7', true)) === 42n, 'Revocation poisoned the runtime')
    return observations
  } catch (error) {
    throw new Error(
      String(error) +
        '; dependent revocation=' +
        JSON.stringify({ ...observations, current: vm.inspect() }),
    )
  } finally {
    if (!disposed) vm.dispose()
  }
}
