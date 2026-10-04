// Dedicated destruction-only identity allocation diagnostics; hosted runners only.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { ModuleFactory, NativeModule, WasmManifest, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { isScriptObject, type ScriptObject, type ScriptObjectIdentity } from '../../src/engine/script/runtime.ts'
import { observeNative } from '../helpers/bytecode-lifetime.ts'
import { executionStats } from '../helpers/execution-budget.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const variant = process.argv[2] as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest
assert.equal(manifest.diagnosticAllocator, true)
assert.equal(manifest.capabilities?.objectIdentity, 1)
const assets = manifest.variants[variant]
assert(assets)
const { default: factory } = (await import(pathToFileURL(resolve(directory, assets.mjs.file)).href)) as { default: ModuleFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file))),
  probeSha256 = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex')
assert.equal(createHash('sha256').update(wasmBinary).digest('hex'), assets.wasm.sha256)
assert.equal(createHash('sha256').update(readFileSync(resolve(directory, assets.mjs.file))).digest('hex'), assets.mjs.sha256)

const results: Record<string, unknown>[] = [], failures: Record<string, unknown>[] = []
mkdirSync('out/ci', { recursive: true })
const save = () => writeFileSync(`out/ci/object-identity-allocations-${variant}.json`, JSON.stringify({
  variant, sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID,
  probeSha256, manifest, results, failures,
}, null, 2) + '\n')
save()

function observeAllocator() {
  let module!: NativeModule & { krkrAllocationTrace?: string }
  const native = observeNative(async (options) => {
    module = await factory(options)
    return module
  })
  return { ...native, allocationTrace: () => module.krkrAllocationTrace ?? null }
}
type Native = ReturnType<typeof observeAllocator>
function allocations(native: Native) {
  assert.equal(native.call('krkr_test_live_allocation_stat', 2), 0, 'Diagnostic allocation ledger overflow')
  return {
    bytes: native.call('krkr_test_live_allocation_stat', 0),
    allocations: native.call('krkr_test_live_allocation_stat', 1),
    strings: native.call('krkr_native_string_cells'),
    objects: native.call('krkr_native_lifetime_stat', 4),
  }
}
function snapshot(native: Native, vm: TjsWasmRuntime) {
  return { ...native.stats(), ...vm.inspect(), allocations: allocations(native) }
}
function stableObjects(before: ReturnType<typeof snapshot>, after: ReturnType<typeof snapshot>) {
  assert.equal(after.scriptObjects, before.scriptObjects)
  assert.equal(after.blocks, before.blocks)
  assert.equal(after.contexts, before.contexts)
  assert.equal(after.pendingHandles, 0)
  assert.equal(after.drainingReleased, false)
}
function idle(native: Native) {
  const state = executionStats(native)
  for (const key of ['depth', 'bytes', 'functions', 'tries', 'delegations'] as const)
    assert.equal(state[key], 0, `Identity operation retained execution ${key}`)
  assert.equal(native.call('krkr_native_lifetime_stat', 0), 0)
  assert.equal(native.call('krkr_native_lifetime_stat', 1), 0)
  return state
}
const setup = String.raw`
var identityFinalized=0;
class IdentityAllocationOwner {
  function finalize(){global.identityFinalized++;}
}
function invalidateIdentityOwner(value){invalidate value;}
`
async function createOwner(vm: TjsWasmRuntime, binary: boolean) {
  await vm.execute('try{identityAllocatorWarmMissing();}catch(error){}')
  await vm.execute(binary ? await vm.compile(setup, 'identity-allocation.tjs') : setup)
  const expression = 'new IdentityAllocationOwner()',
    value = await vm.execute(binary ? await vm.compile(expression, 'identity-instance.tjs', true) : expression,
      'identity-instance.tjs', true)
  assert(isScriptObject(value))
  return value
}
async function invalidate(vm: TjsWasmRuntime, owner: ScriptObject) {
  const callback = await vm.execute('invalidateIdentityOwner', '', true)
  assert(isScriptObject(callback))
  try { await vm.invoke(callback, [owner]) }
  finally { vm.release(callback) }
  await vm.collect()
}
type Operation = 'observe-handle' | 'observe-weak' | 'upgrade-live' | 'upgrade-invalid'
type Row = { operation: Operation | 'budget'; debugMode: boolean; binary: boolean; after: number }
const disposedControls = new Map<string, ReturnType<typeof allocations>>()

