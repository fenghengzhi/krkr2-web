import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, NativeModule, WasmManifest, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'

// The ordinary Node gate uses Asyncify. The dedicated hosted command also runs
// this same file with KRKR_VARIANT_STACK_VARIANT=jspi and --experimental-wasm-jspi.
const variant = (process.env.KRKR_VARIANT_STACK_VARIANT ?? 'asyncify') as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
  assets = manifest.variants[variant]!
assert(assets)
const { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
type StackStats = { allocatedBlocks: number; usingBlocks: number; allocatedSlots: number; usingSlots: number }
function gate() {
  let release!: () => void
  const promise = new Promise<void>((yes) => { release = yes })
  return { promise, release }
}
const locals = Array.from({ length: 220 }, (_, i) => `var v${i}=depth+${i};`).join('\n'),
  intact = Array.from({ length: 220 }, (_, i) => `if(v${i}!=depth+${i})throw "changed register ${i}";`).join('\n'),
  source = `
var System=__host("Pool.Factory"),finalTrace="";
function grow(depth,mode){
 ${locals}
 var answer=219;
 if(depth) answer=grow(depth-1,mode)+1;
 else {
   if(mode==2)__host("Pool.wait");
   if(mode){
     __host("Pool.mark","before");System.doCompact(5);__host("Pool.mark","after");
   }
 }
 ${intact}
 return answer;
}
class PoolFinal {
 var kind;
 function PoolFinal(value){kind=value;}
 function finalize(){
   global.finalTrace+=kind+",";
   global.__host("Pool.mark","final:"+kind+":before");
   global.System.doCompact(5);
   if(kind=="outer"){
     var nested=new global.PoolFinal("inner");
     if(global.grow(8,1)!=227)throw "nested registers";
   }
   global.__host("Pool.mark","final:"+kind+":after");
   if(kind=="throw")throw new global.Exception("pool-finalizer-error");
 }
}
function releaseFrame(){var owner=new PoolFinal("outer");return 42;}
function failedFrame(){var a=new PoolFinal("throw"),b=new PoolFinal("last");return 77;}
`

async function fixture(binary: boolean) {
  let module!: NativeModule, pointer = 0
  const control = new ExecutionControl(), entered = gate(), held = gate(),
    observations: { label: string; stats: StackStats }[] = [],
    stats = (): StackStats => {
      assert(pointer, 'VM must be alive before reading pool metadata')
      assert.equal(typeof module._krkr_vm_variant_stack_stat, 'function')
      const field = (index: number) => Number(module._krkr_vm_variant_stack_stat!(pointer, index))
      return { allocatedBlocks: field(0), usingBlocks: field(1), allocatedSlots: field(2), usingSlots: field(3) }
    }, intercepted: ModuleFactory = async (options) => {
      module = await factory(options)
      const create = module._krkr_create!
      module._krkr_create = (...args) => { pointer = Number(create(...args)); return pointer }
      return module
    }, vm = await TjsWasmRuntime.create(intercepted, async (operation, args) => {
      if (operation === 'Pool.Factory') return { kind: 'value', value: {
        type: 'class', namespace: 'System', className: 'System', id: 0, properties: [],
      } }
      if (operation === 'System.doCompact') {
        assert.equal(args[0], 5n)
        assert.equal(args[1], undefined, 'Native compact should not report a hidden GC error')
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Pool.mark') {
        observations.push({ label: String(args[0]), stats: stats() })
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Pool.wait') {
        entered.release()
        await held.promise
        return { kind: 'value', value: undefined }
      }
      throw new Error(`Unexpected pool host operation ${operation}`)
    }, { wasmBinary, variant, control })
  try { await vm.execute(binary ? await vm.compile(source, 'pool.tjs') : source, 'pool.tjs') }
  catch (error) {
    try { await vm.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Pool setup and cleanup failed') }
    throw error
  }
  return { vm, control, entered, held, observations, stats,
    expression: (text: string) => vm.execute(text, 'pool-expression.tjs', true),
    async close() {
      held.release()
      try { vm.dispose() } finally { pointer = 0 }
      assert.equal(Number(module._krkr_native_lifetime_stat!(4)), 0)
    },
  }
}
async function using(binary: boolean, run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary), errors: unknown[] = []
  try { await run(f) } catch (error) { errors.push(error) }
  try { await f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Variant stack regression or cleanup failed')
}

for (const binary of [false, true]) {
  const mode = `${variant}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: real compact releases unused register blocks while every live local survives`, { timeout: 60000 }, async (t) => {
    await using(binary, async (f) => {
      assert.equal(await f.expression('grow(48,0)'), 267n)
      const warm = f.stats()
      assert(warm.allocatedBlocks > 2)
      assert.equal(warm.usingBlocks, 0)
      assert.equal(warm.usingSlots, 0)
      assert.equal(await f.expression('grow(2,1)'), 221n)
      const before = f.observations.find((entry) => entry.label === 'before')!.stats,
        after = f.observations.find((entry) => entry.label === 'after')!.stats
      assert(before.allocatedBlocks > before.usingBlocks)
      assert(after.usingBlocks > 0)
      assert.equal(after.allocatedBlocks, after.usingBlocks)
      assert.equal(after.usingSlots, before.usingSlots)
      assert(after.allocatedSlots < before.allocatedSlots)
      assert.equal(f.stats().usingBlocks, 0)
      assert.equal(await f.expression('grow(48,0)'), 267n, 'Reclaimed blocks can be allocated again')
      t.diagnostic(JSON.stringify({ warm, before, after, regrown: f.stats() }))
    })
  })
  test(`${mode}: compact during real finalizers preserves reentry and clearing after a throwing finalizer`, { timeout: 60000 }, async (t) => {
    await using(binary, async (f) => {
      await f.expression('grow(48,0)')
      assert.equal(await f.expression('releaseFrame()'), 42n)
      assert.equal(await f.expression('finalTrace'), 'outer,inner,')
      await assert.rejects(f.expression('failedFrame()'), /pool-finalizer-error/)
      const trace = String(await f.expression('finalTrace')).split(',').filter(Boolean).sort()
      assert.deepEqual(trace, ['inner', 'last', 'outer', 'throw'])
      const markers = f.observations.filter((entry) => entry.label.startsWith('final:'))
      assert.equal(markers.length, 8)
      assert(markers.every((entry) => entry.stats.usingBlocks > 0 && entry.stats.usingSlots > 0))
      assert.equal(f.stats().usingBlocks, 0)
      assert.equal(await f.expression('grow(24,1)'), 243n)
      t.diagnostic(JSON.stringify({ markers, after: f.stats() }))
    })
  })
  for (const cancel of [false, true]) test(`${mode}: suspended native registers ${cancel ? 'unwind on Stop' : 'resume through compact'} without moving live blocks`, { timeout: 60000 }, async (t) => {
    await using(binary, async (f) => {
      await f.expression('grow(48,0)')
      const work = f.expression('grow(12,2)'), observed = Promise.allSettled([work])
      try {
        await f.entered.promise
        const suspended = f.stats()
        assert(suspended.usingBlocks > 1 && suspended.usingSlots > 220)
        f.control.pause()
        assert.deepEqual(f.stats(), suspended, 'Read-only diagnostics cannot reclaim or move suspended registers')
        if (cancel) f.control.cancel()
        else f.control.resume()
        f.held.release()
        if (cancel) await assert.rejects(work, /Execution cancelled/)
        else assert.equal(await work, 231n)
        await observed
        assert.equal(f.stats().usingBlocks, 0)
        assert.equal(f.stats().usingSlots, 0)
        if (cancel) assert.equal(f.observations.length, 0, 'Canceled TJS must not resume into compact')
        else {
          const after = f.observations.find((entry) => entry.label === 'after')!.stats
          assert.equal(after.allocatedBlocks, after.usingBlocks)
          assert(after.usingSlots > 220)
        }
        t.diagnostic(JSON.stringify({ cancel, suspended, after: f.stats(), observations: f.observations }))
      } finally {
        f.control.resume(); f.held.release(); await observed
      }
    })
  })
}
