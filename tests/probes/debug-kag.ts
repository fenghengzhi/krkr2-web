import { probeBrowsers } from '../helpers/probe-browsers.ts'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'
// Original KAG exception handler, deliberate Conductor failure and recovery.
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { resolve, sep, extname } from 'node:path'
import { createHash } from 'node:crypto'
import { chromium, firefox, webkit, expect, type Browser, type BrowserContext, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

interface DiagnosticResult {
  browser: string
  backend: string
  status: 'unreported' | 'running' | 'passed' | 'failed'
  error?: string
  evidenceErrors: string[]
  steps: string[]
  [key: string]: unknown
}
const root = resolve('dist'),
  directory = process.argv[2] ?? 'out/verification/debug',
  out = directory + '/kag-diagnostics',
  source = await readFile(
    process.env.KRKR_KAG_FIXTURE ?? '../kirikiroid2-web/tests/test_files/xp3/kag3_template.xp3',
  ),
  indexSha256 = createHash('sha256')
    .update(await readFile(root + '/index.html'))
    .digest('hex'),
  sourceSha256 = createHash('sha256').update(source).digest('hex'),
  results: DiagnosticResult[] = probeBrowsers().flatMap((browser) =>
    ['asyncify', 'jspi'].map((backend) => ({ browser, backend, status: 'unreported' as const,
      evidenceErrors: [], steps: [] }))),
  saveSummary = () => writeFile(directory + '/kag-diagnostics.json', JSON.stringify({
    recordedAt: new Date().toISOString(), indexSha256, sourceSha256, results,
  }, null, 2) + '\n')
await mkdir(out, { recursive: true })
await saveSummary()
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
    for (const result of results) {
      const name = result.browser as 'chromium' | 'firefox' | 'webkit', backend = result.backend,
        errors: string[] = [],
        prefix = `${out}/${name}-${backend}`
      let browser: Browser | undefined, context: BrowserContext | undefined, page: Page | undefined,
        tracing = false
      result.status = 'running'
      await saveSummary()
      try {
        browser = await { chromium, firefox, webkit }[name].launch(browserLaunchOptions)
        context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
        page = await context.newPage()
        page.on('pageerror', (error) => errors.push(error.message))
        await context.tracing.start({ screenshots: name !== 'webkit', snapshots: true, sources: true })
        tracing = true
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
        result.steps.push('original-kag-ready')
        const exit = page.locator('.leave-fullscreen')
        if (await exit.isVisible()) await exit.click()
        await evaluate(
          page,
          '(function(){kag.conductor.stop();global.diagnosticSeen=[];Debug.addLoggingHandler(function(line){diagnosticSeen.add(line);});kag.conductor.loadScenario("debug-failure.ks");kag.conductor.startProcess();return 1;})()',
          '1',
        )
        await expect(page.locator('#logs')).toContainText('KAG-diagnostic-primary')
        result.steps.push('deliberate-conductor-error-logged')
        // The fixed KAG Initialize.tjs handler disables events before calling
        // System.inform(e.message), then restores them only after it returns.
        // Confirm this exact deliberate Conductor error through the real UI;
        // evaluating more TJS here would wait behind the suspended handler.
        const errorMessage = [
            'An error occurred',
            'File: debug-failure.ks   Line: 5',
            'Tag:  ( This may indicate the tag before or after the error )',
            'Error occurred in iscript block starting from line 3 of debug-failure.ks.',
            '( See console for details )',
            'KAG-diagnostic-primary',
          ].join('\n'),
          dialog = page.getByRole('dialog', { name: 'Information', exact: true }),
          owner = page.locator('.game-window'),
          confirm = dialog.getByRole('button', { name: '确定', exact: true })
        await expect(page.locator('.game-system-dialog')).toHaveCount(1)
        await expect(dialog).toBeVisible()
        await expect(dialog).toHaveAttribute('data-kind', 'inform')
        await expect(dialog.getByText(errorMessage, { exact: true })).toBeVisible()
        await expect(dialog.getByRole('textbox')).toHaveCount(0)
        await expect(page.locator('#status')).toHaveText('事件已停止')
        await expect(owner).toHaveCount(1)
        await expect(owner).toHaveAttribute('data-blocked', 'true')
        await expect(owner).toHaveAttribute('aria-disabled', 'true')
        await expect(page.getByText('KAG-diagnostic-recovered', { exact: true })).toHaveCount(0)
        await expect(confirm).toBeEnabled()
        result.steps.push('original-handler-dialog-blocks-owner')
        await page.screenshot({ path: prefix + '-dialog.png', fullPage: true })
        await confirm.click()
        await expect(page.locator('.game-system-dialog')).toHaveCount(0)
        await expect(page.locator('#status')).toHaveText('运行中')
        await expect(owner).toHaveAttribute('data-blocked', 'false')
        await evaluate(page, 'System.eventDisabled', '0')
        result.steps.push('confirmation-restores-events-and-owner')
        await evaluate(page, 'diagnosticSeen.join("\\n").indexOf("KAG-diagnostic-primary")>=0', '1')
        await evaluate(
          page,
          '(function(){kag.conductor.stop();kag.conductor.loadScenario("debug-recovery.ks");kag.conductor.startProcess();return 1;})()',
          '1',
        )
        await expect(page.getByText('KAG-diagnostic-recovered', { exact: true })).toBeVisible()
        result.steps.push('original-conductor-recovers')
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
        result.steps.push('exported-log-retains-primary-and-recovery')
        Object.assign(result, {
          browser: name,
          backend,
          sourceSha256,
          indexSha256,
          errors,
          originalHandler: true,
          originalHandlerDialog: {
            caption: 'Information',
            message: errorMessage,
            eventDisabledWhileOpen: true,
            windowBlockedWhileOpen: true,
            confirmed: true,
            screenshot: prefix + '-dialog.png',
          },
          primaryLogged: true,
          observersNotified: true,
          recovered: true,
          logPath: file.path,
          log: prefix + '.console.log',
          screenshot: prefix + '.png',
          logSha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
        })
        result.status = 'passed'
      } catch (error) {
        result.status = 'failed'
        result.error = error instanceof Error ? error.stack ?? error.message : String(error)
        // Each backend owns its outcome. A failed first backend must not erase
        // its identity or prevent attempting the independent second backend.
        if (page) {
          try { await page.screenshot({ path: prefix + '-failure.png', fullPage: true, timeout: 5000 }) }
          catch (failure) { result.evidenceErrors.push('Failure screenshot: ' + String(failure)) }
          try { await writeFile(prefix + '-failure.txt', await page.locator('#logs').innerText({ timeout: 3000 })) }
          catch (failure) { result.evidenceErrors.push('Failure log: ' + String(failure)) }
        }
      } finally {
        try { if (tracing) await context!.tracing.stop({ path: prefix + '.zip' }) }
        catch (error) { result.evidenceErrors.push('Trace: ' + String(error)) }
        try { await browser?.close() }
        catch (error) { result.evidenceErrors.push('Browser cleanup: ' + String(error)) }
        result.errors = [...errors]
        if (errors.length || result.evidenceErrors.length) result.status = 'failed'
        await saveSummary()
        console.log(`${result.status.toUpperCase()} ${name}/${backend}: original KAG error logging and recovery`)
      }
    }
  assert.equal(
    createHash('sha256')
      .update(await readFile(root + '/index.html'))
      .digest('hex'),
    indexSha256,
  )
  await saveSummary()
  assert(results.every((result) => result.status === 'passed'), 'Original KAG diagnostics did not pass every backend; inspect kag-diagnostics.json')
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
