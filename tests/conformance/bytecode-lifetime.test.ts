import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  exerciseBytecodeLifetime,
  makeBytecodeWork,
  bytecodePhases,
  exerciseBytecodeControl,
} from '../helpers/bytecode-lifetime.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

test('native bytecode success, late link failure and invalid ownership release their allocations', async (t) => {
  assert.equal(manifest.capabilities?.bytecodeLifecycle, 1)
  assert.equal(manifest.diagnosticAllocator, false)
  t.diagnostic(JSON.stringify(await exerciseBytecodeLifetime(factory, wasmBinary, 'asyncify')))
})
let work: ReturnType<typeof makeBytecodeWork> | undefined
for (const phase of bytecodePhases)
  for (const cancel of [false, true])
    test(
      `native bytecode phase ${phase} pauses and ${cancel ? 'cancels' : 'resumes'} after allocating resources`,
      { timeout: 180_000 },
      async (t) => {
        work ??= makeBytecodeWork(factory, wasmBinary, 'asyncify')
        t.diagnostic(
          JSON.stringify(
            await exerciseBytecodeControl(
              factory,
              wasmBinary,
              'asyncify',
              await work,
              phase,
              cancel,
            ),
          ),
        )
      },
    )
