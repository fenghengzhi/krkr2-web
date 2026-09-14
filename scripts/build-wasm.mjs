import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const localTools = resolve(root, '../toolchains/krkr2')
const sdk = process.env.EMSDK || resolve(localTools, 'emsdk')
const toolchain = resolve(sdk, 'upstream/emscripten/cmake/Modules/Platform/Emscripten.cmake')
if (!existsSync(toolchain))
  throw new Error(
    'Emscripten not found. Activate emsdk or set EMSDK before running npm run build:wasm.',
  )
const bison =
  process.env.BISON_EXECUTABLE ||
  (existsSync(resolve(localTools, 'bison/bin/bison'))
    ? resolve(localTools, 'bison/bin/bison')
    : 'bison')
const requested = process.argv.slice(2)
const variants = requested.length ? requested : ['asyncify', 'jspi']
if (variants.some((v) => !['asyncify', 'jspi'].includes(v)))
  throw new Error('Expected asyncify and/or jspi')
const output = resolve(root, '.generated/wasm')
mkdirSync(output, { recursive: true })
const manifestPath = resolve(output, 'manifest.json')
const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, 'utf8'))
  : { abi: 4, variants: {} }
const sourceHasher = createHash('sha256')
function hashSources(directory) {
  for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name, 'en'),
  )) {
    const path = `${directory}/${entry.name}`
    // Independently built font kernels do not change the TJS binary inputs.
    if (path === 'native/fonts' || path === 'third_party/unicode') continue
    if (entry.isDirectory()) hashSources(path)
    else if (/\.(c|cc|cpp|h|hpp|inc|y|py|in|txt)$/.test(entry.name)) {
      sourceHasher.update(path + '\0').update(readFileSync(resolve(root, path)))
    }
  }
}
hashSources('native')
hashSources('third_party')
const sourceHash = sourceHasher.digest('hex')
for (const [variant, assets] of Object.entries(manifest.variants)) {
  if (assets.sourceHash !== sourceHash) delete manifest.variants[variant]
}
const pythonRoot = resolve(sdk, 'python')
const bundledPython = existsSync(pythonRoot)
  ? readdirSync(pythonRoot)
      .map((version) => resolve(pythonRoot, version, 'bin/python3'))
      .find(existsSync)
  : undefined
const python = process.env.EMSDK_PYTHON || bundledPython
const env = { ...process.env, EMSDK: sdk, ...(python ? { EMSDK_PYTHON: python } : {}) }
function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (${result.status})`)
}
for (const variant of variants) {
  const build = resolve(root, `out/native/${variant}`)
  run('cmake', [
    '-S',
    'native',
    '-B',
    build,
    '-G',
    'Ninja',
    `-DCMAKE_TOOLCHAIN_FILE=${toolchain}`,
    '-DCMAKE_BUILD_TYPE=Release',
    `-DBISON_EXECUTABLE=${bison}`,
    `-DTJS_VARIANT=${variant}`,
    ...(python ? [`-DPython3_EXECUTABLE=${python}`] : []),
  ])
  run('cmake', ['--build', build, '--parallel', process.env.KRKR_BUILD_JOBS || '4'])
  const assets = {}
  for (const extension of ['mjs', 'wasm']) {
    const content = readFileSync(resolve(build, `tjs.${extension}`))
    const hash = createHash('sha256').update(content).digest('hex')
    const name = `tjs-${variant}-${hash.slice(0, 16)}.${extension}`
    writeFileSync(resolve(output, name), content)
    assets[extension] = { file: name, sha256: hash, bytes: content.byteLength }
  }
  manifest.variants[variant] = { ...assets, sourceHash }
}
manifest.abi = 4
manifest.source = { tjs2Revision: '6622499f70c3b30240d34d73d757c8adff45248f', sha256: sourceHash }
manifest.toolchain = readFileSync(
  resolve(sdk, 'upstream/emscripten/emscripten-version.txt'),
  'utf8',
)
  .trim()
  .replaceAll('"', '')
writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
console.log(`WASM manifest: ${manifestPath}`)
run(process.execPath, ['scripts/build-fonts.mjs'])
