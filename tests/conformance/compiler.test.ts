import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { compilerPhases, exerciseCompiler } from '../helpers/compiler-runtime.ts'
import { compilerGate, compilerSource } from '../helpers/compiler-runtime.ts'
import { headless } from '../helpers/headless.ts'
import { TjsWasmRuntime } from '../../src/backends/script/tjs-wasm/runtime.ts'
import { MemorySaveStore } from '../../src/engine/ports/saves.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

for (const phase of compilerPhases)
  for (const cancel of [false, true])
    test(
      `native compiler phase ${phase} pauses and ${cancel ? 'cancels' : 'resumes'} without console callbacks`,
      { timeout: 60_000 },
      async (t) => {
        assert.equal(manifest.capabilities?.cooperativeCompilation, 1)
        t.diagnostic(
          JSON.stringify(await exerciseCompiler(factory, wasmBinary, 'asyncify', phase, cancel)),
        )
      },
    )

for (const phase of compilerPhases)
  test(
    `compileStorage cancellation in native phase ${phase} closes and persists the opened output`,
    { timeout: 60_000 },
    async () => {
      const store = new MemorySaveStore()
      await store.commit([
        { path: 'savedata/long.cjs', bytes: new TextEncoder().encode('old file') },
      ])
      let pause = () => {}
      const gate = compilerGate(factory, phase, () => pause())
      const { session } = await headless(
        {
          'startup.tjs': 'var finished=0;',
          'long.tjs': compilerSource(),
        },
        {
          saveStore: store,
          createRuntime: (handler, control, options) => {
            pause = () => session.pause()
            return TjsWasmRuntime.create(gate.factory, handler, { control, wasmBinary, ...options })
          },
        },
      )
      let pending: Promise<unknown> | undefined
      try {
        await session.start()
        gate.arm()
        let settled = false
        pending = session.evaluate('Scripts.compileStorage("long.tjs","savedata/long.cjs")').then(
          (value) => {
            settled = true
            return value
          },
          (error: unknown) => {
            settled = true
            return error
          },
        )
        await Promise.race([
          gate.started,
          pending.then((result) => {
            throw new Error(`Missing phase ${phase}: ${String(result)}`)
          }),
        ])
        await new Promise<void>((resolve) => setTimeout(resolve, 25))
        assert.equal(settled, false)
        await session.stop()
        assert.match(String(await pending), /Execution cancelled/)
        const output = session.exportSaves().find((file) => file.path === 'savedata/long.cjs')
        assert(output)
        assert.equal(output.bytes.length, 0)
        assert.deepEqual(await store.load(), [output])
        assert.equal(session.snapshot().pendingSaves, 0)
      } finally {
        await session.stop()
        await pending
      }
    },
  )
