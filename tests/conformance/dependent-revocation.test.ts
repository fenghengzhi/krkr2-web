import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  dependentRevocationCases,
  exerciseDependentRevocation,
} from '../helpers/dependent-revocation.ts'
const root = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasm = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
for (const debug of [false, true])
  for (const binary of [false, true])
    for (const name of dependentRevocationCases)
      test(
        `dependent revocation ${name} / debug=${debug} / bytecode=${binary}`,
        { timeout: 60000 },
        async (t) => {
          t.diagnostic(
            JSON.stringify(
              await exerciseDependentRevocation(factory, wasm, 'asyncify', name, debug, binary),
            ),
          )
        },
      )
