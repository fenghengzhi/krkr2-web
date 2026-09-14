// Opt-in real Local Font Access probe in an isolated, explicitly permitted context.
// Store counts and pixel presence, never the user's font inventory or font bytes.
import { chromium, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { once } from 'node:events'
import { createHash } from 'node:crypto'

const root = resolve('dist'),
  indexSha256 = createHash('sha256')
    .update(await readFile(root + '/index.html'))
    .digest('hex'),
  server = createServer(async (request, response) => {
    const name = new URL(request.url!, 'http://localhost').pathname.slice(1) || 'index.html'
    if (!/^[\w./-]+$/.test(name) || name.split('/').includes('..')) {
      response.writeHead(404).end()
      return
    }
    try {
      const mime: Record<string, string> = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.json': 'application/json',
        '.css': 'text/css',
        '.wasm': 'application/wasm',
      }
      response.setHeader('content-type', mime[extname(name)] ?? 'application/octet-stream')
      response.end(await readFile(resolve(root, name)))
    } catch {
      response.writeHead(404).end()
    }
  }).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('Missing server address')
const url = `http://127.0.0.1:${address.port}`,
  browser = await chromium.launch(),
  context = await browser.newContext(),
  page = await context.newPage(),
  errors: string[] = []
try {
  await context.grantPermissions(['local-fonts'], { origin: url })
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(url + '/?backend=asyncify')
  const nativeApi = await page.evaluate(() =>
    String((window as unknown as { queryLocalFonts: unknown }).queryLocalFonts).includes(
      '[native code]',
    ),
  )
  expect(nativeApi).toBe(true)
  await page
    .locator('#files')
    .setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'var w=new Window(),a=new Layer(w,null);w.visible=true;a.font.doUserSelect(fsfTrueTypeOnly|fsfIgnoreSymbol|fsfNoVertical,"Real local fonts","Choose","ABCD");Debug.message("native-local-font-selected");',
      ),
    })
  const dialog = page.getByRole('dialog', { name: 'Real local fonts', exact: true })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('option')).toHaveCount(0)
  await dialog.getByRole('button', { name: '读取本机字体', exact: true }).click()
  await expect(dialog.getByRole('status')).toHaveText('字体列表已更新。', { timeout: 60000 })
  const filteredFamilies = await dialog.getByRole('option').count()
  expect(filteredFamilies).toBeGreaterThan(0)
  await expect(dialog.locator('.font-sample')).toHaveAttribute('data-font-face', /./)
  const rendered = await dialog.locator('.font-sample').evaluate((canvas) => {
    const c = canvas as HTMLCanvasElement,
      pixels = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data
    return pixels.some((v, i) => i % 4 === 3 && v > 0)
  })
  expect(rendered).toBe(true)
  await dialog.getByRole('button', { name: '确定', exact: true }).click()
  await expect(page.getByText('native-local-font-selected', { exact: true })).toBeVisible()
  await page.locator('#stop').click()
  expect(errors).toEqual([])
  const result = {
    verifiedAt: new Date().toISOString(),
    browser: await browser.version(),
    indexSha256,
    nativeApi,
    filteredFamilies,
    rendered,
    selected: true,
    errors,
    scope:
      'Real Chromium Local Font Access in an isolated test context with local-fonts permission granted. No font names or bytes retained; does not verify the human permission prompt.',
  }
  await writeFile(
    'out/verification/font-selection/local-fonts.json',
    JSON.stringify(result, null, 2) + '\n',
  )
  console.log(JSON.stringify(result))
} finally {
  await browser.close()
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  )
}
