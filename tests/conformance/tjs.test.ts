import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import {
  isScriptObject,
  ScriptError,
  scriptRecord,
  scriptList,
  type HostHandler,
} from '../../src/engine/script/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const delay = (ms = 5) => new Promise<void>((resolve) => setTimeout(resolve, ms))
async function runtime(
  handler: HostHandler = () => {
    throw new Error('Unexpected host call')
  },
  control?: ExecutionControl,
) {
  return TjsWasmRuntime.create(factory, handler, { wasmBinary, control })
}

test('an ABI 5 module without release-drain state is rejected before creating a VM', async () => {
  let created = false
  const legacy: ModuleFactory = async () => ({
    HEAPU8: new Uint8Array(),
    HEAPU16: new Uint16Array(),
    HEAPU32: new Uint32Array(),
    _krkr_abi_version: () => 5,
    _krkr_create: () => {
      created = true
      return 1
    },
    ccall: async () => 0,
  })
  await assert.rejects(
    TjsWasmRuntime.create(legacy, () => ({ kind: 'value', value: undefined })),
    /missing native release-state support/,
  )
  assert.equal(created, false)
})

for (const binary of [false, true])
  for (const outcome of ['success', 'throw', 'cancel'] as const)
    test(
      `${binary ? 'bytecode' : 'source'}: native drain stays active with an empty release queue during suspended ${outcome} finalization`,
      { timeout: 30000 },
      async () => {
        const control = new ExecutionControl()
        let enter!: () => void, release!: () => void
        const entered = new Promise<void>((resolve) => {
            enter = resolve
          }),
          gate = new Promise<void>((resolve) => {
            release = resolve
          })
        let observed: ReturnType<TjsWasmRuntime['inspect']> | undefined,
          collecting: Promise<void> | undefined
        const vm = await runtime(async (operation) => {
          assert.equal(operation, 'DuringDrain')
          observed = vm.inspect()
          enter()
          await gate
          return { kind: 'value', value: undefined }
        }, control)
        try {
          assert.equal(manifest.capabilities?.nativeReleaseState, 1)
          assert.equal(vm.inspect().drainingReleased, false)
          const source = `class DrainMarker {
          function finalize(){__host("DuringDrain");${outcome === 'throw' ? 'throw "drain-finalizer-failure";' : ''}}
        }`
          const program = binary ? await vm.compile(source, 'drain-state.tjs') : source
          await vm.execute(program, binary ? 'drain-state.cjs' : 'drain-state.tjs')
          const owned = await vm.execute('new DrainMarker()', 'drain-owner.tjs', true)
          assert(isScriptObject(owned))
          vm.release(owned)
          assert.equal(vm.inspect().pendingHandles, 1)
          assert.equal(vm.inspect().drainingReleased, false)
          collecting = vm.collect()
          await Promise.race([
            entered,
            collecting.then(() => {
              throw new Error('Collector returned without observing finalization')
            }),
          ])
          assert.equal(observed?.pendingHandles, 0, 'The retiring handle already left the queue')
          assert.equal(
            observed?.drainingReleased,
            true,
            'The native finalizer still owns the drain',
          )
          assert.equal(vm.inspect().drainingReleased, true)
          if (outcome === 'cancel') control.cancel()
          release()
          if (outcome === 'success') await collecting
          else
            await assert.rejects(
              collecting,
              outcome === 'throw' ? /drain-finalizer-failure/ : /Execution cancelled/,
            )
          assert.equal(vm.inspect().drainingReleased, false)
          assert.equal(vm.inspect().pendingHandles, 0)
        } finally {
          release()
          await collecting?.catch(() => {})
          vm.dispose()
        }
      },
    )

