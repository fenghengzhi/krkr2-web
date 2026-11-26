import type { Plugin } from 'vite'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { validateLegacyMediaManifest, type LegacyMediaManifest } from '../../src/backends/video/legacy/module.ts'

export function legacyMediaAssets(root: string): Plugin {
  const directory = resolve(root, process.env.KRKR_LEGACY_MEDIA_DIR ?? '.generated/legacy-media'),
    path = resolve(directory, 'manifest.json'), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
  if (!existsSync(path)) throw new Error('Build legacy movie assets first: node scripts/build-legacy-media.mjs')
  const bytes = readFileSync(path), manifest = JSON.parse(bytes.toString()) as LegacyMediaManifest
  validateLegacyMediaManifest(manifest)
  for (const [file, expected] of [
    ['native/legacy-media/source.json', manifest.source.manifestSha256],
    ['native/legacy-media/elementary-mpeg1-clock.patch', manifest.source.elementaryClockSha256],
    ['native/legacy-media/post.js', manifest.source.postSha256],
    ['scripts/build-legacy-media.mjs', manifest.source.buildSha256],
  ]) if (hash(readFileSync(resolve(root, file!))) !== expected) throw new Error('Legacy media build sources changed; rebuild its assets')
  const filename = `manifest-${hash(bytes).slice(0, 16)}.json`, files = new Map([[filename, bytes], ['manifest.json', bytes]])
  for (const asset of Object.values(manifest.assets)) {
    const data = readFileSync(resolve(directory, asset.file))
    if (data.length !== asset.bytes || hash(data) !== asset.sha256) throw new Error('Legacy movie asset hash mismatch')
    files.set(asset.file, data)
  }
  return {
    name: 'krkr-legacy-media-assets',
    config() { return { define: { __KRKR_LEGACY_MEDIA_MANIFEST_FILE__: JSON.stringify('legacy-media/' + filename) } } },
    configureServer(server) {
      server.middlewares.use('/legacy-media', (request, response, next) => {
        const name = request.url?.split('?')[0]?.slice(1) ?? '', data = files.get(name)
        if (!data) return next()
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.mjs') ? 'text/javascript' : 'application/json')
        response.setHeader('Cache-Control', 'no-cache'); response.end(data)
      })
    },
    generateBundle() { for (const [name, source] of files) this.emitFile({ type: 'asset', fileName: 'legacy-media/' + name, source }) },
  }
}
