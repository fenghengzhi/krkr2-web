import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  copyFileSync,
  readdirSync,
} from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  sdk = process.env.EMSDK || resolve(root, '../toolchains/krkr2/emsdk'),
  emscripten = resolve(sdk, 'upstream/emscripten')
const compiler = resolve(emscripten, 'emcc')
if (!existsSync(compiler)) throw new Error('Set EMSDK or install Emscripten before building fonts')
const output = resolve(root, '.generated/fonts'),
  build = resolve(root, 'out/native/fonts')
const pythonRoot = resolve(sdk, 'python'),
  python =
    process.env.EMSDK_PYTHON ||
    (existsSync(pythonRoot)
      ? readdirSync(pythonRoot)
          .map((version) => resolve(pythonRoot, version, 'bin/python3'))
          .find(existsSync)
      : undefined)
mkdirSync(output, { recursive: true })
mkdirSync(build, { recursive: true })
const env = { ...process.env, EMSDK: sdk, ...(python ? { EMSDK_PYTHON: python } : {}) }
const result = spawnSync(
  compiler,
  [
    'native/fonts/font.c',
    '-O2',
    '--no-entry',
    '-sUSE_FREETYPE=1',
    '-sMODULARIZE=1',
    '-sEXPORT_ES6=1',
    '-sEXPORT_NAME=createFont',
    '-sENVIRONMENT=web,worker,node',
    '-sFILESYSTEM=0',
    '-sALLOW_MEMORY_GROWTH=1',
    '-sABORTING_MALLOC=0',
    '-sINITIAL_MEMORY=4194304',
    '-sMAXIMUM_MEMORY=134217728',
    "-sINCOMING_MODULE_JS_API=['locateFile','wasmBinary']",
    "-sEXPORTED_FUNCTIONS=['_malloc','_free']",
    "-sEXPORTED_RUNTIME_METHODS=['HEAPU8','HEAP32']",
    '-o',
    resolve(build, 'font.mjs'),
  ],
  {
    cwd: root,
    env,
    stdio: 'inherit',
  },
)
if (result.error) throw result.error
if (result.status !== 0) throw new Error('Font module build failed')
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  assets = {}
for (const extension of ['mjs', 'wasm']) {
  const bytes = readFileSync(resolve(build, 'font.' + extension)),
    sha256 = hash(bytes),
    file = `font-${sha256.slice(0, 16)}.${extension}`
  writeFileSync(resolve(output, file), bytes)
  assets[extension] = { file, sha256, bytes: bytes.length }
}
const port = readFileSync(resolve(emscripten, 'tools/ports/freetype.py'), 'utf8'),
  version = /TAG = '([^']+)'/.exec(port)?.[1]
const configuration = spawnSync(resolve(emscripten, 'em-config'), ['PORTS'], {
  cwd: root,
  env,
  encoding: 'utf8',
})
if (configuration.error) throw configuration.error
if (configuration.status !== 0 || !configuration.stdout.trim())
  throw new Error('Could not resolve Emscripten font port location')
const source = resolve(configuration.stdout.trim(), 'freetype', 'freetype-' + version)
const licenses = resolve(root, 'public/licenses/freetype')
mkdirSync(licenses, { recursive: true })
for (const name of ['LICENSE.TXT', 'FTL.TXT'])
  copyFileSync(resolve(source, name === 'FTL.TXT' ? 'docs' : '.', name), resolve(licenses, name))
writeFileSync(
  resolve(licenses, 'CREDITS.txt'),
  `FreeType ${version}\nPortions of this software are copyright (c) The FreeType Project (https://freetype.org). All rights reserved.\nFreeType is distributed here under the FreeType Project License; see FTL.TXT.\nSource: https://github.com/freetype/freetype/tree/${version}\n`,
)
const manifest = {
  abi: 2,
  library: 'FreeType',
  version,
  toolchain: readFileSync(resolve(emscripten, 'emscripten-version.txt'), 'utf8')
    .trim()
    .replaceAll('"', ''),
  sourceSha256: hash(readFileSync(resolve(root, 'native/fonts/font.c'))),
  portSha256: hash(port),
  assets,
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
