// Original KAG exception handler, deliberate Conductor failure and recovery.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, sep, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const root = resolve('dist'),
  directory = process.argv[2] ?? 'out/verification/debug',
  out = directory + '/kag-diagnostics',
  source = await readFile('../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3'),
  indexSha256 = createHash('sha256')
    .update(await readFile(root + '/index.html'))
    .digest('hex'),
  sourceSha256 = createHash('sha256').update(source).digest('hex'),
  results: unknown[] = []
await mkdir(out, { recursive: true })
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost'),
      path = resolve(
        root,
        '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)),
      )
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('missing')
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.json': 'application/json',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
    }
    res.setHeader('content-type', types[extname(path)] ?? 'application/octet-stream')
    res.end(await readFile(path))
  } catch {
    res.writeHead(404).end()
  }
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')
try {
  for (const name of ['chromium', 'firefox', 'webkit'] as const)
    for (const backend of ['asyncify', 'jspi']) {
      const browser = await { chromium, firefox, webkit }[name].launch(),
        context = await browser.newContext({ viewport: { width: 1280, height: 900 } }),
        page = await context.newPage(),
        errors: string[] = [],
        prefix = `${out}/${name}-${backend}`
      page.on('pageerror', (error) => errors.push(error.message))
      await context.tracing.start({
        screenshots: name !== 'webkit',
        snapshots: true,
        sources: true,
      })
      try {
        await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
        await page.locator('#files').setInputFiles([
          { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: source },
          {
            name: 'debug-failure.ks',
            mimeType: 'text/plain',
            buffer: Buffer.from(
              '\ufeff*start\n[eval exp="Debug.notice(\'KAG-diagnostic-context\')"]\n[iscript]\nthrow new Exception("KAG-diagnostic-primary");\n[endscript]\n[s]\n',
            ),
          },
          {
            name: 'debug-recovery.ks',
            mimeType: 'text/plain',
            buffer: Buffer.from(
              '\ufeff*start\n[eval exp="Debug.message(\'KAG-diagnostic-recovered\')"][s]\n',
            ),
          },
        ])
        await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
        const exit = page.locator('.leave-fullscreen')
        if (await exit.isVisible()) await exit.click()
        await evaluate(
          page,
          '(function(){kag.conductor.stop();global.diagnosticSeen=[];Debug.addLoggingHandler(function(line){diagnosticSeen.add(line);});kag.conductor.loadScenario("debug-failure.ks");kag.conductor.startProcess();return 1;})()',
          '1',
        )
        await expect(page.locator('#logs')).toContainText('KAG-diagnostic-primary')
        await expect(page.locator('#status')).toHaveText('运行中')
        await evaluate(page, 'System.eventDisabled', '0')
        await evaluate(page, 'diagnosticSeen.join("\\n").indexOf("KAG-diagnostic-primary")>=0', '1')
        await evaluate(
          page,
          '(function(){kag.conductor.stop();kag.conductor.loadScenario("debug-recovery.ks");kag.conductor.startProcess();return 1;})()',
          '1',
        )
        await expect(page.getByText('KAG-diagnostic-recovered', { exact: true })).toBeVisible()
        await evaluate(page, 'System.eventDisabled', '0')
        await expect(page.locator('#save-status')).toContainText('已保存')
        const [download] = await Promise.all([
            page.waitForEvent('download'),
            page.locator('#export-saves').click(),
          ]),
          backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
            files: { path: string; base64: string }[]
          },
          file = backup.files.find((file) => file.path.endsWith('krkr.console.log'))
        assert(file)
        const bytes = Buffer.from(file.base64, 'base64'),
          text = bytes.toString('utf16le')
        assert.deepEqual([...bytes.subarray(0, 2)], [255, 254])
        assert(text.includes('! KAG-diagnostic-context'))
        assert(text.includes('KAG-diagnostic-primary'))
        assert(text.includes('debug-failure.ks'))
        assert(text.includes('KAG-diagnostic-recovered'))
        assert(!text.includes('Member "logAsError" does not exist'))
        assert.deepEqual(errors, [])
        await writeFile(prefix + '.console.log', bytes)
        await page.screenshot({ path: prefix + '.png', fullPage: true })
        results.push({
          browser: name,
          backend,
          sourceSha256,
          indexSha256,
          errors,
          originalHandler: true,
          primaryLogged: true,
          observersNotified: true,
          recovered: true,
          logPath: file.path,
          log: prefix + '.console.log',
          screenshot: prefix + '.png',
          logSha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        })
        await context.tracing.stop()
        console.log(`PASS ${name}/${backend}: original KAG error logging and recovery`)
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
  assert.equal(
    createHash('sha256')
      .update(await readFile(root + '/index.html'))
      .digest('hex'),
    indexSha256,
  )
  await writeFile(
    directory + '/kag-diagnostics.json',
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        indexSha256,
        sourceSha256,
        results,
      },
      null,
      2,
    ) + '\n',
  )
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
