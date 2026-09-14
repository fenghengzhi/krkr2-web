import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  isScriptObject,
  type ScriptWeakObject,
  type ScriptValue,
} from '../../src/engine/script/runtime.ts'
import { checkLifetime as check } from './bytecode-lifetime.ts'

export const weakReturnCases = ['retained', 'invalidated', 'revoked', 'foreign'] as const

/** Reply-owned references must not become invisible permanent host handles. */
export async function exerciseWeakReturn(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: (typeof weakReturnCases)[number],
  debugMode: boolean,
  binary: boolean,
) {
  let weak: ScriptWeakObject | undefined, reply: ScriptValue
  const vm = await TjsWasmRuntime.create(factory, () => ({ kind: 'value', value: reply }), {
    wasmBinary,
    variant,
    debugMode,
  })
  const execute = async (source: string, expression = false) =>
    vm.execute(
      binary ? await vm.compile(source, 'weak-return.tjs', expression) : source,
      'weak-return.tjs',
      expression,
    )
  try {
    await execute(
      'var finalized=0;try{throw new Exception("warm");}catch(e){};class WeakReturn {var marker=42;function value(){return this.marker;}function finalize(){finalized++;}}',
    )
    const baseline = vm.inspect()
    await execute('var origin=new WeakReturn();')
    const origin = await execute('origin', true)
    check(isScriptObject(origin), 'No native owner')
    if (!isScriptObject(origin)) throw new Error('No native owner')
    weak = vm.observe(origin, () => {})
    reply = weak
    vm.release(origin)
    await execute('0', true)
    const owned = vm.inspect()
    check(owned.handles === baseline.handles, 'Observation retained a host handle')
    if (name === 'retained') {
      await execute('var returned=__host("Weak");delete global.origin;')
      check((await execute('returned.value()', true)) === 42n, 'Returned closure lost its receiver')
      check(
        (await execute('returned===__host("Weak")', true)) === 1n,
        'Weak return changed identity',
      )
      check((await execute('finalized', true)) === 0n, 'Returned closure did not own its instance')
      check(vm.inspect().handles === baseline.handles, 'Weak return allocated an extra host root')
      await execute('delete global.returned;')
    } else if (name === 'invalidated') {
      await execute('invalidate origin;')
      check(
        (await execute('__host("Weak")===null', true)) === 1n,
        'Invalid weak return was not null',
      )
      await execute('delete global.origin;')
    } else if (name === 'revoked') {
      vm.unobserve(weak)
      check(
        (await execute('__host("Weak")===null', true)) === 1n,
        'Revoked weak return was not null',
      )
      check((await execute('isvalid origin', true)) === 1n, 'Revocation invalidated the instance')
      await execute('delete global.origin;')
    } else {
      const other = await TjsWasmRuntime.create(
        factory,
        () => ({ kind: 'value', value: undefined }),
        { wasmBinary, variant, debugMode },
      )
      try {
        const foreign = await other.execute('%[]', 'foreign.tjs', true)
        if (!isScriptObject(foreign)) throw new Error('No foreign object')
        reply = other.observe(foreign, () => {})
        let error: unknown
        try {
          await execute('__host("Weak")', true)
        } catch (caught) {
          error = caught
        }
        check(
          String(error).includes('different TJS runtime'),
          'Foreign weak token crossed runtimes',
        )
        other.release(foreign)
      } finally {
        other.dispose()
      }
      reply = weak
      await execute('delete global.origin;')
    }
    check(
      (await execute('__host("Weak")===null', true)) === 1n,
      'Expired observation returned an object',
    )
    check((await execute('finalized', true)) === 1n, 'Wrong weak return finalizer count')
    const after = vm.inspect()
    for (const field of ['handles', 'scriptObjects', 'weakOwners', 'pendingHandles'] as const)
      check(after[field] === baseline[field], `Weak return retained ${field}`)
    return { name, variant, debugMode, binary, baseline, owned, after }
  } finally {
    vm.dispose()
  }
}
