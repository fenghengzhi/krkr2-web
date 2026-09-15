import { browserLaunchOptions } from '../helpers/browser-launch.ts'
// Opt-in browser verification of a local KAG fixture. The static server serves
// only dist/ and closes with the browser; game bytes enter through file import.
import { createServer } from 'node:http'
import { readFile, stat, mkdir, writeFile } from 'node:fs/promises'
import { resolve, basename, extname, sep } from 'node:path'
import { chromium, firefox, webkit, expect } from '@playwright/test'
import { encodeBmp } from '../../src/formats/image/bmp.ts'
const filename = process.argv[2],
  engine = process.argv[3] ?? 'chromium',
  backend = process.argv[4] ?? 'asyncify',
  mode = process.argv[5] ?? 'startup',
  flow = mode === 'flow',
  saving = mode === 'save',
  transitioning = mode === 'transition'
if (
  !filename ||
  !['chromium', 'firefox', 'webkit'].includes(engine) ||
  !['asyncify', 'jspi'].includes(backend) ||
  !['startup', 'flow', 'save', 'transition'].includes(mode)
)
  throw new Error(
    'Usage: node --import tsx tests/probes/kag-browser.ts fixture.xp3 [chromium|firefox|webkit] [asyncify|jspi] [flow|save|transition]',
  )
const root = resolve('dist'),
  directory = resolve(process.env.KRKR_KAG_OUTPUT ?? 'out/verification'),
  reportName = `${basename(filename, '.xp3')}-${engine}-${backend}${mode === 'startup' ? '' : '-' + mode}`
const files =
  mode !== 'startup'
    ? [
        {
          name: basename(filename),
          mimeType: 'application/octet-stream',
          buffer: await readFile(resolve(filename)),
        },
        {
          name: saving
            ? 'save-verification.ks'
            : transitioning
              ? 'transition-verification.ks'
              : 'input-verification.ks',
          mimeType: 'text/plain',
          buffer: await readFile(
            resolve(
              saving
                ? 'tests/fixtures/kag-save.ks'
                : transitioning
                  ? 'tests/fixtures/kag-transition.ks'
                  : 'tests/fixtures/kag-input.ks',
            ),
          ),
        },
        ...(transitioning
          ? [
              {
                name: 'verification-rule.bmp',
                mimeType: 'image/bmp',
                buffer: Buffer.from(
                  encodeBmp(
                    {
                      width: 2,
                      height: 1,
                      data: new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]),
                    },
                    'bmp24',
                  ),
                ),
              },
            ]
          : []),
      ]
    : resolve(filename)
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1'),
      file = resolve(
        root,
        '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname),
      )
    if (!file.startsWith(root + sep) || !(await stat(file)).isFile()) {
      response.writeHead(404).end()
      return
    }
    const types: Record<string, string> = {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.mjs': 'text/javascript',
      '.css': 'text/css',
      '.wasm': 'application/wasm',
      '.json': 'application/json',
      '.png': 'image/png',
    }
    response.writeHead(200, { 'Content-Type': types[extname(file)] ?? 'application/octet-stream' })
    response.end(await readFile(file))
  } catch {
    response.writeHead(404).end()
  }
})
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
if (!address || typeof address === 'string') throw new Error('No browser probe address')
const browser = await { chromium, firefox, webkit }[engine as 'chromium']
  .launch(browserLaunchOptions)
  .catch(async (error) => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    throw error
  })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } }),
  errors: string[] = []