test('native console warnings can suspend and run nested script on the existing compiler stack', async () => {
  const vm = await runtime(),
    messages: string[] = []
  try {
    await vm.execute('var warningVisits=0;')
    vm.setConsoleOutput(async (message) => {
      messages.push(message)
      await delay()
      return { kind: 'script', source: 'warningVisits+=1;', name: 'warning-observer.tjs' }
    })
    await vm.execute('var checked=0;if(checked=1){}', 'warning-source.tjs')
    assert.equal(await vm.execute('warningVisits', '', true), 1n)
    assert.equal(await vm.execute('checked', '', true), 1n)
    assert.equal(messages.length, 1)
    assert.match(messages[0]!, /warning-source.tjs.*line 1/)
    vm.setConsoleOutput(null)
    await vm.execute('if(checked=2){}', 'muted.tjs')
    assert.equal(messages.length, 1)
  } finally {
    vm.dispose()
  }
})

test('bytecode compilation awaits console continuations and the result executes without compiling again', async () => {
  const vm = await runtime(),
    messages: string[] = []
  try {
    await vm.execute('var compilerObserver=0;')
    vm.setConsoleOutput(async (message) => {
      messages.push(message)
      await delay()
      return { kind: 'script', source: 'compilerObserver+=1;', name: 'compile-observer.tjs' }
    })
    const bytes = await vm.compile(
      'var compiledValue=0;if(compiledValue=7){}',
      'compiled-warning.tjs',
    )
    assert.equal(Buffer.from(bytes.subarray(0, 4)).toString(), 'TJS2')
    await vm.execute(bytes, 'compiled-warning.tjs')
    assert.equal(await vm.execute('compiledValue+compilerObserver', '', true), 8n)
    assert.equal(messages.length, 1)
    await assert.rejects(vm.compile('x\0y'), /NUL/)
  } finally {
    vm.dispose()
  }
})

test('exported compound and increment instructions preserve register, member and property operands', async (t) => {
  const vm = await runtime()
  try {
    for (const operator of [
      '||=',
      '&&=',
      '|=',
      '^=',
      '&=',
      '>>=',
      '<<=',
      '>>>=',
      '+=',
      '-=',
      '%=',
      '/=',
      '\\=',
      '*=',
      '++',
      '--',
    ]) {
      for (const target of ['local', 'object.value', 'object[key]', '(*accessor)']) {
        t.diagnostic(`bytecode round trip: ${target} ${operator}`)
        const mutation = ['++', '--'].includes(operator)
          ? target + operator
          : target + operator + '3'
        const source = `
var backing=29;
property exportedValue {getter(){return backing;} setter(v){backing=v;}}
function exercise(){
  var local=29,object=%[value:29],key="value",accessor=&exportedValue;
  var returned=(${mutation});
  return [returned,local,object.value,backing].join(",");
}
var exportedResult=exercise();`
        await vm.execute(source, 'operator-source.tjs')
        const expected = await vm.execute('exportedResult', '', true)
        const compiled = await vm.compile(source, 'operator-compiled.tjs')
        await vm.execute(compiled, 'operator-compiled.tjs')
        assert.equal(
          await vm.execute('exportedResult', '', true),
          expected,
          `${target} ${operator}`,
        )
      }
    }
  } finally {
    vm.dispose()
  }
})

test('syntax failures never execute a parsed prefix or return partial compiled code', async () => {
  const vm = await runtime()
  try {
    await vm.execute('var parsed=0;')
    for (const source of [
      'parsed=1; function {',
      'parsed=2; var broken=; parsed=3;',
      'class Partial {function method(){return 1;}} class Broken {',
      'parsed=4; if (',
    ]) {
      await assert.rejects(vm.execute(source, 'invalid-source.tjs'), { name: 'ScriptError' })
      assert.equal(await vm.execute('parsed', '', true), 0n)
      await assert.rejects(vm.compile(source, 'invalid-compile.tjs'), { name: 'ScriptError' })
      assert.equal(await vm.execute('parsed', '', true), 0n)
    }
    await assert.rejects(vm.execute('1 +', 'invalid-expression.tjs', true), { name: 'ScriptError' })
    await assert.rejects(vm.compile('1 +', 'invalid-expression.tjs', true), { name: 'ScriptError' })
    const recovered = await vm.compile('6*7', 'syntax-recovery.tjs', true)
    assert.equal(await vm.execute(recovered, 'syntax-recovery.tjs'), 42n)
  } finally {
    vm.dispose()
  }
})

