import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { isScriptObject, type ScriptObject } from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'
import { executionStats } from './execution-budget.ts'

export const hostHandleCases = [
  'batch-throwing',
  'stale-during-finalize',
  'duplicate-release',
  'nested-release',
  'primary-host-error',
] as const

const source = `
var hostHandleLog="";
class HostHandleFinal {
  var label,behavior;
  function HostHandleFinal(n,b){label=n;behavior=b;}
  function finalize(){
    hostHandleLog+=label;
    if(behavior===1)throw new Exception("release-"+label);
    if(behavior===2){__host("handle-inspect");hostHandleLog+="a";}
    if(behavior===3){__host("handle-duplicate");hostHandleLog+="a";}
    if(behavior===4){__host("handle-hold");hostHandleLog+="a";}
  }
}
`
const describeError = (error: unknown) =>
  error instanceof Error ? { name: error.name, message: error.message } : String(error)

/** Observe the release boundary before any recovery execute can drain a missed handle. */
export async function exerciseHostHandles(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  name: string,
  debugMode: boolean,
  binary: boolean,
) {
  check(
    hostHandleCases.some((item) => item === name),
    'Unknown host handle case',
  )
  const native = observeNative(factory)
  const objects: ScriptObject[] = []
  const callbacks: string[] = []
  const observed: Record<string, unknown> = { name, debugMode, binary, variant, callbacks }
  let entered!: () => void, resume!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const gate = new Promise<void>((resolve) => {
    resume = resolve
  })
  let vm!: TjsWasmRuntime
  let pending: Promise<void> | undefined
  let value: unknown, failure: unknown
  let settled = false
  vm = await TjsWasmRuntime.create(
    native.factory,
    async (operation) => {
      callbacks.push(operation)
      if (operation === 'handle-inspect') {
        // These calls are synchronous and must reject while finalize is still active.
        let retained: ScriptObject | undefined,
          retainError: unknown,
          identityError: unknown,
          snapshotError: unknown
        let identity: string | undefined
        try {
          retained = vm.retain(objects[0]!)
        } catch (error) {
          retainError = error
        }
        try {
          identity = vm.objectIdentity(objects[0]!)
        } catch (error) {
          identityError = error
        }
        try {
          vm.snapshot(objects[0]!)
        } catch (error) {
          snapshotError = error
        }
        observed.stale = {
          retained,
          identity,
          retainError: describeError(retainError),
          identityError: describeError(identityError),
          snapshotError: describeError(snapshotError),
          depth: native.call('krkr_native_lifetime_stat', 1),
        }
        if (retained) vm.release(retained)
        check(
          retainError instanceof Error &&
            retainError.message.includes('Released TJS object handle'),
          'A finalizing handle was retained',
        )
        check(
          identityError instanceof Error &&
            identityError.message.includes('Released TJS object handle'),
          'A finalizing handle exposed an identity',
        )
        check(
          snapshotError instanceof Error &&
            snapshotError.message.includes('Released object handle'),
          'A finalizing handle exposed a data snapshot',
        )
      } else if (operation === 'handle-duplicate') {
        vm.release(objects[0]!)
        vm.release(objects[0]!)
        observed.duplicate = {
          handles: vm.inspect().handles,
          depth: native.call('krkr_native_lifetime_stat', 1),
        }
      } else if (operation === 'handle-hold') {
        entered()
        await gate
      } else if (operation === 'handle-primary') {
        for (const object of objects) vm.release(object)
        throw new Error('host-primary')
      } else throw new Error('Unexpected host handle operation: ' + operation)
      return { kind: 'value', value: undefined }
    },
    { wasmBinary, variant, debugMode },
  )
  const stats = () => ({
    ...native.stats(),
    objects: native.call('krkr_native_lifetime_stat', 4),
    pendingDestructions: native.call('krkr_native_lifetime_stat', 0),
    destructionDepth: native.call('krkr_native_lifetime_stat', 1),
    budget: executionStats(native),
    handles: vm.inspect().handles,
  })
  try {
    await vm.execute('var handleWarm=new Exception("warm");delete handleWarm;')
    await vm.execute(binary ? await vm.compile(source, 'host-handles.tjs') : source)
    const action = name === 'primary-host-error' ? '__host("handle-primary")' : '6*7'
    // Compiling after release would itself flush the queue and hide the tested boundary.
    const preparedAction = binary ? await vm.compile(action, 'handle-boundary.tjs', true) : action
    const before = stats()
    observed.before = before
    const behaviors =
      name === 'batch-throwing'
        ? [1, 0, 0]
        : name === 'primary-host-error'
          ? [1, 0]
          : name === 'nested-release'
            ? [4, 0]
            : name === 'duplicate-release'
              ? [3]
              : [2]
    for (const [index, behavior] of behaviors.entries()) {
      const expression = `new HostHandleFinal("${String.fromCharCode(65 + index)}",${behavior})`
      const object = await vm.execute(
        binary ? await vm.compile(expression, 'host-owner.tjs', true) : expression,
        'host-owner.tjs',
        true,
      )
      check(isScriptObject(object), 'Fixture did not return a native object handle')
      objects.push(object as ScriptObject)
    }
    observed.owned = stats()
    check(
      native.call('krkr_native_lifetime_stat', 4) === before.objects + objects.length,
      'Fixture did not acquire the expected dispatch objects',
    )
    check(vm.inspect().handles === objects.length, 'Fixture did not acquire one handle per object')
    if (name === 'nested-release') vm.release(objects[0]!)
    else if (name !== 'primary-host-error') for (const object of objects) vm.release(object)
    pending = vm.execute(preparedAction, 'handle-boundary.tjs', true).then(
      (result) => {
        value = result
        settled = true
      },
      (error: unknown) => {
        failure = error
        settled = true
      },
    )
    if (name === 'nested-release') {
      await Promise.race([
        started,
        pending.then(() => {
          throw new Error('Finalizer never suspended: ' + String(failure))
        }),
      ])
      observed.suspended = stats()
      check(
        !settled && native.call('krkr_native_lifetime_stat', 1) > 0,
        'Finalizer did not hold a native release frame',
      )
      vm.release(objects[1]!)
      observed.appended = stats()
      resume()
    }
    await pending
    // Keep this read before every further execute/compile/invoke, including log inspection.
    const boundary = stats()
    observed.boundary = boundary
    observed.value = typeof value === 'bigint' ? String(value) : value
    observed.error = describeError(failure)
    check(boundary.objects === before.objects, 'Release boundary returned with live queued objects')
    check(boundary.handles === 0, 'Release boundary retained handles')
    check(
      boundary.blocks === before.blocks && boundary.contexts === before.contexts,
      'Release boundary retained script contexts',
    )
    check(
      boundary.pendingDestructions === 0 &&
        boundary.destructionDepth === 0 &&
        boundary.budget.depth === 0 &&
        boundary.budget.bytes === 0,
      'Release boundary retained execution or destruction frames',
    )
    const expectedError =
      name === 'batch-throwing'
        ? 'release-A'
        : name === 'primary-host-error'
          ? 'host-primary'
          : null
    if (expectedError)
      check(
        failure instanceof Error &&
          failure.name === 'ScriptError' &&
          failure.message.includes(expectedError),
        'Release boundary replaced or lost the primary error',
      )
    else check(!failure && value === 42n, 'Release boundary failed to resume execution')
    const log = await vm.execute('hostHandleLog', 'handle-log.tjs', true)
    observed.log = log
    const expectedLog =
      name === 'batch-throwing'
        ? 'ABC'
        : name === 'primary-host-error'
          ? 'AB'
          : name === 'nested-release'
            ? 'ABa'
            : 'Aa'
    check(
      typeof log === 'string' && log.split('').sort().join('') === expectedLog,
      'Finalizers were missed or repeated',
    )
    const expectedCallback =
      name === 'stale-during-finalize'
        ? 'handle-inspect'
        : name === 'duplicate-release'
          ? 'handle-duplicate'
          : name === 'nested-release'
            ? 'handle-hold'
            : name === 'primary-host-error'
              ? 'handle-primary'
              : undefined
    check(
      callbacks.length === (expectedCallback ? 1 : 0) &&
        (!expectedCallback || callbacks[0] === expectedCallback),
      'Unexpected finalizer callback count',
    )
    check(
      (await vm.execute('6*7', 'handle-recovery.tjs', true)) === 42n,
      'Released handle error poisoned the VM',
    )
    await vm.execute('delete HostHandleFinal;delete hostHandleLog;')
    observed.after = stats()
    check(
      native.stats().blocks === 0 && native.stats().contexts === 0 && vm.inspect().handles === 0,
      'Handle fixture cleanup retained contexts or handles',
    )
    return observed
  } catch (error) {
    throw new Error(`${String(error)}; host handle observations=${JSON.stringify(observed)}`)
  } finally {
    resume()
    await pending
    vm.dispose()
  }
}
