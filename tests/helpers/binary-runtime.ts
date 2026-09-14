import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { isScriptObject, type ScriptValue } from '../../src/engine/script/runtime.ts'
import { binaryHeader, binaryValue } from './binary-scripts.ts'

const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}
export async function exerciseBinaryRuntime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  cancel: boolean,
) {
  const control = new ExecutionControl()
  let reached!: () => void,
    yields = 0,
    armed = false,
    result: ScriptValue,
    error: unknown,
    settled = false
  const started = new Promise<void>((resolve) => (reached = resolve))
  const wrapped: ModuleFactory = (options) =>
    factory({
      ...options,
      onYield: async (phase) => {
        if (armed && phase === 5 && ++yields === 1) {
          control.pause()
          reached()
        }
        await options.onYield(phase)
      },
    })
  const vm = await TjsWasmRuntime.create(wrapped, () => ({ kind: 'value', value: result }), {
    wasmBinary,
    variant,
    control,
  })
  const bytes = new Uint8Array(13 + 500000)
  bytes.set(binaryHeader)
  bytes[8] = 0xdd
  new DataView(bytes.buffer).setUint32(9, 500000, true)
  bytes.fill(42, 13)
  let pending: Promise<void> | undefined
  try {
    check((await vm.execute(binaryValue(-32n))) === -32n, 'Negative fix integer changed')
    check(
      (await vm.execute(binaryValue('日😀\0x'))) === '日😀',
      'Binary string did not follow native NUL termination',
    )
    const compiled = await vm.compile('6*7', 'binary-validation.tjs', true)
    for (const invalid of [
      compiled.subarray(0, 8),
      new Uint8Array([...binaryHeader, 0xdd, 255, 255, 255, 255]),
    ]) {
      let rejected = false
      try {
        await vm.execute(invalid)
      } catch (error) {
        rejected = error instanceof Error && error.name === 'ScriptError'
      }
      check(rejected, 'Invalid binary input reached native execution')
    }
    check((await vm.execute(compiled)) === 42n, 'Binary errors poisoned VM')
    armed = true
    pending = vm.execute(bytes).then(
      (value) => {
        result = value
        settled = true
      },
      (failure: unknown) => {
        error = failure
        settled = true
      },
    )
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error(`Binary input never yielded: ${String(error)}`)
      }),
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    check(!settled && yields === 1, 'Binary input advanced while paused')
    if (cancel) control.cancel()
    else control.resume()
    await pending
    if (cancel)
      check(error instanceof Error && error.name === 'AbortError', 'Binary cancellation failed')
    else {
      check(!error && isScriptObject(result), `Missing native array: ${String(error)}`)
      check(
        (await vm.execute('__host("data").count', '', true)) === 500000n,
        'Binary array length changed',
      )
      check(
        (await vm.execute('__host("data")[499999]', '', true)) === 42n,
        'Binary array contents changed',
      )
      if (isScriptObject(result)) vm.release(result)
      check((await vm.execute('6*7', '', true)) === 42n, 'Binary release poisoned VM')
    }
    check(vm.inspect().handles === 0, 'Binary input leaked host handles')
    return {
      cancel,
      heldMs: 25,
      yields,
      elements: cancel ? 0 : 500000,
      handles: vm.inspect().handles,
      invalidRejected: 2,
      error: error instanceof Error ? error.name : null,
    }
  } finally {
    control.cancel()
    await pending
    vm.dispose()
  }
}
