import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, NativeModule, WasmManifest, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { isScriptObject, ScriptError, type HostHandler } from '../../src/engine/script/runtime.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import { TvpError, type TvpMessage } from '../../src/engine/system/tvp-error.ts'
import { registeredTvpMessageIds, constantTvpMessageIds, type TvpMessageId } from '../../src/engine/system/tvp-message-ids.ts'

const variant = (process.env.KRKR_MESSAGES_VARIANT ?? 'asyncify') as WasmVariant
assert(['asyncify', 'jspi'].includes(variant))
const directory = resolve('.generated/wasm'),
  manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as WasmManifest,
  assets = manifest.variants[variant]!,
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
  wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
function gate() {
  let release!: () => void
  const promise = new Promise<void>((yes) => { release = yes })
  return { promise, release }
}
async function fixture(binary: boolean) {
  let module!: NativeModule, handler: HostHandler = (operation) => { throw new Error('Unexpected host: ' + operation) }
  const control = new ExecutionControl(),
    vm = await TjsWasmRuntime.create(async (options) => {
      module = await factory(options); return module
    }, (operation, args, context) => operation === 'Messages.Factory'
      ? { kind: 'value', value: { type: 'class', namespace: 'System', className: 'System', id: 0, properties: [] } }
      : handler(operation, args, context), { wasmBinary, variant, control })
  const run = async (source: string, expression = false) =>
    vm.execute(binary ? await vm.compile(source, 'tvp-messages.tjs', expression) : source, 'tvp-messages.tjs', expression)
  try { await run('var System=__host("Messages.Factory");') }
  catch (error) {
    try { vm.dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Message setup and cleanup failed') }
    throw error
  }
  return { vm, module, control, run, setHandler(value: HostHandler) { handler = value },
    async assign(id: TvpMessageId, value: string) {
      assert.equal(await run(`System.assignMessage(${JSON.stringify(id)},${JSON.stringify(value)})`, true), 1n)
    },
    close() {
      control.cancel(); vm.dispose()
      assert.equal(Number(module._krkr_native_lifetime_stat!(4)), 0, 'No live dispatch objects remain')
    },
  }
}
async function using(binary: boolean, body: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture(binary), errors: unknown[] = []
  try { await body(f) } catch (error) { errors.push(error) }
  try { f.close() } catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'TVP messages or cleanup failed')
}

test(`${variant}: native message capability and both private exports are required before VM creation`, { timeout: 60000 }, async () => {
  assert.equal(manifest.capabilities?.nativeMessages, 1)
  for (const version of [undefined, 0, 2, 'formatter'] as const) {
    let created = false
    const altered: ModuleFactory = async (options) => {
      const module = await factory(options)
      if (version === undefined) delete module._krkr_native_messages_version
      else if (version === 'formatter') delete module._krkr_format_tvp_message
      else module._krkr_native_messages_version = () => version
      module._krkr_create = () => { created = true; return 0 }
      return module
    }
    await assert.rejects(TjsWasmRuntime.create(altered, () => { throw new Error('Unexpected host') }, { wasmBinary, variant }),
      /missing native TVP message support/)
    assert.equal(created, false)
  }
})