test('a paused compiler warning can be cancelled and concurrent native entry is rejected', async () => {
  const control = new ExecutionControl(),
    vm = await runtime(undefined, control)
  let entered!: () => void, release!: () => void
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r))
  vm.setConsoleOutput(async () => {
    entered()
    await gate
    return { kind: 'value', value: undefined }
  })
  const pending = vm.compile('var a=0;if(a=1){}', 'cancel-compile.tjs')
  const rejected = assert.rejects(pending, /Execution cancelled/)
  try {
    await started
    await assert.rejects(vm.execute('1', '', true), /Concurrent TJS execution/)
    assert.throws(() => vm.setConsoleOutput(null), /while TJS is running/)
    control.pause()
    release()
    let finished = false
    void pending.then(
      () => (finished = true),
      () => (finished = true),
    )
    await delay(20)
    assert.equal(finished, false)
    control.cancel()
    await rejected
  } finally {
    release()
    control.cancel()
    await rejected
    vm.dispose()
  }
})

test('a failing diagnostic callback cannot replace the primary native VM exception', async () => {
  const vm = await runtime()
  let observed = 0
  try {
    vm.setConsoleOutput(() => {
      observed++
      throw new Error('secondary-console-error')
    })
    await assert.rejects(
      vm.execute('function crash(){return missingOriginal;}crash();', 'primary-console.tjs'),
      /missingOriginal/,
    )
    assert(observed > 0)
    vm.setConsoleOutput(null)
    assert.equal(await vm.execute('6*7', 'recovery.tjs', true), 42n)
  } finally {
    vm.dispose()
  }
})

test('VM dumps use a bounded UTF-16 file sink and restore the normal console afterwards', async () => {
  const vm = await runtime((operation) => {
      assert.equal(operation, 'dump')
      return { kind: 'dump' }
    }),
    messages: string[] = []
  try {
    vm.setConsoleOutput((text) => {
      messages.push(text)
      return { kind: 'value', value: undefined }
    })
    await vm.execute('var dumpFunction=function(){return "漢字";};', 'dump-source.tjs')
    const bytes = await vm.execute('__host("dump")', 'dump-query.tjs', true)
    assert(bytes instanceof Uint8Array)
    assert.deepEqual([...bytes.subarray(0, 2)], [255, 254])
    const text = Buffer.from(bytes).toString('utf16le')
    assert.match(text, /TJS Context Dump/)
    assert.match(text, /dump-source.tjs/)
    assert.match(text, /漢字/)
    assert.equal(messages.length, 0)
    await vm.execute('var warning=0;if(warning=1){}', 'after-dump.tjs')
    assert.equal(messages.length, 1)
  } finally {
    vm.dispose()
  }
})

test('structured data preserves int64 and void; explicit snapshots reject cycles and script properties', async () => {
  const vm = await runtime((operation, args, context) => {
    if (operation === 'data')
      return {
        kind: 'value',
        value: scriptRecord({
          large: 9007199254740993n,
          values: scriptList([undefined, null, '日本語']),
        }),
      }
    assert.ok(isScriptObject(args[0]))
    return { kind: 'value', value: context.snapshot(args[0]) }
  })
  try {
    await vm.execute('var data=__host("data"); var copy=__host("copy",data);')
    assert.equal(await vm.execute('copy.large', '', true), 9007199254740993n)
    assert.equal(
      await vm.execute(
        'copy.values[0]===void && copy.values[1]===null && copy.values[2]=="日本語"',
        '',
        true,
      ),
      1n,
    )
    await assert.rejects(
      vm.execute('var cyclic=%[]; cyclic.self=cyclic; __host("copy",cyclic);'),
      /Cyclic data/,
    )
    await assert.rejects(
      vm.execute(
        'class Unsafe { property value { getter(){throw new Exception("getter ran");} } } __host("copy",new Unsafe());',
      ),
      /snapshot requires/,
    )
    assert.equal(await vm.execute('6*7', '', true), 42n)
    assert.equal(vm.inspect().handles, 0)
  } finally {
    vm.dispose()
  }
})

