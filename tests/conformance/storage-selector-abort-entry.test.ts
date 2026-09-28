import nodeTest from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type {
  ModuleFactory,
  ModuleOptions,
  NativeModule,
  WasmManifest,
} from '../../src/backends/script/tjs-wasm/module.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { ModalLoop } from '../../src/engine/scheduler/modal-loop.ts'
import { SystemDialogs, type SystemDialogSnapshot } from '../../src/engine/scene/system-dialogs.ts'
import {
  isScriptObject,
  type HostHandler,
  type ScriptObject,
} from '../../src/engine/script/runtime.ts'

const test = (name: string, run: () => Promise<void>) => nodeTest(name, { timeout: 60000 }, run)
const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
const bytes = Uint8Array.of(83, 69, 76, 69, 67, 84, 0, 255)
const abortOperation = 'Storages.selectFileAbort'

/** Uses the real VM. The eight-byte queueWrite injection exercises the runtime
 * queue seam, not native stream finalization or an allocation-failure path. */
async function boundary(handler: HostHandler, control = new ExecutionControl()) {
  let module!: NativeModule
  let callbacks!: ModuleOptions
  let loop!: ModalLoop
  let dialogs!: SystemDialogs
  const snapshots: SystemDialogSnapshot[] = []
  let beforeAbort: (() => void) | undefined
  const intercepted: ModuleFactory = async (options) => {
    callbacks = options
    module = await factory({
      ...options,
      hostCall: (...args) => {
        const [, name, length] = args
        const operation = String.fromCharCode(
          ...module.HEAPU16.subarray(name >>> 1, (name >>> 1) + length),
        )
        if (operation === abortOperation) beforeAbort?.()
        return options.hostCall(...args)
      },
    })
    return module
  }
  const vm = await TjsWasmRuntime.create(
    intercepted,
    (operation, args, context) => {
      if (operation === 'Factory')
        return {
          kind: 'value',
          value: {
            type: 'class',
            namespace: 'Storages',
            className: 'Storages',
            id: 0,
            properties: [],
          },
        }
      if (operation === 'Modal.bind') return loop.host(operation, args)
      return handler(operation, args, context)
    },
    { wasmBinary, control },
  )
  loop = new ModalLoop(vm, control, {
    hasWork: () => false,
    dispatch: () => {
      throw new Error('No event dispatch is expected')
    },
    beforeWait: (token) => dialogs.beforeWait(token),
    changed: () => dialogs.present(),
  })
  dialogs = new SystemDialogs(loop, {
    changed: (snapshot) => {
      snapshots.push(snapshot)
    },
  })
  return {
    vm,
    control,
    loop,
    dialogs,
    snapshots,
    open(identity: bigint) {
      return dialogs.showStorageSelector(
        Number(identity),
        'Select file',
        {
          save: false,
          name: '',
          initialDirectory: 'game://./',
          defaultExtension: '',
          filters: [],
          filterIndex: 0,
          entries: [],
          directories: ['game://./'],
        },
        (value) => value,
      )
    },
    assertRevoked() {
      assert.deepEqual(
        snapshots.map((snapshot) => snapshot.request?.kind ?? null),
        ['storage-selector', null],
      )
      assert.deepEqual(snapshots.at(-1)?.pendingIds, [])
      assert.equal(dialogs.count, 0)
      assert.equal(loop.depth, 0)
      assert.equal(loop.pendingWaits, 0)
      assert.equal(loop.hasTjsContinuation, false)
    },
    beforeAbort(callback: () => void) {
      beforeAbort = callback
    },
    injectQueuedWrite() {
      const name = 'selector-abort.bin'
      const mode = 'w'
      const dataOffset = (name.length + mode.length) * 2
      const pointer = Number(module._malloc!(dataOffset + bytes.length))
      assert(pointer)
      try {
        module.HEAPU16.set(
          [...name, ...mode].map((character) => character.charCodeAt(0)),
          pointer >>> 1,
        )
        module.HEAPU8.set(bytes, pointer + dataOffset)
        callbacks.queueWrite(
          pointer,
          name.length,
          pointer + name.length * 2,
          mode.length,
          pointer + dataOffset,
          bytes.length,
          0,
        )
        // Runtime must own its copy after the native buffer's lifetime ends.
        module.HEAPU8.fill(0, pointer, pointer + dataOffset + bytes.length)
      } finally {
        module._free!(pointer)
      }
    },
  }
}

