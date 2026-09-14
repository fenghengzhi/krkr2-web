// Hosted diagnostic only: use a fresh VM at every native allocation site.
import assert from 'node:assert/strict'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ModuleFactory,
  WasmManifest,
  WasmVariant,
} from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { observeNative } from '../helpers/bytecode-lifetime.ts'
import { executionStats } from '../helpers/execution-budget.ts'

const variant = process.argv[2] as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const root = resolve('.generated/wasm'),
  manifest: WasmManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
assert.equal(manifest.diagnosticAllocator, true)
assert.equal(manifest.capabilities?.executionBudgets, 1)
const assets = manifest.variants[variant]!
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasmBinary = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
const fixtures = [
  {
    name: 'pooled-frames',
    phase: 9,
    setup: `function executionFault(n){var ${Array.from({ length: 32 }, (_, i) => 'local' + i).join(',')};if(n<=0)return 42;return executionFault(n-1);}`,
    call: 'executionFault(48)',
    expected: 42n,
  },
  {
    name: 'collapsed-arguments',
    phase: 9,
    setup: `function executionFault(values*){return values.count;}var executionArguments=[${new Array(64).fill(1).join(',')}];`,
    call: 'executionFault(executionArguments*)',
    expected: 64n,
  },
  {
    name: 'expanded-arguments',
    phase: 10,
    setup: `function executionFault(a,b){return a+b;}var executionArguments=[20,22,${new Array(62).fill(0).join(',')}];`,
    call: 'executionFault(executionArguments*)',
    expected: 42n,
  },
]
const results: unknown[] = [],
  failures: unknown[] = []
mkdirSync('out/ci', { recursive: true })
const save = () =>
  writeFileSync(
    `out/ci/execution-allocations-${variant}.json`,
    JSON.stringify({ variant, manifest, results, failures }, null, 2) + '\n',
  )
const stable = (native: ReturnType<typeof observeNative>) => {
  const state = executionStats(native)
  assert.equal(state.depth, 0)
  assert.equal(state.bytes, 0)
  assert.equal(state.functions, 0)
  assert.equal(state.tries, 0)
  assert.equal(state.delegations, 0)
  return state
}
for (const debugMode of [false, true])
  for (const fixture of fixtures) {
    let baseline: { heap: number; strings: number } | undefined,
      completed = false
    // The first iteration is a successful control, then each iteration fails one
    // allocation without pre-warming the register/trace pool whose growth is tested.
    for (let after = -1; after < 512; after++) {
      const native = observeNative(factory)
      const vm = await TjsWasmRuntime.create(
        native.factory,
        () => {
          throw new Error('Unexpected host I/O')
        },
        { wasmBinary, variant, debugMode },
      )
      let failure: unknown,
        outcome: Record<string, unknown> = {
          name: fixture.name,
          phase: fixture.phase,
          debugMode,
          after,
        }
      try {
        await vm.execute(fixture.setup, 'fault-setup.tjs')
        const before = native.stats()
        if (after >= 0) native.call('krkr_test_fail_allocation', fixture.phase, after, 0)
        let value: unknown, error: unknown
        try {
          value = await vm.execute(fixture.call, 'fault-call.tjs', true)
        } catch (caught) {
          error = caught
        }
        const hits = native.call('krkr_test_allocation_hits'),
          failedBytes = native.call('krkr_test_failed_bytes')
        native.call('krkr_test_fail_allocation', 0, -1, 0)
        if (hits) {
          assert.equal(hits, 1)
          assert(error instanceof Error && error.name === 'ScriptError', String(error))
        } else {
          assert.equal(error, undefined)
          assert.equal(value, fixture.expected)
          completed = after >= 0
        }
        const current = native.stats(),
          state = stable(native)
        assert.equal(current.contexts, before.contexts)
        assert.equal(current.blocks, before.blocks)
        for (let i = 0; i < 2; i++)
          assert.equal(await vm.execute(fixture.call, 'fault-call.tjs', true), fixture.expected)
        assert.equal(await vm.execute('6*7', 'recovery.tjs', true), 42n)
        stable(native)
        outcome = {
          ...outcome,
          hits,
          failedBytes,
          before,
          current,
          state,
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
      const disposed = {
        heap: native.call('krkr_native_heap_usage'),
        strings: native.call('krkr_native_string_cells'),
      }
      if (after === -1) baseline = disposed
      else if (JSON.stringify(disposed) !== JSON.stringify(baseline))
        failure = {
          ...outcome,
          error: 'Post-disposal allocation differs from successful control',
          baseline,
          disposed,
          prior: failure,
        }
      outcome = { ...outcome, baseline, disposed }
      results.push(outcome)
      if (failure) {
        failures.push(failure)
        console.error(failure)
      } else console.log(`PASS ${variant}/${fixture.name}/debug=${debugMode}/allocation=${after}`)
      save()
      if (completed) break
    }
    if (!completed)
      failures.push({
        name: fixture.name,
        debugMode,
        error: 'Allocation enumeration exceeded 512 sites',
      })
  }
save()
assert.deepEqual(failures, [])
