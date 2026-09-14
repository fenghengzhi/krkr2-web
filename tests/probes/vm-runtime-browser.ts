// Exercise the production runtime adapter's direct compile entry in real browsers.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'vite'
import { chromium, firefox, webkit } from '@playwright/test'

const out = 'out/verification/vm-console',
  bundleRoot = resolve(out, 'runtime'),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
await mkdir(bundleRoot, { recursive: true })
await build({
  configFile: false,
  publicDir: false,
  logLevel: 'error',
  build: {
    outDir: bundleRoot,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: resolve('tests/probes/vm-runtime-entry.ts'),
      formats: ['es'],
      fileName: () => 'runtime.mjs',
    },
  },
})
const bundleSha256 = hash(await readFile(bundleRoot + '/runtime.mjs')),
  manifest = JSON.parse(await readFile('dist/wasm/manifest.json', 'utf8')),
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (path === '/') {
      res.setHeader('content-type', 'text/html')
      res.end('<!doctype html><title>Runtime validation</title>')
      return
    }
    if (!/^\/(runtime\.mjs|wasm\/[a-zA-Z0-9_.-]+)$/.test(path)) {
      res.writeHead(404).end()
      return
    }
    try {
      const file = path === '/runtime.mjs' ? bundleRoot + path : resolve('dist', '.' + path)
      res.setHeader(
        'content-type',
        extname(file) === '.wasm'
          ? 'application/wasm'
          : extname(file) === '.json'
            ? 'application/json'
            : 'text/javascript',
      )
      res.end(await readFile(file))
    } catch {
      res.writeHead(404).end()
    }
  }).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')
const results: unknown[] = []
try {
  for (const name of ['chromium', 'firefox', 'webkit'] as const)
    for (const backend of ['asyncify', 'jspi'] as const) {
      const browser = await { chromium, firefox, webkit }[name].launch(),
        page = await browser.newPage(),
        errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      try {
        await page.goto(`http://127.0.0.1:${address.port}/`)
        const result = await page.evaluate(async (backend) => {
          const url = '/runtime.mjs'
          const fixture = (await import(url)) as typeof import('./vm-runtime-entry.ts')
          return fixture.exerciseRuntime(backend)
        }, backend)
        assert.deepEqual(errors, [])
        results.push({ browser: name, backend, ...result, errors })
        console.log(
          `PASS ${name}/${backend}: direct async compile, callbacks, dump, primary error, pause and cancellation`,
        )
      } finally {
        await browser.close()
      }
    }
  assert.equal(hash(await readFile(bundleRoot + '/runtime.mjs')), bundleSha256)
  assert.deepEqual(JSON.parse(await readFile('dist/wasm/manifest.json', 'utf8')), manifest)
  await writeFile(
    out + '/runtime-browser.json',
    JSON.stringify(
      { verifiedAt: new Date().toISOString(), bundleSha256, manifest, results },
      null,
      2,
    ) + '\n',
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((r) => server.close(() => r()))
}
