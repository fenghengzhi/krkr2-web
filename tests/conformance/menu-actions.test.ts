import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { exerciseMenuActions } from '../helpers/menu-actions.ts'

const root = resolve('.generated/wasm')
const manifest: WasmManifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const assets = manifest.variants.asyncify!
const { default: factory } = (await import(pathToFileURL(resolve(root, assets.mjs.file)).href)) as {
  default: ModuleFactory
}
const wasm = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
for (const binary of [false, true])
  test(
    `Menu native action return and call status / bytecode=${binary}`,
    { timeout: 60000 },
    async (t) => {
      t.diagnostic(JSON.stringify(await exerciseMenuActions(factory, wasm, 'asyncify', binary)))
    },
  )
