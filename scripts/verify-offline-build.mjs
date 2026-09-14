import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Script } from 'node:vm'
import { inflateSync } from 'node:zlib'

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex')
export async function verifyOfflineBuild(directory, base = '/') {
  const read = (path) => readFile(resolve(directory, path))
  const script = (await read('sw.js')).toString()
  new Script(script, { filename: 'sw.js' })
  const end = script.indexOf(';\n')
  assert(script.startsWith('self.__KRKR_SHELL__='))
  const manifest = JSON.parse(script.slice('self.__KRKR_SHELL__='.length, end))
  assert.equal(manifest.schema, 1)
  const listed = manifest.assets.map((asset) => asset.path)
  assert.equal(new Set(listed).size, listed.length)
  const files = await readdir(directory, { recursive: true, withFileTypes: true })
  assert.deepEqual(
    files
      .filter((file) => file.isFile())
      .map((file) => resolve(file.parentPath, file.name).slice(resolve(directory).length + 1))
      .sort(),
    [...listed, 'sw.js'].sort(),
    'Every emitted artifact must be covered by the offline manifest',
  )
  let bytes = 0
  const sourceEntries = []
  for (const asset of manifest.assets) {
    const data = await read(asset.path)
    assert.equal(data.length, asset.bytes, asset.path)
    assert.equal(hash(data), asset.sha256, asset.path)
    bytes += data.length
    sourceEntries.push([
      asset.path,
      hash(
        asset.path === 'index.html'
          ? data.toString().replace(manifest.build, '__KRKR_BUILD_TOKEN__')
          : data,
      ),
    ])
  }
  assert.equal(manifest.bytes, bytes)
  assert.equal(
    manifest.build,
    hash(
      JSON.stringify({
        schema: 1,
        worker: hash(script.slice(end + 2)),
        files: sourceEntries,
      }),
    ),
  )
  const html = (await read('index.html')).toString()
  assert(html.includes(`name="krkr-build" content="${manifest.build}"`))
  assert(!html.includes('__KRKR_BUILD_TOKEN__'))
  for (const name of ['app.webmanifest', 'favicon.svg', 'icon-192.png'])
    assert(html.includes(`href="${base}${name}"`), name)
  const app = JSON.parse(await read('app.webmanifest'))
  assert.equal(app.start_url, './')
  assert.equal(app.scope, './')
  assert.equal(app.display, 'standalone')
  for (const size of [192, 512]) {
    assert(
      app.icons.some((icon) => icon.src === `icon-${size}.png` && icon.sizes === `${size}x${size}`),
    )
    const png = await read(`icon-${size}.png`)
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
    assert.equal(png[24], 8)
    assert.equal(png[25], 6)
    const idat = []
    for (let offset = 8; offset < png.length;) {
      const length = png.readUInt32BE(offset)
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT')
        idat.push(png.subarray(offset + 8, offset + 8 + length))
      offset += length + 12
    }
    assert.equal(inflateSync(Buffer.concat(idat)).length, size * (size * 4 + 1))
  }
  const wasmBytes = await read('wasm/manifest.json')
  const wasmPath = `wasm/manifest-${hash(wasmBytes).slice(0, 16)}.json`
  assert.deepEqual(await read(wasmPath), wasmBytes)
  const wasm = JSON.parse(wasmBytes)
  assert.notEqual(
    wasm.diagnosticAllocator,
    true,
    'Allocator diagnostic kernels cannot be published',
  )
  for (const variant of Object.values(wasm.variants))
    for (const asset of [variant.mjs, variant.wasm])
      assert.equal(hash(await read(`wasm/${asset.file}`)), asset.sha256)
  const fontBytes = await read('fonts/manifest.json'),
    fontPath = `fonts/manifest-${hash(fontBytes).slice(0, 16)}.json`,
    font = JSON.parse(fontBytes)
  assert.deepEqual(await read(fontPath), fontBytes)
  assert.equal(font.abi, 2)
  assert.equal(font.library, 'FreeType')
  for (const asset of Object.values(font.assets)) {
    const bytes = await read(`fonts/${asset.file}`)
    assert.equal(bytes.length, asset.bytes)
    assert.equal(hash(bytes), asset.sha256)
  }
  for (const name of ['LICENSE.TXT', 'FTL.TXT', 'CREDITS.txt'])
    assert(listed.includes('licenses/freetype/' + name))
  assert(listed.some((path) => /session\.worker.*\.js$/.test(path)))
  assert(listed.some((path) => /library\.worker.*\.js$/.test(path)))
  assert(listed.some((path) => /mixer\.worklet.*\.js$/.test(path)))
  return {
    directory,
    base,
    build: manifest.build,
    assets: listed.length,
    bytes,
    wasmManifest: wasmPath,
    fontManifest: fontPath,
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href)
  console.log(await verifyOfflineBuild(process.argv[2] ?? 'dist', process.argv[3] ?? '/'))
