// Exercise the fixed original XP3's Help > Index menu and its original method.
// Only visibility/enabled state changes; neither command nor handler is replaced.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { chromium, firefox, webkit, expect, type Browser, type Page } from '@playwright/test'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'
import { probeBrowsers } from '../helpers/probe-browsers.ts'

type CaseResult = {
  browser: 'chromium' | 'firefox' | 'webkit'
  backend: string
  status: 'not-run' | 'running' | 'passed' | 'failed'
  report: string
  error?: string
}
assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run KAG help verification on GitHub Actions')
const root = resolve('dist'),
  directory = resolve(process.argv[2] ?? 'out/verification/compatibility'),
  out = resolve(directory, 'kag-help'),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  sourcePath = process.env.KRKR_KAG_FIXTURE ?? 'tests/fixtures/compatibility/kag3_template.xp3',
  source = await readFile(sourcePath),
  sourceSha256 = hash(source),
  pair = JSON.parse(await readFile('tests/fixtures/compatibility/kag3_template.zip.json', 'utf8')),
  indexSha256 = hash(await readFile(resolve(root, 'index.html'))),
  observationScript = await readFile(new URL('../helpers/worker-observation.js', import.meta.url), 'utf8'),
  results: CaseResult[] = probeBrowsers().flatMap((browser) =>
    ['asyncify', 'jspi'].map((backend) => ({
      browser, backend, status: 'not-run' as const, report: `kag-help/${browser}-${backend}/report.json`,
    })),
  )
assert.equal(sourceSha256, '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
assert.equal(sourceSha256, pair.sourceSha256)
assert.equal(
  pair.entries.find((entry: { name: string }) => entry.name === 'system/MainWindow.tjs')?.sha256,
  '8f850acfd1c87b77bb37c792e9f80630f4a15f9c5bd0d9aafce5ce59cfedcea7',
)
await mkdir(out, { recursive: true })
const provenance: { source: string; artifact: string; bytes: number; sha256: string }[] = []
for (const [input, artifact] of [
  [sourcePath, 'kag3_template.xp3'],
  ['tests/fixtures/compatibility/kag3_template.zip', 'kag3_template.zip'],
  ['tests/fixtures/compatibility/kag3_template.zip.json', 'fixture-manifest.json'],
  ['out/ci/build-info.json', 'build-info.json'],
  ['dist/wasm/manifest.json', 'wasm-manifest.json'],
  ['dist/fonts/manifest.json', 'font-manifest.json'],
  ['dist/index.html', 'release-index.html'],
  ['dist/sw.js', 'release-service-worker.js'],
  ['tests/probes/help-kag.ts', 'help-kag.ts'],
  ['tests/helpers/worker-observation.js', 'worker-observation.js'],
] as const) {
  const bytes = await readFile(input)
  if (artifact === 'kag3_template.zip') assert.equal(hash(bytes), pair.zipSha256)
  if (artifact === 'wasm-manifest.json')
    assert.equal(JSON.parse(bytes.toString('utf8')).capabilities?.nativeHelp, 1)
  await writeFile(resolve(out, artifact), bytes)
  provenance.push({ source: input, artifact, bytes: bytes.length, sha256: hash(bytes) })
}
const saveSummary = () => writeFile(resolve(directory, 'kag-help.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), sourceSha256, indexSha256,
  sourceForm: 'original XP3 source; no bytecode claim',
  method: 'kag.onHelpIndexMenuItemClick', menu: 'kag.helpIndexMenuItem',
  inventory: { backendTemplates: 2, browsers: ['chromium', 'firefox', 'webkit'], expandedCases: 6, selectedCases: results.length },
  provenance, results,
}, null, 2) + '\n')
await saveSummary()

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost'),
      path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('missing')
    const types: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png',
      '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json',
    }
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    response.end(await readFile(path))
  } catch { response.writeHead(404).end() }
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')

