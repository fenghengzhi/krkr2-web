import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'

export const compilerPhases = [1, 2, 3] as const
export type CompilerPhase = (typeof compilerPhases)[number]
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const check = (value: unknown, message: string) => {
  if (!value) throw new Error(message)
}

// Enough source scanning and constant output to span native scheduling slices.
// Constant/register counts stay below the signed 16-bit bytecode operand limit.
export function compilerSource() {
  const padding = 'x'.repeat(2048 - 4)
  return (
    '/*' +
    ' '.repeat(4 * 1024 * 1024) +
    '*/\nvar compiledPayload=[' +
    Array.from({ length: 2048 }, (_, i) =>
      JSON.stringify(i.toString(16).padStart(4, '0') + padding),
    ).join(',') +
    '];var compiledAnswer=compiledPayload.count+compiledPayload[2047].length;'
  )
}

export function compilerGate(factory: ModuleFactory, phase: CompilerPhase, pause: () => void) {
  let entered!: () => void
  const started = new Promise<void>((resolve) => (entered = resolve))
  const yields: Record<number, number> = { 1: 0, 2: 0, 3: 0 }
  let armed = false,
    reached = false
  const wrapped: ModuleFactory = (options) =>
    factory({
      ...options,
      onYield: async (current) => {
        if (armed && current !== undefined && current >= 1 && current <= 3) {
          yields[current] = yields[current]! + 1
          if (current === phase && !reached) {
            reached = true
            pause()
            entered()
          }
        }
        await options.onYield(current)
      },
    })
  return {
    factory: wrapped,
    started,
    yields,
    arm: () => {
      armed = true
    },
  }
}

export async function exerciseCompiler(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  phase: CompilerPhase,
  cancel: boolean,
) {
  const control = new ExecutionControl()
  const gate = compilerGate(factory, phase, () => control.pause())
  const vm = await TjsWasmRuntime.create(
    gate.factory,
    () => {
      throw new Error('Unexpected compiler host callback')
    },
    { wasmBinary, variant, control },
  )
  let settled = false,
    bytecode: Uint8Array | undefined,
    failure: unknown
  gate.arm()
  const pending = vm.compile(compilerSource(), 'cooperative-compiler.tjs').then(
    (value) => {
      bytecode = value
      settled = true
    },
    (error: unknown) => {
      failure = error
      settled = true
    },
  )
  try {
    // A missing checkpoint must fail, rather than leave a test waiting forever.
    await Promise.race([
      gate.started,
      pending.then(() => {
        throw new Error(`Compilation settled before phase ${phase} checkpoint: ${String(failure)}`)
      }),
    ])
    const before = { ...gate.yields }
    await delay(25)
    check(!settled, `Compilation advanced while phase ${phase} was paused`)
    check(
      JSON.stringify(gate.yields) === JSON.stringify(before),
      'Native work advanced while paused',
    )
    if (cancel) control.cancel()
    else control.resume()
    await pending
    if (cancel) {
      check(
        failure instanceof Error && failure.name === 'AbortError',
        `Incorrect cancellation: ${String(failure)}`,
      )
      check(bytecode === undefined, 'Cancellation returned partial bytecode')
    } else {
      check(
        !failure && bytecode && bytecode.length > 8 * 1024 * 1024,
        `Missing compiled constants: ${String(failure)}`,
      )
      check(
        (await vm.execute('typeof global.compiledAnswer', '', true)) === 'undefined',
        'Compiler executed the source',
      )
      await vm.execute(bytecode!, 'cooperative-compiled.tjs')
      check(
        (await vm.execute('compiledAnswer', '', true)) === 4096n,
        'Resumed bytecode result differs',
      )
      for (const current of compilerPhases)
        check(gate.yields[current]! > 0, `Phase ${current} never yielded`)
    }
    const handles = vm.inspect().handles
    check(handles === 0, 'Compiler leaked host handles')
    return {
      phase,
      cancel,
      heldMs: 25,
      yields: gate.yields,
      bytes: bytecode?.length ?? 0,
      handles,
      error: failure instanceof Error ? failure.name : null,
    }
  } finally {
    control.cancel()
    await pending
    vm.dispose()
  }
}
