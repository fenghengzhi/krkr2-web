import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'

export async function exerciseRuntime(backend: 'asyncify' | 'jspi') {
  const manifest = await (await fetch('/wasm/manifest.json')).json(),
    assets = manifest.variants[backend],
    moduleUrl = '/wasm/' + assets.mjs.file,
    { default: factory } = await import(moduleUrl),
    wasmBinary = new Uint8Array(await (await fetch('/wasm/' + assets.wasm.file)).arrayBuffer()),
    delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    check = (value: unknown, message: string) => {
      if (!value) throw new Error(message)
    }
  const vm = await TjsWasmRuntime.create(factory, () => ({ kind: 'dump' }), {
    wasmBinary,
    variant: backend,
  })
  const warnings: string[] = []
  let compiledBytes = 0,
    dumpBytes = 0,
    primary = '',
    handles = 0,
    shutdownMessages = 0
  try {
    await vm.execute('var observed=0;')
    vm.setConsoleOutput(async (text) => {
      warnings.push(text)
      await delay(2)
      return {
        kind: 'script',
        source: 'observed+=1;',
        name: 'browser-console-callback.tjs',
      }
    })
    const bytes = await vm.compile('var compiled=0;if(compiled=9){}', 'browser-compile.tjs')
    compiledBytes = bytes.length
    await vm.execute(bytes, 'browser-compiled.tjs')
    check((await vm.execute('compiled+observed', '', true)) === 10n, 'Compiler callback ordering')
    check(
      warnings.length === 1 && warnings[0]!.includes('browser-compile.tjs'),
      'Missing native warning',
    )
    vm.setConsoleOutput((text) => {
      warnings.push(text)
      return { kind: 'value', value: undefined }
    })
    const dump = await vm.execute('__host("dump")', 'browser-dump.tjs', true)
    check(dump instanceof Uint8Array, 'Dump did not return bytes')
    const data = dump as Uint8Array
    dumpBytes = data.length
    check(data[0] === 255 && data[1] === 254, 'Dump BOM')
    check(new TextDecoder('utf-16le').decode(data).includes('TJS Context Dump'), 'Dump content')
    check(warnings.length === 1, 'Dump incorrectly called log observers')
    await vm.execute('var after=0;if(after=1){}', 'browser-after-dump.tjs')
    check(warnings.length === 2, 'Console not restored after dump')
    vm.setConsoleOutput(() => {
      throw new Error('secondary-observer')
    })
    try {
      await vm.execute(
        'function crash(){return browserPrimaryMissing;}crash();',
        'browser-primary.tjs',
      )
    } catch (error) {
      primary = String(error)
    }
    check(primary.includes('browserPrimaryMissing'), 'Primary native exception replaced')
    vm.setConsoleOutput(null)
    check(
      (await vm.execute('6*7', 'browser-recovery.tjs', true)) === 42n,
      'Runtime did not recover',
    )
    handles = vm.inspect().handles
    check(handles === 0, 'Leaked host handles')
    vm.setConsoleOutput(() => {
      shutdownMessages++
      return { kind: 'value', value: undefined }
    })
  } finally {
    vm.dispose()
  }
  check(shutdownMessages === 0, 'Console callback during disposal')
  const control = new ExecutionControl(),
    cancelledVm = await TjsWasmRuntime.create(
      factory,
      () => ({ kind: 'value', value: undefined }),
      { wasmBinary, variant: backend, control },
    )
  let entered!: () => void,
    release!: () => void,
    settled = false,
    cancelled = ''
  const started = new Promise<void>((r) => (entered = r)),
    gate = new Promise<void>((r) => (release = r))
  cancelledVm.setConsoleOutput(async () => {
    entered()
    await gate
    return { kind: 'value', value: undefined }
  })
  const pending = cancelledVm.compile('var x=0;if(x=1){}', 'browser-cancel-compile.tjs').then(
    () => {
      settled = true
    },
    (error) => {
      settled = true
      cancelled = String(error)
    },
  )
  let held = false
  try {
    await started
    control.pause()
    release()
    await delay(20)
    held = !settled
    check(held, 'Compilation resumed while paused')
    control.cancel()
    await pending
    check(cancelled.includes('Execution cancelled'), 'Compilation did not cancel')
    check(cancelledVm.inspect().handles === 0, 'Cancelled compile leaked handles')
  } finally {
    release()
    control.cancel()
    await pending
    cancelledVm.dispose()
  }
  return {
    compiledBytes,
    dumpBytes,
    warnings,
    primary,
    handles,
    shutdownMessages,
    held,
    cancelled,
  }
}
