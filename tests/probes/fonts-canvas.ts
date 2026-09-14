// Independent exported-canvas pixel check of synthetic file and pre-rendered glyphs.
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve('dist'),
  reportDirectory = process.argv[2] ?? 'out/verification/fonts',
  directory = reportDirectory + '/canvas'
const indexHash = async () =>
  createHash('sha256')
    .update(await readFile(resolve(root, 'index.html')))
    .digest('hex')
const indexSha256 = await indexHash()
await mkdir(directory, { recursive: true })
const server = createServer(async (req, res) => {
  const path = resolve(
    root,
    '.' + new URL(req.url!, 'http://localhost').pathname.replace(/\/$/, '/index.html'),
  )
  if (!path.startsWith(root + sep)) {
    res.writeHead(404).end()
    return
  }
  try {
    const bytes = await readFile(path),
      types: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.wasm': 'application/wasm',
        '.css': 'text/css',
        '.json': 'application/json',
        '.svg': 'image/svg+xml',
        '.png': 'image/png',
      }
    res
      .writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' })
      .end(bytes)
  } catch {
    res.writeHead(404).end()
  }
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing address')
const results = []
try {
  for (const name of ['chromium', 'firefox', 'webkit'] as const)
    for (const backend of ['asyncify', 'jspi']) {
      const browser = await { chromium, firefox, webkit }[name].launch(),
        page = await browser.newPage({ viewport: { width: 1280, height: 1000 } }),
        errors: string[] = []
      page.on('pageerror', (e) => errors.push(e.message))
      try {
        await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
        await page.locator('#files').setInputFiles([
          {
            name: 'startup.tjs',
            mimeType: 'text/plain',
            buffer: Buffer.from(
              'var w=new Window();w.visible=true;w.setInnerSize(120,70);var a=new Layer(w,null);a.setSize(120,70);a.type=ltAlpha;a.font.face="narrow.ttf";a.font.faceIsFileName=true;a.font.height=20;a.drawText(0,0,"AV",0xffffff);a.font.mapPrerenderedFont("coverage-v1.tft");a.drawText(20,0,"AB",0x123456);Debug.message("font-canvas-ready");',
            ),
          },
          ...(await Promise.all(
            ['narrow.ttf', 'coverage-v1.tft'].map(async (name) => ({
              name,
              mimeType: 'application/octet-stream',
              buffer: await readFile('tests/fixtures/font/' + name),
            })),
          )),
        ])
        await expect(page.locator('#logs')).toContainText('font-canvas-ready')
        const canvas = page.locator('canvas')
        await expect(canvas).toHaveJSProperty('width', 120)
        await expect(canvas).toHaveJSProperty('height', 70)
        // Capture intrinsic pixels; CSS enlargement otherwise resamples this tiny glyph.
        await canvas.evaluate((el) => {
          el.style.width = '120px'
          el.style.height = '70px'
        })
        const sample = async () => {
          const bytes = await canvas.screenshot()
          const pixels = await page.evaluate(
            async (url) => {
              const image = await createImageBitmap(await (await fetch(url)).blob()),
                surface = new OffscreenCanvas(image.width, image.height),
                ctx = surface.getContext('2d')!
              ctx.drawImage(image, 0, 0)
              const pixels = [
                [4.5, 10.5],
                [21.5, 15.5],
                [26.5, 14.5],
              ].map(([x, y]) => [
                ...ctx.getImageData(
                  Math.floor((x! * image.width) / 120),
                  Math.floor((y! * image.height) / 70),
                  1,
                  1,
                ).data,
              ])
              image.close()
              return pixels
            },
            'data:image/png;base64,' + bytes.toString('base64'),
          )
          return { bytes, pixels }
        }
        await expect
          .poll(async () => (await sample()).pixels)
          .toEqual([
            [255, 255, 255, 255],
            [18, 52, 86, 255],
            [18, 52, 86, 255],
          ])
        const result = await sample(),
          path = `${directory}/${name}-${backend}.png`
        await writeFile(path, result.bytes)
        expect(errors).toEqual([])
        results.push({
          browser: name,
          backend,
          cssScale: '1:1',
          pixels: result.pixels,
          screenshot: path,
          errors,
        })
        console.log(`PASS ${name}/${backend}: TTF and pre-rendered glyph pixels`)
      } finally {
        await browser.close()
      }
    }
} finally {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  server.closeAllConnections()
}
expect(await indexHash()).toBe(indexSha256)
await writeFile(
  reportDirectory + '/canvas.json',
  JSON.stringify({ date: new Date().toISOString(), indexSha256, results }, null, 2) + '\n',
)
