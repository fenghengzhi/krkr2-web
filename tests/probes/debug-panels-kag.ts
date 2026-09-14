import { probeBrowsers } from '../helpers/probe-browsers.ts'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'
// Use the template's own menu objects, handlers and keyboard shortcuts.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const out = process.argv[2] ?? 'out/verification/debug-panels',
  root = resolve('dist'),
  source = await readFile(
    process.env.KRKR_KAG_FIXTURE ?? '../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3',
  ),
  digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex'),
  sourceSha256 = digest(source),
  indexSha256 = digest(await readFile(root + '/index.html')),
  results: unknown[] = []
await mkdir(out + '/kag-panels', { recursive: true })
const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname.slice(1) || 'index.html'
  if (!/^[a-zA-Z0-9_./-]+$/.test(path) || path.split('/').includes('..')) {
    res.writeHead(404).end()
    return
  }
  try {
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
      '.json': 'application/json',
    }
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(await readFile(resolve(root, path)))
  } catch {
    res.writeHead(404).end()
  }
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')
try {
  for (const name of probeBrowsers())
    for (const backend of ['asyncify', 'jspi']) {
      const browser = await { chromium, firefox, webkit }[name].launch(browserLaunchOptions),
        context = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
        page = await context.newPage(),
        errors: string[] = [],
        prefix = `${out}/kag-panels/${name}-${backend}`
      page.on('pageerror', (error) => errors.push(error.message))
      await context.tracing.start({
        screenshots: name !== 'webkit',
        snapshots: true,
        sources: true,
      })
      try {
        await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
        await page.locator('#files').setInputFiles({
          name: 'kag3_template.xp3',
          mimeType: 'application/octet-stream',
          buffer: source,
        })
        await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
        const exit = page.locator('.leave-fullscreen')
        if (await exit.isVisible()) await exit.click()
        await evaluate(
          page,
          '(function(){kag.conductor.stop();kag.debugMenu.visible=true;kag.debugMenu.enabled=true;kag.showConsoleMenuItem.visible=true;kag.showConsoleMenuItem.enabled=true;kag.showControllerMenuItem.visible=true;kag.showControllerMenuItem.enabled=true;return 1;})()',
          '1',
        )
        await page
          .locator('#expression')
          .fill('Debug.console.visible=false,Debug.controller.visible=false')
        await page.locator('#evaluate').click()
        await expect(page.locator('#debug-console')).toBeHidden()
        await expect(page.locator('#debug-controller')).toBeHidden()
        const menu = page.locator('#game-menus')
        await menu
          .locator('summary')
          .filter({ hasText: /^Debug$/ })
          .click()
        await menu.getByRole('button', { name: /^Console/ }).click()
        await expect(page.locator('#debug-console')).toBeVisible()
        await expect(page.locator('#debug-controller')).toBeHidden()
        await evaluate(page, '[Debug.console.visible,Debug.controller.visible].join("|")', '1|0')
        await menu
          .locator('summary')
          .filter({ hasText: /^Debug$/ })
          .click()
        await menu.getByRole('button', { name: /^Controller/ }).click()
        await expect(page.locator('#debug-controller')).toBeVisible()
        await evaluate(page, 'Debug.controller.visible', '1')
        await page.locator('#hide-console').click()
        await page.locator('#toggle-controller').click()
        await page.locator('canvas').focus()
        await page.keyboard.press('Shift+F4')
        await expect(page.locator('#debug-console')).toBeVisible()
        await page.keyboard.press('Shift+F1')
        await expect(page.locator('#debug-controller')).toBeVisible()
        await evaluate(page, '[Debug.console.visible,Debug.controller.visible].join("|")', '1|1')
        assert.deepEqual(errors, [])
        await page.screenshot({ path: prefix + '.png', fullPage: true })
        results.push({
          browser: name,
          backend,
          originalMenuHandlers: true,
          originalShortcuts: true,
          independentVisibility: true,
          errors,
          screenshot: prefix + '.png',
        })
        await context.tracing.stop()
        console.log(`PASS ${name}/${backend}: original KAG debug menus and shortcuts`)
      } catch (error) {
        await page.screenshot({ path: prefix + '-failure.png', fullPage: true }).catch(() => {})
        await writeFile(
          prefix + '-failure.txt',
          await page
            .locator('#logs')
            .innerText()
            .catch(() => ''),
        )
        await context.tracing.stop({ path: prefix + '.zip' })
        throw error
      } finally {
        await browser.close()
      }
    }
  assert.equal(digest(await readFile(root + '/index.html')), indexSha256)
  await writeFile(
    out + '/kag-panels.json',
    JSON.stringify(
      { verifiedAt: new Date().toISOString(), sourceSha256, indexSha256, results },
      null,
      2,
    ) + '\n',
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
