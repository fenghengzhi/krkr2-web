import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { isScriptObject, type ScriptObject } from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'

export const dependentLifetimeCases = [
  'owner-release',
  'child-first',
  'owner-retry',
  'child-error',
  'primary-error',
  'invalid-bindings',
  'vm-dispose',
] as const

export async function exerciseDependentLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: string,
  debugMode: boolean,
  binary: boolean,
) {
  check(
    dependentLifetimeCases.some((item) => item === name),
    'Unknown dependent case',
  )
  const native = observeNative(factory),
    marks: string[] = []
  let owner: ScriptObject | undefined, child: ScriptObject | undefined
  const vm = await TjsWasmRuntime.create(
    native.factory,
    async (operation, args) => {
      if (operation === 'Mark') {
        // Real suspendable host reentry from the dependent's native invalidation.
        await Promise.resolve()
        marks.push(String(args[0]))
        return { kind: 'value', value: undefined }
      }
      const object = operation === 'Owner' ? owner : operation === 'Child' ? child : undefined
      check(object, 'Unexpected dependent host operation ' + operation)
      return { kind: 'value', value: object }
    },
    { wasmBinary, variant, debugMode },
  )
  const held: ScriptObject[] = []
  const observations: Record<string, unknown> = { name, variant, debugMode, binary, marks }
  let disposed = false
  const execute = async (source: string, expression = false) =>
    vm.execute(
      binary ? await vm.compile(source, 'dependent.tjs', expression) : source,
      'dependent.tjs',
      expression,
    )
  const acquire = async (source: string) => {
    const value = await execute(source, true)
    check(isScriptObject(value), 'Dependent fixture returned no object')
    held.push(value as ScriptObject)
    return value as ScriptObject
  }
  const release = (value: ScriptObject) => {
    vm.release(value)
    held.splice(held.indexOf(value), 1)
  }
  const rejected = async (operation: () => unknown | Promise<unknown>) => {
    let caught: unknown
    try {
      await operation()
    } catch (error) {
      caught = error
    }
    check(caught instanceof Error, 'Invalid dependent operation was accepted')
    return String(caught)
  }
  const boundary = async () => {
    check(
      (await vm.execute('6*7', 'dependent-boundary.tjs', true)) === 42n,
      'Dependent cleanup poisoned the VM',
    )
    const state = vm.inspect()
    check(
      state.pendingHandles === 0 && state.pendingInvalidations === 0,
      'Dependent work was stranded',
    )
    check(
      native.call('krkr_native_lifetime_stat', 0) === 0 &&
        native.call('krkr_native_lifetime_stat', 1) === 0,
      'Dependent destruction did not unwind',
    )
    return state
  }
  try {
    await vm.execute('try{throw new Exception("warm dependent error");}catch(e){}')
    await execute(`
var failOwner=false,failChild=false;
class DependentParent {function finalize(){__host("Mark","owner");if(failOwner)throw new Exception("owner-finalizer");}}
class DependentChild {function finalize(){__host("Mark","child");if(failChild)throw new Exception("child-finalizer");}}
function ordinaryFunction(){return 42;}
`)
    const baseline = await boundary()
    observations.baseline = baseline
    owner = await acquire(
      name === 'primary-error'
        ? '(global.rootOwner=new DependentParent())'
        : 'new DependentParent()',
    )
    child = await acquire('new DependentChild()')
    observations.owned = vm.inspect()
    check(
      vm.inspect().scriptObjects === baseline.scriptObjects + 2,
      'Unexpected native instance count',
    )

    if (name === 'invalid-bindings') {
      const errors: Record<string, string> = {}
      errors.self = await rejected(() => vm.bindDependent(owner!, owner!))
      const fn = await acquire('ordinaryFunction'),
        cls = await acquire('DependentParent')
      errors.ownerFunction = await rejected(() => vm.bindDependent(fn, child!))
      errors.childFunction = await rejected(() => vm.bindDependent(owner!, fn))
      errors.ownerClass = await rejected(() => vm.bindDependent(cls, child!))
      errors.childClass = await rejected(() => vm.bindDependent(owner!, cls))
      const released = vm.retain(owner)
      vm.release(released)
      errors.released = await rejected(() => vm.bindDependent(released, child!))
      const other = await TjsWasmRuntime.create(
        factory,
        () => {
          throw new Error('Unexpected foreign host call')
        },
        { wasmBinary, variant, debugMode },
      )
      try {
        const foreign = await other.execute('%[]', 'foreign-dependent.tjs', true)
        check(isScriptObject(foreign), 'No foreign dependent')
        errors.foreignOwner = await rejected(() =>
          vm.bindDependent(foreign as ScriptObject, child!),
        )
        errors.foreignChild = await rejected(() =>
          vm.bindDependent(owner!, foreign as ScriptObject),
        )
        other.release(foreign as ScriptObject)
      } finally {
        other.dispose()
      }
      check(vm.inspect().dependents === 0, 'Rejected bindings retained native records')
      await execute('invalidate __host("Child");')
      errors.invalidChild = await rejected(() => vm.bindDependent(owner!, child!))
      await execute('invalidate __host("Owner");')
      errors.invalidOwner = await rejected(() => vm.bindDependent(owner!, child!))
      release(fn)
      release(cls)
      observations.rejections = errors
    } else {
      vm.bindDependent(owner, child)
      observations.bound = vm.inspect()
      check(
        vm.inspect().dependents === 1 && vm.inspect().handles === 2,
        'Dependent registration changed script handles',
      )
      if (name === 'vm-dispose') {
        const before = [...marks]
        vm.dispose()
        disposed = true
        check(
          JSON.stringify(marks) === JSON.stringify(before),
          'Disposal ran dependent script finalizers',
        )
        check(
          native.call('krkr_native_lifetime_stat', 4) === 0,
          'Disposal retained native dependent objects',
        )
        vm.dispose()
        observations.disposed = {
          scriptObjects: native.call('krkr_native_lifetime_stat', 4),
          marks: [...marks],
        }
        return observations
      }
      if (name === 'child-first') {
        await execute('invalidate __host("Child");')
        check(
          (await execute('isvalid __host("Owner")', true)) === 1n,
          'Child invalidation retired its owner',
        )
      } else if (name === 'owner-retry') {
        await execute('failOwner=true;')
        observations.error = await rejected(() => execute('invalidate __host("Owner");'))
        check(String(observations.error).includes('owner-finalizer'), 'Lost failed owner finalizer')
        observations.retry = vm.inspect()
        check(
          vm.inspect().dependents === 1 && (await execute('isvalid __host("Child")', true)) === 1n,
          'Failed owner invalidation retired the dependent',
        )
        await execute('failOwner=false;invalidate __host("Owner");')
      } else {
        if (name === 'child-error' || name === 'primary-error') await execute('failChild=true;')
        release(owner)
        owner = undefined
        if (name === 'primary-error') {
          await boundary() // global.rootOwner still owns the parent
          observations.error = await rejected(() =>
            execute('delete global.rootOwner;throw new Exception("primary-body");'),
          )
          check(
            String(observations.error).includes('primary-body') &&
              !String(observations.error).includes('child-finalizer'),
            'Dependent finalization replaced the primary exception',
          )
        } else if (name === 'child-error') {
          observations.error = await rejected(boundary)
          check(
            String(observations.error).includes('child-finalizer'),
            'Lost deferred dependent error',
          )
        } else await boundary()
        if (name === 'child-error' || name === 'primary-error') {
          observations.failed = vm.inspect()
          check(
            vm.inspect().dependents === 0 && vm.inspect().pendingInvalidations === 0,
            'A throwing dependent retained its native binding',
          )
          await execute('failChild=false;invalidate __host("Child");')
        }
      }
      observations.retired = vm.inspect()
      check(
        vm.inspect().dependents === 0 && vm.inspect().pendingInvalidations === 0,
        'Dependent binding survived invalidation',
      )
      check(
        (await execute('isvalid __host("Child")', true)) === 0n,
        'Dependent remained valid after retirement',
      )
    }
    for (const value of [...held]) release(value)
    owner = child = undefined
    const after = await boundary()
    observations.after = after
    check(
      after.handles === baseline.handles &&
        after.scriptObjects === baseline.scriptObjects &&
        after.dependents === 0 &&
        after.weakOwners === 0,
      'Dependent lifetime did not return to its object baseline',
    )
    const expected =
      name === 'owner-retry'
        ? ['owner', 'owner', 'child']
        : name === 'child-first' || name === 'invalid-bindings'
          ? ['child', 'owner']
          : name === 'child-error' || name === 'primary-error'
            ? ['owner', 'child', 'child']
            : ['owner', 'child']
    check(
      JSON.stringify(marks) === JSON.stringify(expected),
      'Unexpected dependent finalizer ordering',
    )
    return observations
  } catch (error) {
    throw new Error(String(error) + '; dependent observations=' + JSON.stringify(observations))
  } finally {
    if (!disposed) vm.dispose()
  }
}
