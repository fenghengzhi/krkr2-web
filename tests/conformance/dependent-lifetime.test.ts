import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { dependentLifetimeCases, exerciseDependentLifetime } from '../helpers/dependent-lifetime.ts'

const root = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasm = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
for (const debugMode of [false, true])
  for (const binary of [false, true])
    for (const name of dependentLifetimeCases)
      test(
        `dependent lifetime ${name} / debug=${debugMode} / bytecode=${binary}`,
        { timeout: 60000 },
        async (t) => {
          t.diagnostic(
            JSON.stringify(
              await exerciseDependentLifetime(factory, wasm, 'asyncify', name, debugMode, binary),
            ),
          )
        },
      )
