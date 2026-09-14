import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { observeNative, checkLifetime as check } from './bytecode-lifetime.ts'
import { bytecodeOffsets } from './binary-scripts.ts'

export function executionStats(native: ReturnType<typeof observeNative>) {
  const stat = (field: number) => native.call('krkr_vm_execution_stat', field)
  return {
    depth: stat(0),
    bytes: stat(1),
    peakDepth: stat(2),
    peakBytes: stat(3),
    depthLimit: stat(4),
    byteLimit: stat(5),
    stackFree: stat(6),
    stackReserve: stat(7),
    functions: stat(8),
    tries: stat(9),
    delegations: stat(10),
    minimumStackFree: stat(11),
  }
}
function idle(native: ReturnType<typeof observeNative>) {
  const state = executionStats(native)
  check(
    state.depth === 0 &&
      state.bytes === 0 &&
      state.functions === 0 &&
      state.tries === 0 &&
      state.delegations === 0,
    `Unreleased execution budget: ${JSON.stringify(state)}`,
  )
  check(
    state.peakDepth <= state.depthLimit && state.peakBytes <= state.byteLimit,
    'Execution exceeded its reservation',
  )
  return state
}
const definition = 'function budgetRecurse(n){if(n<=0)return 42;return budgetRecurse(n-1);}'
const depthError = /VM execution depth exceeds 256 frames|VM native stack reserve exhausted/
const memoryError = /VM temporary registers and arguments exceed 16 MiB budget/

export async function exerciseExecutionBudget(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  debugMode: boolean,
) {
  const native = observeNative(factory)
  const vm = await TjsWasmRuntime.create(
    native.factory,
    () => {
      throw new Error('Unexpected host I/O')
    },
    { wasmBinary, variant, debugMode },
  )
  const results: { scenario: string; message: string; state: ReturnType<typeof idle> }[] = []
  async function caught(source: string, pattern: RegExp) {
    await vm.execute(
      `var budgetMessage="";try{${source}}catch(e){budgetMessage=e.message;}`,
      'budget-catch.tjs',
    )
    const message = await vm.execute('budgetMessage', 'budget-message.tjs', true)
    check(
      typeof message === 'string' && pattern.test(message),
      `Missing catchable budget error: ${String(message)}`,
    )
    check((await vm.execute('6*7', '', true)) === 42n, 'Budget error poisoned the VM')
    return String(message)
  }
  try {
    for (const binary of [false, true]) {
      await vm.execute(binary ? await vm.compile(definition, 'budget-function.tjs') : definition)
      check((await vm.execute('budgetRecurse(32)', '', true)) === 42n, 'Ordinary recursion changed')
      const message = await caught('budgetRecurse(4096);', depthError)
      results.push({
        scenario: `function/${binary ? 'bytecode' : 'source'}`,
        message,
        state: idle(native),
      })
      await vm.execute('delete budgetRecurse;delete budgetMessage;')
    }
    const tries = (count: number) =>
      'try{'.repeat(count) + 'var budgetTryValue=42;' + '}catch(e){throw e;}'.repeat(count)
    await vm.execute(tries(32), 'ordinary-try.tjs')
    check((await vm.execute('budgetTryValue', '', true)) === 42n, 'Ordinary nested try changed')
    for (const binary of [false, true]) {
      const source = `var budgetMessage="";try{${tries(320)}}catch(e){budgetMessage=e.message;}`
      await vm.execute(binary ? await vm.compile(source, 'deep-try.tjs') : source)
      const message = await vm.execute('budgetMessage', '', true)
      check(
        typeof message === 'string' && depthError.test(message),
        'Nested try did not reach a catchable depth boundary',
      )
      results.push({
        scenario: `try/${binary ? 'bytecode' : 'source'}`,
        message: String(message),
        state: idle(native),
      })
    }
    await vm.execute(
      'class BudgetCycleA extends BudgetCycleB {} class BudgetCycleB extends BudgetCycleA {}',
    )
    results.push({
      scenario: 'superclass-cycle',
      message: await caught('BudgetCycleA.absent;', depthError),
      state: idle(native),
    })
    await vm.execute('delete BudgetCycleA;delete BudgetCycleB;')
    const wide = await vm.compile(definition, 'wide-frame.tjs'),
      layout = bytecodeOffsets(wide),
      view = new DataView(wide.buffer)
    const functionContext = layout.objects.find(
      (object) => view.getInt32(object.start + 8, true) === 1,
    )
    check(functionContext, 'Missing function context')
    view.setInt32(functionContext!.start + 12, 32766, true)
    view.setInt32(functionContext!.start + 20, 32767, true)
    await vm.execute(wide)
    check((await vm.execute('budgetRecurse(4)', '', true)) === 42n, 'Valid wide frames changed')
    results.push({
      scenario: 'wide-registers',
      message: await caught('budgetRecurse(100);', memoryError),
      state: idle(native),
    })
    await vm.execute(
      'delete budgetRecurse;var budgetCalled=0;function budgetCall(a,b){budgetCalled++;return a+b;}',
    )
    check(
      (await vm.execute('budgetCall([20,22]*)', '', true)) === 42n,
      'Ordinary argument expansion changed',
    )
    await vm.execute('var budgetValues=[];budgetValues.count=1000000;budgetCalled=0;')
    results.push({
      scenario: 'expanded-arguments',
      message: await caught('budgetCall(budgetValues*);', memoryError),
      state: idle(native),
    })
    check(
      (await vm.execute('budgetCalled', '', true)) === 0n,
      'Rejected arguments still invoked the callee',
    )
    await vm.execute('budgetValues.count=600000;')
    results.push({
      scenario: 'argument-count',
      message: await caught(
        'budgetCall(budgetValues*,budgetValues*);',
        /VM call exceeds 1000000 arguments/,
      ),
      state: idle(native),
    })
    let invalid: unknown
    try {
      await vm.execute('budgetCall(null*)', '', true)
    } catch (error) {
      invalid = error
    }
    check(
      invalid instanceof Error && invalid.name === 'ScriptError',
      'Null argument expansion did not fail safely',
    )
    await vm.execute(
      'delete budgetCall;delete budgetValues;delete budgetCalled;delete budgetMessage;delete budgetTryValue;',
    )
    check(
      native.stats().contexts === 0 && native.stats().blocks === 0,
      `Error registers retained contexts: ${JSON.stringify(native.stats())}`,
    )
    check(vm.inspect().handles === 0, 'Budget checks leaked host handles')
    return { debugMode, results, final: idle(native), native: native.stats() }
  } finally {
    vm.dispose()
  }
}

