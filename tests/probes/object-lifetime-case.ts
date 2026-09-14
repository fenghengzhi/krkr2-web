import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import { exerciseObjectLifetime } from '../helpers/object-lifetime.ts'

const [variant, name, debug, binary] = process.argv.slice(2)
const root = resolve('.generated/wasm')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const assets = manifest.variants[variant!]!
const { default: factory } = await import(pathToFileURL(resolve(root, assets.mjs.file)).href)
const wasm = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
try {
  const result = await exerciseObjectLifetime(
    factory as ModuleFactory,
    wasm,
    variant as WasmVariant,
    name!,
    debug === 'true',
    binary === 'true',
  )
  console.log('OBJECT_RESULT ' + JSON.stringify({ result }))
} catch (error) {
  console.error(
    'OBJECT_RESULT ' +
      JSON.stringify({
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
  )
  process.exitCode = 1
}