page.on('pageerror', (error) => errors.push(error.message))
const scriptDebug = process.env.KRKR_KAG_SCRIPT_DEBUG === '1'
await page.context().tracing.start({ screenshots: false, snapshots: true, sources: true })
let report: Record<string, unknown> = {
  fixture: basename(filename),
  browser: engine,
  backend,
  date: new Date().toISOString(),
  observationMs: 1500,
  mode,
  scriptDebug,
}
const steps: string[] = []
let evaluation = 0
async function prepareConsole(): Promise<void> {
  // Running is announced before the KAG constructor restores saved options.
  // Wait for startup to finish before inspecting fullscreen; otherwise its
  // late restoration can cover the console after the visibility check.
  await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 20000 })
  const exit = page.locator('.leave-fullscreen')
  if (await exit.isVisible()) await exit.click()
  await expect(page.locator('#stage')).not.toHaveClass(/window-fullscreen/)
}
async function evaluate(source: string, result: string | RegExp): Promise<string> {
  const prefix = `kag-probe-result-${++evaluation}:`
  await page.locator('#expression').fill(`${JSON.stringify(prefix)}+string(${source})`)
  await page.locator('#evaluate').click()
  const output = page
    .locator('#logs p span')
    .filter({ hasText: new RegExp('^' + prefix) })
    .last()
  await expect(output).toBeVisible({ timeout: 5000 })
  const value = ((await output.textContent()) ?? '').slice(prefix.length)
  if (typeof result === 'string') expect(value).toBe(result)
  else expect(value).toMatch(result)
  return value
}
async function marker(name: string): Promise<void> {
  await expect(page.locator('#logs')).toContainText(`flow=${name}`, { timeout: 5000 })
  // Let the conductor reach the wait following the marker before interacting.
  await new Promise((resolve) => setTimeout(resolve, 100))
  await expect(page.locator('#status')).toHaveText('运行中')
  steps.push(name)
}
try {
  await page.goto(`http://127.0.0.1:${address.port}/?backend=${backend}`)
  if (scriptDebug) await page.locator('#script-debug').check()
  await page.locator('#files').setInputFiles(files)
  await page.waitForFunction(
    () => {
      const text = document.querySelector('#status')?.textContent
      return (
        text === '运行中' ||
        text === '运行失败' ||
        document.querySelector('#logs')?.textContent?.includes('An error occurred')
      )
    },
    {},
    { timeout: 20000 },
  )
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const status = await page.locator('#status').textContent(),
    logs = await page.locator('#logs').innerText()
  report = { ...report, status, logs }
  let conductor: string | undefined
  // Running state can precede completion of KAG's constructor. Wait for the
  // script queue to become available instead of silently skipping the scenario.
  await prepareConsole()
  {
    conductor = await evaluate(
      '"conductor="+kag.conductor.timerEnabled+","+kag.conductor.inProcessing',
      /^conductor=[01],[01]$/,
    )
    if (flow) {
      await evaluate(
        '(function(){kag.conductor.loadScenario("input-verification.ks");kag.conductor.startProcess();return "flow-started";})()',
        'flow-started',
      )
      await marker('line')
      await evaluate(
        '(function(){kag.showHistory();return "history="+kag.historyShowing+","+(kag.currentModalLayer===kag.historyLayer);})()',
        'history=1,1',
      )
      await page.locator('canvas').focus()
      await page.keyboard.press('Escape')
      // DOM key dispatch can finish before the queued TJS input handler runs.
      // Observe the eventual state; a single console query can legitimately see 1.
      await expect
        .poll(() => evaluate('"history="+kag.historyShowing', /^history=[01]$/), { timeout: 5000 })
        .toBe('history=0')
      steps.push('history')
      await page.locator('canvas').click()
      await marker('page')
      await page.locator('canvas').focus()
      // KAG intentionally checks the physical key state to discard queued
      // keyDown events whose key has already been released.
      await page.keyboard.down('Enter')
      try {
        await marker('link')
      } finally {
        await page.keyboard.up('Enter')
      }
      const bounds = (await page.locator('canvas').boundingBox())!
      await page
        .locator('canvas')
        .click({ position: { x: (bounds.width * 40) / 640, y: (bounds.height * 44) / 480 } })
      await marker('choice')
    }
    if (saving) {
      await evaluate(
        '(function(){kag.conductor.loadScenario("save-verification.ks");kag.conductor.startProcess();return "save-started";})()',
        'save-started',
      )
      await expect(page.locator('#logs')).toContainText('save=ready:7')
      await evaluate('"plain-save="+kag.saveBookMark(0)', 'plain-save=1')
      steps.push('plain-save')
      await evaluate(
        '(function(){kag.conductor.goToLabel("*changed");kag.conductor.startProcess();return "changed-started";})()',
        'changed-started',
      )
      await expect(page.locator('#logs')).toContainText('save=changed:99')
      await evaluate('"plain-load="+kag.loadBookMark(0)', 'plain-load=1')
      await evaluate('"restored="+f.saved', 'restored=7')
      steps.push('plain-load')
      for (const depth of [8, 24]) {
        await evaluate(
          `(function(){kag.saveThumbnail=true;kag.thumbnailDepth=${depth};return "thumbnail-save-${depth}="+kag.saveBookMark(${depth});})()`,
          `thumbnail-save-${depth}=1`,
        )
        steps.push(`thumbnail-${depth}`)
      }
      const pendingDownload = page.waitForEvent('download')
      await page.locator('#export-saves').click()
      const download = await pendingDownload
      const backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
        files: { path: string; base64: string }[]
      }
      const thumbnails = backup.files.flatMap((file) => {
        const bytes = Buffer.from(file.base64, 'base64')
        if (bytes.length < 2 || bytes.readUInt16LE(0) !== 0x4d42) return []
        const size = bytes.readUInt32LE(2),
          width = bytes.readInt32LE(18),
          height = bytes.readInt32LE(22),
          depth = bytes.readUInt16LE(28),
          offset = bytes.readUInt32LE(10)
        expect(size).toBe(offset + Math.ceil((width * depth) / 32) * 4 * height)
        expect(bytes.length).toBeGreaterThan(size)
        expect(bytes.subarray(offset, size).some((value) => value !== 0)).toBe(true)
        return [
          { path: file.path, depth, width, height, bitmapBytes: size, savedBytes: bytes.length },
        ]
      })
      expect(thumbnails.map((image) => image.depth).sort((a, b) => a - b)).toEqual([8, 24])
      report.thumbnails = thumbnails
      report.beforeReloadLogs = await page.locator('#logs').innerText()
      await page.reload()
      await page.locator('#files').setInputFiles(files)
      await expect(page.locator('#status')).toHaveText('运行中', { timeout: 20000 })
      await prepareConsole()
      await evaluate(
        '(function(){kag.saveThumbnail=true;kag.thumbnailDepth=8;return "reload-load="+kag.loadBookMark(8);})()',
        'reload-load=1',
      )
      await evaluate('"reload-value="+f.saved', 'reload-value=7')
      steps.push('reload')
    }
    if (transitioning) {
      await evaluate(
        '(function(){kag.conductor.loadScenario("transition-verification.ks");kag.conductor.startProcess();return "transition-started";})()',
        'transition-started',
      )
      for (const [kind, color] of [
        ['crossfade', 255],
        ['scroll', 65280],
        ['universal', 16711680],
      ] as const) {
        await expect(page.locator('#logs')).toContainText(`transition=${kind}:${color}`, {
          timeout: 10000,
        })
        steps.push(kind)
      }
      await expect(page.locator('#logs')).toContainText('transition=done')
      steps.push('done')
    }
  }
  const finalStatus = await page.locator('#status').textContent(),
    finalLogs = await page.locator('#logs').innerText()
  report = {
    ...report,
    status: finalStatus,
    logs: finalLogs,
    conductor,
    steps,
    errors,
    observedWithoutError:
      finalStatus === '运行中' &&
      !errors.length &&
      !(await page.locator('#logs .error').count()) &&
      (!flow || steps.join(',') === 'line,history,page,link,choice') &&
      (!saving || steps.join(',') === 'plain-save,plain-load,thumbnail-8,thumbnail-24,reload') &&
      (!transitioning || steps.join(',') === 'crossfade,scroll,universal,done'),
  }
  await mkdir(directory, { recursive: true })
  await page.screenshot({
    path: resolve(directory, `${reportName}.png`),
    fullPage: true,
  })
} catch (error) {
  report = {
    ...report,
    errors,
    steps,
    status: await page
      .locator('#status')
      .textContent()
      .catch(() => undefined),
    logs: await page
      .locator('#logs')
      .innerText()
      .catch(() => undefined),
    error: error instanceof Error ? error.message : String(error),
    observedWithoutError: false,
  }
  await mkdir(directory, { recursive: true })
  await page
    .screenshot({ path: resolve(directory, `${reportName}.png`), fullPage: true })
    .catch(() => {})
} finally {
  await mkdir(directory, { recursive: true })
  await page
    .context()
    .tracing.stop(
      report.observedWithoutError ? {} : { path: resolve(directory, `${reportName}-failure.zip`) },
    )
  await browser.close()
  await new Promise<void>((resolve) => server.close(() => resolve()))
  await mkdir(directory, { recursive: true })
  await writeFile(resolve(directory, `${reportName}.json`), JSON.stringify(report, null, 2) + '\n')
}
console.log(JSON.stringify(report, null, 2))
if (!report.observedWithoutError) process.exitCode = 1
if (!report.observedWithoutError) process.exitCode = 1
if (!report.observedWithoutError) process.exitCode = 1
if (!report.observedWithoutError) process.exitCode = 1
