import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ModuleFactory, WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { exerciseObjectIdentity, objectIdentityCases } from '../helpers/object-identity.ts'

const directory = resolve('.generated/wasm'),
  manifest: WasmManifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')),
  assets = manifest.variants.asyncify!,
  { default: factory } = await import(pathToFileURL(resolve(directory, assets.mjs.file)).href) as { default: ModuleFactory },
  wasm = new Uint8Array(readFileSync(resolve(directory, assets.wasm.file)))

for (const debug of [false, true])
  for (const binary of [false, true])
    for (const name of objectIdentityCases)
      test(`object identity ${name} / debug=${debug} / bytecode=${binary}`, { timeout: 60000 }, async (t) => {
        assert.equal(manifest.capabilities?.objectIdentity, 1)
        t.diagnostic(JSON.stringify(await exerciseObjectIdentity(factory, wasm, 'asyncify', name, debug, binary)))
      })
