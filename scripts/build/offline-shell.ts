import { build, type Plugin } from 'vite'
import { relative, resolve, sep } from 'node:path'
import { readFile, readdir } from 'node:fs/promises'
import { appIcon, digest, iconSvg } from './icons.ts'
import { validateManifest, type ShellAsset, type ShellManifest } from '../../src/pwa/manifest.ts'

const mime = (path: string) => {
  const ext = path.split('.').at(-1)?.toLowerCase()
  const types: Record<string, string> = {
    html: 'text/html',
    js: 'text/javascript',
    mjs: 'text/javascript',
    css: 'text/css',
    json: 'application/json',
    webmanifest: 'application/manifest+json',
    wasm: 'application/wasm',
    png: 'image/png',
    svg: 'image/svg+xml',
    txt: 'text/plain',
    gz: 'application/gzip',
  }
  if (!ext || !types[ext]) throw new Error(`No offline MIME type for ${path}`)
  return types[ext]!
}
export function offlineShell(): Plugin {
  let worker = ''
  let publicDirectory: string | false = false
  return {
    name: 'krkr-offline-shell',
    enforce: 'post',
    apply: 'build',
    config() {
      return { build: { copyPublicDir: false } }
    },
    configResolved(config) {
      publicDirectory = config.publicDir
    },
    async buildStart() {
      // Vite's direct public-directory copy bypasses generateBundle and its hashes.
      // Emit those files through the bundle so offline licensing stays available too.
      if (publicDirectory) {
        const files = await readdir(publicDirectory, { recursive: true, withFileTypes: true })
        for (const file of files) {
          if (!file.isFile()) continue
          const path = resolve(file.parentPath, file.name)
          this.emitFile({
            type: 'asset',
            fileName: relative(publicDirectory, path).split(sep).join('/'),
            source: await readFile(path),
          })
        }
      }
      const result = await build({
        configFile: false,
        publicDir: false,
        logLevel: 'silent',
        build: {
          write: false,
          emptyOutDir: false,
          target: 'es2022',
          minify: true,
          lib: {
            entry: resolve('src/pwa/service-worker.ts'),
            name: 'KrkrOffline',
            formats: ['iife'],
            fileName: () => 'sw.js',
          },
        },
      })
      const output = Array.isArray(result) ? result[0] : result
      if (!output || !('output' in output))
        throw new Error('Unexpected offline worker build output')
      const script = output.output.find((file) => file.type === 'chunk')
      if (!script || script.type !== 'chunk') throw new Error('Offline service worker is missing')
      worker = script.code
      for (const size of [192, 512])
        this.emitFile({ type: 'asset', fileName: `icon-${size}.png`, source: appIcon(size) })
      this.emitFile({ type: 'asset', fileName: 'favicon.svg', source: iconSvg })
      this.emitFile({
        type: 'asset',
        fileName: 'app.webmanifest',
        source: JSON.stringify({
          id: './',
          name: 'krkr2-web',
          short_name: 'krkr2-web',
          lang: 'zh-CN',
          start_url: './',
          scope: './',
          display: 'standalone',
          background_color: '#0c1016',
          theme_color: '#0c1016',
          icons: [
            { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
            { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
          ],
        }),
      })
    },
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const html = bundle['index.html']
        if (
          !html ||
          html.type !== 'asset' ||
          typeof html.source !== 'string' ||
          !html.source.includes('__KRKR_BUILD_TOKEN__')
        )
          throw new Error('Offline app build marker missing from index.html')
        const entries = () =>
          Object.values(bundle)
            .map((file) => ({
              path: file.fileName,
              bytes: Buffer.from(file.type === 'chunk' ? file.code : file.source),
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        const buildId = digest(
          JSON.stringify({
            schema: 1,
            worker: digest(worker),
            files: entries().map((file) => [file.path, digest(file.bytes)]),
          }),
        )
        html.source = html.source.replace('__KRKR_BUILD_TOKEN__', buildId)
        const assets: ShellAsset[] = entries().map((file) => ({
          path: file.path,
          bytes: file.bytes.length,
          sha256: digest(file.bytes),
          mime: mime(file.path),
        }))
        const manifest: ShellManifest = validateManifest({
          schema: 1,
          build: buildId,
          bytes: assets.reduce((sum, file) => sum + file.bytes, 0),
          assets,
        })
        this.emitFile({
          type: 'asset',
          fileName: 'sw.js',
          source: `self.__KRKR_SHELL__=${JSON.stringify(manifest)};\n${worker}`,
        })
      },
    },
  }
}
