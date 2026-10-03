import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { ScriptError } from '../../src/engine/script/runtime.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

// Real native Array.save queues the text write. No host call follows the save,
// so settlement exercises run's final flush, not hostCall's entry flush.
for (const binary of [false, true])
  for (const scriptFails of [false, true])
    for (const writeFails of [false, true])
      test(`runtime final write settlement: ${binary ? 'bytecode' : 'source'}, script=${scriptFails ? 'failure' : 'success'}, write=${writeFails ? 'failure' : 'success'}`, async () => {
        const writeFailure = new Error('final-write-failure'),
          writes: unknown[][] = []
        let rejectWrite = writeFails
        const vm = await TjsWasmRuntime.create(
          factory,
          (operation, args) => {
            if (operation === 'Storage.validateTextWrite')
              return { kind: 'value', value: undefined }
            assert.equal(operation, 'Storage.writeText')
            writes.push([...args])
            if (rejectWrite) throw writeFailure
            return { kind: 'value', value: undefined }
          },
          { wasmBinary },
        )
        try {
          const source = `var values=["pending-write"];
values.save("settlement.txt");
${scriptFails ? 'throw new Exception("script-primary");' : ''}`,
            name = 'write-settlement.tjs',
            input = binary ? await vm.compile(source, name) : source
          let failure: unknown
          try {
            await vm.execute(input, name)
          } catch (error) {
            failure = error
          }
          assert.equal(writes.length, 1)
          assert.equal(writes[0]![0], 'settlement.txt')
          assert.equal(writes[0]![2], 'pending-write\r\n')
          if (scriptFails) {
            const primary = writeFails ? (failure as AggregateError).cause : failure
            assert(primary instanceof ScriptError)
            assert.match(primary.message, /script-primary/)
            assert.match(primary.source, /write-settlement/)
            assert(primary.line > 0)
            if (writeFails) {
              assert(failure instanceof AggregateError)
              assert.equal(failure.message, primary.message)
              assert.deepEqual(failure.errors, [primary, writeFailure])
            } else assert.equal(failure, primary)
          } else assert.equal(failure, writeFails ? writeFailure : undefined)

          // Failed writes remain queued for an explicit retry. Successful ones
          // are removed, and the VM's execution lock is released on every path.
          rejectWrite = false
          await vm.flush()
          assert.equal(writes.length, writeFails ? 2 : 1)
          if (writeFails) assert.deepEqual(writes[1], writes[0])
          await vm.flush()
          assert.equal(writes.length, writeFails ? 2 : 1)
          assert.equal(await vm.execute('21*2', 'recovered.tjs', true), 42n)
          await vm.collect()
          assert.equal(vm.inspect().handles, 0)
          assert.equal(vm.inspect().pendingHandles, 0)
        } finally {
          vm.dispose()
        }
      })