async function allocationRow(row: Row) {
  const native = observeAllocator(),
    index = results.push({ ...row, status: 'creating' }) - 1
  let vm: TjsWasmRuntime | undefined, outcome: Record<string, unknown> = { ...row },
    error: unknown, disposeError: unknown, hits = -1,
    terminalIdentity: ScriptObjectIdentity | undefined,
    disposed: ReturnType<typeof allocations> | undefined
  const publish = (status: string, fields: Record<string, unknown> = {}) => {
    outcome = { ...outcome, ...fields, status }
    results[index] = outcome
    save()
  }
  try {
    vm = await TjsWasmRuntime.create(native.factory, () => {
      throw new Error('Unexpected identity allocator host call')
    }, { wasmBinary, variant, debugMode: row.debugMode })
    publish('preparing')
    const owner = await createOwner(vm, row.binary), closure = vm.objectIdentity(owner)
    let invalidations = 0
    const weak = vm.observe(owner, () => { invalidations++ })
    let identity: ScriptObjectIdentity | undefined
    if (row.operation.startsWith('upgrade')) {
      identity = vm.observeIdentity(weak)
      assert(identity)
      if (row.operation === 'upgrade-invalid') {
        await invalidate(vm, owner)
        assert.equal(invalidations, 1)
        assert.equal(vm.upgrade(weak), undefined, 'Resource weak must still expire on invalidate')
        assert.equal(vm.observeIdentity(weak), undefined, 'An expired resource token cannot start a new observation')
        assert(vm.identityAlive(identity), 'Existing identity must survive resource invalidation')
      }
    }
    const before = snapshot(native, vm)
    assert.equal(before.handles, 1)
    assert.equal(before.pendingHandles, 0)
    assert.equal(before.objectIdentities, identity ? 1 : 0)
    assert.equal(before.weakOwners, row.operation === 'upgrade-invalid' ? 0 : 1)
    publish('armed', { before, closure })

    if (row.operation === 'budget') {
      const tokens: ScriptObjectIdentity[] = []
      for (let i = 0; i < 4096; i++) {
        const token = vm.observeIdentity(weak)
        assert(token)
        tokens.push(token)
      }
      assert.equal(vm.inspect().objectIdentities, 4096)
      assert.throws(() => vm!.observeIdentity(owner), /identity observation allocation or token budget failed/)
      assert.equal(vm.inspect().handles, before.handles, 'Weak identities must not retain host handles')
      stableObjects(before, snapshot(native, vm))
      const first = tokens.shift()!
      vm.unobserveIdentity(first)
      vm.unobserveIdentity(first)
      assert.equal(vm.identityAlive(first), false)
      assert.equal(vm.upgradeIdentity(first), undefined, 'Revocation is expiry, not allocation failure')
      const replacement = vm.observeIdentity(owner)
      assert(replacement)
      assert(replacement.id > tokens.at(-1)!.id, 'Identity tokens must never be reused')
      tokens.push(replacement)
      for (const token of tokens) vm.unobserveIdentity(token)
      assert.equal(vm.inspect().objectIdentities, 0)
      assert.deepEqual(allocations(native), before.allocations, 'Revoking the budget set must reclaim every observer allocation')
      identity = vm.observeIdentity(owner)
      assert(identity)
      publish('budget-reclaimed', { budgetCount: 4096, afterBudget: snapshot(native, vm) })
    } else if (row.operation.startsWith('observe')) {
      let injected: unknown
      if (row.after >= 0) native.call('krkr_test_fail_allocation', 12, row.after, 0)
      try { identity = vm.observeIdentity(row.operation === 'observe-weak' ? weak : owner) }
      catch (failure) { injected = failure }
      hits = native.call('krkr_test_allocation_hits')
      const failedBytes = native.call('krkr_test_failed_bytes')
      native.call('krkr_test_fail_allocation', 0, -1, 0)
      const after = snapshot(native, vm)
      stableObjects(before, after)
      assert.equal(after.handles, before.handles, 'Observation must not create a strong host lease')
      assert.equal(after.weakOwners, before.weakOwners)
      if (hits) {
        assert(injected instanceof Error)
        assert.match(injected.message, /identity observation allocation or token budget failed/)
        assert.equal(identity, undefined)
        assert.equal(after.objectIdentities, 0)
        assert.deepEqual(after.allocations, before.allocations, 'Partial observer allocation must detach and roll back')
      } else {
        assert.equal(injected, undefined)
        assert(identity)
        assert.equal(after.objectIdentities, 1)
      }
      publish('observed', { hits, failedBytes, after, allocationTrace: native.allocationTrace(),
        injectedError: injected instanceof Error ? injected.message : null })
      // Both failing and successful runs finish with one fresh observation;
      // revocation/retry must not change the owner's ordinary references.
      if (identity) vm.unobserveIdentity(identity)
      identity = vm.observeIdentity(weak)
      assert(identity)
      assert.equal(vm.inspect().objectIdentities, 1)
    } else {
      assert(identity)
      let lease: ScriptObject | undefined, injected: unknown
      if (row.after >= 0) native.call('krkr_test_fail_allocation', 13, row.after, 0)
      try { lease = vm.upgradeIdentity(identity) }
      catch (failure) { injected = failure }
      hits = native.call('krkr_test_allocation_hits')
      const failedBytes = native.call('krkr_test_failed_bytes')
      native.call('krkr_test_fail_allocation', 0, -1, 0)
      const after = snapshot(native, vm)
      stableObjects(before, after)
      assert.equal(after.objectIdentities, 1)
      assert.equal(after.weakOwners, before.weakOwners)
      if (hits) {
        assert(injected instanceof Error)
        assert.equal(injected.message, 'TJS object identity upgrade allocation failed')
        assert.equal(lease, undefined, 'Allocation failure must not become an empty successful lease')
        assert.equal(after.handles, before.handles)
        assert.deepEqual(after.allocations, before.allocations, 'Failed upgrade must restore reference and allocation baselines')
      } else {
        assert.equal(injected, undefined)
        assert(lease)
        assert.equal(vm.objectIdentity(lease), closure)
        assert.equal(after.handles, before.handles + 1)
      }
      const retry = vm.upgradeIdentity(identity)
      assert(retry, 'Retry after either control or failure must still acquire the identity')
      assert.equal(vm.objectIdentity(retry), closure)
      assert.notEqual(retry.id, owner.id)
      if (lease) {
        assert.notEqual(retry.id, lease.id)
        vm.release(lease)
      }
      vm.release(retry)
      await vm.collect()
      assert.equal(vm.inspect().handles, before.handles)
      assert.equal(vm.inspect().pendingHandles, 0)
      assert(vm.identityAlive(identity))
      publish('upgraded', { hits, failedBytes, after, allocationTrace: native.allocationTrace(),
        injectedError: injected instanceof Error ? injected.message : null })
    }

    assert(identity)
    assert.equal(vm.objectIdentity(owner), closure)
    assert.equal(vm.inspect().handles, 1)
    assert(vm.identityAlive(identity))
    // Do not unobserve: actual final destruction must retire the token itself.
    vm.release(owner)
    await vm.collect()
    const released = snapshot(native, vm)
    assert.equal(released.handles, 0)
    assert.equal(released.pendingHandles, 0)
    assert.equal(released.objectIdentities, 0)
    assert.equal(released.weakOwners, 0)
    assert.equal(released.scriptObjects, before.scriptObjects - 1)
    assert.equal(released.blocks, before.blocks)
    assert.equal(released.contexts, before.contexts)
    assert.equal(invalidations, 1)
    assert.equal(vm.identityAlive(identity), false)
    assert.equal(vm.upgradeIdentity(identity), undefined, 'Actual expiry must not reuse a prior failure flag')
    vm.unobserveIdentity(identity)
    vm.unobserve(weak)
    assert.equal(await vm.execute('identityFinalized', '', true), 1n)
    publish('released', { released, invalidations, budget: idle(native) })

    // Terminal disposal also retires live identity metadata before VM roots.
    // Keep a normal host handle intentionally; dispose must release it itself.
    const terminalExpression = 'new IdentityAllocationOwner()',
      terminal = await vm.execute(row.binary ? await vm.compile(terminalExpression, 'identity-terminal.tjs', true) : terminalExpression,
        'identity-terminal.tjs', true)
    assert(isScriptObject(terminal))
    terminalIdentity = vm.observeIdentity(terminal)
    assert(terminalIdentity)
    assert.equal(vm.inspect().handles, 1)
    assert.equal(vm.inspect().objectIdentities, 1)
    publish('disposing', { beforeDispose: snapshot(native, vm) })
  } catch (failure) { error = failure }
  finally {
    if (vm) {
      native.call('krkr_test_fail_allocation', 0, -1, 0)
      try {
        vm.dispose()
        if (terminalIdentity) {
          assert.equal(vm.identityAlive(terminalIdentity), false)
          assert.equal(vm.upgradeIdentity(terminalIdentity), undefined)
          vm.unobserveIdentity(terminalIdentity)
        }
        assert.equal(allocations(native).objects, 0, 'Terminal disposal retained native script instances')
      }
      catch (failure) { disposeError = failure }
      disposed = allocations(native)
    }
  }
  const key = `${row.operation}/${row.debugMode}/${row.binary}`
  if (row.after === -1 && disposed) disposedControls.set(key, disposed)
  const baseline = disposedControls.get(key)
  if (!error && !disposeError && row.after >= 0) {
    try { assert.deepEqual(disposed, baseline, 'Faulted path retained allocations after terminal VM disposal') }
    catch (failure) { error = failure }
  }
  const failed = error !== undefined || disposeError !== undefined
  publish(failed ? 'failed' : 'passed', { hits, disposed, baseline,
    error: error instanceof Error ? { message: error.message, stack: error.stack } : String(error ?? ''),
    disposeError: disposeError instanceof Error ? { message: disposeError.message, stack: disposeError.stack } : String(disposeError ?? '') })
  if (failed) {
    failures.push(outcome)
    console.error(`FAIL ${variant}/${key}/allocation=${row.after}`, outcome)
  } else console.log(`PASS ${variant}/${key}/allocation=${row.after}`)
  save()
  return { failed, hits }
}

for (const debugMode of [false, true])
  for (const binary of [false, true]) {
    for (const operation of ['observe-handle', 'observe-weak', 'upgrade-live', 'upgrade-invalid'] as const) {
      let complete = false, controlled = false
      for (let after = -1; after < 128; after++) {
        const row = await allocationRow({ operation, debugMode, binary, after })
        if (after === -1) controlled = !row.failed
        if (!controlled) break
        if (after >= 0 && row.hits === 0) { complete = true; break }
      }
      if (controlled && !complete) {
        failures.push({ operation, debugMode, binary, error: 'Identity allocation enumeration exceeded 128 sites without a no-hit run' })
        save()
      }
    }
    await allocationRow({ operation: 'budget', debugMode, binary, after: -1 })
  }
save()
if (failures.length) process.exitCode = 1
