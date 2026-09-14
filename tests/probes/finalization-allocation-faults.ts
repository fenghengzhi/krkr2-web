// Verify cleanup allocation failures separately from constructor allocations.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { observeNative } from '../helpers/bytecode-lifetime.ts'
import { executionStats } from '../helpers/execution-budget.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const variant = process.argv[2] as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const root = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
assert.equal(manifest.diagnosticAllocator, true)
const assets = manifest.variants[variant]
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasmBinary = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
const results: unknown[] = [],
  failures: unknown[] = []
mkdirSync('out/ci', { recursive: true })
const save = () =>
  writeFileSync(
    `out/ci/finalization-allocations-${variant}.json`,
    JSON.stringify({ variant, manifest, results, failures }, null, 2) + '\n',
  )
function allocated(native: ReturnType<typeof observeNative>) {
  assert.equal(native.call('krkr_test_live_allocation_stat', 2), 0)
  return {
    bytes: native.call('krkr_test_live_allocation_stat', 0),
    blocks: native.call('krkr_test_live_allocation_stat', 1),
    strings: native.call('krkr_native_string_cells'),
    objects: native.call('krkr_native_lifetime_stat', 4),
  }
}
for (const debugMode of [false, true])
  for (const collection of ['array', 'dictionary'])
    for (const implicit of [false, true]) {
      let baseline: ReturnType<typeof allocated> | undefined,
        completed = false
      for (let after = -1; after < 512; after++) {
        const native = observeNative(factory)
        const vm = await TjsWasmRuntime.create(
          native.factory,
          () => {
            throw new Error('Unexpected host I/O')
          },
          { wasmBinary, variant, debugMode },
        )
        let outcome: Record<string, unknown> = { debugMode, collection, implicit, after },
          failure: unknown
        try {
          await vm.execute('try{missingCleanupWarm();}catch(e){}')
          const create = `var bucket=${collection === 'array' ? '[]' : '%[]'};for(var i=0;i<128;i++)bucket[i]=new CleanupLeaf();`
          await vm.execute(
            'var cleanupFinalized=0;class CleanupLeaf{function finalize(){cleanupFinalized++;}}' +
              (implicit ? `function cleanupRun(){${create}return 42;}` : create),
          )
          const before = native.stats(),
            beforeObjects = native.call('krkr_native_lifetime_stat', 4)
          const call = implicit
            ? 'cleanupRun()'
            : collection === 'array'
              ? 'bucket.clear()'
              : '(Dictionary.clear incontextof bucket)()'
          if (after >= 0) native.call('krkr_test_fail_allocation', 11, after, 0)
          let error: unknown
          try {
            await vm.execute(call, 'cleanup-fault.tjs', true)
          } catch (caught) {
            error = caught
          }
          const hits = native.call('krkr_test_allocation_hits'),
            failedBytes = native.call('krkr_test_failed_bytes')
          native.call('krkr_test_fail_allocation', 0, -1, 0)
          if (hits) assert(error instanceof Error && error.name === 'ScriptError', String(error))
          else {
            assert.equal(error, undefined)
            completed = after >= 0
          }
          const finalized = await vm.execute('cleanupFinalized', '', true)
          assert.equal(finalized, implicit || !hits ? 128n : 0n)
          const objects = native.call('krkr_native_lifetime_stat', 4)
          assert.equal(objects, beforeObjects - (implicit || hits ? 0 : 128))
          for (let i = 0; i < 2; i++) await vm.execute(call, 'cleanup-fault.tjs', true)
          assert.equal(await vm.execute('cleanupFinalized', '', true), implicit ? 384n : 128n)
          assert.equal(await vm.execute('6*7', '', true), 42n)
          const current = native.stats(),
            budget = executionStats(native)
          assert.equal(current.blocks, before.blocks)
          assert.equal(current.contexts, before.contexts)
          assert.equal(budget.depth, 0)
          assert.equal(budget.bytes, 0)
          assert.equal(native.call('krkr_native_lifetime_stat', 0), 0)
          assert.equal(native.call('krkr_native_lifetime_stat', 1), 0)
          outcome = {
            ...outcome,
            hits,
            failedBytes,
            finalized: Number(finalized),
            before,
            current,
            beforeObjects,
            objects,
            budget,
            error: error instanceof Error ? error.message : null,
          }
        } catch (error) {
          failure = {
            ...outcome,
            error: String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        } finally {
          native.call('krkr_test_fail_allocation', 0, -1, 0)
          vm.dispose()
        }
        const disposed = allocated(native)
        if (after === -1) baseline = disposed
        else if (JSON.stringify(disposed) !== JSON.stringify(baseline))
          failure = {
            ...outcome,
            error: 'Cleanup retained live allocations after disposal',
            baseline,
            disposed,
            prior: failure,
          }
        results.push({ ...outcome, baseline, disposed })
        if (failure) {
          failures.push(failure)
          console.error(failure)
        } else
          console.log(
            `PASS ${variant}/${collection}/implicit=${implicit}/debug=${debugMode}/allocation=${after}`,
          )
        save()
        if (completed) break
      }
      if (!completed)
        failures.push({
          debugMode,
          collection,
          implicit,
          error: 'Allocation enumeration exceeded 512 sites',
        })
    }
save()
assert.deepEqual(failures, [])