test('TJS preserves integers, floating point, UTF-16, octets and source state', async () => {
  const vm = await runtime()
  try {
    assert.equal(await vm.execute('9007199254740993', 'int.tjs', true), 9007199254740993n)
    assert.equal(await vm.execute('1.25 + 0.5', 'float.tjs', true), 1.75)
    assert.equal(await vm.execute('"你好😀"', 'text.tjs', true), '你好😀')
    assert.deepEqual(
      await vm.execute('<% 00 7f ff %>', 'bytes.tjs', true),
      new Uint8Array([0, 127, 255]),
    )
    await vm.execute('var answer = 40; function add(a) { return answer + a; }')
    assert.equal(await vm.execute('add(2)', 'state.tjs', true), 42n)
  } finally {
    vm.dispose()
  }
})

test('source compiles to real TJS bytecode and executes in a fresh VM', async () => {
  const vm = await runtime()
  const bytes = await vm.compile('21 * 2', 'compiled.tjs', true)
  vm.dispose()
  assert.ok(bytes.length > 16)
  const fresh = await runtime()
  try {
    assert.equal(await fresh.execute(bytes, 'compiled.tjb'), 42n)
  } finally {
    fresh.dispose()
  }
})

test('async host reads resume synchronously, including nested TJS callbacks', async () => {
  const order: string[] = []
  const vm = await runtime(async (operation, args) => {
    order.push(operation)
    await delay()
    if (operation === 'callback') {
      assert.ok(isScriptObject(args[0]))
      return { kind: 'invoke', callback: args[0], args: [2n] }
    }
    if (operation === 'read') return { kind: 'value', value: 40n }
    throw new Error(`Unexpected ${operation}`)
  })
  try {
    assert.equal(
      await vm.execute(
        '__host("callback", function(a) { return __host("read") + a; })',
        'nested.tjs',
        true,
      ),
      42n,
    )
    assert.deepEqual(order, ['callback', 'read'])
    assert.equal(vm.inspect().handles, 0)
  } finally {
    vm.dispose()
  }
})

test('native host proxies preserve object identity and suspend indexed properties and methods', async () => {
  const values = [0n, 0n]
  const vm = await runtime(async (operation, args) => {
    await delay(1)
    if (operation === 'proxy')
      return {
        kind: 'value',
        value: { type: 'proxy', namespace: 'flags', id: 7, className: 'WaveFlags' },
      }
    assert.equal(args[0], 7n)
    if (operation === 'flags.call' && args[1] === 'reset') {
      values.fill(0n)
      return { kind: 'value', value: undefined }
    }
    if (operation === 'flags.get' && args[1] === 'count') return { kind: 'value', value: 2n }
    const index = Number(args[1])
    assert.ok(index === 0 || index === 1)
    if (operation === 'flags.set') {
      assert.equal(typeof args[2], 'bigint')
      values[index] = args[2] as bigint
    }
    return { kind: 'value', value: values[index] }
  })
  try {
    await vm.execute(
      'var holder=%[flags:__host("proxy")];var flags=holder.flags;flags[0]=40;flags[0]++;flags[0]+=1;',
    )
    assert.equal(await vm.execute('flags[0]', '', true), 42n)
    assert.equal(
      await vm.execute(
        'holder.flags===flags && flags instanceof "WaveFlags" && flags.count==2',
        '',
        true,
      ),
      1n,
    )
    await vm.execute('flags.reset();')
    assert.deepEqual(values, [0n, 0n])
    await vm.execute('invalidate flags;')
    assert.equal(await vm.execute('isvalid flags', '', true), 0n)
    await assert.rejects(vm.execute('flags[0]', '', true), /invalidated|invalid/i)
  } finally {
    vm.dispose()
  }
})

test('async nested script execution returns to its caller and preserves order', async () => {
  const vm = await runtime(async () => {
    await delay()
    return { kind: 'script', source: 'loaded = 41;', name: 'loaded.tjs' }
  })
  try {
    await vm.execute('var loaded = 0; __host("execStorage"); loaded += 1;', 'startup.tjs')
    assert.equal(await vm.execute('loaded', 'check.tjs', true), 42n)
  } finally {
    vm.dispose()
  }
})

