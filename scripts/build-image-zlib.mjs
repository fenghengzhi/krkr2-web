import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Build image-zlib only on GitHub-hosted Actions')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  sdk = process.env.EMSDK || resolve(root, '../toolchains/krkr2/emsdk'),
  emscripten = resolve(sdk, 'upstream/emscripten'),
  source = JSON.parse(readFileSync(resolve(root, 'native/image-zlib/source.json'), 'utf8')),
  toolchain = readFileSync(resolve(emscripten, 'emscripten-version.txt'), 'utf8').trim().replaceAll('"', ''),
  port = readFileSync(resolve(emscripten, 'tools/ports/zlib.py'), 'utf8'),
  version = /VERSION = '([^']+)'/.exec(port)?.[1], archiveHash = /HASH = '([^']+)'/.exec(port)?.[1]
if (toolchain !== source.toolchain || version !== source.version || archiveHash !== source.sha512)
  throw new Error('Image zlib toolchain/port source differs from its pinned source manifest')
const pythonRoot = resolve(sdk, 'python'), python = process.env.EMSDK_PYTHON ||
  (existsSync(pythonRoot) ? readdirSync(pythonRoot).map((name) => resolve(pythonRoot, name, 'bin/python3')).find(existsSync) : undefined),
  env = { ...process.env, EMSDK: sdk, ...(python ? { EMSDK_PYTHON: python } : {}) },
  build = resolve(root, 'out/native/image-zlib'), output = resolve(root, '.generated/image-zlib')
mkdirSync(build, { recursive: true }); mkdirSync(output, { recursive: true })
const compiled = spawnSync(resolve(emscripten, 'emcc'), [
  'native/image-zlib/kernel.c', '-std=c11', '-O2', '--no-entry', '-sUSE_ZLIB=1',
  '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createImageZlib', '-sENVIRONMENT=web,worker,node',
  '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH=1', '-sABORTING_MALLOC=0',
  '-sSTACK_SIZE=65536', '-sINITIAL_MEMORY=2097152', '-sMAXIMUM_MEMORY=67108864',
  "-sINCOMING_MODULE_JS_API=['locateFile','wasmBinary']", "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']",
  '-o', resolve(build, 'image-zlib.mjs'),
], { cwd: root, env, stdio: 'inherit' })
if (compiled.error) throw compiled.error
if (compiled.status !== 0) throw new Error(`Image zlib build failed (${compiled.status})`)
const configuration = spawnSync(resolve(emscripten, 'em-config'), ['PORTS'], { cwd: root, env, encoding: 'utf8' })
if (configuration.error) throw configuration.error
if (configuration.status !== 0 || !configuration.stdout.trim()) throw new Error('Could not resolve zlib port source directory')
const sourceDirectory = resolve(configuration.stdout.trim(), 'zlib', `zlib-${version}`),
  sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex'), files = {}, assets = {}
for (const name of readdirSync(sourceDirectory).filter((name) => /\.(c|h)$/.test(name)).sort()) {
  const bytes = readFileSync(resolve(sourceDirectory, name))
  files[name] = { bytes: bytes.length, sha256: sha256(bytes) }
}
if (!files['inflate.c'] || !files['zconf.h'] || !files['zlib.h']) throw new Error('Incomplete zlib source inventory')
const portConfiguration = readFileSync(resolve(emscripten, 'tools/ports/zlib/zconf.h'))
if (files['zconf.h'].sha256 !== sha256(portConfiguration)) throw new Error('Unexpected zlib port target configuration')
for (const kind of ['mjs', 'wasm']) {
  const bytes = readFileSync(resolve(build, `image-zlib.${kind}`)), hash = sha256(bytes),
    file = `image-zlib-${hash.slice(0, 16)}.${kind}`
  writeFileSync(resolve(output, file), bytes)
  assets[kind] = { file, bytes: bytes.length, sha256: hash }
}
const licenses = resolve(root, 'public/licenses/image-zlib')
mkdirSync(licenses, { recursive: true })
copyFileSync(resolve(sourceDirectory, 'LICENSE'), resolve(licenses, 'LICENSE.txt'))
writeFileSync(resolve(licenses, 'CREDITS.txt'), `zlib ${version}\nSource: ${source.url}\nArchive SHA-512: ${source.sha512}\nBuilt separately for PNG pull inflation. See LICENSE.txt.\n`)
const manifest = {
  abi: 1, library: 'zlib', version, toolchain,
  source: { url: source.url, archiveSha512: source.sha512,
    kernelSha256: sha256(readFileSync(resolve(root, 'native/image-zlib/kernel.c'))),
    portSha256: sha256(port), files },
  limits: { streams: 64, streamAllocationBytes: 131072, totalAllocationBytes: 8388608,
    wasmBytes: 67108864, inputBytes: 8192, outputBytes: 32769 }, assets,
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