async function pageState(page: Page): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      page.evaluate(() => ({
        status: document.querySelector('#status')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        applicationErrors: [...document.querySelectorAll('#logs .error')].map((line) => line.textContent),
        runtime: document.querySelector('#runtime-info')?.textContent,
        help: [...document.querySelectorAll('.game-help')].map((panel) => ({
          title: panel.querySelector('.game-help-title')?.textContent,
          path: panel.querySelector('.game-help-path')?.textContent,
          text: panel.querySelector('.game-help-text')?.textContent,
        })),
        worker: (window as unknown as { __krkrWorkerObservation?: () => unknown }).__krkrWorkerObservation?.(),
      })).catch((error) => ({ unavailable: String(error) })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ unavailable: 'read-timeout' }), 3000) }),
    ])
  } finally { clearTimeout(timer) }
}

let evaluation = 0
async function evaluate(page: Page, expression: string, expected: string): Promise<void> {
  const marker = `help-kag-result-${++evaluation}:`,
    source = `${JSON.stringify(marker)}+string(${expression})`,
    field = page.locator('#expression')
  await expect(page.locator('#evaluate')).toBeEnabled()
  await field.fill(source)
  await expect(field).toHaveValue(source)
  // Submit the real console form by keyboard. A long nonmodal help panel may
  // cover the right edge of the console without blocking keyboard access.
  await field.press('Enter')
  await expect(page.getByText(marker + expected, { exact: true })).toBeVisible()
}

