import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory } from '../../src/backends/script/tjs-wasm/module.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { scriptList, scriptRecord, type HostHandler } from '../../src/engine/script/runtime.ts'

const binding = 'var trace=__host("trace-function");'
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
const check = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message)
}

/** Runs the same assertions on Node and actual browser Asyncify/JSPI modules. */
export async function exerciseTrace(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: string,
) {
  const traces: Record<string, string> = {}
  const create = (debugMode: boolean, handler?: HostHandler, control?: ExecutionControl) =>
    TjsWasmRuntime.create(
      factory,
      (operation, args, context) => {
        if (operation === 'trace-function')
          return { kind: 'value', value: { type: 'native-method', name: 'getTraceString' } }
        if (!handler) throw new Error('Unexpected trace host call: ' + operation)
        return handler(operation, args, context)
      },
      { wasmBinary, variant, debugMode, control },
    )
  const disabled = await create(false)
  try {
    await disabled.execute(binding)
    check(
      (await disabled.execute('trace()', 'disabled.tjs', true)) === '',
      'Disabled trace must be empty',
    )
  } finally {
    disabled.dispose()
  }

  const vm = await create(true, async (operation, args) => {
    await delay(2)
    if (operation === 'allocate')
      return {
        kind: 'value',
        value: scriptList(
          Array.from({ length: 160 }, (_, index) =>
            scriptRecord({ index: BigInt(index), payload: 'x'.repeat(32768) }),
          ),
        ),
      }
    if (operation === 'source')
      return {
        kind: 'script',
        name: 'nested-host.tjs',
        lineOffset: 40,
        source: 'var nestedHostTrace=trace();',
      }
    if (operation === 'callback') {
      const callback = args[0]
      if (
        !callback ||
        typeof callback !== 'object' ||
        !('type' in callback) ||
        callback.type !== 'object'
      )
        throw new Error('Missing callback')
      return { kind: 'invoke', callback, args: [] }
    }
    throw new Error('Unexpected trace operation')
  })
  try {
    await vm.execute(binding, 'bind-trace.tjs')
    check(
      (await vm.execute('trace instanceof "Function"', '', true)) === 1n,
      'Native method identity',
    )
    await vm.execute(
      [
        'function leaf(){',
        '  return trace();',
        '}',
        'function outer(){',
        '  return leaf();',
        '}',
        'var traceResult=outer();',
      ].join('\n'),
      '呼出し.tjs',
    )
    traces.nested = String(await vm.execute('traceResult', '', true))
    check(
      traces.nested ===
        '呼出し.tjs(2)[(function) leaf] <-- 呼出し.tjs(5)[(function) outer] <-- 呼出し.tjs(7)[(top level script) global]',
      'Exact source lines and call order: ' + traces.nested,
    )
    for (const [argument, frames] of [
      ['', 3],
      ['void', 3],
      ['0', 3],
      ['1', 1],
      ['2', 2],
      ['"2"', 2],
      ['-1', 1],
      ['-2147483648', 1],
      ['99', 3],
    ] as const) {
      const result = await vm.execute(
        `function a(){return trace(${argument});}function b(){return a();}b();`,
        'limit.tjs',
      )
      // ExecScript's result is void; inspect the captured expression separately.
      void result
      const value = String(await vm.execute('b()', 'limit-call.tjs', true))
      check(value.split(' <-- ').length === frames, `Trace limit ${argument}: ${value}`)
    }
    await vm.execute(
      'function innerTry(){try{try{return trace();}catch(e){}}catch(e){}}function outerTry(){try{return innerTry();}catch(e){}}var tried=outerTry();',
      'try-trace.tjs',
    )
    traces.try = String(await vm.execute('tried', '', true))
    check(traces.try.split(' <-- ').length === 3, 'Try frames must be collapsed: ' + traces.try)
    check(traces.try.includes('innerTry') && traces.try.includes('outerTry'), 'Try frame names')

    await vm.execute(
      [
        'function waiting(){',
        '  var allocated=__host("allocate");',
        '  __host("source");',
        '  var callbackTrace=__host("callback",function(){return trace();});',
        '  return [trace(),callbackTrace,allocated.count].join("|");',
        '}',
        'var waited=waiting();',
      ].join('\n'),
      'suspended.tjs',
    )
    traces.suspended = String(await vm.execute('waited', '', true))
    traces.host = String(await vm.execute('nestedHostTrace', '', true))
    check(
      traces.suspended.startsWith(
        'suspended.tjs(5)[(function) waiting] <-- suspended.tjs(7)[(top level script) global]|',
      ),
      'Position after suspending/allocating: ' + traces.suspended,
    )
    check(
      traces.suspended.includes(
        'suspended.tjs(4)[(function expression) (anonymous)] <-- suspended.tjs(4)[(function) waiting]',
      ),
      'Native callback frames: ' + traces.suspended,
    )
    check(traces.suspended.endsWith('|160'), 'Suspended host value allocation')
    check(
      traces.host ===
        'nested-host.tjs(41)[(top level script) global] <-- suspended.tjs(3)[(function) waiting] <-- suspended.tjs(7)[(top level script) global]',
      'Nested source offset and original parent: ' + traces.host,
    )

    const bytes = await vm.compile(
      'function compiledTrace(){return trace();}var bytecodeTrace=compiledTrace();',
      'compiled-trace.tjs',
    )
    await vm.execute(bytes, 'loaded-bytecode.tjs')
    traces.bytecode = String(await vm.execute('bytecodeTrace', '', true))
    check(
      traces.bytecode.includes('(1)[(function) compiledTrace]') &&
        traces.bytecode.split(' <-- ').length === 2,
      'Bytecode trace: ' + traces.bytecode,
    )
    let primary = ''
    vm.setConsoleOutput(async () => {
      await delay(2)
      throw new Error('secondary-debug-observer')
    })
    try {
      await vm.execute(
        'function primary(){return missingTracePrimary;}primary();',
        'primary-trace.tjs',
      )
    } catch (error) {
      primary = String(error)
    }
    check(
      primary.includes('missingTracePrimary') && !primary.includes('secondary-debug-observer'),
      'Primary error replaced: ' + primary,
    )
    vm.setConsoleOutput(null)
    traces.recovered = String(await vm.execute('trace()', 'trace-recovery.tjs', true))
    check(
      traces.recovered === 'trace-recovery.tjs(1)[(top level script) global]',
      'Stale exception frames: ' + traces.recovered,
    )
    check(vm.inspect().handles === 0, 'Trace operations retained host handles')
  } finally {
    vm.dispose()
  }

  const control = new ExecutionControl()
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const cancelled = await create(
    true,
    async () => {
      entered()
      await gate
      return { kind: 'value', value: undefined }
    },
    control,
  )
  let settled = false,
    cancellation = ''
  await cancelled.execute(binding)
  const pending = cancelled
    .execute('function waiting(){__host("wait");}waiting();', 'cancel-trace.tjs')
    .then(
      () => {
        settled = true
      },
      (error) => {
        settled = true
        cancellation = String(error)
      },
    )
  try {
    await started
    control.pause()
    release()
    await delay(20)
    check(!settled, 'Trace-enabled VM resumed while paused')
    control.cancel()
    await pending
    check(cancellation.includes('Execution cancelled'), 'Trace-enabled cancellation')
    check(cancelled.inspect().handles === 0, 'Cancellation retained handles')
  } finally {
    release()
    control.cancel()
    await pending
    cancelled.dispose()
  }
  const fresh = await create(true)
  try {
    await fresh.execute(binding)
    traces.fresh = String(await fresh.execute('trace()', 'fresh-trace.tjs', true))
    check(
      traces.fresh === 'fresh-trace.tjs(1)[(top level script) global]',
      'Disposed VM leaked trace frames',
    )
  } finally {
    fresh.dispose()
  }
  return { traces, cancelled: cancellation, defaultDisabled: true, nativeMethod: true }
}
