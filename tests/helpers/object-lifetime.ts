import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { observeNative, checkLifetime as check } from './bytecode-lifetime.ts'
import { executionStats } from './execution-budget.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'

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
  {
    name: 'explicit-retry',
    setup: `class RetryFinal {function finalize(){lifetimeLog+="R";if(lifetimeLog==="R")throw new Exception("explicit-first");}}
      function lifetimeRun(){var object=new RetryFinal();var message="";try{invalidate object;}catch(e){message=e.message;}
      if(!(isvalid object)||message.indexOf("explicit-first")<0)throw new Exception("explicit-invalidity");
      invalidate object;if(isvalid object)throw new Exception("explicit-retry");return 42;}`,
    action: 'lifetimeRun()',
    error: null,
    log: 'RR',
  },
  {
    name: 'caught-cleanup',
    setup: `var caughtObject=new ThrowingFinal();function lifetimeRun(){var message="";try{delete global.caughtObject;}catch(e){message=e.message;}
      if(message.indexOf("finalizer-A")<0)throw new Exception("cleanup-not-caught:"+message+":"+lifetimeLog);return 42;}`,
    action: 'lifetimeRun()',
    error: null,
    log: 'A',
  },
  {
    name: 'resurrection',
    setup: `var resurrected;class ResurrectFinal {function finalize(){lifetimeLog+="R";if(lifetimeLog==="R"){resurrected=this;throw new Exception("resurrect-first");}}}
      function makeResurrect(){var object=new ResurrectFinal();}
      function lifetimeRun(){var message="";try{makeResurrect();}catch(e){message=e.message;}
      if(!(isvalid resurrected)||message.indexOf("resurrect-first")<0)throw new Exception("resurrection-lost");
      invalidate resurrected;delete resurrected;return 42;}`,
    action: 'lifetimeRun()',
    error: null,
    log: 'RR',
  },
  {
    name: 'explicit-cycle',
    setup: `class CycleFinal {var name,peer;function CycleFinal(n){name=n;}function finalize(){lifetimeLog+=name;}}
      function lifetimeRun(){var a=new CycleFinal("A"),b=new CycleFinal("B");a.peer=b;b.peer=a;delete b;invalidate a;
      if(isvalid a)throw new Exception("cycle-invalidity");return 42;}`,
    action: 'lifetimeRun()',
    error: null,
    log: 'AB',
  },
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
    await vm.execute(
      'var lifetimeWarm=[];lifetimeWarm=%[];lifetimeWarm=new Exception("warm");delete lifetimeWarm;',
    )
    const beforeObjects = native.call('krkr_native_lifetime_stat', 4)
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
      'delete lifetimeRun;delete lifetimeClosure;delete bucket;delete a;delete b;delete BrokenFinal;delete ThrowingFinal;delete OtherFinal;delete RetryFinal;delete ResurrectFinal;delete resurrected;delete makeResurrect;delete CycleFinal;delete caughtObject;delete lifetimeLog;',
    )
    const after = native.stats(),
      budget = executionStats(native)
    const destruction = {
      pending: native.call('krkr_native_lifetime_stat', 0),
      depth: native.call('krkr_native_lifetime_stat', 1),
      peakDepth: native.call('krkr_native_lifetime_stat', 2),
      queued: native.call('krkr_native_lifetime_stat', 3),
      objects: native.call('krkr_native_lifetime_stat', 4),
    }
    check(
      destruction.objects === beforeObjects,
      `Finalizer retained dispatch objects: ${JSON.stringify({ observed, beforeObjects, destruction })}`,
    )
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
    return { ...(observed as object), after, budget, destruction, beforeObjects }
  } finally {
    vm.dispose()
  }
}

export async function exerciseFinalizationControl(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  explicit: boolean,
  binary: boolean,
  cancel: boolean,
) {
  const native = observeNative(factory),
    control = new ExecutionControl()
  let replyKind = -1
  const wrapped: ModuleFactory = async (options) => {
    const module = await native.factory(options),
      ccall = module.ccall.bind(module)
    module.ccall = async (...args) => {
      const reply = await ccall(...args)
      replyKind = Number(module._krkr_reply_kind!(reply))
      return reply
    }
    return module
  }
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
      entered = resolve
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve
    })
  const vm = await TjsWasmRuntime.create(
    wrapped,
    async (operation) => {
      check(operation === 'lifetime-hold', 'Unexpected finalizer host call')
      entered()
      await gate
      return { kind: 'value', value: undefined }
    },
    { wasmBinary, variant, control, debugMode: true },
  )
  let pending: Promise<void> | undefined,
    settled = false,
    value: unknown,
    error: unknown
  try {
    const setup = `var finalizerCount=0;class WaitingFinal {function finalize(){__host("lifetime-hold");finalizerCount++;}}
      ${explicit ? 'var heldObject=new WaitingFinal();' : ''}
      function finalizerRun(){${explicit ? 'invalidate heldObject;' : 'var object=new WaitingFinal();'}return 42;}`
    await vm.execute(binary ? await vm.compile(setup, 'waiting-finalizer.tjs') : setup)
    const before = native.stats(),
      beforeObjects = native.call('krkr_native_lifetime_stat', 4)
    pending = vm.execute('finalizerRun()', '', true).then(
      (result) => {
        value = result
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
        throw new Error(`Finalizer never suspended: ${String(error)}`)
      }),
    ])
    const heldDepth = native.call('krkr_native_lifetime_stat', 1)
    if (!explicit) check(heldDepth > 0, 'Implicit finalizer has no active release')
    control.pause()
    release()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    check(!settled, 'Finalizer advanced while paused')
    if (cancel) control.cancel()
    else control.resume()
    await pending
    const nativeReplyKind = replyKind
    if (cancel)
      check(
        error instanceof Error && error.name === 'AbortError',
        `Finalizer cancellation failed: ${String(error)}`,
      )
    else check(value === 42n && !error, `Finalizer resume failed: ${String(error)}`)
    check(nativeReplyKind === (cancel ? 1 : 0), 'Finalizer cancellation did not unwind natively')
    const after = native.stats(),
      budget = executionStats(native),
      objects = native.call('krkr_native_lifetime_stat', 4)
    check(
      after.blocks === before.blocks &&
        after.contexts === before.contexts &&
        objects === beforeObjects,
      `Finalizer control retained resources: ${JSON.stringify({ before, after, beforeObjects, objects })}`,
    )
    check(
      budget.depth === 0 &&
        budget.bytes === 0 &&
        native.call('krkr_native_lifetime_stat', 0) === 0 &&
        native.call('krkr_native_lifetime_stat', 1) === 0,
      'Finalizer control retained execution or destruction frames',
    )
    if (!cancel)
      check(
        (await vm.execute('finalizerCount', '', true)) === 1n,
        'Finalizer did not finish exactly once',
      )
    return {
      explicit,
      binary,
      cancel,
      heldMs: 25,
      heldDepth,
      nativeReplyKind,
      before,
      after,
      beforeObjects,
      objects,
      budget,
      error: error instanceof Error ? error.name : null,
    }
  } finally {
    release()
    control.cancel()
    await pending
    vm.dispose()
  }
}
