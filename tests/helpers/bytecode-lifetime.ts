import type {
  ModuleFactory,
  NativeModule,
  WasmVariant,
} from '../../src/backends/script/tjs-wasm/module.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { bytecodeOffsets } from './binary-scripts.ts'

export const checkLifetime = (value: unknown, message: string): void => {
  if (!value) throw new Error(message)
}
export function observeNative(factory: ModuleFactory) {
  let native!: NativeModule,
    pointer = 0
  return {
    factory: (async (options) => {
      native = await factory(options)
      const create = native._krkr_create!
      native._krkr_create = (...args) => {
        pointer = Number(create(...args))
        return pointer
      }
      return native
    }) as ModuleFactory,
    call(name: string, ...args: number[]) {
      return Number(native[`_${name}`]!(...args))
    },
    stats() {
      return {
        heap: Number(native._krkr_native_heap_usage!()),
        strings: Number(native._krkr_native_string_cells!()),
        blocks: Number(native._krkr_vm_script_blocks!(pointer)),
        contexts: Number(native._krkr_vm_script_contexts!(pointer)),
      }
    },
  }
}
export const lifetimeSource = `
class LifetimeBase { function base() { return 20; } }
class LifetimeBox extends LifetimeBase {
  var stored=22;
  property value { getter(){return stored;} setter(v){stored=v;} }
  function answer(){return base()+value;}
}
var lifetimeBox=new LifetimeBox();
if(lifetimeBox.answer()!=42)throw "lifetime-inheritance";
lifetimeBox.value=21;
if(lifetimeBox.answer()!=41)throw "lifetime-accessor";
var lifetimeOctet=<%00 ff 2a%>;
var lifetimeLong="long bytecode string with native allocation beyond short storage";
`
export const lifetimeCleanup =
  'invalidate lifetimeBox;delete lifetimeBox;delete LifetimeBox;delete LifetimeBase;delete lifetimeOctet;delete lifetimeLong;'

/** Empty property names pass the container bounds checks but fail native PropSet. */
export function lateLinkFailure(original: Uint8Array) {
  const bytes = original.slice(),
    layout = bytecodeOffsets(bytes),
    data = new DataView(bytes.buffer)
  const object = layout.objects.find((object) => data.getUint32(object.propertiesCount, true) > 0)
  checkLifetime(object, 'Fixture has no registered class properties')
  const index = data.getInt32(object!.properties, true)
  let offset = layout.pools[5]!.count + 4
  for (let i = 0; i < index; i++) offset += 4 + Math.ceil(data.getUint32(offset, true) / 2) * 4
  checkLifetime(data.getUint32(offset, true) > 0, 'Fixture property name is already empty')
  data.setUint16(offset + 4, 0, true)
  return bytes
}
/** Repeated references to one long name amplify a small file into large contexts. */
export function expandedBytecodeNames(original: Uint8Array) {
  const layout = bytecodeOffsets(original),
    originalView = new DataView(original.buffer, original.byteOffset, original.byteLength)
  const stringCount = layout.pools[5]!.count,
    stringEnd = layout.pools[6]!.count
  const stringIndex = originalView.getUint32(stringCount, true),
    units = 512 * 1024,
    count = 256
  const extra = new Uint8Array(4 + units * 2),
    extraView = new DataView(extra.buffer)
  extraView.setUint32(0, units, true)
  for (let i = 0; i < units; i++) extraView.setUint16(4 + i * 2, 0x61, true)
  const root = layout.objects[0]!,
    object = original.slice(
      root.start - 8,
      root.length + 4 + originalView.getUint32(root.length, true),
    )
  const start = layout.objectsStart + extra.length,
    bytes = new Uint8Array(start + 16 + object.length * count),
    view = new DataView(bytes.buffer)
  bytes.set(original.subarray(0, stringEnd))
  bytes.set(extra, stringEnd)
  bytes.set(original.subarray(stringEnd, layout.objectsStart + 16), stringEnd + extra.length)
  view.setUint32(8, bytes.length, true)
  view.setUint32(16, originalView.getUint32(16, true) + extra.length, true)
  view.setUint32(stringCount, stringIndex + 1, true)
  view.setUint32(start + 4, 16 + object.length * count, true)
  view.setUint32(start + 8, 0, true)
  view.setUint32(start + 12, count, true)
  for (let i = 0; i < count; i++) {
    const at = start + 16 + i * object.length
    bytes.set(object, at)
    view.setInt32(at + 8, i ? 0 : -1, true)
    view.setInt32(at + 12, stringIndex, true)
    view.setInt32(at + 16, i ? 1 : 0, true)
  }
  return bytes
}

