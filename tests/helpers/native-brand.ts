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
    await execute('class Branded {} function unbranded(){} var other=%[];')
    const baseline = vm.inspect()
    owner = await acquire('new Branded()')
    vm.registerNativeLifetime(owner, 'Tag.A', 0)
    vm.registerNativeLifetime(owner, 'Tag.B', 0xffffffff)
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
    return { variant, debugMode, binary, baseline, before, ids, calls, invalidated, after }
  } finally {
    for (const value of held) vm.release(value)
    vm.dispose()
  }
}
