import { defineConfig, type Plugin } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { offlineShell } from './scripts/build/offline-shell.ts'
import { fontAssets } from './scripts/build/font-assets.ts'

const root = dirname(fileURLToPath(import.meta.url))
function wasmAssets(): Plugin {
  const directory = resolve(root, process.env.KRKR_WASM_DIR ?? '.generated/wasm')
  const manifestBytes = readFileSync(resolve(directory, 'manifest.json'))
  const manifestFile = `manifest-${createHash('sha256').update(manifestBytes).digest('hex').slice(0, 16)}.json`
  return {
    name: 'krkr-wasm-assets',
    config() {
      return { define: { __KRKR_WASM_MANIFEST_FILE__: JSON.stringify('wasm/' + manifestFile) } }
    },
    configureServer(server) {
      server.middlewares.use('/wasm', (request, response, next) => {
        const name = request.url?.split('?')[0]?.slice(1) ?? ''
        if (
          name !== manifestFile &&
          !/^(manifest\.json|tjs-(asyncify|jspi)-[a-f0-9]{16}\.(mjs|wasm))$/.test(name)
        )
          return next()
        const file = resolve(directory, name === manifestFile ? 'manifest.json' : name)
        if (!existsSync(file)) {
          response.statusCode = 404
          response.end('Run npm run build:wasm')
          return
        }
        response.setHeader(
          'Content-Type',
          name.endsWith('.wasm')
            ? 'application/wasm'
            : name.endsWith('.mjs')
              ? 'text/javascript'
              : 'application/json',
        )
        response.setHeader('Cache-Control', 'no-cache')
        response.end(readFileSync(file))
      })
    },
    generateBundle() {
      const manifestPath = resolve(directory, 'manifest.json')
      if (!existsSync(manifestPath)) throw new Error('Build WASM first: npm run build:wasm')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        variants: Record<
          string,
          { mjs: { file: string; sha256: string }; wasm: { file: string; sha256: string } }
        >
      }
      for (const variant of Object.values(manifest.variants))
        for (const asset of [variant.mjs, variant.wasm]) {
          const bytes = readFileSync(resolve(directory, asset.file))
          if (createHash('sha256').update(bytes).digest('hex') !== asset.sha256)
            throw new Error(`WASM asset hash mismatch: ${asset.file}; rebuild the WASM modules`)
        }
      const files = [
        'manifest.json',
        ...Object.values(manifest.variants).flatMap((variant) => [
          variant.mjs.file,
          variant.wasm.file,
        ]),
      ]
      this.emitFile({ type: 'asset', fileName: `wasm/${manifestFile}`, source: manifestBytes })
      for (const name of files)
        this.emitFile({
          type: 'asset',
          fileName: `wasm/${name}`,
          source: readFileSync(resolve(directory, name)),
        })
    },
  }
}

export default defineConfig({
  plugins: [workerRpc({ pool: 1 }), wasmAssets(), fontAssets(root), offlineShell()],
  build: { target: 'es2022' },
  worker: { format: 'es' },
})
