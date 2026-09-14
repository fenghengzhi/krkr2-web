import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  objectLifetimeCases,
  exerciseObjectLifetime,
  exerciseFinalizationControl,
} from '../helpers/object-lifetime.ts'

const root = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasm = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
for (const debug of [false, true])
  for (const binary of [false, true])
    for (const fixture of objectLifetimeCases)
      test(
        `object lifetime ${fixture.name} / debug=${debug} / bytecode=${binary}`,
        { timeout: 60000 },
        async (t) => {
          assert.equal(manifest.capabilities?.objectFinalization, 1)
          t.diagnostic(
            JSON.stringify(
              await exerciseObjectLifetime(factory, wasm, 'asyncify', fixture.name, debug, binary),
            ),
          )
        },
      )
for (const explicit of [false, true])
  for (const binary of [false, true])
    for (const cancel of [false, true])
      test(
        `finalizer control / explicit=${explicit} / bytecode=${binary} / cancel=${cancel}`,
        { timeout: 60000 },
        async (t) => {
          t.diagnostic(
            JSON.stringify(
              await exerciseFinalizationControl(
                factory,
                wasm,
                'asyncify',
                explicit,
                binary,
                cancel,
              ),
            ),
          )
        },
      )