export async function exerciseDeepContinuation(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  cancel: boolean,
) {
  const native = observeNative(factory),
    control = new ExecutionControl()
  let nativeReplyKind = -1
  const wrapped: ModuleFactory = async (options) => {
    const module = await native.factory(options),
      ccall = module.ccall.bind(module)
    module.ccall = async (...parameters) => {
      const pointer = await ccall(...parameters)
      nativeReplyKind = Number(module._krkr_reply_kind!(pointer))
      return pointer
    }
    return module
  }
  let entered!: () => void,
    release!: () => void,
    settled = false,
    result: unknown,
    error: unknown
  const started = new Promise<void>((resolve) => (entered = resolve)),
    gate = new Promise<void>((resolve) => (release = resolve))
  const vm = await TjsWasmRuntime.create(
    wrapped,
    async () => {
      entered()
      await gate
      return { kind: 'value', value: 42n }
    },
    { wasmBinary, variant, control, debugMode: true },
  )
  let pending: Promise<void> | undefined
  try {
    await vm.execute(
      'function deepBudget(n){try{if(n<=0)return __host("hold");return deepBudget(n-1);}catch(e){return 99;}}',
    )
    pending = vm.execute('deepBudget(64)', 'deep-continuation.tjs', true).then(
      (value) => {
        settled = true
        result = value
      },
      (failure: unknown) => {
        settled = true
        error = failure
      },
    )
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error(`No deep suspension: ${String(error)}`)
      }),
    ])
    const held = executionStats(native)
    check(held.functions >= 65 && held.tries >= 65, `Missing deep frames: ${JSON.stringify(held)}`)
    control.pause()
    release()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    check(!settled, 'Deep continuation advanced while paused')
    if (cancel) control.cancel()
    else control.resume()
    await pending
    if (cancel)
      check(
        error instanceof Error && error.name === 'AbortError',
        `Deep cancellation failed: ${String(error)}`,
      )
    else check(result === 42n && !error, `Deep resume failed: ${String(error)}`)
    check(nativeReplyKind === (cancel ? 1 : 0), 'Script catch swallowed native cancellation')
    return {
      cancel,
      nativeReplyKind,
      held,
      after: idle(native),
      heldMs: 25,
      error: error instanceof Error ? error.name : null,
    }
  } finally {
    release()
    control.cancel()
    await pending
    vm.dispose()
  }
}
