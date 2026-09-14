import { build } from 'vite'
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { verifyOfflineBuild } from './verify-offline-build.mjs'
const directory = resolve('out/verification/pwa')
await mkdir(directory, { recursive: true })
const original = process.env.KRKR_WASM_DIR
try {
  delete process.env.KRKR_WASM_DIR
  await build({
    base: '/player/',
    logLevel: 'warn',
    build: { outDir: resolve(directory, 'site-a') },
  })
  const wasm = resolve(directory, 'fixture-wasm')
  await cp(resolve('.generated/wasm'), wasm, { recursive: true })
  const manifest = JSON.parse(await readFile(resolve(wasm, 'manifest.json'), 'utf8'))
  manifest.testRelease = 'pwa-fixture-b'
  await writeFile(resolve(wasm, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  process.env.KRKR_WASM_DIR = wasm
  await build({
    base: '/player/',
    logLevel: 'warn',
    build: { outDir: resolve(directory, 'site-b') },
  })
} finally {
  if (original === undefined) delete process.env.KRKR_WASM_DIR
  else process.env.KRKR_WASM_DIR = original
}
const a = await verifyOfflineBuild(resolve(directory, 'site-a'), '/player/')
const b = await verifyOfflineBuild(resolve(directory, 'site-b'), '/player/')
assert.notEqual(a.build, b.build)
assert.notEqual(a.wasmManifest, b.wasmManifest)
await writeFile(
  resolve(directory, 'fixture-artifacts.json'),
  JSON.stringify({ a, b }, null, 2) + '\n',
)
console.log('Built real subpath PWA releases A and B without modifying .generated/wasm')
