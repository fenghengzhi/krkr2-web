// Exercise weak-owner registration, upgrade and disposal on GitHub-hosted runners.
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
import {
  isScriptObject,
  type ScriptObject,
  type ScriptWeakObject,
} from '../../src/engine/script/runtime.ts'
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
function observeAllocator() {
  let module!: NativeModule & { krkrAllocationTrace?: string }
  const native = observeNative(async (options) => {
    module = await factory(options)
    return module
  })
  return { ...native, allocationTrace: () => module.krkrAllocationTrace ?? null }
}
const results: unknown[] = [],
  failures: unknown[] = []
mkdirSync('out/ci', { recursive: true })
const save = () =>
  writeFileSync(
    `out/ci/owner-observation-allocations-${variant}.json`,
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
  for (const binary of [false, true]) {
    let baseline: ReturnType<typeof allocated> | undefined,
      completed = false,
      controlPassed = false
    for (let after = -1; after < 128; after++) {
      const native = observeAllocator()
      const vm = await TjsWasmRuntime.create(
        native.factory,
        () => {
          throw new Error('Unexpected observation allocator host call')
        },
        { wasmBinary, variant, debugMode },
      )
      let outcome: Record<string, unknown> = { operation: 'register', debugMode, binary, after },
        failure: unknown
      try {
        await vm.execute('try{missingOwnerAllocationWarm();}catch(e){}')
        const setup =
          'var allocationOwnerFinalized=0;class AllocationOwner {function finalize(){allocationOwnerFinalized++;}}'
        await vm.execute(binary ? await vm.compile(setup, 'owner-allocation.tjs') : setup)
        const expression = 'new AllocationOwner()'
        const value = await vm.execute(
          binary ? await vm.compile(expression, 'owner-allocation-instance.tjs', true) : expression,
          'owner-allocation-instance.tjs',
          true,
        )
        assert(isScriptObject(value))
        const owner = value as ScriptObject,
          identity = vm.objectIdentity(owner)
        const before = { ...native.stats(), ...vm.inspect(), allocations: allocated(native) }
        assert.equal(before.weakOwners, 0)
        assert.equal(before.handles, 1)
        assert.equal(before.pendingHandles, 0)
        let notifications = 0,
          error: unknown,
          token: ScriptWeakObject | undefined
        if (after >= 0) native.call('krkr_test_fail_allocation', 12, after, 0)
        try {
          token = vm.observe(owner, () => {
            notifications++
          })
        } catch (caught) {
          error = caught
        }
        const hits = native.call('krkr_test_allocation_hits'),
          failedBytes = native.call('krkr_test_failed_bytes')
        native.call('krkr_test_fail_allocation', 0, -1, 0)
        const registered = { ...native.stats(), ...vm.inspect(), allocations: allocated(native) }
        outcome = {
          ...outcome,
          before,
          registered,
          allocationTrace: native.allocationTrace(),
          hits,
          failedBytes,
          error: error instanceof Error ? error.message : null,
        }
        assert.equal(registered.handles, before.handles)
        assert.equal(registered.pendingHandles, 0)
        assert.equal(registered.scriptObjects, before.scriptObjects)
        assert.equal(registered.blocks, before.blocks)
        assert.equal(registered.contexts, before.contexts)
        assert.equal(vm.objectIdentity(owner), identity)
        assert.equal(notifications, 0)
        if (hits) {
          assert(error instanceof Error, 'Failed native registration was accepted')
          assert.equal(token, undefined)
          assert.equal(registered.weakOwners, 0)
          // Register again to verify a failed allocation detached any partial observer.
          token = vm.observe(owner, () => {
            notifications++
          })
        } else {
          assert.equal(error, undefined)
          assert(token)
          assert.equal(registered.weakOwners, 1)
          completed = after >= 0
        }
        assert(token)
        vm.release(owner)
        assert.equal(await vm.execute('6*7', 'owner-allocation-release.tjs', true), 42n)
        const released = { ...native.stats(), ...vm.inspect(), budget: executionStats(native) }
        outcome = { ...outcome, released, notifications }
        assert.equal(notifications, 1)
        assert.equal(released.weakOwners, 0)
        assert.equal(released.handles, 0)
        assert.equal(released.pendingHandles, 0)
        assert.equal(released.scriptObjects, before.scriptObjects - 1)
        assert.equal(released.blocks, before.blocks)
        assert.equal(released.contexts, before.contexts)
        assert.equal(released.budget.depth, 0)
        assert.equal(released.budget.bytes, 0)
        assert.equal(native.call('krkr_native_lifetime_stat', 0), 0)
        assert.equal(native.call('krkr_native_lifetime_stat', 1), 0)
        assert.equal(vm.upgrade(token), undefined)
        vm.unobserve(token)
        assert.equal(
          await vm.execute('allocationOwnerFinalized', 'owner-allocation-finalized.tjs', true),
          1n,
        )
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
      if (after === -1) {
        baseline = disposed
        controlPassed = !failure
      } else if (JSON.stringify(disposed) !== JSON.stringify(baseline))
        failure = {
          ...outcome,
          error: 'Owner registration retained live allocations after disposal',
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
          `PASS ${variant}/owner-observation/debug=${debugMode}/binary=${binary}/allocation=${after}`,
        )
      save()
      if (!controlPassed || completed) break
    }
    if (controlPassed && !completed)
      failures.push({
        operation: 'register',
        debugMode,
        binary,
        error: 'Owner allocation enumeration exceeded 128 sites',
      })
  }
for (const debugMode of [false, true])
  for (const binary of [false, true]) {
    let baseline: ReturnType<typeof allocated> | undefined,
      completed = false,
      controlPassed = false
    for (let after = -1; after < 512; after++) {
      const native = observeAllocator()
      const vm = await TjsWasmRuntime.create(
        native.factory,
        () => {
          throw new Error('Disposal attempted asynchronous host work')
        },
        { wasmBinary, variant, debugMode },
      )
      let outcome: Record<string, unknown> = { operation: 'dispose', debugMode, binary, after },
        failure: unknown,
        disposeAttempted = false
      const tokens: ScriptWeakObject[] = [],
        weakCounts: number[] = [],
        upgrades: number[] = []
      let notifications = 0,
        disposalReentries = 0
      const index = results.length
      results.push({ ...outcome, status: 'preparing' })
      try {
        await vm.execute('try{missingOwnerDisposalWarm();}catch(e){}')
        const setup = `var disposeBucket=[],disposeDictionary=%[];
          class DisposeOwner {var members;function DisposeOwner(n){members=[];for(var j=0;j<8;j++)members.add(%[value:n]);}}
          for(var i=0;i<32;i++){var item=new DisposeOwner(i);disposeBucket.add(item);disposeDictionary[i]=item;}delete item;`
        await vm.execute(binary ? await vm.compile(setup, 'owner-disposal.tjs') : setup)
        for (let i = 0; i < 4; i++) {
          const value = await vm.execute(`disposeBucket[${i}]`, 'owner-disposal-handle.tjs', true)
          assert(isScriptObject(value))
          for (let observer = 0; observer < 2; observer++)
            tokens.push(
              vm.observe(value, () => {
                notifications++
                weakCounts.push(vm.inspect().weakOwners)
                for (const token of tokens) {
                  const lease = vm.upgrade(token)
                  if (lease) {
                    upgrades.push(lease.id)
                    vm.release(lease)
                  }
                }
                if (disposalReentries === 0) {
                  disposalReentries++
                  vm.dispose()
                }
              }),
            )
        }
        const before = { ...native.stats(), ...vm.inspect(), allocations: allocated(native) }
        assert.equal(before.weakOwners, 8)
        assert.equal(before.handles, 4)
        assert.equal(before.pendingHandles, 0)
        outcome = { ...outcome, before, status: 'disposing' }
        results[index] = outcome
        save()
        if (after >= 0) native.call('krkr_test_fail_allocation', 11, after, 0)
        disposeAttempted = true
        let error: unknown
        try {
          vm.dispose()
        } catch (caught) {
          error = caught
        }
        const hits = native.call('krkr_test_allocation_hits'),
          failedBytes = native.call('krkr_test_failed_bytes')
        // Keep the fault armed through every native destructor and engine cleanup.
        native.call('krkr_test_fail_allocation', 0, -1, 0)
        const disposed = allocated(native),
          budget = executionStats(native)
        outcome = {
          ...outcome,
          status: 'disposed',
          allocationTrace: native.allocationTrace(),
          hits,
          failedBytes,
          notifications,
          weakCounts,
          upgrades,
          disposalReentries,
          disposed,
          budget,
          error: error instanceof Error ? error.message : null,
        }
        assert.equal(error, undefined, 'VM disposal must finish even if cleanup allocation fails')
        assert.equal(notifications, 8)
        assert.equal(weakCounts.at(-1), 0)
        assert.equal(disposalReentries, 1)
        assert.deepEqual(upgrades, [])
        assert.equal(disposed.objects, 0)
        assert.equal(native.call('krkr_native_lifetime_stat', 0), 0)
        assert.equal(native.call('krkr_native_lifetime_stat', 1), 0)
        assert.equal(budget.depth, 0)
        assert.equal(budget.bytes, 0)
        for (const token of tokens) {
          assert.equal(vm.upgrade(token), undefined)
          vm.unobserve(token)
        }
        vm.dispose()
        assert.equal(notifications, 8)
        completed = after >= 0 && hits === 0
      } catch (error) {
        failure = {
          ...outcome,
          error: String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }
      } finally {
        native.call('krkr_test_fail_allocation', 0, -1, 0)
        if (!disposeAttempted) vm.dispose()
      }
      const disposed = allocated(native)
      if (after === -1) {
        baseline = disposed
        controlPassed = !failure
      } else if (JSON.stringify(disposed) !== JSON.stringify(baseline))
        failure = {
          ...outcome,
          error: 'VM disposal retained live allocations after cleanup failure',
          baseline,
          disposed,
          prior: failure,
        }
      results[index] = { ...outcome, baseline, disposed }
      if (failure) {
        failures.push(failure)
        console.error(failure)
      } else
        console.log(
          `PASS ${variant}/owner-disposal/debug=${debugMode}/binary=${binary}/allocation=${after}`,
        )
      save()
      if (!controlPassed || completed) break
    }
    if (controlPassed && !completed)
      failures.push({
        operation: 'dispose',
        debugMode,
        binary,
        error: 'Disposal allocation enumeration exceeded 512 sites',
      })
  }
for (const debugMode of [false, true])
  for (const binary of [false, true]) {
    let baseline: ReturnType<typeof allocated> | undefined,
      completed = false,
      controlPassed = false
    for (let after = -1; after < 128; after++) {
      const native = observeAllocator()
      const vm = await TjsWasmRuntime.create(
        native.factory,
        () => {
          throw new Error('Unexpected upgrade allocator host call')
        },
        { wasmBinary, variant, debugMode },
      )
      let outcome: Record<string, unknown> = { operation: 'upgrade', debugMode, binary, after },
        failure: unknown
      const index = results.length
      results.push({ ...outcome, status: 'preparing' })
      try {
        await vm.execute('try{missingOwnerUpgradeWarm();}catch(e){}')
        const setup =
          'var upgradeOwnerFinalized=0;class UpgradeOwner {function finalize(){upgradeOwnerFinalized++;}}'
        await vm.execute(binary ? await vm.compile(setup, 'owner-upgrade.tjs') : setup)
        const expression = 'new UpgradeOwner()'
        const value = await vm.execute(
          binary ? await vm.compile(expression, 'owner-upgrade-instance.tjs', true) : expression,
          'owner-upgrade-instance.tjs',
          true,
        )
        assert(isScriptObject(value))
        const owner = value as ScriptObject,
          identity = vm.objectIdentity(owner)
        let notifications = 0
        const token = vm.observe(owner, () => {
          notifications++
        })
        const before = { ...native.stats(), ...vm.inspect(), allocations: allocated(native) }
        assert.equal(before.weakOwners, 1)
        assert.equal(before.handles, 1)
        assert.equal(before.pendingHandles, 0)
        outcome = { ...outcome, before, identity, status: 'upgrading' }
        results[index] = outcome
        save()
        let lease: ScriptObject | undefined, error: unknown
        if (after >= 0) native.call('krkr_test_fail_allocation', 13, after, 0)
        try {
          lease = vm.upgrade(token)
        } catch (caught) {
          error = caught
        }
        const hits = native.call('krkr_test_allocation_hits'),
          failedBytes = native.call('krkr_test_failed_bytes')
        native.call('krkr_test_fail_allocation', 0, -1, 0)
        const upgraded = { ...native.stats(), ...vm.inspect(), allocations: allocated(native) }
        outcome = {
          ...outcome,
          status: 'upgraded',
          upgraded,
          hits,
          failedBytes,
          error: error instanceof Error ? error.message : null,
          lease: lease?.id,
        }
        assert.equal(upgraded.weakOwners, 1)
        assert.equal(upgraded.pendingHandles, 0)
        assert.equal(upgraded.scriptObjects, before.scriptObjects)
        assert.equal(upgraded.blocks, before.blocks)
        assert.equal(upgraded.contexts, before.contexts)
        assert.equal(vm.objectIdentity(owner), identity)
        assert.equal(notifications, 0)
        if (hits) {
          assert(
            error instanceof Error && error.message === 'TJS owner upgrade allocation failed',
            'Upgrade allocation failure was confused with owner expiry',
          )
          assert.equal(lease, undefined)
          assert.equal(upgraded.handles, before.handles)
        } else {
          assert.equal(error, undefined)
          assert(lease)
          assert.equal(vm.objectIdentity(lease), identity)
          assert.equal(upgraded.handles, before.handles + 1)
          completed = after >= 0
        }
        // A retry must retain the exact closure and reset the native error flag.
        const retry = vm.upgrade(token)
        assert(retry)
        assert.equal(vm.objectIdentity(retry), identity)
        assert.notEqual(retry.id, owner.id)
        if (lease) assert.notEqual(retry.id, lease.id)
        const retried = { ...native.stats(), ...vm.inspect() }
        outcome = { ...outcome, retried, retry: retry.id }
        assert.equal(retried.handles, before.handles + (lease ? 2 : 1))
        assert.equal(retried.weakOwners, 1)
        assert.equal(retried.scriptObjects, before.scriptObjects)
        vm.release(owner)
        if (lease) vm.release(lease)
        assert.equal(await vm.execute('6*7', 'owner-upgrade-lease-boundary.tjs', true), 42n)
        const leased = { ...native.stats(), ...vm.inspect() }
        outcome = { ...outcome, leased }
        assert.equal(leased.handles, 1)
        assert.equal(leased.pendingHandles, 0)
        assert.equal(leased.weakOwners, 1)
        assert.equal(leased.scriptObjects, before.scriptObjects)
        assert.equal(notifications, 0)
        vm.release(retry)
        assert.equal(await vm.execute('6*7', 'owner-upgrade-release.tjs', true), 42n)
        const released = { ...native.stats(), ...vm.inspect(), budget: executionStats(native) }
        outcome = { ...outcome, released, notifications }
        assert.equal(notifications, 1)
        assert.equal(released.weakOwners, 0)
        assert.equal(released.handles, 0)
        assert.equal(released.pendingHandles, 0)
        assert.equal(released.scriptObjects, before.scriptObjects - 1)
        assert.equal(released.blocks, before.blocks)
        assert.equal(released.contexts, before.contexts)
        assert.equal(released.budget.depth, 0)
        assert.equal(released.budget.bytes, 0)
        assert.equal(native.call('krkr_native_lifetime_stat', 0), 0)
        assert.equal(native.call('krkr_native_lifetime_stat', 1), 0)
        assert.equal(vm.upgrade(token), undefined)
        vm.unobserve(token)
        assert.equal(
          await vm.execute('upgradeOwnerFinalized', 'owner-upgrade-finalized.tjs', true),
          1n,
        )
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
      if (after === -1) {
        baseline = disposed
        controlPassed = !failure
      } else if (JSON.stringify(disposed) !== JSON.stringify(baseline))
        failure = {
          ...outcome,
          error: 'Owner upgrade retained live allocations after disposal',
          baseline,
          disposed,
          prior: failure,
        }
      results[index] = { ...outcome, baseline, disposed }
      if (failure) {
        failures.push(failure)
        console.error(failure)
      } else
        console.log(
          `PASS ${variant}/owner-upgrade/debug=${debugMode}/binary=${binary}/allocation=${after}`,
        )
      save()
      if (!controlPassed || completed) break
    }
    if (controlPassed && !completed)
      failures.push({
        operation: 'upgrade',
        debugMode,
        binary,
        error: 'Owner upgrade allocation enumeration exceeded 128 sites',
      })
  }
save()
assert.deepEqual(failures, [])
