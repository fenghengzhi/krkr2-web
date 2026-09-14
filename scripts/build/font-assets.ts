import type { Plugin } from 'vite'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import type { FontManifest } from '../../src/backends/text/freetype/module.ts'
export function fontAssets(root: string): Plugin {
  const directory = resolve(root, process.env.KRKR_FONT_DIR ?? '.generated/fonts'),
    path = resolve(directory, 'manifest.json')
  if (!existsSync(path)) throw new Error('Build font assets first: npm run build:fonts')
  const bytes = readFileSync(path),
    manifest = JSON.parse(bytes.toString()) as FontManifest,
    filename = `manifest-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`
  const files = new Map([
    [filename, bytes],
    ['manifest.json', bytes],
  ])
  if (manifest.abi !== 2) throw new Error('Font asset ABI mismatch')
  for (const kind of ['mjs', 'wasm'] as const) {
    const asset = manifest.assets[kind]
    if (!new RegExp(`^font-[a-f0-9]{16}\\.${kind}$`).test(asset.file))
      throw new Error('Invalid font asset name')
    const bytes = readFileSync(resolve(directory, asset.file))
    if (
      bytes.length !== asset.bytes ||
      createHash('sha256').update(bytes).digest('hex') !== asset.sha256
    )
      throw new Error('Font asset hash mismatch; rebuild font assets')
    files.set(asset.file, bytes)
  }
  return {
    name: 'krkr-font-assets',
    config() {
      return { define: { __KRKR_FONT_MANIFEST_FILE__: JSON.stringify('fonts/' + filename) } }
    },
    configureServer(server) {
      server.middlewares.use('/fonts', (request, response, next) => {
        const name = request.url?.split('?')[0]?.slice(1) ?? '',
          bytes = files.get(name)
        if (!bytes) return next()
        response.setHeader(
          'Content-Type',
          name.endsWith('.wasm')
            ? 'application/wasm'
            : name.endsWith('.mjs')
              ? 'text/javascript'
              : 'application/json',
        )
        response.setHeader('Cache-Control', 'no-cache')
        response.end(bytes)
      })
    },
    generateBundle() {
      for (const [name, source] of files)
        this.emitFile({ type: 'asset', fileName: 'fonts/' + name, source })
    },
  }
}
