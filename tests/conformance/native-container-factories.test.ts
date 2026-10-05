import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, NativeModule, WasmManifest, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { scriptList, scriptRecord } from '../../src/engine/script/runtime.ts'

const variant = (process.env.KRKR_CONTAINER_VARIANT ?? 'asyncify') as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
  assets = manifest.variants[variant]!,
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

const source = String.raw`
var anchorList=__host("Containers.list"),anchorRecord=__host("Containers.record");
var expected=anchorRecord.tag,generator=new Math.RandomGenerator(anchorRecord.seed);
var arrayMethod=anchorList.add incontextof global;
var dictionaryMethod=Dictionary.assign incontextof global;
var anchorState=generator.serialize();
function identities(){
  return (anchorList.add incontextof global)===global.arrayMethod &&
    (Dictionary.assign incontextof global)===global.dictionaryMethod &&
    anchorList instanceof "Array" && anchorRecord instanceof "Dictionary" &&
    anchorRecord.tag===global.expected && anchorState instanceof "Dictionary" &&
    anchorState.state.length==4992;
}
function allocateBatch(){
  for(var i=0;i<16;i++){
    var list=__host("Containers.list"),record=__host("Containers.record");
    if(!(list instanceof "Array") || !(record instanceof "Dictionary"))throw "host container type changed";
    if(list[0]!==global.expected || list[1].tag!==global.expected || record.tag!==global.expected)
      throw "container module mixed";
    // Closure identity also includes objThis. Rebind both closures to one
    // receiver before comparing their native method objects.
    if((list.add incontextof global)!==global.arrayMethod)throw "Array factory method identity changed";
    if((Dictionary.assign incontextof global)!==global.dictionaryMethod)throw "Dictionary method identity changed";
    list.add(71);if(list.count!=3 || list[2]!=71)throw "new Array method lost its own receiver";
    (Dictionary.assign incontextof record)(global.anchorRecord);
    if(record.tag!==global.expected || record.nested[0]!==global.expected)throw "Dictionary factory instance invalid";
    var state=generator.serialize();
    if(!(state instanceof "Dictionary") || state.state.length!=4992)throw "Random.serialize did not make a native Dictionary";
    var restored=new Math.RandomGenerator(state);
    if(generator.random64()!=restored.random64())throw "native serialized state changed";
  }
  return identities();
}
`

async function fixture(binary: boolean, tag: string, seed: bigint) {
  let module!: NativeModule
  const calls = { list: 0, record: 0 }, vm = await TjsWasmRuntime.create(async (options) => {
    module = await factory(options)
    return module
  }, (operation) => {
    if (operation === 'Containers.list') {
      calls.list++
      return { kind: 'value', value: scriptList([tag, scriptRecord({ tag })]) }
    }
    if (operation === 'Containers.record') {
      calls.record++
      return { kind: 'value', value: scriptRecord({ tag, seed, nested: scriptList([tag]) }) }
    }
    throw new Error('Unexpected container host operation: ' + operation)
  }, { wasmBinary, variant })
  let closed = false
  const close = () => {
    if (closed) return
    vm.dispose(); closed = true
    assert.equal(Number(module._krkr_native_lifetime_stat!(4)), 0,
      'No live native dispatch objects, including cached container factories, survive VM disposal')
  }
  try {
    await vm.execute(binary ? await vm.compile(source, 'container-factories.tjs') : source, 'container-factories.tjs')
    // Compile each call once. The live-object plateau must not be confused
    // with adding unrelated source strings to the script compilation cache.
    const batch = binary ? await vm.compile('allocateBatch()', 'container-call.tjs', true) : 'allocateBatch()',
      identity = binary ? await vm.compile('identities()', 'container-identity.tjs', true) : 'identities()'
    return { vm, module, calls, close,
      batch: () => vm.execute(batch, 'container-call.tjs', true),
      identity: () => vm.execute(identity, 'container-identity.tjs', true),
    }
  } catch (error) {
    try { close() }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'Container setup and cleanup failed', { cause: error }) }
    throw error
  }
}
function settled(f: Awaited<ReturnType<typeof fixture>>) {
  const state = f.vm.inspect()
  assert.deepEqual([state.handles, state.pendingHandles, state.weakOwners, state.objectIdentities,
    state.dependents, state.pendingInvalidations], [0, 0, 0, 0, 0, 0])
  assert.equal(state.drainingReleased, false)
  assert.equal(Number(f.module._krkr_native_lifetime_stat!(0)), 0, 'No native destruction remains pending')
  assert.equal(Number(f.module._krkr_native_lifetime_stat!(1)), 0, 'No native destruction frame remains active')
  assert(state.scriptObjects > 0, 'The live VM still owns its classes and explicitly retained anchor containers')
  return state.scriptObjects
}

for (const binary of [false, true]) {
  const mode = `${variant}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: real ScriptList/ScriptRecord and Random.serialize factories retain active method identity and retire to zero`, { timeout: 60000 }, async () => {
    const f = await fixture(binary, 'single', 1234n), failures: unknown[] = []
    try {
      assert.deepEqual(f.calls, { list: 1, record: 1 })
      assert.equal(await f.identity(), 1n)
      assert.equal(await f.batch(), 1n)
      await f.vm.collect()
      const baseline = settled(f)
      for (let iteration = 0; iteration < 8; iteration++) {
        assert.equal(await f.batch(), 1n)
        assert.equal(await f.identity(), 1n)
        await f.vm.collect()
        assert.equal(settled(f), baseline, 'Repeated factory allocation does not retain another class or container per round')
      }
      assert.deepEqual(f.calls, { list: 145, record: 145 })
    } catch (error) { failures.push(error) }
    try { f.close() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Container lifetime or disposal failed', { cause: failures[0] })
  })

  test(`${mode}: two simultaneous modules keep independent native container factories after one VM retires`, { timeout: 60000 }, async () => {
    const first = await fixture(binary, 'first', 17n), failures: unknown[] = []
    let second: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      second = await fixture(binary, 'second', 29n)
      assert.notEqual(first.module, second.module)
      assert.notEqual(first.module.HEAPU8.buffer, second.module.HEAPU8.buffer)
      assert.deepEqual(await Promise.all([first.identity(), second.identity()]), [1n, 1n])
      assert.deepEqual(await Promise.all([first.batch(), second.batch()]), [1n, 1n])
      await Promise.all([first.vm.collect(), second.vm.collect()])
      const firstBaseline = settled(first), secondBaseline = settled(second)
      for (let iteration = 0; iteration < 3; iteration++) {
        assert.equal(await second.batch(), 1n)
        assert.equal(await first.batch(), 1n)
        await Promise.all([first.vm.collect(), second.vm.collect()])
        assert.equal(settled(first), firstBaseline)
        assert.equal(settled(second), secondBaseline)
      }
      first.close()
      assert.deepEqual(first.calls, { list: 65, record: 65 })
      assert.equal(await second.batch(), 1n)
      assert.equal(await second.identity(), 1n)
      await second.vm.collect()
      assert.equal(settled(second), secondBaseline, 'The survivor keeps exactly its own previously live object set')
      assert.deepEqual(second.calls, { list: 81, record: 81 })
      assert.equal(Number(first.module._krkr_native_lifetime_stat!(4)), 0, 'Using the survivor cannot resurrect another module factory')
    } catch (error) { failures.push(error) }
    try { first.close() } catch (error) { failures.push(error) }
    try { second?.close() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Independent container modules or cleanup failed', { cause: failures[0] })
  })
}
