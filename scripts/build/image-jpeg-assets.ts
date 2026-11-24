import type { Plugin } from 'vite'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { validateImageJpegManifest, type ImageJpegManifest } from '../../src/backends/image-jpeg/module.ts'

export function imageJpegAssets(root: string): Plugin {
  const directory = resolve(root, process.env.KRKR_IMAGE_JPEG_DIR ?? '.generated/image-jpeg'),
    path = resolve(directory, 'manifest.json')
  if (!existsSync(path)) throw new Error('Build image JPEG assets first: node scripts/build-image-jpeg.mjs')
  const bytes = readFileSync(path), manifest = JSON.parse(bytes.toString()) as ImageJpegManifest
  validateImageJpegManifest(manifest)
  if (manifest.source.kernelSha256 !== createHash('sha256')
    .update(readFileSync(resolve(root, 'native/image-jpeg/kernel.c'))).digest('hex'))
    throw new Error('Image JPEG kernel source changed; rebuild image JPEG')
  const filename = `manifest-${createHash('sha256').update(bytes).digest('hex').slice(0, 16)}.json`,
    files = new Map([[filename, bytes], ['manifest.json', bytes]])
  for (const kind of ['mjs', 'wasm'] as const) {
    const asset = manifest.assets[kind], data = readFileSync(resolve(directory, asset.file))
    if (data.length !== asset.bytes || createHash('sha256').update(data).digest('hex') !== asset.sha256)
      throw new Error('Image JPEG asset hash mismatch; rebuild image JPEG')
    files.set(asset.file, data)
  }
  return {
    name: 'krkr-image-jpeg-assets',
    config() { return { define: { __KRKR_IMAGE_JPEG_MANIFEST_FILE__: JSON.stringify('image-jpeg/' + filename) } } },
    configureServer(server) {
      server.middlewares.use('/image-jpeg', (request, response, next) => {
        const name = request.url?.split('?')[0]?.slice(1) ?? '', data = files.get(name)
        if (!data) return next()
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm'
          : name.endsWith('.mjs') ? 'text/javascript' : 'application/json')
        response.setHeader('Cache-Control', 'no-cache'); response.end(data)
      })
    },
    generateBundle() {
      for (const [name, source] of files) this.emitFile({ type: 'asset', fileName: 'image-jpeg/' + name, source })
    },
  }
}
