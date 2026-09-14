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
import { bytecodeOffsets } from '../helpers/binary-scripts.ts'
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
      native.call('krkr_test_fail_allocation', phase, after, 0)
      let error: unknown
      try {
        await vm.execute(bytes)
      } catch (failure) {
        error = failure
      }
      const hits = native.call('krkr_test_allocation_hits'),
        failedBytes = native.call('krkr_test_failed_bytes')
      native.call('krkr_test_fail_allocation', 0, -1, 0)
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
        failedBytes,
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
      native.call('krkr_test_fail_allocation', 0, -1, 0)
      vm.dispose()
      save()
    }
    if (complete) break
  }
  if (!complete) failures.push({ phase, error: 'Allocation enumeration exceeded 512 sites' })
}
// Grow the shared string heap in a fresh VM; compiling in that VM would warm
// its heap and hide failures of the block/free-index replacement itself.
const compiler = await TjsWasmRuntime.create(
  factory,
  () => {
    throw new Error('Unexpected host I/O')
  },
  { wasmBinary, variant },
)
const base = await compiler.compile('42', 'growth.tjs', true)
compiler.dispose()
const layout = bytecodeOffsets(base),
  baseView = new DataView(base.buffer),
  count = 6000
const names = new Uint8Array(count * 16),
  namesView = new DataView(names.buffer)
for (let i = 0; i < count; i++) {
  const name = 'g' + String(i).padStart(5, '0')
  namesView.setUint32(i * 16, name.length, true)
  for (let j = 0; j < name.length; j++)
    namesView.setUint16(i * 16 + 4 + j * 2, name.charCodeAt(j), true)
}
const insert = layout.pools[6]!.count,
  expanded = new Uint8Array(base.length + names.length),
  expandedView = new DataView(expanded.buffer)
expanded.set(base.subarray(0, insert))
expanded.set(names, insert)
expanded.set(base.subarray(insert), insert + names.length)
expandedView.setUint32(8, expanded.length, true)
expandedView.setUint32(16, baseView.getUint32(16, true) + names.length, true)
expandedView.setUint32(
  layout.pools[5]!.count,
  baseView.getUint32(layout.pools[5]!.count, true) + count,
  true,
)
let disposedBaseline: { heap: number; strings: number } | undefined
for (const target of ['baseline', 'string_block', 'string_index']) {
  const native = observeNative(factory),
    vm = await TjsWasmRuntime.create(
      native.factory,
      () => {
        throw new Error('Unexpected host I/O')
      },
      { wasmBinary, variant },
    )
  try {
    if (target !== 'baseline') {
      const size = native.call(`krkr_test_${target}_bytes`)
      native.call('krkr_test_fail_allocation', 6, 0, size)
      await assert.rejects(vm.execute(expanded), { name: 'ScriptError' })
      assert.equal(native.call('krkr_test_allocation_hits'), 1)
      assert.equal(native.call('krkr_test_failed_bytes'), size)
      native.call('krkr_test_fail_allocation', 0, -1, 0)
      assert.equal(native.stats().contexts, 0)
      assert.equal(native.stats().blocks, 0)
    }
    for (let i = 0; i < 2; i++) assert.equal(await vm.execute(expanded), 42n)
    assert.equal(native.stats().contexts, 0)
    assert.equal(native.stats().blocks, 0)
  } catch (error) {
    failures.push({ target, error: String(error) })
  } finally {
    native.call('krkr_test_fail_allocation', 0, -1, 0)
    vm.dispose()
  }
  const disposed = {
    heap: native.call('krkr_native_heap_usage'),
    strings: native.call('krkr_native_string_cells'),
  }
  if (target === 'baseline') disposedBaseline = disposed
  else if (JSON.stringify(disposed) !== JSON.stringify(disposedBaseline))
    failures.push({ target, disposedBaseline, disposed })
  results.push({ target, disposed })
  save()
}

save()
assert.deepEqual(failures, [])
assert(results.length > 3, 'No allocator failures were exercised')
