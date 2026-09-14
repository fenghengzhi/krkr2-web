import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type {
  ModuleFactory,
  NativeModule,
  WasmVariant,
} from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { isScriptObject, type ScriptObject } from '../../src/engine/script/runtime.ts'
import { observeNative } from '../helpers/bytecode-lifetime.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const variant = process.argv[2] as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const root = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
assert.equal(manifest.diagnosticAllocator, true)
assert.equal(manifest.capabilities.soundObjectLifetime, 1)
const assets = manifest.variants[variant]
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasmBinary = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
const results: Record<string, unknown>[] = [],
  failures: unknown[] = []
mkdirSync('out/ci', { recursive: true })
const save = () =>
  writeFileSync(
    `out/ci/dependent-allocations-${variant}.json`,
    JSON.stringify({ variant, manifest, results, failures }, null, 2) + '\n',
  )

for (const operation of ['register', 'invalidate'] as const)
  for (const debugMode of [false, true])
    for (const binary of [false, true]) {
      let baseline: unknown,
        completed = false
      for (let after = -1; after < 128; after++) {
        let module!: NativeModule & { krkrAllocationTrace?: string }
        const native = observeNative(async (options) => {
          module = await factory(options)
          return module
        })
        const allocated = () => {
          assert.equal(native.call('krkr_test_live_allocation_stat', 2), 0)
          return {
            bytes: native.call('krkr_test_live_allocation_stat', 0),
            blocks: native.call('krkr_test_live_allocation_stat', 1),
            strings: native.call('krkr_native_string_cells'),
            objects: native.call('krkr_native_lifetime_stat', 4),
          }
        }
        const vm = await TjsWasmRuntime.create(
          native.factory,
          () => {
            throw new Error('Unexpected dependent allocator host callback')
          },
          { wasmBinary, variant, debugMode },
        )
        const index = results.length
        let row: Record<string, unknown> = {
            operation,
            debugMode,
            binary,
            after,
            status: 'preparing',
          },
          failure: unknown
        results.push(row)
        const journal = (fields: Record<string, unknown>) => {
          row = { ...row, ...fields }
          results[index] = row
          save()
        }
        try {
          await vm.execute('var warm=%[];delete warm;try{missingDependentWarm();}catch(e){}')
          const object = async (source: string) => {
            const value = await vm.execute(
              binary ? await vm.compile(source, 'dependent-allocation.tjs', true) : source,
              'dependent-allocation.tjs',
              true,
            )
            assert(isScriptObject(value))
            return value as ScriptObject
          }
          const owner = await object('%[]'),
            child = await object(
              '%[' + Array.from({ length: 64 }, (_, i) => `k${i}:${i}`).join(',') + ']',
            )
          if (operation === 'invalidate') {
            vm.bindDependent(owner, child)
            vm.release(child)
            assert.equal(await vm.execute('6*7', '', true), 42n)
          }
          const before = { ...native.stats(), ...vm.inspect() }
          assert.equal(before.handles, operation === 'register' ? 2 : 1)
          assert.equal(before.dependents, operation === 'register' ? 0 : 1)
          journal({ before, status: operation })
          if (after >= 0)
            native.call('krkr_test_fail_allocation', operation === 'register' ? 14 : 11, after, 0)
          let error: unknown
          try {
            if (operation === 'register') vm.bindDependent(owner, child)
            else {
              vm.release(owner)
              await vm.execute('6*7', 'dependent-invalidation.tjs', true)
            }
          } catch (caught) {
            error = caught
          }
          const hits = native.call('krkr_test_allocation_hits'),
            failedBytes = native.call('krkr_test_failed_bytes')
          native.call('krkr_test_fail_allocation', 0, -1, 0)
          journal({
            hits,
            failedBytes,
            allocationTrace: module.krkrAllocationTrace ?? null,
            error: error instanceof Error ? { name: error.name, message: error.message } : null,
            current: { ...native.stats(), ...vm.inspect() },
          })
          if (hits) {
            assert(error instanceof Error)
            assert.match(error.message, operation === 'register' ? /Cannot bind/ : /bad_alloc/)
            if (operation === 'invalidate') assert.equal(error.name, 'ScriptError')
          } else {
            assert.equal(error, undefined)
            completed = after >= 0
          }
          if (operation === 'register') {
            assert.equal(vm.inspect().dependents, hits ? 0 : 1)
            assert.equal(vm.inspect().scriptObjects, before.scriptObjects)
            assert.equal(vm.inspect().handles, 2)
            if (hits) vm.bindDependent(owner, child)
            assert.equal(vm.inspect().dependents, 1)
            vm.release(owner)
            vm.release(child)
          }
          assert.equal(await vm.execute('6*7', '', true), 42n)
          const released = { ...native.stats(), ...vm.inspect() }
          journal({ released, status: 'released' })
          for (const field of [
            'handles',
            'weakOwners',
            'dependents',
            'pendingHandles',
            'pendingInvalidations',
          ] as const)
            assert.equal(released[field], 0)
          assert.equal(released.scriptObjects, before.scriptObjects - 2)
          assert.equal(released.blocks, before.blocks)
          assert.equal(released.contexts, before.contexts)
          assert.equal(native.call('krkr_native_lifetime_stat', 0), 0)
          assert.equal(native.call('krkr_native_lifetime_stat', 1), 0)
        } catch (error) {
          failure = {
            ...row,
            error: String(error),
            stack: error instanceof Error ? error.stack : undefined,
          }
        } finally {
          native.call('krkr_test_fail_allocation', 0, -1, 0)
          vm.dispose()
        }
        const disposed = allocated()
        if (after === -1) baseline = disposed
        else if (JSON.stringify(disposed) !== JSON.stringify(baseline))
          failure = {
            ...row,
            error: 'Dependent cleanup retained allocations',
            baseline,
            disposed,
            prior: failure,
          }
        results[index] = { ...row, baseline, disposed }
        if (failure) failures.push(failure)
        console.log(
          `${failure ? 'FAIL' : 'PASS'} ${variant}/${operation}/debug=${debugMode}/binary=${binary}/allocation=${after}`,
        )
        save()
        if (completed || (after === -1 && failure)) break
      }
      if (!completed)
        failures.push({
          operation,
          debugMode,
          binary,
          error: 'Dependent allocation enumeration incomplete',
        })
    }
save()
assert.deepEqual(failures, [])
