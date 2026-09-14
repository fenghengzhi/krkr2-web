// Executed only by the hosted, non-release allocation diagnostic workflow.
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
import {
  observeNative,
  lifetimeSource,
  lifetimeCleanup,
  lateLinkFailure,
} from '../helpers/bytecode-lifetime.ts'

const variant = process.argv[2] as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const root = resolve('.generated/wasm'),
  manifest: WasmManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
assert.equal(manifest.diagnosticAllocator, true)
const assets = manifest.variants[variant]!
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasmBinary = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
const results: unknown[] = [],
  failures: unknown[] = []
mkdirSync('out/ci', { recursive: true })
function save() {
  writeFileSync(
    `out/ci/allocations-${variant}.json`,
    JSON.stringify({ variant, manifest, results, failures }, null, 2) + '\n',
  )
}

for (const phase of [6, 7, 8]) {
  let complete = false
  for (let after = 0; after < 512; after++) {
    const native = observeNative(factory)
    const vm = await TjsWasmRuntime.create(
      native.factory,
      () => {
        throw new Error('Unexpected host I/O')
      },
      { wasmBinary, variant },
    )
    try {
      const bytes = await vm.compile(lifetimeSource, 'allocation.tjs'),
        invalid = lateLinkFailure(bytes)
      await vm.execute(bytes)
      await vm.execute(lifetimeCleanup)
      await assert.rejects(vm.execute(invalid), { name: 'ScriptError' })
      await vm.execute('6*7', '', true)
      const before = native.stats()
      assert.equal(before.blocks, 0)
      assert.equal(before.contexts, 0)
      native.call('krkr_test_fail_allocation', phase, after)
      let error: unknown
      try {
        await vm.execute(bytes)
      } catch (failure) {
        error = failure
      }
      const hits = native.call('krkr_test_allocation_hits')
      native.call('krkr_test_fail_allocation', 0, -1)
      if (!hits) {
        assert.equal(error, undefined)
        await vm.execute(lifetimeCleanup)
        complete = true
      } else {
        assert.equal(hits, 1)
        assert(error instanceof Error && error.name === 'ScriptError', String(error))
      }
      assert.equal(await vm.execute('6*7', '', true), 42n)
      const current = native.stats()
      assert.deepEqual(current, before, `phase ${phase}, allocation ${after}`)
      // The very same VM must still accept the complete inheritance fixture.
      await vm.execute(bytes)
      await vm.execute(lifetimeCleanup)
      assert.deepEqual(native.stats(), before)
      results.push({
        phase,
        after,
        hits,
        before,
        current,
        error: error instanceof Error ? error.message : null,
      })
      console.log(`PASS ${variant}: phase ${phase}, allocation ${after}, hits ${hits}`)
    } catch (error) {
      const failure = {
        phase,
        after,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }
      failures.push(failure)
      console.error(failure)
      // A corrupted instance must not be reused for the next injection.
    } finally {
      native.call('krkr_test_fail_allocation', 0, -1)
      vm.dispose()
      save()
    }
    if (complete) break
  }
  if (!complete) failures.push({ phase, error: 'Allocation enumeration exceeded 512 sites' })
}
save()
assert.deepEqual(failures, [])
assert(results.length > 3, 'No allocator failures were exercised')