async function program(vm: TjsWasmRuntime, binary: boolean, source: string) {
  const text = `var Storages=__host("Factory");
function abortEntryPump(){throw new Exception("selector-continuation-primary");}
__host("Modal.bind",abortEntryPump);
${source}`
  return binary ? vm.compile(text, 'storage-selector-abort-entry.tjs') : text
}

for (const binary of [false, true]) {
  const mode = binary ? 'bytecode' : 'source'

  test(`selector abort revokes before a queued write and preserves its real boundary failure (${mode})`, async () => {
    const events: string[] = []
    const writes: unknown[][] = []
    let failWrite = true
    const fixture = await boundary((operation, args) => {
      if (operation === 'Storages.selectFile') {
        assert(typeof args[0] === 'bigint')
        events.push(`select:${args[0]}`)
        fixture.open(args[0])
        fixture.injectQueuedWrite()
        throw new Error('selector-dispatch-primary')
      }
      if (operation === abortOperation) {
        events.push(`abort:${args[0]}`)
        fixture.dialogs.abortStorageSelector(Number(args[0]))
        return { kind: 'value', value: undefined }
      }
      if (operation === 'Storage.writeBinary') {
        events.push(failWrite ? 'write-failed' : 'write-saved')
        writes.push([...args])
        if (failWrite) throw new Error('actual-write-handler-failed')
        return { kind: 'value', value: undefined }
      }
      assert.equal(operation, 'Unrelated')
      events.push('unrelated')
      return { kind: 'value', value: 42n }
    })
    const { vm } = fixture
    try {
      const source = await program(
        vm,
        binary,
        `var primary="",after=0;
try{Storages.selectFile(%[]);}catch(error){primary=error.message;}
after=1;`,
      )
      await assert.rejects(vm.execute(source), /actual-write-handler-failed/)
      fixture.assertRevoked()
      assert.deepEqual(events, ['select:1', 'abort:1', 'write-failed'])
      assert.deepEqual(writes, [['selector-abort.bin', 'w', bytes]])
      failWrite = false
      await vm.flush()
      assert.deepEqual(writes, [
        ['selector-abort.bin', 'w', bytes],
        ['selector-abort.bin', 'w', bytes],
      ])
      assert.equal(
        await vm.execute('[primary,after].join("|")', '', true),
        'selector-dispatch-primary|1',
      )
      assert.equal(await vm.execute('__host("Unrelated")', '', true), 42n)
      assert.deepEqual(events, ['select:1', 'abort:1', 'write-failed', 'write-saved', 'unrelated'])
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      fixture.loop.dispose()
      vm.dispose()
    }
  })

  test(`selector abort revokes before a real observer failure reaches the same execution boundary (${mode})`, async () => {
    const events: string[] = []
    let owner: ScriptObject | undefined
    const fixture = await boundary((operation, args, context) => {
      if (operation === 'Storages.selectFile') {
        assert(typeof args[0] === 'bigint')
        events.push(`select:${args[0]}`)
        const reply = fixture.open(args[0])
        assert(owner)
        context.release(owner)
        owner = undefined
        return reply
      }
      if (operation === abortOperation) {
        events.push(`abort:${args[0]}`)
        fixture.dialogs.abortStorageSelector(Number(args[0]))
        return { kind: 'value', value: undefined }
      }
      assert.equal(operation, 'Unrelated')
      events.push('unrelated')
      return { kind: 'value', value: 42n }
    })
    const { vm } = fixture
    try {
      // Acquire outside the tested invocation so no script argument register
      // can retain the owner beyond releasing the final host lease below.
      await vm.execute('class AbortObservedOwner {}')
      const value = await vm.execute('new AbortObservedOwner()', '', true)
      assert(isScriptObject(value))
      owner = vm.retain(value)
      vm.observe(value, () => {
        events.push('owner-observer-failed')
        throw new Error('actual-owner-observer-failed')
      })
      vm.release(value)
      const source = await program(
        vm,
        binary,
        `var primary="",after=0;
try{Storages.selectFile(%[]);}catch(error){primary=error.message;}
after=1;`,
      )
      await assert.rejects(vm.execute(source), /actual-owner-observer-failed/)
      fixture.assertRevoked()
      assert.deepEqual(events, ['select:1', 'owner-observer-failed', 'abort:1'])
      assert.equal(vm.inspect().weakOwners, 0)
      assert.equal(
        await vm.execute('[primary,after].join("|")', '', true),
        'selector-continuation-primary|1',
      )
      assert.equal(await vm.execute('__host("Unrelated")', '', true), 42n)
      assert.deepEqual(events, ['select:1', 'owner-observer-failed', 'abort:1', 'unrelated'])
      fixture.loop.dispose()
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      if (owner) vm.release(owner)
      fixture.loop.dispose()
      vm.dispose()
    }
  })

  test(`selector abort validates primitive identity without reading object members (${mode})`, async () => {
    const calls: string[] = []
    const fixture = await boundary((operation) => {
      calls.push(operation)
      return { kind: 'value', value: undefined }
    })
    const { vm } = fixture
    try {
      const source = await program(
        vm,
        binary,
        `var errors=[],reads=0;
class Identity {
  function toString(){global.reads++;return "1";}
  function valueOf(){global.reads++;return 1;}
}
function attempt(value){try{__host("Storages.selectFileAbort",value);}catch(error){errors.add(error.message);}}
attempt(void);attempt(null);attempt("1");attempt(1.5);attempt(0);attempt(-1);
attempt(9007199254740992);attempt(new Identity());
try{__host("Storages.selectFileAbort");}catch(error){errors.add(error.message);}
try{__host("Storages.selectFileAbort",1,2);}catch(error){errors.add(error.message);}
`,
      )
      await vm.execute(source)
      assert.deepEqual(calls, [])
      assert.equal(await vm.execute('errors.count+"|"+reads', '', true), '10|0')
      assert.equal(
        await vm.execute('errors.join("|")', '', true),
        Array(10).fill('Invalid Storages.selectFileAbort identity').join('|'),
      )
      fixture.loop.dispose()
      await vm.collect()
      assert.equal(vm.inspect().handles, 0)
      assert.equal(vm.inspect().pendingHandles, 0)
    } finally {
      fixture.loop.dispose()
      vm.dispose()
    }
  })

  for (const cancel of [false, true]) {
    test(`selector abort revokes while paused and ${cancel ? 'Stop cancels' : 'resume releases'} the native return (${mode})`, async () => {
      const control = new ExecutionControl()
      const events: string[] = []
      let reportAborted!: () => void
      const aborted = new Promise<void>((resolve) => {
        reportAborted = resolve
      })
      const fixture = await boundary((operation, args) => {
        if (operation === 'Storages.selectFile') {
          assert(typeof args[0] === 'bigint')
          events.push(`select:${args[0]}`)
          fixture.open(args[0])
          throw new Error('selector-paused-primary')
        }
        if (operation === abortOperation) {
          events.push(`abort:${args[0]}`)
          fixture.dialogs.abortStorageSelector(Number(args[0]))
          reportAborted()
          return { kind: 'value', value: undefined }
        }
        events.push(operation)
        return { kind: 'value', value: undefined }
      }, control)
      const { vm } = fixture
      let running: Promise<unknown> | undefined
      try {
        const source = await program(
          vm,
          binary,
          `var primary="",after=0;
try{Storages.selectFile(%[]);}catch(error){primary=error.message;__host("Caught");}
after=1;__host("After");`,
        )
        // Deliberate scheduler seam: pause exactly before the real host entry.
        // No synthetic native return or second VM execution is used.
        fixture.beforeAbort(() => control.pause())
        let settled = false
        running = vm.execute(source)
        const observed = running.then(
          () => {
            settled = true
            return undefined
          },
          (error: unknown) => {
            settled = true
            return error
          },
        )
        let timeout!: ReturnType<typeof setTimeout>
        try {
          await Promise.race([
            aborted,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error('Paused selector was not revoked')),
                20000,
              )
            }),
          ])
        } finally {
          clearTimeout(timeout)
        }
        await new Promise<void>((resolve) => setImmediate(resolve))
        assert(control.paused)
        fixture.assertRevoked()
        assert.equal(settled, false)
        assert.deepEqual(events, ['select:1', 'abort:1'])
        if (cancel) control.cancel()
        else control.resume()
        const error = await observed
        if (cancel) {
          assert(error instanceof Error)
          assert.equal(error.name, 'AbortError')
          assert.deepEqual(events, ['select:1', 'abort:1'])
        } else {
          assert.equal(error, undefined)
          assert.deepEqual(events, ['select:1', 'abort:1', 'Caught', 'After'])
          assert.equal(
            await vm.execute('[primary,after].join("|")', '', true),
            'selector-paused-primary|1',
          )
        }
        assert.equal(vm.inspect().pendingHandles, 0)
      } finally {
        control.cancel()
        await running?.catch(() => {})
        fixture.loop.dispose()
        vm.dispose()
      }
    })
  }
}
