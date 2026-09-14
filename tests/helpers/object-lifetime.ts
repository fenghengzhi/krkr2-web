import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { observeNative, checkLifetime as check } from './bytecode-lifetime.ts'
import { executionStats } from './execution-budget.ts'

const classes = `
var lifetimeLog="";
class ThrowingFinal {
  function finalize(){lifetimeLog+="A";throw new Exception("finalizer-A");}
}
class OtherFinal { function finalize(){lifetimeLog+="B";} }
`
export const objectLifetimeCases = [
  {
    name: 'ordinary-scope',
    setup: 'function lifetimeRun(){var object=new OtherFinal();return 42;}',
    action: 'lifetimeRun()',
    error: null,
    log: 'B',
  },
  {
    name: 'throwing-scope',
    setup: 'function lifetimeRun(){var object=new ThrowingFinal();return 42;}',
    action: 'lifetimeRun()',
    error: 'finalizer-A',
    log: 'A',
  },
  {
    name: 'primary-body',
    setup:
      'function lifetimeRun(){var object=new ThrowingFinal();throw new Exception("primary-body");}',
    action: 'lifetimeRun()',
    error: 'primary-body',
    log: 'A',
  },
  {
    name: 'closure-pair',
    setup:
      'var a=new ThrowingFinal();var b=new OtherFinal();var lifetimeClosure=a incontextof b;delete a;delete b;',
    action: 'delete lifetimeClosure',
    error: 'finalizer-A',
    log: 'AB',
  },
  {
    name: 'array-clear',
    setup: 'var bucket=[new ThrowingFinal(),new OtherFinal()];',
    action: 'bucket.clear()',
    error: 'finalizer-A',
    log: 'AB',
    empty: 'bucket.count===0',
  },
  ...[0, 16].map((count) => ({
    name: count ? 'dictionary-large' : 'dictionary-small',
    setup:
      'var bucket=%[];bucket.a=new ThrowingFinal();bucket.b=new OtherFinal();' +
      Array.from({ length: count }, (_, i) => `bucket.item${i}=${i};`).join(''),
    action: '(Dictionary.clear incontextof bucket)()',
    error: 'finalizer-A',
    log: 'AB',
    empty: 'bucket.a===void&&bucket.b===void',
  })),
  {
    name: 'primary-constructor',
    setup:
      'class BrokenFinal { function BrokenFinal(){throw new Exception("primary-constructor");} function finalize(){lifetimeLog+="A";throw new Exception("finalizer-A");}}',
    action: 'new BrokenFinal()',
    error: 'primary-constructor',
    log: 'A',
  },
  ...['array', 'dictionary', 'throwing-array'].map((kind) => ({
    name: 'deep-' + kind,
    setup: `function lifetimeRun(){var chain=new ${kind === 'throwing-array' ? 'ThrowingFinal' : 'OtherFinal'}();for(var i=0;i<8192;i++){${kind === 'dictionary' ? 'var next=%[];next.child=chain;chain=next;' : 'chain=[chain];'}}return 42;}`,
    action: 'lifetimeRun()',
    error: kind === 'throwing-array' ? 'finalizer-A' : null,
    log: kind === 'throwing-array' ? 'A' : 'B',
  })),
] as const

export async function exerciseObjectLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: string,
  debugMode: boolean,
  binary: boolean,
) {
  const fixture = objectLifetimeCases.find((item) => item.name === name)
  check(fixture, 'Unknown object lifetime case')
  const native = observeNative(factory)
  const vm = await TjsWasmRuntime.create(
    native.factory,
    () => {
      throw new Error('Unexpected host call')
    },
    { wasmBinary, variant, debugMode },
  )
  let observed: unknown
  try {
    const setup = classes + fixture!.setup
    await vm.execute(binary ? await vm.compile(setup, 'lifetime-setup.tjs') : setup)
    let value: unknown, failure: unknown
    try {
      value = await vm.execute(fixture!.action, 'lifetime-action.tjs', true)
    } catch (error) {
      failure = error
    }
    const log = await vm.execute('lifetimeLog', '', true)
    observed = {
      name,
      debugMode,
      binary,
      log,
      value: typeof value === 'bigint' ? String(value) : value,
      error: failure instanceof Error ? { name: failure.name, message: failure.message } : null,
      native: native.stats(),
      budget: executionStats(native),
    }
    if (fixture!.error)
      check(
        failure instanceof Error &&
          failure.name === 'ScriptError' &&
          failure.message.includes(fixture!.error),
        `Primary error changed: ${JSON.stringify(observed)}`,
      )
    else check(value === 42n && !failure, `Ordinary cleanup changed: ${JSON.stringify(observed)}`)
    check(
      typeof log === 'string' && log.split('').sort().join('') === fixture!.log,
      `Finalizers were missed or repeated: ${JSON.stringify(observed)}`,
    )
    if ('empty' in fixture!)
      check(
        (await vm.execute(fixture!.empty, '', true)) === 1n,
        'Container retained cleared members',
      )
    check((await vm.execute('6*7', '', true)) === 42n, 'Finalizer poisoned the VM')
    await vm.execute(
      'delete lifetimeRun;delete lifetimeClosure;delete bucket;delete a;delete b;delete BrokenFinal;delete ThrowingFinal;delete OtherFinal;delete lifetimeLog;',
    )
    const after = native.stats(),
      budget = executionStats(native)
    const destruction = {
      pending: native.call('krkr_native_lifetime_stat', 0),
      depth: native.call('krkr_native_lifetime_stat', 1),
      peakDepth: native.call('krkr_native_lifetime_stat', 2),
      queued: native.call('krkr_native_lifetime_stat', 3),
    }
    check(
      destruction.pending === 0 && destruction.depth === 0 && destruction.peakDepth <= 32,
      `Destruction queue did not drain: ${JSON.stringify(destruction)}`,
    )
    if (name.startsWith('deep-'))
      check(destruction.queued > 0, 'Deep fixture did not exercise queued destruction')
    check(
      after.blocks === 0 && after.contexts === 0,
      `Finalizer retained contexts: ${JSON.stringify({ observed, after })}`,
    )
    check(
      budget.depth === 0 && budget.bytes === 0 && vm.inspect().handles === 0,
      'Finalizer retained frames or handles',
    )
    return { ...(observed as object), after, budget, destruction }
  } finally {
    vm.dispose()
  }
}