try {
  for (const result of results) {
    const { browser: name, backend } = result,
      prefix = resolve(out, `${name}-${backend}`),
      errors: string[] = [], evidenceErrors: string[] = [], steps: string[] = [],
      browserConsole: unknown[] = [], events: unknown[] = [],
      workers: { url: string; closed: boolean }[] = [],
      body = (session: string) => [
        `Original KAG Help / ${name} / ${backend} / ${session}`,
        '帮助文档 雪 🌸 — 原始菜单调用',
        '<script>window.__kagHelpMarkupExecuted=true</script>',
        '<img src="must-not-load.png"> & <b>literal text</b>',
        '',
        ...Array.from({ length: 35 }, (_, index) => `Line ${index + 1}: selectable, scrollable text.`),
        `End of ${session}.`, '',
      ].join('\n'),
      firstText = body('first-session'), freshText = body('fresh-session'),
      firstBytes = Buffer.from('\ufeff' + firstText), freshBytes = Buffer.from('\ufeff' + freshText)
    let browser: Browser | undefined, page: Page | undefined, tracing = false
    result.status = 'running'
    await mkdir(prefix, { recursive: true })
    await writeFile(resolve(prefix, 'readme-first.txt'), firstBytes)
    await writeFile(resolve(prefix, 'readme-fresh.txt'), freshBytes)
    await saveSummary()
    const record = (kind: string, data: unknown) => events.push({ at: new Date().toISOString(), kind, data })
    const collect = async (label: string) => {
      assert(page)
      const state = await pageState(page)
      await writeFile(resolve(prefix, `${label}.json`), JSON.stringify(state, null, 2) + '\n')
      await page.screenshot({ path: resolve(prefix, `${label}.png`), fullPage: true, timeout: 5000 })
      assert(state && typeof state === 'object' && !('unavailable' in state), 'Readable DOM evidence is required')
      assert.deepEqual((state as { applicationErrors: unknown }).applicationErrors, [])
      const worker = (state as { worker?: { installed: boolean; dropped: number; observationErrors: number } }).worker
      assert(worker?.installed, 'Real Worker metadata observation is required')
      assert.equal(worker.dropped, 0)
      assert.equal(worker.observationErrors, 0)
      record('capture', label)
    }
    const input = (bytes: Buffer) => [
      { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: source },
      { name: 'readme.txt', mimeType: 'text/plain', buffer: bytes },
    ]
    const ready = async () => {
      assert(page)
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('.game-help')).toHaveCount(0)
      await evaluate(page,
        '(function(){kag.conductor.stop();global.helpKagOriginalCommand=kag.helpIndexMenuItem.command;global.helpKagOriginalHandler=kag.onHelpIndexMenuItemClick;kag.helpMenu.visible=true;kag.helpMenu.enabled=true;kag.helpMenu.accessible=true;kag.helpIndexMenuItem.visible=true;kag.helpIndexMenuItem.enabled=true;kag.helpIndexMenuItem.accessible=true;return kag.helpFile;})()',
        'readme.txt')
    }
    const openMenu = async (expectedText: string, label: string) => {
      assert(page)
      const menu = page.locator('#game-menus')
      await menu.locator('summary').filter({ hasText: /^Help$/ }).click()
      await menu.getByRole('button', { name: /^Index/ }).click()
      const panel = page.locator('.game-help'), text = panel.locator('.game-help-text')
      await expect(panel).toHaveCount(1)
      await expect(panel).toBeVisible()
      await expect(panel.locator('.game-help-title')).toHaveText('readme.txt')
      await expect(panel.locator('.game-help-path')).toHaveText('game://./readme.txt')
      await expect(text).toBeVisible()
      assert.equal(await text.textContent(), expectedText, 'Displayed text must equal the actual readme bytes after BOM decoding')
      await expect(panel.locator('script,img,b')).toHaveCount(0)
      assert.equal(await page.evaluate(() => (window as unknown as { __kagHelpMarkupExecuted?: boolean }).__kagHelpMarkupExecuted), undefined)
      // This request must finish while the help panel remains open. The real
      // menu handler cannot still be waiting for dismissal on the native stack.
      await evaluate(page,
        '(function(){global.helpKagContinuation=(typeof global.helpKagContinuation=="undefined"?0:global.helpKagContinuation)+1;return (kag.helpIndexMenuItem.command===helpKagOriginalCommand)+"|"+(kag.onHelpIndexMenuItemClick===helpKagOriginalHandler)+"|"+int(global.helpKagContinuation>0);})()',
        '1|1|1')
      await expect(panel).toBeVisible()
      assert.equal(await text.textContent(), expectedText)
      steps.push(label + '-original-menu-visible-and-script-continued')
      await collect(label + '-open')
      const scroll = await text.evaluate((element) => {
        element.scrollTop = element.scrollHeight
        return { top: element.scrollTop, overflow: element.scrollHeight > element.clientHeight, selection: getComputedStyle(element).userSelect }
      })
      assert(scroll.overflow && scroll.top > 0, 'Long real help text must be scrollable')
      assert.equal(scroll.selection, 'text')
      record('help-scroll', { label, ...scroll })
      await collect(label + '-scrolled')
    }
    const stop = async (count: number, label: string) => {
      assert(page)
      const button = page.locator('#stop')
      await expect(button).toBeEnabled()
      await button.focus()
      await button.press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-help')).toHaveCount(0)
      await expect(page.locator('.game-window')).toHaveCount(0)
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect.poll(() => workers.filter((worker) => worker.closed).length).toBe(count)
      await collect(label)
      steps.push(label)
    }
    try {
      browser = await { chromium, firefox, webkit }[name].launch(browserLaunchOptions)
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await context.addInitScript({ content: observationScript })
      page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => browserConsole.push({ at: new Date().toISOString(), type: message.type(), text: message.text() }))
      page.on('worker', (worker) => {
        if (!/\/session\.worker[-.]/.test(new URL(worker.url()).pathname)) return
        const entry = { url: worker.url(), closed: false }
        workers.push(entry)
        worker.on('close', () => { entry.closed = true })
      })
      await context.tracing.start({ screenshots: name !== 'webkit', snapshots: true, sources: true })
      tracing = true
      await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
      await page.locator('#files').setInputFiles(input(firstBytes))
      await ready()
      await collect('first-ready')
      await openMenu(firstText, 'first')
      await page.locator('.game-help-close[data-action=close]').click()
      await expect(page.locator('.game-help')).toHaveCount(0)
      await evaluate(page, 'helpKagContinuation', '1')
      await collect('closed')
      steps.push('close-removes-help-with-session-running')
      await openMenu(firstText, 'reopened')
      const staleClose = await page.locator('.game-help-close[data-action=close]').elementHandle()
      assert(staleClose)
      await stop(1, 'stop-with-help-open')
      await page.locator('#files').setInputFiles(input(freshBytes))
      await ready()
      await evaluate(page, 'typeof global.helpKagContinuation', 'undefined')
      await collect('fresh-ready-without-old-help')
      steps.push('fresh-session-has-no-old-help')
      await openMenu(freshText, 'fresh')
      // Exercise an old detached control after the real new-session document
      // is visible; its disposed listener must not close the current help.
      assert.equal(await staleClose.evaluate((element) => element.isConnected), false)
      await staleClose.evaluate((element) => {
        if (!(element instanceof HTMLButtonElement)) throw new Error('Expected the original help close button')
        element.click()
      })
      await staleClose.dispose()
      await expect(page.locator('.game-help')).toBeVisible()
      assert.equal(await page.locator('.game-help-text').textContent(), freshText)
      await evaluate(page, 'helpKagContinuation', '1')
      await collect('stale-close-cannot-affect-new-session')
      steps.push('stale-close-cannot-affect-new-session')
      assert.equal(workers.length, 2)
      await stop(2, 'final-stop-releases-help')
      assert.deepEqual(errors, [])
      result.status = 'passed'
    } catch (error) {
      result.status = 'failed'
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(`FAIL ${name}/${backend}: ${result.error}`)
    } finally {
      if (page) await collect('final').catch((error) => evidenceErrors.push('final-page: ' + String(error)))
      if (tracing && page)
        await page.context().tracing.stop({ path: resolve(prefix, 'trace.zip') }).catch((error) => evidenceErrors.push('trace: ' + String(error)))
      await browser?.close().catch((error) => evidenceErrors.push('browser-close: ' + String(error)))
      if ((evidenceErrors.length || errors.length) && result.status === 'passed') {
        result.status = 'failed'
        result.error = 'Late page or evidence errors: ' + [...errors, ...evidenceErrors].join('; ')
      }
      await writeFile(resolve(prefix, 'events.json'), JSON.stringify(events, null, 2) + '\n')
      await writeFile(resolve(prefix, 'browser-console.json'), JSON.stringify(browserConsole, null, 2) + '\n')
      await writeFile(resolve(prefix, 'report.json'), JSON.stringify({
        ...result, sourceSha256, indexSha256, errors, evidenceErrors, steps, workers,
        firstInput: { bytes: firstBytes.length, sha256: hash(firstBytes) },
        freshInput: { bytes: freshBytes.length, sha256: hash(freshBytes) },
        originalMenuHandler: true, originalXp3Bytes: true,
        observedWithoutError: result.status === 'passed',
      }, null, 2) + '\n')
      await saveSummary()
      if (result.status === 'passed') console.log(`PASS ${name}/${backend}: original KAG Help menu, continued script and fresh-session cleanup`)
    }
  }
  assert.equal(hash(await readFile(resolve(root, 'index.html'))), indexSha256)
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await saveSummary()
  const files: { path: string; bytes: number; sha256: string }[] = []
  const inventory = async (path: string): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = resolve(path, entry.name)
      if (entry.isDirectory()) await inventory(file)
      else if (entry.isFile() && file !== resolve(out, 'artifact-manifest.json')) {
        const bytes = await readFile(file)
        files.push({ path: relative(directory, file).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) })
      }
    }
  }
  await inventory(out)
  const summary = await readFile(resolve(directory, 'kag-help.json'))
  files.push({ path: 'kag-help.json', bytes: summary.length, sha256: hash(summary) })
  files.sort((a, b) => a.path.localeCompare(b.path))
  await writeFile(resolve(out, 'artifact-manifest.json'), JSON.stringify({
    recordedAt: new Date().toISOString(), githubRun: process.env.GITHUB_RUN_ID,
    githubSha: process.env.GITHUB_SHA, sourceSha256, indexSha256, files,
  }, null, 2) + '\n')
}
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1
