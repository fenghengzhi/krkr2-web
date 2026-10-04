// Two backend templates per browser (six cases in the full compatibility matrix).
// The fixed original XP3 is imported byte-for-byte, alongside the existing save
// scenario. Its MainWindow methods, selector calls and bookmark serializer are
// neither replaced nor recompiled as a supposed original bytecode fixture.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { chromium, firefox, webkit, expect, type Browser, type Page } from '@playwright/test'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'
import { probeBrowsers } from '../helpers/probe-browsers.ts'

type Backup = { gameId: string; files: { path: string; base64: string }[] }
type CaseResult = {
  browser: string
  backend: string
  status: 'not-run' | 'running' | 'passed' | 'failed'
  report: string
  error?: string
}

const root = resolve('dist'),
  directory = resolve(process.argv[2] ?? 'out/verification/compatibility'),
  out = resolve(directory, 'kag-storage-selector'),
  hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  sourcePath = process.env.KRKR_KAG_FIXTURE ?? 'tests/fixtures/compatibility/kag3_template.xp3',
  source = await readFile(sourcePath),
  sourceSha256 = hash(source),
  scenario = await readFile('tests/fixtures/kag-save.ks'),
  pair = JSON.parse(await readFile('tests/fixtures/compatibility/kag3_template.zip.json', 'utf8')),
  indexSha256 = hash(await readFile(resolve(root, 'index.html'))),
  observationScript = await readFile(
    new URL('../helpers/worker-observation.js', import.meta.url),
    'utf8',
  ),
  browsers = probeBrowsers(),
  results: CaseResult[] = browsers.flatMap((browser) =>
    ['asyncify', 'jspi'].map((backend) => ({
      browser,
      backend,
      status: 'not-run' as const,
      report: `kag-storage-selector/${browser}-${backend}/report.json`,
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
await writeFile(resolve(out, 'kag3_template.xp3'), source)
provenance.push({
  source: sourcePath,
  artifact: 'kag3_template.xp3',
  bytes: source.length,
  sha256: sourceSha256,
})
for (const [input, output] of [
  ['out/ci/build-info.json', 'build-info.json'],
  ['dist/wasm/manifest.json', 'wasm-manifest.json'],
  ['dist/fonts/manifest.json', 'font-manifest.json'],
  ['dist/sw.js', 'release-service-worker.js'],
  ['tests/fixtures/compatibility/kag3_template.zip.json', 'fixture-manifest.json'],
  ['tests/fixtures/kag-save.ks', 'kag-save.ks'],
] as const) {
  const bytes = await readFile(input)
  await writeFile(resolve(out, output), bytes)
  provenance.push({ source: input, artifact: output, bytes: bytes.length, sha256: hash(bytes) })
}
const saveSummary = () =>
  writeFile(
    resolve(directory, 'kag-storage-selector.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        sourceSha256,
        scenarioSha256: hash(scenario),
        indexSha256,
        sourceForm: 'original XP3 source; no bytecode claim',
        methods: ['kag.saveBookMarkToFileWithAsk', 'kag.loadBookMarkFromFileWithAsk'],
        inventory: {
          backendTemplates: 2,
          browsers: ['chromium', 'firefox', 'webkit'],
          expandedCases: 6,
          selectedCases: results.length,
        },
        provenance,
        results,
      },
      null,
      2,
    ) + '\n',
  )
await saveSummary()

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost'),
      path = resolve(
        root,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
      )
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('missing')
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.json': 'application/json',
      '.wasm': 'application/wasm',
      '.png': 'image/png',
      '.svg': 'image/svg+xml',
      '.webmanifest': 'application/manifest+json',
    }
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    response.end(await readFile(path))
  } catch {
    response.writeHead(404).end()
  }
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')

async function readPage(page: Page): Promise<unknown> {
  // Observe only DOM and existing metadata; never queue a TJS request while a
  // selector is holding its continuation. Bound failure collection separately.
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      page
        .evaluate(() => ({
          status: document.querySelector('#status')?.textContent,
          saveStatus: document.querySelector('#save-status')?.textContent,
          logs: document.querySelector('#logs')?.textContent,
          applicationErrors: [...document.querySelectorAll('#logs .error')].map(
            (line) => line.textContent,
          ),
          runtime: document.querySelector('#runtime-info')?.textContent,
          dialogs: [...document.querySelectorAll<HTMLDialogElement>('.game-system-dialog')].map(
            (dialog) => ({
              kind: dialog.dataset.kind,
              requestId: dialog.dataset.requestId,
              open: dialog.open,
              title: dialog.querySelector('h2')?.textContent,
              text: dialog.textContent,
              fields: [
                ...dialog.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input,select'),
              ].map((input) => ({
                id: input.id,
                value: input.value,
                disabled: input.disabled,
              })),
            }),
          ),
          worker: (
            window as unknown as { __krkrWorkerObservation?: () => unknown }
          ).__krkrWorkerObservation?.(),
        }))
        .catch((error) => ({ unavailable: String(error) })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ unavailable: 'read-timeout' }), 3000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

try {
  for (const result of results) {
    const { browser: name, backend } = result,
      prefix = resolve(out, `${name}-${backend}`),
      filename = `Selector-${name}-${backend}-雪`,
      savePath = `savedata/${filename}.kdt`,
      canonical = `game://./${savePath}`,
      errors: string[] = [],
      browserConsole: unknown[] = [],
      events: unknown[] = [],
      evidenceErrors: string[] = [],
      steps: string[] = []
    let browser: Browser | undefined,
      page: Page | undefined,
      tracing = false,
      evaluation = 0,
      freshBrowserContext = false
    result.status = 'running'
    await mkdir(prefix, { recursive: true })
    await saveSummary()
    const event = (kind: string, data: unknown) =>
      events.push({ at: new Date().toISOString(), kind, data })
    const collect = async (label: string, screenshot = true) => {
      assert(page)
      const state = await readPage(page)
      await writeFile(resolve(prefix, `${label}.json`), JSON.stringify(state, null, 2) + '\n')
      if (screenshot)
        await page.screenshot({
          path: resolve(prefix, `${label}.png`),
          fullPage: true,
          timeout: 5000,
        })
      assert(
        state && typeof state === 'object' && !('unavailable' in state),
        'Page evidence must remain readable',
      )
      assert.deepEqual(
        (state as { applicationErrors: unknown }).applicationErrors,
        [],
        'Application errors, including Stop cleanup errors, must remain empty',
      )
      const observer = (
        state as { worker?: { installed?: boolean; dropped?: number; observationErrors?: number } }
      ).worker
      assert(observer, 'Real Worker metadata observer must be available')
      assert.equal(observer?.installed, true, 'Real Worker metadata observer must be installed')
      assert.equal(observer.dropped, 0, 'Worker observation must not silently drop events')
      assert.equal(
        observer.observationErrors,
        0,
        'Worker observation must not silently lose metadata',
      )
    }
    const begin = async (expression: string) => {
      assert(page)
      const marker = `selector-kag-${++evaluation}:`,
        code = `${JSON.stringify(marker)}+string(${expression})`
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      await page.locator('#expression').fill(code)
      await expect(page.locator('#expression')).toHaveValue(code)
      event('evaluate-request', { marker, expression })
      await page.locator('#evaluate').click()
      return marker
    }
    const finish = async (marker: string, expected: string) => {
      assert(page)
      const line = page
        .locator('#logs p span')
        .filter({ hasText: new RegExp('^' + marker) })
        .last()
      await expect(line).toBeVisible({ timeout: 10000 })
      const value = ((await line.textContent()) ?? '').slice(marker.length)
      event('evaluate-result', { marker, value, expected })
      assert.equal(value, expected)
    }
    const evaluate = async (expression: string, expected: string) =>
      finish(await begin(expression), expected)
    const exportBackup = async (label: string): Promise<Backup> => {
      assert(page)
      await expect(page.locator('#export-saves')).toBeEnabled()
      const [download] = await Promise.all([
          page.waitForEvent('download'),
          page.locator('#export-saves').click(),
        ]),
        path = await download.path()
      assert(path, 'A real backup download is required')
      const bytes = await readFile(path),
        backup = JSON.parse(bytes.toString('utf8')) as Backup
      await writeFile(resolve(prefix, `${label}-backup.json`), bytes)
      event('backup', {
        label,
        gameId: backup.gameId,
        bytes: bytes.length,
        sha256: hash(bytes),
        files: backup.files.map((file) => {
          const data = Buffer.from(file.base64, 'base64')
          return { path: file.path, bytes: data.length, sha256: hash(data) }
        }),
      })
      return backup
    }
    const ready = async () => {
      assert(page)
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(page.locator('#stage')).not.toHaveClass(/window-fullscreen/)
      await expect(page.locator('#status')).toHaveText('运行中')
    }
    const openBookmark = async (label: string, defaultName: boolean) => {
      assert(page)
      const marker = await begin(
          '(function(){kag.loadBookMarkFromFileWithAsk();return kag.lastSaveDataNameGlobal+"|"+f.saved;})()',
        ),
        dialog = page.getByRole('dialog', { name: 'Follow Bookmark', exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveAttribute('data-kind', 'storage-selector')
      await expect(dialog.getByLabel('目录', { exact: true })).toHaveValue('game://./savedata/')
      await expect(dialog.getByLabel('文件类型', { exact: true })).toHaveValue('1')
      if (defaultName)
        await expect(dialog.getByLabel('文件名', { exact: true })).toHaveValue(filename + '.kdt')
      const entry = dialog.getByRole('button', { name: filename + '.kdt', exact: true })
      await expect(entry).toBeVisible()
      await expect(entry).toHaveAttribute('data-entry-name', canonical)
      await entry.click()
      await expect(dialog.getByLabel('文件名', { exact: true })).toHaveValue(filename + '.kdt')
      await collect(label + '-open-dialog')
      await dialog.getByRole('button', { name: '打开', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await finish(marker, canonical + '|7')
      await evaluate('f.saved', '7')
      steps.push(label + '-restored')
      await collect(label + '-restored')
    }
    try {
      browser = await { chromium, firefox, webkit }[name as 'chromium'].launch(browserLaunchOptions)
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      freshBrowserContext = true
      page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) =>
        browserConsole.push({
          at: new Date().toISOString(),
          type: message.type(),
          text: message.text(),
        }),
      )
      await context.addInitScript({ content: observationScript })
      await context.tracing.start({
        screenshots: name !== 'webkit',
        snapshots: true,
        sources: true,
      })
      tracing = true
      await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
      const files = [
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: source },
        { name: 'save-verification.ks', mimeType: 'text/plain', buffer: scenario },
      ]
      await page.locator('#files').setInputFiles(files)
      await ready()
      await evaluate(
        '[kag.saveThumbnail,kag.saveDataMode,Storages.getFullPath(System.dataPath),kag.lastSaveDataNameGlobal].join("|")',
        '0||game://./savedata/|',
      )
      await evaluate(
        '(function(){kag.conductor.stop();kag.conductor.loadScenario("save-verification.ks");kag.conductor.startProcess();return 1;})()',
        '1',
      )
      await expect(page.locator('#logs')).toContainText('save=ready:7')
      const before = await exportBackup('before-first-save-as')
      // The unmodified KAG constructor saves these two system dictionaries.
      // No numbered bookmark or test-created directory seed precedes Save As.
      assert.deepEqual(before.files.map((file) => file.path).sort(), [
        'savedata/datasc.ksd',
        'savedata/datasu.ksd',
      ])
      assert(
        !before.files.some((file) => file.path === savePath),
        'First Save As must target a new file',
      )
      await evaluate(`Storages.isExistentStorage(${JSON.stringify(canonical)})`, '0')
      await collect('before-first-save-as')
      steps.push('fresh-context-before-first-save-as')

      const marker = await begin(
          `(function(){kag.saveBookMarkToFileWithAsk();return kag.lastSaveDataNameGlobal+"|"+Storages.isExistentStorage(${JSON.stringify(canonical)})+"|"+f.saved;})()`,
        ),
        dialog = page.getByRole('dialog', { name: 'Place Bookmark', exact: true })
      await expect(dialog).toBeVisible()
      await expect(dialog).toHaveAttribute('data-kind', 'storage-selector')
      await expect(dialog.getByLabel('目录', { exact: true })).toHaveValue('game://./savedata/')
      await expect(dialog.getByLabel('文件类型', { exact: true })).toHaveValue('1')
      await expect(dialog.getByLabel('文件名', { exact: true })).toHaveValue('Checkpoint')
      await dialog.getByLabel('文件名', { exact: true }).fill(filename)
      await collect('save-as-dialog')
      await dialog.getByRole('button', { name: '保存', exact: true }).click()
      await expect(dialog).toHaveCount(0)
      await finish(marker, canonical + '|1|7')
      await evaluate(`Scripts.evalStorage(${JSON.stringify(canonical)}).user.saved`, '7')
      await expect(page.locator('#save-status')).toContainText('已保存')
      const saved = await exportBackup('after-save-as'),
        file = saved.files.find((file) => file.path === savePath)
      assert(file, 'Original KAG Save As must actually write the selected file')
      const bytes = Buffer.from(file.base64, 'base64')
      assert.deepEqual([...bytes.subarray(0, 2)], [255, 254])
      const decoded = bytes.subarray(2).toString('utf16le')
      assert.match(decoded, /"saved"\s*=>\s*7\b/)
      await writeFile(resolve(prefix, 'saved-target.kdt'), bytes)
      await writeFile(resolve(prefix, 'saved-target-decoded.txt'), decoded)
      event('original-kag-save-written', {
        canonical,
        path: savePath,
        bytes: bytes.length,
        sha256: hash(bytes),
      })
      steps.push('original-save-as-persisted')

      await evaluate(
        '(function(){kag.conductor.goToLabel("*changed");kag.conductor.startProcess();return 1;})()',
        '1',
      )
      await expect(page.locator('#logs')).toContainText('save=changed:99')
      await evaluate('f.saved', '99')
      await openBookmark('same-session', true)
      await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await collect('before-reload-stopped')
      await page.reload()
      await page.locator('#files').setInputFiles(files)
      await ready()
      const recovered = await exportBackup('after-reload'),
        recoveredFile = recovered.files.find((file) => file.path === savePath)
      assert.equal(recovered.gameId, saved.gameId)
      assert(recoveredFile, 'The selected file must survive Stop and a document reload')
      assert.deepEqual(Buffer.from(recoveredFile.base64, 'base64'), bytes)
      await evaluate(
        `(function(){kag.conductor.stop();f.saved=99;return Storages.isExistentStorage(${JSON.stringify(canonical)})+"|"+f.saved;})()`,
        '1|99',
      )
      await openBookmark('after-reload', false)
      const restored = await exportBackup('after-reload-open')
      assert.deepEqual(
        Buffer.from(restored.files.find((file) => file.path === savePath)!.base64, 'base64'),
        bytes,
      )
      assert.deepEqual(errors, [])
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-system-dialog')).toHaveCount(0)
      await expect(page.locator('.game-window')).toHaveCount(0)
      await collect('final-stopped')
      steps.push('stop-releases-ui')
      result.status = 'passed'
    } catch (error) {
      result.status = 'failed'
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(`FAIL ${name}/${backend}: ${result.error}`)
    } finally {
      if (page)
        await collect('final').catch((error) => evidenceErrors.push('final-page: ' + String(error)))
      if (tracing && page)
        await page
          .context()
          .tracing.stop({ path: resolve(prefix, 'trace.zip') })
          .catch((error) => evidenceErrors.push('trace: ' + String(error)))
      await browser
        ?.close()
        .catch((error) => evidenceErrors.push('browser-close: ' + String(error)))
      // Missing evidence is visible and cannot silently turn a failed collection
      // into a passing case. Preserve partial data from every attempted case.
      if ((evidenceErrors.length || errors.length) && result.status === 'passed') {
        result.status = 'failed'
        result.error = 'Late page or evidence errors: ' + [...errors, ...evidenceErrors].join('; ')
      }
      await writeFile(resolve(prefix, 'events.json'), JSON.stringify(events, null, 2) + '\n')
      await writeFile(
        resolve(prefix, 'browser-console.json'),
        JSON.stringify(browserConsole, null, 2) + '\n',
      )
      await writeFile(
        resolve(prefix, 'report.json'),
        JSON.stringify(
          {
            ...result,
            sourceSha256,
            scenarioSha256: hash(scenario),
            indexSha256,
            canonical,
            savePath,
            errors,
            evidenceErrors,
            steps,
            originalMethods: true,
            originalXp3Bytes: true,
            freshBrowserContext,
            observedWithoutError: result.status === 'passed',
          },
          null,
          2,
        ) + '\n',
      )
      await saveSummary()
      if (result.status === 'passed')
        console.log(
          `PASS ${name}/${backend}: original KAG Save As, same-session Open and persistent Open after reload`,
        )
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
        files.push({
          path: relative(directory, file).split(sep).join('/'),
          bytes: bytes.length,
          sha256: hash(bytes),
        })
      }
    }
  }
  await inventory(out)
  const summary = await readFile(resolve(directory, 'kag-storage-selector.json'))
  files.push({ path: 'kag-storage-selector.json', bytes: summary.length, sha256: hash(summary) })
  files.sort((a, b) => a.path.localeCompare(b.path))
  await writeFile(
    resolve(out, 'artifact-manifest.json'),
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        githubRun: process.env.GITHUB_RUN_ID,
        githubSha: process.env.GITHUB_SHA,
        sourceSha256,
        indexSha256,
        files,
      },
      null,
      2,
    ) + '\n',
  )
}
if (results.some((result) => result.status !== 'passed')) process.exitCode = 1