export async function exerciseBytecodeLifetime(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
) {
  const native = observeNative(factory)
  const vm = await TjsWasmRuntime.create(
    native.factory,
    () => {
      throw new Error('Unexpected host I/O')
    },
    { wasmBinary, variant },
  )
  try {
    await vm.execute(lifetimeSource)
    await vm.execute(lifetimeCleanup)
    checkLifetime(
      native.stats().contexts === 0 && native.stats().blocks === 0,
      'Explicit source instance cleanup retained contexts',
    )
    const bytes = await vm.compile(lifetimeSource, 'lifetime.tjs'),
      invalid = lateLinkFailure(bytes)
    const cycle = bytes.slice(),
      layout = bytecodeOffsets(cycle),
      view = new DataView(cycle.buffer)
    const top = view.getInt32(layout.objectsStart + 8, true),
      root = layout.objects[top]!
    let reference = -1
    for (let i = 0; i < view.getUint32(root.dataCount, true); i++)
      if ([2, 10].includes(view.getInt16(root.data + i * 4, true))) {
        reference = root.data + i * 4 + 2
        break
      }
    checkLifetime(reference >= 0, 'Fixture has no ownership edge')
    view.setInt16(reference, top, true)
    const orphan = cycle.slice()
    new DataView(orphan.buffer).setInt16(reference - 2, 0, true)
    new DataView(orphan.buffer).setInt16(reference, 0, true)
    async function load() {
      await vm.execute(bytes)
      await vm.execute(lifetimeCleanup)
    }
    async function reject(value: Uint8Array) {
      let error: unknown
      try {
        await vm.execute(value)
      } catch (failure) {
        error = failure
      }
      checkLifetime(
        error instanceof Error && error.name === 'ScriptError',
        `Missing recoverable error: ${String(error)}`,
      )
    }
    await load()
    for (const value of [invalid, cycle, orphan]) await reject(value)
    await vm.execute('6*7', '', true)
    const before = native.stats()
    checkLifetime(
      before.blocks === 0 && before.contexts === 0,
      `Warmup retained bytecode: ${JSON.stringify(before)}`,
    )
    for (let i = 0; i < 12; i++) {
      await load()
      for (const value of [invalid, cycle, orphan]) await reject(value)
      checkLifetime((await vm.execute('6*7', '', true)) === 42n, 'Failure poisoned the VM')
      const after = native.stats()
      checkLifetime(
        after.blocks === before.blocks && after.contexts === before.contexts,
        `Unreleased contexts: ${JSON.stringify(after)}`,
      )
      checkLifetime(
        after.strings === before.strings && after.heap === before.heap,
        `Native allocation growth: ${JSON.stringify({ before, after, i })}`,
      )
    }
    return { loads: 13, rejected: 39, before, after: native.stats(), handles: vm.inspect().handles }
  } finally {
    vm.dispose()
  }
}

export const bytecodePhases = [6, 7, 8] as const
export async function makeBytecodeWork(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
) {
  const vm = await TjsWasmRuntime.create(
    factory,
    () => {
      throw new Error('Unexpected host I/O')
    },
    { wasmBinary, variant },
  )
  try {
    return {
      pools: await vm.compile('"' + '字'.repeat(4 * 1024 * 1024) + '"', 'pool-work.tjs', true),
      contexts: await vm.compile(
        'class LifetimeMany {' +
          Array.from({ length: 24000 }, (_, i) => `function f${i}(){return 42;}`).join('') +
          '}',
        'context-work.tjs',
      ),
    }
  } finally {
    vm.dispose()
  }
}
export async function exerciseBytecodeControl(
  factory: ModuleFactory,
  wasmBinary: Uint8Array,
  variant: WasmVariant,
  work: Awaited<ReturnType<typeof makeBytecodeWork>>,
  phase: (typeof bytecodePhases)[number],
  cancel: boolean,
) {
  const control = new ExecutionControl(),
    native = observeNative(factory),
    bytes = phase === 6 ? work.pools : work.contexts
  let reached!: () => void,
    armed = false,
    yields = 0,
    settled = false,
    error: unknown,
    observed: ReturnType<typeof native.stats> | undefined
  const started = new Promise<void>((resolve) => (reached = resolve))
  let before: ReturnType<typeof native.stats>
  const wrapped: ModuleFactory = (options) =>
    native.factory({
      ...options,
      onYield: async (current) => {
        if (armed && current === phase && !observed) {
          const stats = native.stats()
          // Observe actual partial materialization, rather than just phase entry.
          if (
            phase === 6
              ? stats.heap > before.heap + bytes.length + 1024 * 1024
              : stats.contexts > before.contexts
          ) {
            observed = stats
            yields++
            control.pause()
            reached()
          }
        }
        await options.onYield(current)
      },
    })
  const vm = await TjsWasmRuntime.create(
    wrapped,
    () => {
      throw new Error('Unexpected host I/O')
    },
    { wasmBinary, variant, control },
  )
  let pending: Promise<void> | undefined
  try {
    await vm.execute('42', '', true)
    before = native.stats()
    armed = true
    pending = vm.execute(bytes).then(
      () => {
        settled = true
      },
      (failure: unknown) => {
        settled = true
        error = failure
      },
    )
    await Promise.race([
      started,
      pending.then(() => {
        throw new Error(`No partial bytecode phase ${phase} checkpoint: ${String(error)}`)
      }),
    ])
    await new Promise<void>((resolve) => setTimeout(resolve, 25))
    checkLifetime(!settled && yields === 1, 'Bytecode advanced while paused')
    if (cancel) control.cancel()
    else control.resume()
    await pending
    if (cancel)
      checkLifetime(
        error instanceof Error && error.name === 'AbortError',
        `Cancellation failed: ${String(error)}`,
      )
    else {
      checkLifetime(!error, `Bytecode resume failed: ${String(error)}`)
      if (phase !== 6) {
        await vm.execute('var lifetimeMany=new LifetimeMany();')
        checkLifetime(
          (await vm.execute('lifetimeMany.f23999()', '', true)) === 42n,
          'Linked function changed',
        )
        await vm.execute('invalidate lifetimeMany;delete lifetimeMany;delete LifetimeMany;')
      }
    }
    const after = native.stats()
    checkLifetime(
      after.blocks === before.blocks && after.contexts === before.contexts,
      `Bytecode rollback retained contexts: ${JSON.stringify({ before, after })}`,
    )
    checkLifetime(vm.inspect().handles === 0, 'Bytecode control leaked host handles')
    return {
      phase,
      cancel,
      yields,
      heldMs: 25,
      before,
      observed,
      after,
      error: error instanceof Error ? error.name : null,
    }
  } finally {
    control.cancel()
    await pending
    vm.dispose()
  }
}