for (const binary of [false, true]) {
  const mode = `${variant}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: all fixed TVP holders use the real assignMessage mapper and constants remain unassignable`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      assert.equal(registeredTvpMessageIds.length, 138); assert.equal(constantTvpMessageIds.length, 6)
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), '不正なパラメータです')
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPCannotOpenStorage', args: ['file'] }), 'ストレージ file を開くことができません')
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPStorageInArchiveNotFound', args: ['member', 'archive'] }),
        'ストレージ member がアーカイブ archive の中に見つかりません')
      const constants = constantTvpMessageIds.map((id) => f.vm.formatTvpMessage({ id, args: [] }))
      await f.run(`var assigned=0,rejected=0;
${registeredTvpMessageIds.map((id) => `assigned+=System.assignMessage("${id}","assigned:${id}");`).join('\n')}
${constantTvpMessageIds.map((id) => `rejected+=System.assignMessage("${id}","must-not-replace");`).join('\n')}
rejected+=System.assignMessage("TVPNotARealMessage","must-not-create");`)
      assert.equal(await f.run('assigned', true), 138n)
      assert.equal(await f.run('rejected', true), 0n)
      for (const id of registeredTvpMessageIds)
        assert.equal(f.vm.formatTvpMessage({ id, args: [] }), 'assigned:' + id)
      constantTvpMessageIds.forEach((id, i) => assert.equal(f.vm.formatTvpMessage({ id, args: [] }), constants[i]))
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPExecutionFail', args: ['tool'] }), 'tool を実行できません')
    })
  })

  test(`${mode}: native formatting has exact zero/one/two-argument percent semantics and validates its private boundary`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const template = '%%|%1|%2|%1|%3|%10|end%', argument = 'A%2%%'
      await f.assign('TVPInvalidParam', template)
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), template)
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [argument] }), '%|A%2%%|%2|A%2%%|%3|A%2%%0|end%')
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [argument, '日本語😀'] }),
        '%|A%2%%|日本語😀|A%2%%|%3|A%2%%0|end%')
      await f.assign('TVPInvalidParam', 'left:%1:right')
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: ['A\0B'] }), 'left:A:right',
        'The existing JS-to-ttstr boundary truncates the argument at NUL before substitution')
      for (const message of [
        { id: 'TVPNotARealMessage', args: [] }, { id: 'TVPInvalidParam\0tail', args: [] },
        { id: 'TVPInvalidParam', args: ['1', '2', '3'] }, { id: 'TVPInvalidParam', args: [1] },
      ]) assert.throws(() => f.vm.formatTvpMessage(message as unknown as TvpMessage), /Invalid typed|Unknown TVP message/)
      await f.assign('TVPInvalidParam', '%1%1')
      assert.throws(() => f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: ['x'.repeat(5 * 1024 * 1024)] }), /temporary|budget/i)
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: ['ok'] }), 'okok', 'Rejected formatting refunds its temporary budget')
      assert.equal(f.vm.inspect().handles, 0)
    })
  })

  test(`${mode}: thrown typed host errors resolve the latest holder through nested continuations and preserve script metadata`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const error = new TvpError('TVPCannotOpenStorage', ['A%2'], 'old Web diagnostic')
      f.setHandler((operation, args) => {
        if (operation === 'Messages.invoke') {
          assert(isScriptObject(args[0])); return { kind: 'invoke', callback: args[0], args: [] }
        }
        if (operation === 'Messages.plain') throw new Error('plain-message-preserved')
        throw error
      })
      await f.assign('TVPCannotOpenStorage', 'old:%1')
      await f.run('function nestedFailure(){System.assignMessage("TVPCannotOpenStorage","new:%1:%%");__host("Messages.fail");}')
      assert.equal(await f.run('(function(){try{__host("Messages.invoke",nestedFailure);}catch(e){return e.message;}})()', true), 'new:A%2:%')
      await assert.rejects(f.run('nestedFailure();'), (failure: unknown) => {
        assert(failure instanceof ScriptError)
        assert.equal(failure.message, 'new:A%2:%')
        assert.match(failure.source, /tvp-messages/); assert(failure.line > 0); assert.match(failure.trace, /nestedFailure|tvp-messages/)
        return true
      })
      assert.equal(await f.run('(function(){try{__host("Messages.plain");}catch(e){return e.message;}})()', true), 'plain-message-preserved')
      await f.vm.collect(); assert.equal(f.vm.inspect().handles, 0)
    })
  })

  test(`${mode}: native text/binary reads, writer preflights and next-host write settlement propagate typed errors`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const calls: string[] = []
      let queued = false, writes = 0
      f.setHandler((operation, args) => {
        calls.push(operation)
        if (queued && ['Storage.validateTextWrite', 'Storage.validateWrite'].includes(operation)) return { kind: 'value', value: args[0] }
        if (queued && ['Storage.writeText', 'Storage.writeBinary'].includes(operation)) {
          assert.equal(args[2] instanceof Uint8Array, operation === 'Storage.writeBinary')
          if (++writes > 1) return { kind: 'value', value: undefined }
        }
        throw new TvpError('TVPCannotOpenStorage', [String(args[0])], 'stream Web diagnostic')
      })
      await f.assign('TVPCannotOpenStorage', 'stream:%1')
      for (const [source, operation] of [
        ['[].load("missing");', 'Storage.readText'], ['[].loadStruct("missing");', 'Storage.readBinary'],
        ['["x"].save("missing");', 'Storage.validateTextWrite'], ['["x"].saveStruct("missing","b");', 'Storage.validateWrite'],
      ]) {
        assert.equal(await f.run(`(function(){try{${source}}catch(e){return e.message;}})()`, true), 'stream:missing')
        assert.equal(calls.at(-1), operation)
      }
      assert.equal(calls.length, 4, 'Rejected writer preflights never queue data')
      queued = true
      for (const write of ['["x"].save("queued");', '["x"].saveStruct("queued","b");']) {
        writes = 0
        await f.run(`var queuedError="";${write}System.assignMessage("TVPCannotOpenStorage","late:%1");try{__host("Messages.next");}catch(e){queuedError=e.message;}`)
        assert.equal(await f.run('queuedError', true), 'late:queued')
        assert.equal(writes, 2, 'The failed entry flush preserves the queued write for the successful tail retry')
      }
      assert(!calls.includes('Messages.next'), 'Entry flush failure precedes the requested handler')
      assert.equal(await f.run('System.assignMessage("TJSReadError","core-short-read")', true), 1n)
      await f.assign('TVPReadError', 'distinct-tvp-read')
      f.setHandler((operation) => {
        assert.equal(operation, 'Storage.readBinary')
        // Real KBAD header followed by an int64 with only one payload byte.
        return { kind: 'value', value: new Uint8Array([75, 66, 65, 68, 49, 48, 48, 0, 0xd3, 1]) }
      })
      for (const call of ['[].loadStruct("truncated")', 'Dictionary.loadStruct("truncated")'])
        assert.equal(await f.run(`(function(){try{${call};}catch(e){return e.message;}})()`, true), 'core-short-read')
      assert.equal(f.vm.formatTvpMessage({ id: 'TVPReadError', args: [] }), 'distinct-tvp-read')
    })
  })

  test(`${mode}: final write failures format without reentering TJS and retain typed cause beside a script primary`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const writeError = new TvpError('TVPCannotOpenStorageForWrite', ['tail'], 'tail Web diagnostic')
      let rejectWrite = true, failingWrite = writeError
      f.setHandler((operation, args) => {
        if (operation === 'Storage.validateTextWrite') return { kind: 'value', value: args[0] }
        assert.equal(operation, 'Storage.writeText')
        if (rejectWrite) throw failingWrite
        return { kind: 'value', value: undefined }
      })
      await f.assign('TVPCannotOpenStorageForWrite', 'tail:%1')
      await assert.rejects(f.run('["queued"].save("tail");'), (failure: unknown) => {
        assert(failure instanceof ScriptError); assert.equal(failure.message, 'tail:tail'); assert.equal(failure.cause, writeError); return true
      })
      rejectWrite = false; await f.vm.flush(); rejectWrite = true
      await assert.rejects(f.run('["queued"].save("tail");throw new Exception("script-primary");'), (failure: unknown) => {
        assert(failure instanceof AggregateError); assert.equal(failure.errors.length, 2)
        const [primary, write] = failure.errors
        assert(primary instanceof ScriptError); assert.equal(primary.message, 'script-primary')
        assert(write instanceof ScriptError); assert.equal(write.message, 'tail:tail'); assert.equal(write.cause, writeError)
        assert.equal(failure.cause, primary); return true
      })
      rejectWrite = false; await f.vm.flush(); await f.vm.collect()
      assert.equal(f.vm.inspect().handles, 0); assert.equal(f.vm.inspect().pendingHandles, 0)
      await f.assign('TVPCannotOpenStorageForWrite', '%1%1')
      failingWrite = new TvpError('TVPCannotOpenStorageForWrite', ['x'.repeat(5 * 1024 * 1024)], 'original write diagnostic')
      rejectWrite = true
      await assert.rejects(f.run('["queued"].save("tail");'), (failure: unknown) => {
        assert(failure instanceof AggregateError)
        assert.equal(failure.cause, failingWrite); assert.equal(failure.errors[0], failingWrite)
        assert(failure.errors[1] instanceof ScriptError); assert.match(failure.errors[1].message, /temporary|budget/i)
        return true
      })
      rejectWrite = false; await f.vm.flush()
    })
  })

  test(`${mode}: typed errors from collect finalizers and console callbacks retain cleanup and current messages`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      f.setHandler(() => { throw new TvpError('TVPInvalidParam', [], 'finalizer diagnostic') })
      await f.assign('TVPInvalidParam', 'finalizer-current')
      await f.run('class FinalMessage {function finalize(){__host("Messages.finalizer");}}')
      const owner = await f.run('new FinalMessage()', true)
      assert(isScriptObject(owner)); f.vm.release(owner)
      await assert.rejects(f.vm.collect(), /finalizer-current/)
      assert.equal(f.vm.inspect().pendingHandles, 0); assert.equal(f.vm.inspect().handles, 0)
      let consoleCalls = 0
      f.vm.setConsoleOutput(() => { consoleCalls++; throw new TvpError('TVPInvalidParam', [], 'console diagnostic') })
      await f.assign('TVPInvalidParam', 'console-current')
      assert.equal(await f.run('(function(){try{__host("Runtime.console","text");}catch(e){return e.message;}})()', true), 'console-current')
      assert.equal(consoleCalls, 1)
      // This reaches the real native HostConsole while reporting an unhandled
      // script exception. Its secondary typed failure must not replace primary.
      await assert.rejects(f.run('function primaryFailure(){return missingPrimaryMessage;}primaryFailure();'), /missingPrimaryMessage/)
      assert(consoleCalls > 1)
      f.vm.setConsoleOutput(null)
      assert.equal(await f.run('21*2', true), 42n)
      await f.assign('TVPInvalidParam', 'observer-current')
      await f.run('class ObservedMessage {}')
      const observed = await f.run('new ObservedMessage()', true),
        observerError = new TvpError('TVPInvalidParam', [], 'observer diagnostic')
      assert(isScriptObject(observed))
      f.vm.observe(observed, () => { throw observerError }); f.vm.release(observed)
      await assert.rejects(f.vm.collect(), (failure: unknown) => {
        assert(failure instanceof ScriptError); assert.equal(failure.message, 'observer-current')
        assert.equal(failure.cause, observerError); return true
      })
      assert.equal(f.vm.inspect().weakOwners, 0)
      await f.run('var terminalMessageOwner=new ObservedMessage();')
      const terminal = await f.run('terminalMessageOwner', true)
      assert(isScriptObject(terminal))
      f.vm.observe(terminal, () => { throw observerError }); f.vm.release(terminal)
      await f.assign('TVPInvalidParam', 'terminal-current')
      assert.throws(() => f.vm.dispose(), (failure: unknown) => {
        assert(failure instanceof ScriptError); assert.equal(failure.message, 'terminal-current')
        assert.equal(failure.cause, observerError); return true
      })
    })
  })

  test(`${mode}: pure formatting preserves queued releases and cancellation wins over a paused typed failure`, { timeout: 60000 }, async () => {
    await using(binary, async (f) => {
      const entered = gate(), released = gate(), observations: number[] = []
      let seenCatch = false
      f.setHandler(async (operation, args, context) => {
        if (operation === 'Messages.pending') {
          assert(isScriptObject(args[0])); context.release(context.retain(args[0]))
          observations.push(f.vm.inspect().pendingHandles)
          assert.equal(context.formatTvpMessage?.({ id: 'TVPInvalidParam', args: [] }), 'pure-current')
          observations.push(f.vm.inspect().pendingHandles)
          return { kind: 'value', value: undefined }
        }
        if (operation === 'Messages.wait') {
          entered.release(); await released.promise
          throw new TvpError('TVPInvalidParam', [], 'paused diagnostic')
        }
        if (operation === 'Messages.caught') { seenCatch = true; return { kind: 'value', value: undefined } }
        throw new Error('Unexpected host: ' + operation)
      })
      await f.assign('TVPInvalidParam', 'pure-current')
      await f.run('__host("Messages.pending",%[value:1]);')
      assert(observations[0]! > 0); assert.equal(observations[1], observations[0])
      await f.vm.collect(); assert.equal(f.vm.inspect().pendingHandles, 0)
      const pending = f.run('try{__host("Messages.wait");}catch(e){__host("Messages.caught");}').then(
        () => undefined, (error: unknown) => error)
      try {
        await entered.promise; f.control.pause()
        assert.equal(f.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), 'pure-current')
        f.control.cancel(); released.release()
        const error = await pending
        assert(error instanceof Error); assert.match(error.message, /cancelled/i); assert.equal(seenCatch, false)
      } finally { f.control.cancel(); released.release(); await pending }
    })
  })

  test(`${mode}: simultaneous native message catalogs remain isolated across reassignment and VM retirement`, { timeout: 60000 }, async () => {
    const first = await fixture(binary), errors: unknown[] = []
    let second: Awaited<ReturnType<typeof fixture>> | undefined, firstClosed = false
    try {
      second = await fixture(binary)
      await first.assign('TVPInvalidParam', 'first-module')
      await second.assign('TVPInvalidParam', 'second-module')
      assert.equal(first.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), 'first-module')
      assert.equal(second.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), 'second-module')
      first.close(); firstClosed = true
      await second.assign('TVPInvalidParam', 'second-still-live')
      assert.equal(second.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), 'second-still-live')
      assert.throws(() => first.vm.formatTvpMessage({ id: 'TVPInvalidParam', args: [] }), /disposed/)
    } catch (error) { errors.push(error) }
    try { if (!firstClosed) first.close() } catch (error) { errors.push(error) }
    try { second?.close() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Message isolation or cleanup failed')
  })
}
