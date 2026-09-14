import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { isScriptObject, type ScriptObject } from '../../src/engine/script/runtime.ts'
import { checkLifetime as check, observeNative } from './bytecode-lifetime.ts'
import { executionStats } from './execution-budget.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'

export const hostHandleCases = [
  'batch-throwing',
  'stale-during-finalize',
  'duplicate-release',
  'nested-release',
  'primary-host-error',
  'primary-storage-error',
] as const
export const hostHandleControlCases = ['paused-resume', 'paused-cancel'] as const

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
  error === undefined
    ? null
    : error instanceof Error
      ? { name: error.name, message: error.message }
      : String(error)

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
      if (operation === 'handle-scripts-class')
        return { kind: 'value', value: { type: 'native-class', name: 'Scripts' } }
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
      } else if (operation === 'Storage.readText') {
        for (const object of objects) vm.release(object)
        throw new Error('storage-primary')
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
    if (name === 'primary-storage-error')
      await vm.execute('var Scripts=__host("handle-scripts-class");var hostHandleStorage=[];')
    const action =
      name === 'primary-host-error'
        ? '__host("handle-primary")'
        : name === 'primary-storage-error'
          ? 'Scripts.eval("hostHandleStorage.load(\\"missing-release.txt\\")")'
          : '6*7'
    // Compiling after release would itself flush the queue and hide the tested boundary.
    const preparedAction = binary ? await vm.compile(action, 'handle-boundary.tjs', true) : action
    const before = stats()
    observed.before = before
    const behaviors =
      name === 'batch-throwing'
        ? [1, 0, 0]
        : name === 'primary-host-error' || name === 'primary-storage-error'
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
    else if (name !== 'primary-host-error' && name !== 'primary-storage-error')
      for (const object of objects) vm.release(object)
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
          : name === 'primary-storage-error'
            ? 'storage-primary'
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
        : name === 'primary-host-error' || name === 'primary-storage-error'
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
              : name === 'primary-storage-error'
                ? 'Storage.readText'
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
    if (name === 'primary-storage-error')
      await vm.execute('delete hostHandleStorage;delete Scripts;')
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

/** A paused host return must not let queued destruction escape a cancel or resume boundary. */
export async function exerciseHostHandleControl(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  debugMode: boolean,
  binary: boolean,
  cancel: boolean,
) {
  const native = observeNative(factory),
    control = new ExecutionControl()
  const name = cancel ? 'paused-cancel' : 'paused-resume'
  const observed: Record<string, unknown> = { name, variant, debugMode, binary, cancel }
  let nativeReplyKind = -1
  const wrapped: ModuleFactory = async (options) => {
    const module = await native.factory(options),
      ccall = module.ccall.bind(module)
    module.ccall = async (...args) => {
      const reply = await ccall(...args)
      nativeReplyKind = Number(module._krkr_reply_kind!(reply))
      return reply
    }
    return module
  }
  let entered!: () => void, resume!: () => void
  const started = new Promise<void>((resolve) => {
      entered = resolve
    }),
    gate = new Promise<void>((resolve) => {
      resume = resolve
    })
  let hostCalls = 0
  const vm = await TjsWasmRuntime.create(
    wrapped,
    async (operation) => {
      check(operation === 'handle-control-hold', 'Unexpected handle control callback')
      hostCalls++
      entered()
      await gate
      return { kind: 'value', value: undefined }
    },
    { wasmBinary, variant, debugMode, control },
  )
  const stats = () => ({
    ...native.stats(),
    objects: native.call('krkr_native_lifetime_stat', 4),
    pendingDestructions: native.call('krkr_native_lifetime_stat', 0),
    destructionDepth: native.call('krkr_native_lifetime_stat', 1),
    budget: executionStats(native),
    handles: vm.inspect().handles,
  })
  let pending: Promise<void> | undefined,
    value: unknown,
    failure: unknown,
    settled = false
  try {
    await vm.execute('var controlWarm=new Exception("warm");delete controlWarm;')
    const setup = `var hostHandleControlLog="";class HostHandleControlFinal {
      var label;function HostHandleControlFinal(n){label=n;}
      function finalize(){if(label==="A")__host("handle-control-hold");hostHandleControlLog+=label;}
    }`
    await vm.execute(binary ? await vm.compile(setup, 'host-handle-control.tjs') : setup)
    const action = binary ? await vm.compile('6*7', 'handle-control-boundary.tjs', true) : '6*7'
    const before = stats()
    observed.before = before
    const objects: ScriptObject[] = []
    for (const label of ['A', 'B']) {
      const expression = `new HostHandleControlFinal("${label}")`
      const object = await vm.execute(
        binary ? await vm.compile(expression, 'handle-control-owner.tjs', true) : expression,
        'handle-control-owner.tjs',
        true,
      )
      check(isScriptObject(object), 'Control fixture did not return an object handle')
      objects.push(object as ScriptObject)
    }
    observed.owned = stats()
    check(
      native.call('krkr_native_lifetime_stat', 4) === before.objects + 2 &&
        vm.inspect().handles === 2,
      'Control fixture did not acquire exactly two native objects',
    )
    vm.release(objects[0]!)
    pending = vm.execute(action, 'handle-control-boundary.tjs', true).then(
      (result) => {
        value = result
        settled = true
      },
      (error: unknown) => {
        failure = error
        settled = true
      },
    )
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error('Control finalizer never suspended: ' + String(failure))
      }),
    ])
    observed.suspended = stats()
    check(
      !settled && native.call('krkr_native_lifetime_stat', 1) > 0,
      'Control finalizer has no active release frame',
    )
    control.pause()
    vm.release(objects[1]!)
    observed.appended = stats()
    resume()
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    observed.paused = { ...stats(), settled, paused: control.paused, hostCalls }
    check(
      !settled && control.paused && native.call('krkr_native_lifetime_stat', 1) > 0,
      'Paused finalizer advanced before resume or cancel',
    )
    if (cancel) control.cancel()
    else control.resume()
    await pending
    const boundary = stats()
    observed.boundary = boundary
    observed.nativeReplyKind = nativeReplyKind
    observed.error = describeError(failure)
    observed.value = typeof value === 'bigint' ? String(value) : value
    observed.heldMs = 25
    check(
      boundary.objects === before.objects && boundary.handles === 0,
      'Control boundary returned with live queued objects or handles',
    )
    check(
      boundary.blocks === before.blocks && boundary.contexts === before.contexts,
      'Control boundary retained script contexts',
    )
    check(
      boundary.pendingDestructions === 0 &&
        boundary.destructionDepth === 0 &&
        boundary.budget.depth === 0 &&
        boundary.budget.bytes === 0,
      'Control boundary retained native frames',
    )
    check(
      nativeReplyKind === (cancel ? 1 : 0),
      'Control cancellation did not unwind through a native error reply',
    )
    if (cancel)
      check(
        failure instanceof Error && failure.name === 'AbortError',
        'Queued release cancellation was not reported',
      )
    else {
      check(!failure && value === 42n, 'Paused release did not resume successfully')
      const log = await vm.execute('hostHandleControlLog', 'handle-control-log.tjs', true)
      observed.log = log
      check(log === 'AB', 'Resumed finalizers did not finish once in release order')
      check(
        (await vm.execute('6*7', 'handle-control-recovery.tjs', true)) === 42n,
        'Resumed release poisoned the VM',
      )
    }
    check(hostCalls === 1, 'Control finalizer host call was missed or repeated')
    return observed
  } catch (error) {
    throw new Error(
      `${String(error)}; host handle control observations=${JSON.stringify(observed)}`,
    )
  } finally {
    resume()
    control.cancel()
    await pending
    vm.dispose()
  }
}