test('host failures produce source diagnostics and do not corrupt the VM', async () => {
  const vm = await runtime(async () => {
    await delay()
    throw new Error('Asset does not exist')
  })
  try {
    await assert.rejects(
      vm.execute('__host("read");', 'missing.tjs'),
      (error: unknown) =>
        error instanceof ScriptError &&
        error.message.includes('Asset does not exist') &&
        error.source === 'missing.tjs',
    )
    assert.equal(await vm.execute('6 * 7', 'after-error.tjs', true), 42n)
  } finally {
    vm.dispose()
  }
})

test('object ownership is explicit and handles are invalid after release', async () => {
  const vm = await runtime()
  try {
    const callback = await vm.execute('function() { return 42; }', 'callback.tjs', true)
    assert.ok(isScriptObject(callback))
    const retained = vm.retain(callback)
    vm.release(callback)
    assert.equal(await vm.invoke(retained), 42n)
    vm.release(retained)
    assert.equal(vm.inspect().handles, 0)
    await assert.rejects(vm.invoke(retained), /Released TJS object handle/)
  } finally {
    vm.dispose()
  }
})

test('budget checkpoints let cancellation interrupt a CPU loop', async () => {
  const control = new ExecutionControl()
  const vm = await runtime(undefined, control)
  const timer = setTimeout(() => control.cancel(), 30)
  try {
    await assert.rejects(vm.execute('while(true) {}', 'loop.tjs'), /cancelled/)
  } finally {
    clearTimeout(timer)
    vm.dispose()
  }
})

test('explicit invalidation runs async finalizers; shutdown starts no new host work', async () => {
  const events: string[] = []
  const vm = await runtime(async (operation) => {
    await delay()
    events.push(operation)
    return { kind: 'value', value: undefined }
  })
  try {
    await vm.execute('class Cleanup { function finalize() { __host("finalize"); } }')
    await vm.execute('var resource = new Cleanup();')
    const object = await vm.execute('resource', 'resource.tjs', true)
    assert.ok(isScriptObject(object))
    vm.release(object)
    await vm.execute('invalidate resource;', 'finalize.tjs')
    assert.deepEqual(events, ['finalize'])
    await vm.execute('var pending = new Cleanup();')
  } finally {
    vm.dispose()
  }
  await delay()
  assert.deepEqual(events, ['finalize'])
})

test('stop while paused or awaiting host I/O eventually releases the VM', async () => {
  const control = new ExecutionControl()
  const vm = await runtime(async () => {
    await delay(50)
    return { kind: 'value', value: 1n }
  }, control)
  const running = vm.execute('__host("read");', 'pending.tjs')
  control.pause()
  await delay()
  control.cancel()
  await assert.rejects(running, /cancelled/)
  vm.dispose()
  vm.dispose()
})

test('closure identities compare the exact function/context pair across pins without executing properties', async () => {
  const vm = await runtime()
  const handles = []
  try {
    await vm.execute(
      'class Item { function Item(){} function action(tick){return tick;} } var a=new Item(),b=new Item();',
    )
    for (const expression of ['a.action', 'a.action', 'b.action', 'a', 'a']) {
      const object = await vm.execute(expression, 'identity.tjs', true)
      assert(isScriptObject(object))
      handles.push(object)
    }
    assert.equal(vm.objectIdentity(handles[0]!), vm.objectIdentity(handles[1]!))
    assert.notEqual(vm.objectIdentity(handles[0]!), vm.objectIdentity(handles[2]!))
    assert.equal(vm.objectIdentity(handles[3]!), vm.objectIdentity(handles[4]!))
    const retained = vm.retain(handles[0]!)
    assert.equal(vm.objectIdentity(retained), vm.objectIdentity(handles[0]!))
    vm.release(retained)
    assert.throws(() => vm.objectIdentity(retained), /Released/)
    const before = vm.inspect().handles
    for (let i = 0; i < 1000; i++) vm.objectIdentity(handles[0]!)
    assert.equal(vm.inspect().handles, before)
    assert.equal(await vm.invoke(handles[0]!, [42n]), 42n)
  } finally {
    for (const handle of handles) vm.release(handle)
    vm.dispose()
  }
})
