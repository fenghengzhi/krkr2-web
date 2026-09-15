import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { isScriptObject, type ScriptObject } from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'

export async function exerciseNativeBrand(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  debugMode: boolean,
  binary: boolean,
) {
  const native = observeNative(factory),
    held: ScriptObject[] = [],
    calls: string[] = []
  let owner: ScriptObject | undefined
  const vm = await TjsWasmRuntime.create(
    native.factory,
    (operation, args) => {
      if (operation === 'Owner') return { kind: 'value', value: owner }
      check(operation === 'Tag.A' || operation === 'Tag.B', 'Unexpected native brand operation')
      calls.push(operation + ':' + String(args[0]))
      return { kind: 'value', value: undefined }
    },
    { wasmBinary, variant, debugMode },
  )
  const execute = async (source: string, expression = false) =>
    vm.execute(
      binary ? await vm.compile(source, 'native-brand.tjs', expression) : source,
      'native-brand.tjs',
      expression,
    )
  const acquire = async (source: string) => {
    const value = await execute(source, true)
    check(isScriptObject(value), 'Expected a native brand fixture object')
    held.push(value as ScriptObject)
    return value as ScriptObject
  }
  try {
    await execute(
      'class Branded {} function unbranded(){} var other=%[]; var stateDeaths=0; class StateVictim { function finalize(){stateDeaths++;} }',
    )
    const baseline = vm.inspect()
    owner = await acquire('new Branded()')
    vm.registerNativeLifetime(owner, 'Tag.A', 0)
    const state = await acquire('%[payload:new StateVictim()]')
    vm.registerNativeLifetime(owner, 'Tag.B', 0xffffffff, state)
    held.splice(held.indexOf(state), 1)
    vm.release(state)
    await vm.collect()
    check(
      (await execute('stateDeaths', true)) === 0n,
      'Native instance did not retain its private state',
    )
    vm.registerNativeLifetime(owner, 'Tag.A', 99)
    const bound = await acquire('__host("Owner") incontextof other'),
      plain = await acquire('unbranded'),
      before = vm.inspect()
    const ids = {
      first: vm.nativeLifetimeIdentifier(owner, 'Tag.A'),
      maximum: vm.nativeLifetimeIdentifier(owner, 'Tag.B'),
      bound: vm.nativeLifetimeIdentifier(bound, 'Tag.A'),
    }
    check(
      ids.first === 0 && ids.maximum === 0xffffffff && ids.bound === 0,
      'Wrong native slot identifier',
    )
    check(
      vm.nativeLifetimeIdentifier(owner, 'Tag.Missing') === undefined,
      'Unknown native brand matched',
    )
    check(
      vm.nativeLifetimeIdentifier(plain, 'Tag.A') === undefined,
      'Function acquired a native brand',
    )
    check(
      JSON.stringify(vm.inspect()) === JSON.stringify(before),
      'Native brand lookup retained an object',
    )
    check(native.call('krkr_native_hook_count') === 3, 'Native brand lookup changed its slots')
    await execute('invalidate __host("Owner");')
    check(
      (await execute('stateDeaths', true)) === 1n,
      'Native invalidation did not release its private state',
    )
    check(
      vm.nativeLifetimeIdentifier(owner, 'Tag.A') === 0,
      'Invalidation erased native instance metadata',
    )
    check(
      vm.nativeLifetimeIdentifier(bound, 'Tag.B') === 0xffffffff,
      'Bound invalid native cast failed',
    )
    check(
      calls.join(',') === 'Tag.A:99,Tag.B:4294967295,Tag.A:0',
      'Native slot invalidation order changed',
    )
    const invalidated = vm.inspect()
    for (const value of held.splice(0)) vm.release(value)
    const released = vm.nativeLifetimeIdentifier(owner, 'Tag.A')
    check(released === undefined, 'Released handle exposed native instance metadata')
    owner = undefined
    await vm.collect()
    const after = vm.inspect()
    for (const key of [
      'handles',
      'scriptObjects',
      'weakOwners',
      'pendingHandles',
      'dependents',
      'pendingInvalidations',
    ] as const)
      check(after[key] === baseline[key], 'Native brand fixture retained ' + key)
    check(
      native.call('krkr_native_hook_count') === 0,
      'Native metadata survived actual object release',
    )
    // Native state must keep an ordinary owner cycle until explicit invalidation,
    // while observations alone remain non-owning.
    const nativeCalls = [...calls]
    let expired = 0
    owner = await acquire('new Branded()')
    const weak = vm.observe(owner, () => {
        expired++
      }),
      cycle = await acquire('%[owner:__host("Owner")]')
    vm.registerNativeLifetime(owner, 'Tag.A', 7, cycle)
    for (const value of held.splice(0)) vm.release(value)
    owner = undefined
    await vm.collect()
    check(
      native.call('krkr_native_hook_count') === 1 && expired === 0,
      'Native state lost its owner cycle',
    )
    owner = vm.upgrade(weak)
    check(!!owner, 'Native state cycle could not be observed')
    held.push(owner!)
    await execute('invalidate __host("Owner");')
    check(expired === 1, 'Native cycle invalidation did not revoke its observation')
    vm.unobserve(weak)
    for (const value of held.splice(0)) vm.release(value)
    owner = undefined
    await vm.collect()
    check(
      native.call('krkr_native_hook_count') === 0,
      'Explicit invalidation retained a native cycle',
    )
    const cycleAfter = vm.inspect()
    for (const key of ['handles', 'scriptObjects', 'weakOwners', 'pendingHandles'] as const)
      check(cycleAfter[key] === baseline[key], 'Native cycle retained ' + key)

    await execute(
      'class ThrowingBrand {function finalize(){throw new Exception("private-owner-failure");}} class ThrowingState {function finalize(){stateDeaths++;throw new Exception("private-state-failure");}}',
    )
    const failureBaseline = vm.inspect()
    owner = await acquire('new ThrowingBrand()')
    const failingState = await acquire('new ThrowingState()')
    vm.registerNativeLifetime(owner, 'Tag.A', 8, failingState)
    // Release the state argument first; only the native instance retains it.
    held.splice(held.indexOf(failingState), 1)
    vm.release(failingState)
    await vm.collect()
    for (const value of held.splice(0)) vm.release(value)
    owner = undefined
    let implicitError = ''
    try {
      await vm.collect()
    } catch (error) {
      implicitError = String(error)
    }
    check(
      implicitError.includes('private-owner-failure'),
      'Implicit native state cleanup lost the primary error: ' + implicitError,
    )
    check(
      (await execute('stateDeaths', true)) === 2n,
      'A failed owner destructor did not release native state',
    )
    check(
      native.call('krkr_native_hook_count') === 0,
      'Failed owner destruction retained a native slot',
    )
    const failureAfter = vm.inspect()
    for (const key of ['handles', 'scriptObjects', 'weakOwners', 'pendingHandles'] as const)
      check(
        failureAfter[key] === failureBaseline[key],
        'Failed native state cleanup retained ' + key,
      )
    owner = await acquire('new Branded()')
    const shutdownCycle = await acquire('%[owner:__host("Owner")]')
    vm.registerNativeLifetime(owner, 'Tag.A', 9, shutdownCycle)
    for (const value of held.splice(0)) vm.release(value)
    owner = undefined
    await vm.collect()
    check(native.call('krkr_native_hook_count') === 1, 'Shutdown fixture lost its native cycle')
    const callsBeforeShutdown = calls.length
    vm.dispose()
    const shutdownHooks = native.call('krkr_native_hook_count')
    check(
      shutdownHooks === 0 && calls.length === callsBeforeShutdown,
      'Terminal disposal retained native state or ran a host callback',
    )
    return {
      variant,
      debugMode,
      binary,
      baseline,
      before,
      ids,
      calls: nativeCalls,
      invalidated,
      after,
      cycleAfter,
      implicitError,
      failureBaseline,
      failureAfter,
      shutdownHooks,
    }
  } finally {
    for (const value of held) vm.release(value)
    vm.dispose()
  }
}
