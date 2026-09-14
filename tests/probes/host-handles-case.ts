import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmVariant } from '../../src/backends/script/tjs-wasm/module.ts'
import {
  exerciseHostHandles,
  exerciseHostHandleControl,
  hostHandleControlCases,
} from '../helpers/host-handles.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true')
const [variant, name, debug, binary] = process.argv.slice(2)
assert(variant === 'asyncify' || variant === 'jspi')
const root = resolve('.generated/wasm')
const manifest = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'))
const assets = manifest.variants[variant]!
const { default: factory } = await import(pathToFileURL(resolve(root, assets.mjs.file)).href)
const wasm = new Uint8Array(readFileSync(resolve(root, assets.wasm.file)))
try {
  const result = hostHandleControlCases.some((item) => item === name)
    ? await exerciseHostHandleControl(
        factory as ModuleFactory,
        wasm,
        variant as WasmVariant,
        debug === 'true',
        binary === 'true',
        name === 'paused-cancel',
      )
    : await exerciseHostHandles(
        factory as ModuleFactory,
        wasm,
        variant as WasmVariant,
        name!,
        debug === 'true',
        binary === 'true',
      )
  console.log('HOST_HANDLES_RESULT ' + JSON.stringify({ result }))
} catch (error) {
  console.error(
    'HOST_HANDLES_RESULT ' +
      JSON.stringify({
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      }),
  )
  process.exitCode = 1
}
