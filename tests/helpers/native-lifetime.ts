import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { isScriptObject, type ScriptObject } from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'

export const nativeLifetimeCases = [
  'implicit',
  'explicit',
  'direct-finalize',
  'script-retry',
  'native-retry',
  'reverse-slots',
  'invalid-registrations',
  'reentrant-invalidation',
  'paused-resume',
  'paused-cancel',
  'vm-dispose',
] as const

/** Exercise native-instance slots before member deletion, not observer callbacks. */
export async function exerciseNativeLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: (typeof nativeLifetimeCases)[number],
  debugMode: boolean,
  binary: boolean,
) {
  const native = observeNative(factory),
    control = new ExecutionControl(),
    events: string[] = [],
    nativeCalls: number[] = [],
    held: ScriptObject[] = [],
    seen: { marker: number; valid: number; id: number }[] = []
  let owner: ScriptObject | undefined,
    inspector: ScriptObject | undefined,
    disposed = false,
    resume!: () => void,
    entered!: () => void
  const gate = new Promise<void>((resolve) => {
      resume = resolve
    }),
    entering = new Promise<void>((resolve) => {
      entered = resolve
    })
  const observations: Record<string, unknown> = {
    name,
    variant,
    debugMode,
    binary,
    events,
    nativeCalls,
    seen,
  }
  const vm = await TjsWasmRuntime.create(
    native.factory,
    async (operation, args) => {
      if (operation === 'ScriptFinalize') {
        events.push('script')
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Native.invalidate') {
        const id = Number(args[0])
        check(isScriptObject(args[1]), 'Native callback did not receive its owner')
        nativeCalls.push(id)
        events.push('native:' + id)
        if (name === 'native-retry' && nativeCalls.length === 1) throw new Error('native-first')
        if (name === 'paused-resume' || name === 'paused-cancel') {
          entered()
          await gate
        } else await Promise.resolve()
        return { kind: 'invoke', callback: inspector!, args: [args[1], args[0]] }
      }
      if (operation === 'Seen') {
        const record = { marker: Number(args[0]), valid: Number(args[1]), id: Number(args[2]) }
        seen.push(record)
        events.push('seen:' + record.id)
        return { kind: 'value', value: undefined }
      }
      check(operation === 'Owner' && owner, 'Unexpected native lifetime host call')
      return { kind: 'value', value: owner }
    },
    { wasmBinary, variant, debugMode, control },
  )
  const execute = async (source: string, expression = false) =>
    vm.execute(
      binary ? await vm.compile(source, 'native-lifetime.tjs', expression) : source,
      'native-lifetime.tjs',
      expression,
    )
  const acquire = async (source: string) => {
    const result = await execute(source, true)
    check(isScriptObject(result), 'No native lifetime object')
    held.push(result as ScriptObject)
    return result as ScriptObject
  }
  const release = (object: ScriptObject) => {
    vm.release(object)
    held.splice(held.indexOf(object), 1)
  }
  const rejects = async (operation: () => unknown | Promise<unknown>) => {
    let error: unknown
    try {
      await operation()
    } catch (caught) {
      error = caught
    }
    check(error instanceof Error, 'Invalid native lifetime operation succeeded')
    return String(error)
  }
  try {
    await execute(`
var failScript=false,reenter=${name === 'reentrant-invalidation' ? 'true' : 'false'};
try{throw new Exception("warm native lifetime");}catch(e){}
class HookOwner {var marker=42;function finalize(){__host("ScriptFinalize");if(failScript)throw new Exception("script-first");}}
function inspectHook(owner,id){__host("Seen",owner.marker,(isvalid owner),id);if(reenter)invalidate owner;}
`)
    const baseline = vm.inspect()
    observations.baseline = baseline
    inspector = await acquire('inspectHook')
    owner = await acquire('new HookOwner()')
    vm.observe(owner, () => {
      events.push('observe')
    })
    const slots = name === 'reverse-slots' ? 4 : 1
    for (let id = 1; id <= slots; id++) vm.registerNativeLifetime(owner, 'Native.invalidate', id)
    check(
      native.call('krkr_native_hook_count') === slots,
      'Native instance did not own its registrations',
    )
    observations.registered = { ...vm.inspect(), hooks: native.call('krkr_native_hook_count') }
    if (name === 'vm-dispose') {
      vm.dispose()
      disposed = true
      vm.dispose()
      check(
        native.call('krkr_native_hook_count') === 0 &&
          native.call('krkr_native_lifetime_stat', 4) === 0,
        'Native instance survived VM destruction',
      )
      check(
        events.join(',') === 'observe' && nativeCalls.length === 0 && seen.length === 0,
        'Terminal VM disposal entered a host operation or script finalizer',
      )
      observations.disposed = {
        hooks: native.call('krkr_native_hook_count'),
        scriptObjects: native.call('krkr_native_lifetime_stat', 4),
      }
      return observations
    }
    if (name === 'reverse-slots') {
      observations.fullSlotError = await rejects(() =>
        vm.registerNativeLifetime(owner!, 'Native.invalidate', 5),
      )
      check(
        native.call('krkr_native_hook_count') === 4,
        'Failed fifth slot leaked its native instance',
      )
    }
    if (name === 'invalid-registrations') {
      const errors: Record<string, string> = {}
      errors.operation = await rejects(() =>
        vm.registerNativeLifetime(owner!, 'invalid/operation', 1),
      )
      errors.identifier = await rejects(() =>
        vm.registerNativeLifetime(owner!, 'Native.invalidate', -1),
      )
      errors.overflow = await rejects(() =>
        vm.registerNativeLifetime(owner!, 'Native.invalidate', 0x100000000),
      )
      errors.function = await rejects(() =>
        vm.registerNativeLifetime(inspector!, 'Native.invalidate', 2),
      )
      const cls = await acquire('HookOwner')
      errors.class = await rejects(() => vm.registerNativeLifetime(cls, 'Native.invalidate', 2))
      const released = vm.retain(owner)
      vm.release(released)
      errors.released = await rejects(() =>
        vm.registerNativeLifetime(released, 'Native.invalidate', 2),
      )
      const other = await TjsWasmRuntime.create(
        factory,
        () => {
          throw new Error('Unexpected foreign callback')
        },
        { wasmBinary, variant },
      )
      try {
        const foreign = await other.execute('%[]', '', true)
        check(isScriptObject(foreign), 'Missing foreign native owner')
        errors.foreign = await rejects(() =>
          vm.registerNativeLifetime(foreign as ScriptObject, 'Native.invalidate', 2),
        )
        other.release(foreign as ScriptObject)
        await other.collect()
      } finally {
        other.dispose()
      }
      check(
        native.call('krkr_native_hook_count') === 1,
        'Invalid registration changed native slots',
      )
      observations.rejections = errors
    }
    if (name === 'direct-finalize') {
      await execute('__host("Owner").finalize();')
      check(
        events.join(',') === 'script' && nativeCalls.length === 0,
        'Direct finalize ran native invalidation',
      )
      check(
        (await execute('__host("Owner").marker', true)) === 42n,
        'Direct finalize cleared instance members',
      )
    }
    if (name === 'script-retry' || name === 'native-retry') {
      if (name === 'script-retry') await execute('failScript=true;')
      observations.firstError = await rejects(() => execute('invalidate __host("Owner");'))
      check(
        String(observations.firstError).includes(
          name === 'script-retry' ? 'script-first' : 'native-first',
        ),
        'Lost failed invalidation error',
      )
      check(
        (await execute('(isvalid __host("Owner")) && __host("Owner").marker==42', true)) === 1n,
        'Failed invalidation prematurely cleared owner members',
      )
      check(
        !events.includes('observe') && seen.length === 0,
        'Failed invalidation published retirement',
      )
      if (name === 'script-retry') {
        check(nativeCalls.length === 0, 'Native invalidation followed a failed script finalizer')
        await execute('failScript=false;')
      }
    }
    if (name === 'implicit' || name === 'paused-resume' || name === 'paused-cancel') {
      release(owner)
      owner = undefined
      if (name === 'implicit') await vm.collect()
      else {
        let settled = false,
          endingError: unknown
        const ending = vm.collect().then(
          () => {
            settled = true
          },
          (error) => {
            settled = true
            endingError = error
          },
        )
        await Promise.race([
          entering,
          ending.then(() => {
            throw new Error('Native invalidation did not suspend')
          }),
        ])
        control.pause()
        resume()
        await new Promise((resolve) => setTimeout(resolve, 25))
        check(!settled && seen.length === 0, 'Native callback crossed a paused VM boundary')
        name === 'paused-cancel' ? control.cancel() : control.resume()
        await ending
        observations.control = {
          heldMs: 25,
          error: endingError instanceof Error ? endingError.name : null,
        }
        check(
          name === 'paused-cancel'
            ? endingError instanceof Error && endingError.name === 'AbortError'
            : !endingError,
          'Wrong native invalidation cancellation outcome',
        )
      }
    } else {
      await execute('invalidate __host("Owner");')
      check(
        (await execute('isvalid __host("Owner")', true)) === 0n,
        'Native invalidation left its owner valid',
      )
      await execute('invalidate __host("Owner");')
      if (name === 'invalid-registrations')
        observations.invalidOwnerError = await rejects(() =>
          vm.registerNativeLifetime(owner!, 'Native.invalidate', 2),
        )
    }
    for (const object of [...held]) release(object)
    inspector = owner = undefined
    if (!control.cancelled) await vm.collect()
    if (control.cancelled) {
      vm.dispose()
      disposed = true
      check(
        native.call('krkr_native_hook_count') === 0 &&
          native.call('krkr_native_lifetime_stat', 4) === 0,
        'Cancelled native callback retained its VM',
      )
      observations.cancelledDispose = {
        hooks: native.call('krkr_native_hook_count'),
        scriptObjects: native.call('krkr_native_lifetime_stat', 4),
      }
    } else {
      const after = vm.inspect()
      observations.after = after
      for (const field of [
        'handles',
        'scriptObjects',
        'weakOwners',
        'dependents',
        'pendingInvalidations',
        'pendingHandles',
      ] as const)
        check(after[field] === baseline[field], `Native lifetime retained ${field}`)
      check(native.call('krkr_native_hook_count') === 0, 'Native slots survived owner release')
      check((await execute('6*7', true)) === 42n, 'Native invalidation poisoned the VM')
    }
    const expectedIds =
      name === 'reverse-slots' ? [4, 3, 2, 1] : name === 'native-retry' ? [1, 1] : [1]
    check(
      JSON.stringify(nativeCalls) === JSON.stringify(expectedIds),
      'Native instance order or retry count differs',
    )
    check(
      seen.length === (name === 'paused-cancel' ? 0 : slots),
      'Wrong native callback observation count',
    )
    for (const row of seen)
      check(row.marker === 42 && row.valid === 1, 'Native cleanup followed member deletion')
    check(
      events.filter((event) => event === 'script').length ===
        (['direct-finalize', 'script-retry', 'native-retry'].includes(name) ? 2 : 1),
      'Wrong script finalizer count',
    )
    check(
      events.filter((event) => event === 'observe').length === 1,
      'Retirement did not notify once',
    )
    check(
      events.indexOf('observe') > events.lastIndexOf('seen:1'),
      'Weak retirement preceded native callbacks',
    )
    return observations
  } catch (error) {
    throw new Error(
      String(error) +
        '; native lifetime=' +
        JSON.stringify({ ...observations, hooks: native.call('krkr_native_hook_count') }),
    )
  } finally {
    resume()
    control.resume()
    if (!disposed) vm.dispose()
  }
}
