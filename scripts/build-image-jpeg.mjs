import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Build image-jpeg only on GitHub-hosted Actions')
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  source = JSON.parse(readFileSync(resolve(root, 'native/image-jpeg/source.json'), 'utf8')),
  sdk = process.env.EMSDK || resolve(root, '../toolchains/krkr2/emsdk'),
  emscripten = resolve(sdk, 'upstream/emscripten'),
  toolchain = readFileSync(resolve(emscripten, 'emscripten-version.txt'), 'utf8').trim().replaceAll('"', ''),
  sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex'),
  build = resolve(root, 'out/native/image-jpeg'), sourceDirectory = resolve(build, 'source'),
  output = resolve(root, '.generated/image-jpeg')
if (source.schema !== 1 || source.library !== 'ijg-libjpeg' || source.version !== '6b' || source.jpegAbi !== 62 ||
    toolchain !== '6.0.9' || source.toolchain !== toolchain)
  throw new Error('Image JPEG source/toolchain manifest mismatch')
mkdirSync(sourceDirectory, { recursive: true }); mkdirSync(output, { recursive: true })
async function download(entry) {
  const response = await fetch(entry.url, { signal: AbortSignal.timeout(60000) })
  if (!response.ok) throw new Error(`Image JPEG source download failed: ${entry.url} (${response.status})`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.length !== entry.bytes || sha256(bytes) !== entry.sha256)
    throw new Error('Image JPEG source hash/size mismatch: ' + entry.url)
  return bytes
}
const archive = await download(source.archive), archivePath = resolve(build, 'jpegsrc.v6b.tar.gz')
writeFileSync(archivePath, archive)
const pythonRoot = resolve(sdk, 'python'), python = process.env.EMSDK_PYTHON ||
  (existsSync(pythonRoot) ? readdirSync(pythonRoot).map((name) => resolve(pythonRoot, name, 'bin/python3')).find(existsSync) : undefined) || 'python3',
  env = { ...process.env, EMSDK: sdk, EMSDK_PYTHON: python }
// Extract only flat, regular, hash-pinned source files. Do not execute IJG's
// configure, sample programs, or any script from the downloaded archive.
const extraction = spawnSync(python, ['-c', `
import hashlib,json,pathlib,sys,tarfile
archive,manifest,destination=sys.argv[1:]
source=json.loads(pathlib.Path(manifest).read_text())
wanted={entry['file']:entry for entry in source['files']}
seen=set(); root=pathlib.Path(destination).resolve()
with tarfile.open(archive) as bundle:
 for item in bundle:
  name=item.name.removeprefix('jpeg-6b/')
  if name not in wanted: continue
  if name in seen or not item.isfile() or '/' in name or item.size>2*1024*1024: raise RuntimeError('Unsafe JPEG source member: '+name)
  data=bundle.extractfile(item).read(); expected=wanted[name]
  if len(data)!=expected['bytes'] or hashlib.sha256(data).hexdigest()!=expected['sha256']: raise RuntimeError('JPEG source member differs: '+name)
  (root/name).write_bytes(data); seen.add(name)
if seen!=set(wanted): raise RuntimeError('Missing pinned JPEG source files: '+str(set(wanted)-seen))
`, archivePath, resolve(root, 'native/image-jpeg/source.json'), sourceDirectory], { cwd: root, env, stdio: 'inherit' })
if (extraction.error) throw extraction.error
if (extraction.status !== 0) throw new Error(`Image JPEG source extraction failed (${extraction.status})`)
const originalHeaders = {}
for (const entry of source.originalHeaders) {
  if (!['jconfig.h', 'jmorecfg.h'].includes(entry.file)) throw new Error('Unexpected JPEG configuration override')
  const bytes = await download(entry)
  writeFileSync(resolve(sourceDirectory, entry.file), bytes)
  originalHeaders[entry.file] = { bytes: bytes.length, sha256: sha256(bytes) }
}
if (Object.keys(originalHeaders).length !== 2) throw new Error('Both original JPEG configuration headers are required')
const flags = ['-std=c11', '-O2', '-fwrapv', '-fno-strict-aliasing', '-ffp-contract=off'],
  command = [resolve(root, 'native/image-jpeg/kernel.c'), ...source.decoderSources.map((name) => {
    if (!/^j[a-z]+\.c$/.test(name) || !source.files.some((entry) => entry.file === name))
      throw new Error('Unpinned JPEG decoder translation unit: ' + name)
    return resolve(sourceDirectory, name)
  }), '-I', sourceDirectory, ...flags, '--no-entry',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sEXPORT_NAME=createImageJpeg', '-sENVIRONMENT=web,worker,node',
    '-sFILESYSTEM=0', '-sALLOW_MEMORY_GROWTH=1', '-sABORTING_MALLOC=0', '-sSUPPORT_LONGJMP=1',
    '-sSTACK_SIZE=131072', '-sINITIAL_MEMORY=4194304', '-sMAXIMUM_MEMORY=268435456',
    "-sINCOMING_MODULE_JS_API=['locateFile','wasmBinary']", "-sEXPORTED_RUNTIME_METHODS=['HEAPU8']",
    '-o', resolve(build, 'image-jpeg.mjs')]
writeFileSync(resolve(build, 'compile-command.json'), JSON.stringify({ toolchain, command }, null, 2) + '\n')
const compiled = spawnSync(resolve(emscripten, 'emcc'), command, { cwd: root, env, stdio: 'inherit' })
if (compiled.error) throw compiled.error
if (compiled.status !== 0) throw new Error(`Image JPEG build failed (${compiled.status})`)
const files = {}, assets = {}
for (const name of readdirSync(sourceDirectory).filter((name) => /\.(c|h)$/.test(name)).sort()) {
  const bytes = readFileSync(resolve(sourceDirectory, name))
  files[name] = { bytes: bytes.length, sha256: sha256(bytes) }
}
for (const kind of ['mjs', 'wasm']) {
  const bytes = readFileSync(resolve(build, `image-jpeg.${kind}`)), hash = sha256(bytes),
    file = `image-jpeg-${hash.slice(0, 16)}.${kind}`
  writeFileSync(resolve(output, file), bytes)
  assets[kind] = { file, bytes: bytes.length, sha256: hash }
}
const licenses = resolve(root, 'public/licenses/image-jpeg')
mkdirSync(licenses, { recursive: true })
copyFileSync(resolve(sourceDirectory, 'README'), resolve(licenses, 'LICENSE.txt'))
writeFileSync(resolve(licenses, 'CREDITS.txt'), `This software is based in part on the work of the Independent JPEG Group.\nIJG JPEG6b (27-Mar-1998), with pinned KRKR2 libjpeg2 configuration headers.\nSource: ${source.archive.url}\nArchive SHA-256: ${source.archive.sha256}\nCompiled separately for selected JPEG loading. See LICENSE.txt for the original README and license.\n`)
const manifest = {
  abi: 1, library: source.library, version: source.version, jpegAbi: source.jpegAbi, toolchain,
  source: { url: source.archive.url, archiveSha256: source.archive.sha256,
    kernelSha256: sha256(readFileSync(resolve(root, 'native/image-jpeg/kernel.c'))), files, originalHeaders,
    decoderSources: source.decoderSources, flags, scope: source.scope },
  limits: { streams: 64, totalAllocationBytes: 134217728, wasmBytes: 268435456, inputBytes: 8192,
    outputBytes: 32768, carryBytes: 73728, sourceBytes: 67108864, dimension: 4096, steps: 131072 }, assets,
}
writeFileSync(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(JSON.stringify(manifest, null, 2))
