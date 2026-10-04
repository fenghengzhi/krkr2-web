import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { isScriptObject, type ScriptObjectIdentity, type ScriptValue } from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'

export const objectIdentityCases = [
  'explicit-invalidation', 'implicit-destruction', 'revocation',
  'notification-reentry', 'finalizer-resurrection', 'finalizer-error',
  'partial-construction', 'deep-release', 'invalid-observation', 'vm-isolation', 'vm-dispose',
] as const

export async function exerciseObjectIdentity(
  factory: ModuleFactory, wasmBinary: Uint8Array, variant: WasmVariant,
  name: (typeof objectIdentityCases)[number], debugMode: boolean, binary: boolean,
) {
  const identities: ScriptObjectIdentity[] = [], expired: number[] = [],
    observations: Record<string, unknown> = {}
  let returned: ScriptValue, reenter: ((token: number) => void) | undefined,
    disposed = false, vm!: TjsWasmRuntime
  const native = observeNative(async (options) => factory({
    ...options,
    objectDestroyed(pointer, token) {
      options.objectDestroyed?.(pointer, token)
      expired.push(token)
      reenter?.(token)
    },
  }))
  vm = await TjsWasmRuntime.create(native.factory, async (operation, args) => {
    if (operation === 'ObserveIdentity') {
      check(isScriptObject(args[0]), 'Identity observation requires a real instance')
      if (!isScriptObject(args[0])) throw new Error('Missing observed instance')
      const identity = vm.observeIdentity(args[0])
      check(identity, 'Live constructor instance could not be observed')
      identities.push(identity!)
      return { kind: 'value', value: undefined }
    }
    check(operation === 'IdentityReply', 'Unexpected identity host call')
    await Promise.resolve()
    return { kind: 'value', value: returned }
  }, { wasmBinary, variant, debugMode })
  const execute = async (code: string, expression = false) => vm.execute(
    binary ? await vm.compile(code, 'object-identity.tjs', expression) : code,
    'object-identity.tjs', expression,
  )
  const identityOf = async (expression = 'origin') => {
    const owner = await execute(expression, true)
    check(isScriptObject(owner), 'No identity owner handle')
    if (!isScriptObject(owner)) throw new Error('No identity owner')
    try {
      const token = vm.observeIdentity(owner)
      check(token, 'A live owner identity was rejected')
      identities.push(token!)
      return token!
    } finally { vm.release(owner); await vm.collect() }
  }
  const reject = (operation: () => unknown) => {
    let failure: unknown
    try { operation() } catch (error) { failure = error }
    check(failure instanceof Error && String(failure).includes('different TJS runtime'),
      'Foreign identity was accepted')
  }
  try {
    await execute(String.raw`
var finalized=0,revive=false,failFinalize=false,constructObserve=false,failConstruct=false;
try{throw new Exception("identity-warmup");}catch(error){}
function identityFunction(){return 42;}
class IdentityOwner {
  var child;
  function IdentityOwner(next=null){child=next;if(constructObserve)__host("ObserveIdentity",this);if(failConstruct)throw new Exception("identity-constructor-fault");}
  function value(){return 42;}
  function finalize(){finalized++;if(revive){revive=false;global.saved=this;}if(failFinalize)throw new Exception("identity-finalizer-fault");}
}
`)
    const baseline = vm.inspect()
    if (name === 'partial-construction') {
      await execute('constructObserve=true;failConstruct=true;')
      let failure: unknown
      try { await execute('new IdentityOwner()', true) } catch (error) { failure = error }
      check(String(failure).includes('identity-constructor-fault'), 'Constructor error was lost')
      check(identities.length === 1 && !vm.identityAlive(identities[0]!), 'Failed constructor retained its identity')
      observations.failure = String(failure)
    } else if (name === 'deep-release') {
      await execute('constructObserve=true;var head=null;for(var i=0;i<128;i++)head=new IdentityOwner(head);')
      check(identities.length === 128 && vm.inspect().objectIdentities === 128, 'Deep chain identity inventory differs')
      await execute('delete global.head;')
      check((await execute('finalized', true)) === 128n, 'Deep release skipped a finalizer')
      check(identities.every((token) => !vm.identityAlive(token)), 'Deep release left a live identity')
      check(native.call('krkr_native_lifetime_stat', 0) === 0, 'Deep native release queue did not drain')
    } else {
      await execute('var origin=new IdentityOwner();')
      const token = await identityOf()
      returned = token
      check(vm.inspect().handles === baseline.handles, 'Identity observation added a strong host root')
      check(vm.identityAlive(token), 'New native identity is not alive')
      if (name === 'explicit-invalidation') {
        const owner = await execute('origin', true)
        if (!isScriptObject(owner)) throw new Error('No resource owner')
        let invalidations = 0
        const weak = vm.observe(owner, () => invalidations++)
        vm.release(owner)
        await vm.collect()
        await execute('invalidate origin;')
        check(invalidations === 1 && vm.upgrade(weak) === undefined, 'Resource weak observation changed semantics')
        check(vm.observeIdentity(weak) === undefined, 'An expired resource token created a fresh identity')
        check(vm.identityAlive(token), 'Explicit invalidation expired the independent identity')
        check((await execute('__host("IdentityReply")===origin && !(isvalid __host("IdentityReply"))', true)) === 1n,
          'Identity reply lost the invalid instance or reopened its validity')
        const lease = vm.upgradeIdentity(token)
        check(lease, 'Alive invalid identity did not upgrade')
        if (lease) {
          check(vm.nativeLifetimeIdentifier(lease, 'not-registered') === undefined, 'Identity upgrade invented native state')
          vm.release(lease)
          await vm.collect()
        }
        check(vm.inspect().handles === baseline.handles, 'Identity reply leaked a host handle')
        await execute('var held=__host("IdentityReply");delete global.origin;')
        check(vm.identityAlive(token), 'A reply-held invalid instance was destroyed early')
        await execute('delete global.held;')
      } else if (name === 'revocation') {
        vm.unobserveIdentity(token)
        vm.unobserveIdentity(token)
        check(!vm.identityAlive(token) && vm.upgradeIdentity(token) === undefined, 'Revoked identity could upgrade')
        check((await execute('__host("IdentityReply")===null && isvalid origin', true)) === 1n,
          'Revocation altered the owner or returned a revoked reference')
        const next = await identityOf()
        check(next.id > token.id, 'Identity token was reused')
        await execute('delete global.origin;')
        check(!vm.identityAlive(next), 'Replacement observation survived actual destruction')
      } else if (name === 'notification-reentry') {
        const second = await identityOf()
        let callbacks = 0
        reenter = () => {
          callbacks++
          check(!vm.identityAlive(token) && !vm.identityAlive(second), 'A destruction callback observed a still-upgradeable sibling token')
          check(vm.upgradeIdentity(token) === undefined && vm.upgradeIdentity(second) === undefined,
            'Identity resurrected after actual deletion began')
          vm.unobserveIdentity(token)
          vm.unobserveIdentity(second)
        }
        await execute('delete global.origin;')
        check(callbacks > 0 && callbacks <= 2, 'Missing or repeated destruction notification')
        observations.callbacks = callbacks
        reenter = undefined
      } else if (name === 'finalizer-resurrection') {
        await execute('revive=true;delete global.origin;')
        check(vm.identityAlive(token), 'BeforeDestruction resurrection was treated as actual deletion')
        check((await execute('saved===__host("IdentityReply")', true)) === 1n, 'Resurrected object changed identity')
        check((await execute('finalized', true)) === 1n, 'Resurrection reran finalization')
        await execute('delete global.saved;')
        check((await execute('finalized', true)) === 1n, 'Actual deletion reran completed finalization')
      } else if (name === 'finalizer-error') {
        await execute('failFinalize=true;')
        let failure: unknown
        try { await execute('delete global.origin;') } catch (error) { failure = error }
        check(String(failure).includes('identity-finalizer-fault'), 'Finalizer error was lost')
        check(!vm.identityAlive(token), 'Throwing finalizer retained the consumed last reference')
        observations.failure = String(failure)
        await execute('failFinalize=false;')
      } else if (name === 'invalid-observation') {
        const count = vm.inspect().objectIdentities
        for (const expression of ['identityFunction', 'IdentityOwner', 'identityFunction incontextof origin']) {
          const candidate = await execute(expression, true)
          check(isScriptObject(candidate), 'Invalid-observation fixture did not produce a native closure')
          if (!isScriptObject(candidate)) throw new Error('Missing closure fixture')
          try {
            check(vm.observeIdentity(candidate) === undefined, 'Non-instance closure became an object identity')
            check(vm.inspect().objectIdentities === count, 'Rejected observation left a token')
          } finally { vm.release(candidate); await vm.collect() }
        }
        const released = await execute('origin', true)
        if (!isScriptObject(released)) throw new Error('Missing released-handle fixture')
        vm.release(released)
        check(vm.observeIdentity(released) === undefined, 'Released handle created a new identity')
        await vm.collect()
        await execute('delete global.origin;')
      } else if (name === 'vm-isolation') {
        const other = await TjsWasmRuntime.create(factory, () => ({ kind: 'value', value: token }),
          { wasmBinary, variant, debugMode })
        try {
          reject(() => other.identityAlive(token))
          reject(() => other.upgradeIdentity(token))
          reject(() => other.unobserveIdentity(token))
          let failure: unknown
          try { await other.execute('__host("ForeignIdentity")', '', true) } catch (error) { failure = error }
          check(String(failure).includes('different TJS runtime'), 'Foreign identity descriptor crossed VM reply boundary')
        } finally { other.dispose() }
        await execute('delete global.origin;')
      } else if (name === 'vm-dispose') {
        vm.dispose()
        disposed = true
        check(!vm.identityAlive(token) && vm.upgradeIdentity(token) === undefined, 'VM disposal left an upgradeable identity')
        vm.unobserveIdentity(token)
        check(expired.includes(token.id), 'VM disposal omitted identity revocation')
        check(native.call('krkr_native_lifetime_stat', 4) === 0, 'Disposed VM retained script instances')
        return { name, variant, debugMode, binary, baseline, expired, disposed }
      } else await execute('delete global.origin;')
      check(!vm.identityAlive(token), 'An unowned identity remained alive')
      returned = token
      check((await execute('__host("IdentityReply")===null', true)) === 1n, 'Expired identity reply did not become null')
    }
    await vm.collect()
    const after = vm.inspect()
    for (const field of ['handles', 'weakOwners', 'objectIdentities', 'scriptObjects', 'pendingHandles'] as const)
      check(after[field] === baseline[field], `Identity scenario retained ${field}`)
    check(native.call('krkr_native_lifetime_stat', 0) === 0, 'Pending native destructions remain')
    return { name, variant, debugMode, binary, baseline, after, expired, observations }
  } finally {
    reenter = undefined
    if (!disposed) vm.dispose()
  }
}
