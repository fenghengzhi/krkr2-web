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
    functionLimit: stat(12),
    delegationLimit: stat(13),
    peakFunctions: stat(14),
    peakTries: stat(15),
    peakDelegations: stat(16),
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
    state.peakDepth <= state.depthLimit &&
      state.peakBytes <= state.byteLimit &&
      state.peakFunctions <= state.functionLimit &&
      state.peakDelegations <= state.delegationLimit,
    'Execution exceeded its reservation',
  )
  return state
}
const definition = 'function budgetRecurse(n){if(n<=0)return 42;return budgetRecurse(n-1);}'
const depthError =
  /VM (?:execution depth exceeds 256|function depth exceeds 128|delegation depth exceeds 128) frames|VM native stack reserve exhausted/
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
    (operation, args) => {
      if (operation === 'budget-host' && typeof args[0] === 'bigint')
        return {
          kind: 'script',
          source: `budgetHost(${args[0]})`,
          name: 'host-budget.tjs',
          expression: true,
        }
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
      check((await vm.execute('budgetRecurse(96)', '', true)) === 42n, 'Ordinary recursion changed')
      const message = await caught('budgetRecurse(4096);', depthError)
      results.push({
        scenario: `function/${binary ? 'bytecode' : 'source'}`,
        message,
        state: idle(native),
      })
      await vm.execute('delete budgetRecurse;delete budgetMessage;')
    }
    const tries = (count: number) =>
      'try{'.repeat(count) + 'budgetTryValue=42;' + '}catch(e){throw e;}'.repeat(count)
    await vm.execute('var budgetTryValue=0;' + tries(32), 'ordinary-try.tjs')
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
    for (const binary of [false, true]) {
      const mixed =
        'function budgetRecurse(n){try{if(n<=0)return 42;return budgetRecurse(n-1);}catch(e){throw e;}}'
      await vm.execute(binary ? await vm.compile(mixed, 'mixed-budget.tjs') : mixed)
      check(
        (await vm.execute('budgetRecurse(64)', '', true)) === 42n,
        'Ordinary mixed recursion changed',
      )
      const message = await caught('budgetRecurse(4096);', depthError)
      results.push({
        scenario: `mixed/${binary ? 'bytecode' : 'source'}`,
        message,
        state: idle(native),
      })
      await vm.execute('delete budgetRecurse;')
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
    await vm.execute('function budgetHost(n){if(n<=0)return 42;return __host("budget-host",n-1);}')
    check((await vm.execute('budgetHost(16)', '', true)) === 42n, 'Ordinary host reentry changed')
    results.push({
      scenario: 'host-continuations',
      message: await caught('budgetHost(4096);', depthError),
      state: idle(native),
    })
    await vm.execute('delete budgetHost;')
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
      'delete budgetRecurse;var budgetCalled=0;function budgetCall(values*){budgetCalled++;return values[0]+values[1];}',
    )
    check(
      (await vm.execute('budgetCall([20,22]*)', '', true)) === 42n,
      'Ordinary argument expansion changed',
    )
    await vm.execute('var budgetValues=[];budgetValues.count=1000000;budgetCalled=0;')
    results.push({
      scenario: 'argument-memory',
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
    const automaticInstances = []
    for (const binary of [false, true]) {
      await vm.execute('var automaticFinalized=0;')
      const source =
        'class AutomaticBudgetBox {function value(){return 42;}function finalize(){automaticFinalized++;}}'
      await vm.execute(binary ? await vm.compile(source, 'automatic-instance.tjs') : source)
      check(
        (await vm.execute('(new AutomaticBudgetBox()).value()', '', true)) === 42n,
        'Temporary instance method changed',
      )
      const finalized = await vm.execute('automaticFinalized', '', true)
      check(finalized === 1n, 'Exited expression registers retained a temporary instance')
      await vm.execute('delete AutomaticBudgetBox;delete automaticFinalized;')
      check(
        native.stats().contexts === 0 && native.stats().blocks === 0,
        'Temporary instance kept method contexts alive',
      )
      automaticInstances.push({ binary, finalized: Number(finalized), state: idle(native) })
    }
    check(
      native.stats().contexts === 0 && native.stats().blocks === 0,
      `Error registers retained contexts: ${JSON.stringify(native.stats())}`,
    )
    check(vm.inspect().handles === 0, 'Budget checks leaked host handles')
    return { debugMode, results, automaticInstances, final: idle(native), native: native.stats() }
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

export async function exerciseArgumentControl(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  cancel: boolean,
) {
  const native = observeNative(factory),
    control = new ExecutionControl()
  let entered!: () => void,
    armed = false,
    settled = false,
    error: unknown,
    result: unknown,
    observed: ReturnType<typeof executionStats> | undefined
  let before: ReturnType<typeof native.stats>
  const started = new Promise<void>((resolve) => (entered = resolve))
  const wrapped: ModuleFactory = (options) =>
    native.factory({
      ...options,
      onYield: async (phase) => {
        if (armed && !observed && phase === 10) {
          const state = executionStats(native)
          if (
            state.bytes > 8 * 1024 * 1024 &&
            native.stats().heap > before.heap + 8 * 1024 * 1024
          ) {
            observed = state
            control.pause()
            entered()
          }
        }
        await options.onYield(phase)
      },
    })
  const vm = await TjsWasmRuntime.create(
    wrapped,
    () => {
      throw new Error('Unexpected host I/O')
    },
    { wasmBinary, variant, control },
  )
  let pending: Promise<void> | undefined
  try {
    await vm.execute(
      'var argumentToken=%[];var argumentValues=[];argumentValues.count=700000;for(var i=0;i<700000;i++)argumentValues[i]=argumentToken;function argumentTarget(*){return 42;}',
    )
    before = native.stats()
    armed = true
    pending = vm.execute('argumentTarget(argumentValues*)', 'argument-control.tjs', true).then(
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
        throw new Error(`No materialized argument checkpoint: ${String(error)}`)
      }),
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    check(!settled, 'Argument preparation advanced while paused')
    if (cancel) control.cancel()
    else control.resume()
    await pending
    if (cancel)
      check(
        error instanceof Error && error.name === 'AbortError',
        `Argument cancellation failed: ${String(error)}`,
      )
    else check(result === 42n && !error, `Argument resume failed: ${String(error)}`)
    const after = idle(native),
      resources = native.stats()
    check(
      resources.blocks === before.blocks && resources.contexts === before.contexts,
      'Argument preparation retained call contexts',
    )
    // The large source array remains intentionally global; only the temporary
    // copied arguments and frame storage must be gone after this operation.
    check(
      resources.heap <= before.heap + 64 * 1024,
      `Argument buffers were retained: ${JSON.stringify({ before, resources })}`,
    )
    return {
      cancel,
      heldMs: 25,
      observed,
      after,
      before,
      resources,
      error: error instanceof Error ? error.name : null,
    }
  } finally {
    control.cancel()
    await pending
    vm.dispose()
  }
}
