import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { exerciseExecutionBudget, exerciseDeepContinuation } from '../helpers/execution-budget.ts'

const directory = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(
  pathToFileURL(resolve(directory, assets.mjs.file)).href
)) as { default: ModuleFactory }
const wasmBinary = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))
for (const debug of [false, true])
  test(
    `VM execution bounds recover with tracing ${debug ? 'enabled' : 'disabled'}`,
    { timeout: 60000 },
    async (t) => {
      assert.equal(manifest.capabilities?.executionBudgets, 1)
      t.diagnostic(
        JSON.stringify(await exerciseExecutionBudget(factory, wasmBinary, 'asyncify', debug)),
      )
    },
  )
for (const cancel of [false, true])
  test(
    `deep native function/try stacks pause and ${cancel ? 'cancel' : 'resume'}`,
    { timeout: 60000 },
    async (t) => {
      t.diagnostic(
        JSON.stringify(await exerciseDeepContinuation(factory, wasmBinary, 'asyncify', cancel)),
      )
    },
  )
