// Original MessageLayer keyboard and MainWindow pad navigation must perform
// real cursorX/Y writes, hover highlighting and link dispatch. Only the browser
// device snapshot boundary is injected; no KAG input method is replaced.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, relative, resolve, sep } from 'node:path'
import { chromium, firefox, webkit, expect, type Browser, type Page } from '@playwright/test'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { probeBrowsers } from '../helpers/probe-browsers.ts'

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Run original KAG cursor verification on Actions')
const root = resolve('dist'), directory = resolve(process.argv[2] ?? 'out/verification/compatibility'),
  out = resolve(directory, 'kag-cursor'), hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex'),
  sourcePath = process.env.KRKR_KAG_FIXTURE ?? 'tests/fixtures/compatibility/kag3_template.xp3',
  source = await readFile(sourcePath), sourceSha256 = hash(source),
  scenario = await readFile('tests/fixtures/kag-cursor.ks'),
  pair = JSON.parse(await readFile('tests/fixtures/compatibility/kag3_template.zip.json', 'utf8')),
  indexSha256 = hash(await readFile(resolve(root, 'index.html'))),
  observer = await readFile('tests/helpers/worker-observation.js', 'utf8')
assert.equal(sourceSha256, '5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
assert.equal(pair.entries.find((entry: { name: string }) => entry.name === 'system/MessageLayer.tjs')?.sha256,
  '322022ef5ed50dd945519c33f16c93fea5d578d30c66252f3695571e5e9b9f36')
assert.equal(pair.entries.find((entry: { name: string }) => entry.name === 'system/MainWindow.tjs')?.sha256,
  '8f850acfd1c87b77bb37c792e9f80630f4a15f9c5bd0d9aafce5ce59cfedcea7')
const gamepadBoundary = 'Injected navigator.getGamepads device snapshots; not physical hardware measurements',
  padMapping = { source: 'system/MainWindow.tjs:638-644',
    sourceSha256: '8f850acfd1c87b77bb37c792e9f80630f4a15f9c5bd0d9aafce5ce59cfedcea7',
    left: { axis: -1, virtualKey: 437, mappedKey: 37 },
    right: { axis: 1, virtualKey: 439, mappedKey: 39 },
    confirm: { button: 0, virtualKey: 448, mappedKey: 13 } }
type PadRead = {
  read: number; at: number; phase: string; epoch: number; axes: number[]
  pressedButtons: number[]; neutral: boolean; focusedGameSurface: boolean; documentFocused: boolean
  activeElement: { tag: string; className: string; windowId: string | null; surfaceEpoch: string | null } | null
}
type PadFixture = {
  installed: boolean; phase: string; epoch: number; axes: number[]; buttons: boolean[]
  reads: number; dropped: number; samples: PadRead[]
}
// Raw init-script text avoids transpiler helpers in the page context. Every
// entry is a passive record of a real production getGamepads() read.
const deviceFixture = String.raw`(() => {
  const state = { installed: false, phase: 'initial-neutral', epoch: 0,
    axes: [0, 0], buttons: Array(17).fill(false), reads: 0, dropped: 0, samples: [] };
  Object.defineProperty(window, '__krkrCursorPadDevice', { value: state });
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => {
    const at = performance.now(), axes = [...state.axes], active = document.activeElement,
      owner = active?.closest('[data-window-id]'), documentFocused = document.hasFocus(),
      pressedButtons = state.buttons.flatMap((pressed, index) => pressed ? [index] : []);
    const sample = { read: ++state.reads, at, phase: state.phase, epoch: state.epoch, axes,
      pressedButtons, neutral: axes.every(value => value === 0) && pressedButtons.length === 0,
      documentFocused,
      focusedGameSurface: documentFocused && !!active?.matches('#stage canvas, #stage .game-text-input'),
      activeElement: active ? { tag: active.tagName, className: active.className,
        windowId: owner?.getAttribute('data-window-id') ?? null,
        surfaceEpoch: owner?.getAttribute('data-surface-epoch') ?? null } : null };
    if (state.samples.length < 8192) state.samples.push(sample); else state.dropped++;
    return [{ index: 0, id: 'KAG cursor controlled standard pad', connected: true,
      mapping: 'standard', timestamp: at, axes,
      buttons: state.buttons.map(pressed => ({ pressed, touched: pressed, value: pressed ? 1 : 0 })) }];
  } });
  state.installed = true;
})();`
type Result = {
  browser: 'chromium' | 'firefox' | 'webkit'; backend: string
  status: 'not-run' | 'running' | 'passed' | 'failed'; report: string; error?: string
}
const results: Result[] = probeBrowsers().flatMap((browser) => ['asyncify', 'jspi'].map((backend) => ({
  browser, backend, status: 'not-run', report: `kag-cursor/${browser}-${backend}/report.json`,
})))
await mkdir(out, { recursive: true })
const provenance: { source: string; artifact: string; bytes: number; sha256: string }[] = []
for (const [input, artifact] of [
  [sourcePath, 'kag3_template.xp3'],
  ['tests/fixtures/compatibility/kag3_template.zip', 'kag3_template.zip'],
  ['tests/fixtures/compatibility/kag3_template.zip.json', 'fixture-manifest.json'],
  ['tests/fixtures/kag-cursor.ks', 'cursor-verification.ks'],
  ['out/ci/build-info.json', 'build-info.json'], ['dist/wasm/manifest.json', 'wasm-manifest.json'],
  ['dist/index.html', 'release-index.html'], ['dist/sw.js', 'release-service-worker.js'],
  ['tests/probes/cursor-kag.ts', 'cursor-kag.ts'], ['tests/helpers/worker-observation.js', 'worker-observation.js'],
] as const) {
  const bytes = await readFile(input)
  if (artifact === 'kag3_template.zip') assert.equal(hash(bytes), pair.zipSha256)
  await writeFile(resolve(out, artifact), bytes)
  provenance.push({ source: input, artifact, bytes: bytes.length, sha256: hash(bytes) })
}
const saveSummary = () => writeFile(resolve(directory, 'kag-cursor.json'), JSON.stringify({
  recordedAt: new Date().toISOString(), sourceSha256, indexSha256, provenance,
  sourceForm: 'original XP3 source; no bytecode claim',
  methods: ['MainWindow.action', 'MainWindow.onKeyDown', 'MainWindow.getKeyState',
    'MessageLayer.onKeyDown', 'MessageLayer.setFocusToLink', 'MessageLayer.onMouseMove', 'MessageLayer.processLink'],
  gamepadBoundary, padMapping,
  inventory: { selectedCases: results.length, expandedCases: 6 }, results,
}, null, 2) + '\n')
await saveSummary()
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? '/', 'http://localhost'),
      path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
    if (!path.startsWith(root + sep) || !(await stat(path)).isFile()) throw new Error('missing')
    const types: Record<string, string> = {
      '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
      '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml',
    }
    response.writeHead(200, { 'content-type': types[extname(path)] ?? 'application/octet-stream' })
    response.end(await readFile(path))
  } catch { response.writeHead(404).end() }
}).listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
assert(address && typeof address !== 'string')

try {
  for (const result of results) {
    const prefix = resolve(out, `${result.browser}-${result.backend}`),
      errors: string[] = [], evidenceErrors: string[] = [], steps: string[] = [],
      events: unknown[] = [], consoleMessages: unknown[] = [], workers: { url: string; closed: boolean }[] = []
    let browser: Browser | undefined, page: Page | undefined, tracing = false,
      deviceEvidence: PadFixture | undefined
    await mkdir(prefix, { recursive: true })
    result.status = 'running'
    await saveSummary()
    const capture = async (name: string) => {
      assert(page)
      const state = await page.evaluate(() => ({
        status: document.querySelector('#status')?.textContent,
        logs: document.querySelector('#logs')?.textContent,
        errors: [...document.querySelectorAll('#logs .error')].map((element) => element.textContent),
        cursors: [...document.querySelectorAll<HTMLElement>('.game-virtual-cursor')].map((cursor) => ({
          windowId: cursor.dataset.windowId, revision: cursor.dataset.cursorRevision,
          shape: cursor.dataset.cursorShape, hidden: cursor.hidden,
          bounds: cursor.getBoundingClientRect().toJSON(),
        })),
        worker: (window as unknown as { __krkrWorkerObservation?: () => unknown }).__krkrWorkerObservation?.(),
        gamepad: (() => {
          const state = (window as unknown as { __krkrCursorPadDevice?: PadFixture }).__krkrCursorPadDevice
          return state && { installed: state.installed, phase: state.phase, reads: state.reads,
            dropped: state.dropped, lastSample: state.samples.at(-1) }
        })(),
      }))
      await writeFile(resolve(prefix, `${name}.json`), JSON.stringify(state, null, 2) + '\n')
      await page.screenshot({ path: resolve(prefix, `${name}.png`), fullPage: true, timeout: 5000 })
      assert.deepEqual(state.errors, [])
      const worker = state.worker as { installed?: boolean; dropped?: number; observationErrors?: number } | undefined
      assert(worker?.installed)
      assert.equal(worker.dropped, 0)
      assert.equal(worker.observationErrors, 0)
    }
    try {
      browser = await { chromium, firefox, webkit }[result.browser].launch(browserLaunchOptions)
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
      await context.addInitScript({ content: observer })
      await context.addInitScript({ content: deviceFixture })
      page = await context.newPage()
      page.on('pageerror', (error) => errors.push(error.message))
      page.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }))
      page.on('worker', (worker) => {
        if (!/\/session\.worker[-.]/.test(new URL(worker.url()).pathname)) return
        const entry = { url: worker.url(), closed: false }
        workers.push(entry)
        worker.on('close', () => { entry.closed = true })
      })
      await context.tracing.start({ screenshots: result.browser !== 'webkit', snapshots: true, sources: true })
      tracing = true
      await page.goto(`http://127.0.0.1:${address.port}/?backend=${result.backend}`)
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: source },
        { name: 'cursor-verification.ks', mimeType: 'text/plain', buffer: scenario },
      ])
      await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await evaluate(page, '(function(){kag.conductor.loadScenario("cursor-verification.ks");kag.conductor.startProcess();return "started";})()', 'started')
      await expect(page.getByText('cursor-kag:ready', { exact: true })).toBeVisible()
      await evaluate(page, `(function(){
global.cursorOriginalFocus=kag.current.setFocusToLink;
global.cursorOriginalKey=kag.current.onKeyDown;
global.cursorOriginalMove=kag.current.onMouseMove;
global.cursorOriginalLink=kag.current.processLink;
global.cursorOriginalAction=kag.action;
global.cursorOriginalWindowKey=kag.onKeyDown;
global.cursorOriginalGetKeyState=kag.getKeyState;
global.cursorPadMode=false;
global.cursorLastObservation="";
global.cursorObserve=function(){
  var m=kag.current;
  var state=[m.numLinks,m.keyLink,m.lastLink,m.cursorX,m.cursorY].join("|");
  if(global.cursorPadMode)state+="|"+[int(System.getKeyState(VK_PADRIGHT)),int(System.getKeyState(VK_PADLEFT)),int(System.getKeyState(VK_PAD1))].join("|");
  if(state!==global.cursorLastObservation){global.cursorLastObservation=state;Debug.message((global.cursorPadMode?"cursor-kag:pad-state:":"cursor-kag:state:")+state);}
};
global.cursorObserver=new Timer(global,"cursorObserve");cursorObserver.interval=20;cursorObserver.enabled=true;
kag.current.focus();return kag.current.numLinks;
})()`.replace(/\s*\n\s*/g, ' '), '2')
      const canvas = page.locator('#stage canvas'), marker = page.locator('.game-virtual-cursor:visible')
      // Keyboard navigation requires a physical held key in the original KAG.
      // The timer observes state; none of the four original handlers is changed.
      await canvas.focus()
      const navigate = async (key: string, index: number, label: string) => {
        assert(page)
        const observed = page.locator('#logs p span').filter({ hasText: new RegExp(`^cursor-kag:state:2\\|${index}\\|${index}\\|`) }),
          prior = await observed.count()
        await page.keyboard.down(key)
        try {
          await expect(marker).toHaveCount(1)
          await expect.poll(() => observed.count()).toBeGreaterThan(prior)
          await expect(observed.last()).toBeVisible()
          const state = await page.locator('#logs').innerText()
          events.push({ key, index, phase: label, held: true, log: state })
          await capture(label)
        } finally { await page.keyboard.up(key) }
        steps.push(label)
      }
      await navigate('ArrowRight', 0, 'first-link-highlight')
      const firstPixels = await canvas.screenshot()
      await navigate('ArrowRight', 1, 'second-link-highlight')
      const secondPixels = await canvas.screenshot()
      await writeFile(resolve(prefix, 'first-link-canvas.png'), firstPixels)
      await writeFile(resolve(prefix, 'second-link-canvas.png'), secondPixels)
      assert.notEqual(hash(firstPixels), hash(secondPixels), 'The original highlighted canvas must change between links')
      await navigate('ArrowLeft', 0, 'previous-link-highlight')
      await navigate('Tab', 1, 'tab-link-highlight')
      // The original Enter handler temporarily hides its cursor. Prove real
      // physical takeover while the keyboard cursor is still visible, before
      // that independent hide operation can make a zero-count assertion pass.
      await expect(marker).toHaveCount(1)
      const hotspot = await marker.evaluate((element) => {
        const cursor = element as HTMLElement,
          canvas = cursor.parentElement!.querySelector('canvas')!,
          box = canvas.getBoundingClientRect()
        return {
          x: box.left + (parseFloat(cursor.style.left) - canvas.offsetLeft) * box.width / canvas.clientWidth,
          y: box.top + (parseFloat(cursor.style.top) - canvas.offsetTop) * box.height / canvas.clientHeight,
        }
      })
      await page.mouse.move(hotspot.x, hotspot.y)
      await expect(marker).toHaveCount(0)
      steps.push('physical-pointer-takes-over')
      events.push({ phase: 'physical-takeover', hotspot, input: 'Playwright mouse.move at the visible original second-link cursor hotspot' })
      await capture('physical-takeover')
      await page.keyboard.down('Enter')
      try { await expect(page.getByText('cursor-kag:selected:second', { exact: true })).toBeVisible() }
      finally { await page.keyboard.up('Enter') }
      await expect(page.getByText('cursor-kag:selected:first', { exact: true })).toHaveCount(0)
      steps.push('enter-runs-original-link-target')
      await capture('entered-second-target')
      await evaluate(page, `[kag.current.setFocusToLink===cursorOriginalFocus,kag.current.onKeyDown===cursorOriginalKey,kag.current.onMouseMove===cursorOriginalMove,kag.current.processLink===cursorOriginalLink].join("|")`, '1|1|1|1')

      // Reload the same original two-link scenario within this Session. The
      // second traversal enters only at the Gamepad device API boundary.
      const ready = page.getByText('cursor-kag:ready', { exact: true }), readyBeforePad = await ready.count()
      await evaluate(page, '(function(){global.cursorPadMode=true;global.cursorLastObservation="";kag.conductor.loadScenario("cursor-verification.ks");kag.conductor.startProcess();return "pad-started";})()', 'pad-started')
      await expect.poll(() => ready.count()).toBeGreaterThan(readyBeforePad)
      await evaluate(page, '[kag.padKeyMap[VK_PADLEFT]===VK_LEFT,kag.padKeyMap[VK_PADRIGHT]===VK_RIGHT,kag.padKeyMap[VK_PAD1]===VK_RETURN].join("|")', '1|1|1')
      await evaluate(page, '(kag.current.focus(),kag.current.numLinks)', '2')
      await canvas.focus()
      const sampleDevice = async (phase: string, horizontal = 0, button = -1): Promise<PadRead> => {
        assert(page)
        const epoch = await page.evaluate(({ phase, horizontal, button }) => {
          const state = (window as unknown as { __krkrCursorPadDevice: PadFixture }).__krkrCursorPadDevice
          state.phase = phase
          state.axes = [horizontal, 0]
          state.buttons = Array.from({ length: 17 }, (_, index) => index === button)
          return ++state.epoch
        }, { phase, horizontal, button })
        // The getter is read by production's 50 ms sampler. Waiting for a
        // focused game-surface neutral read admits the pad after focus gating.
        // BrowserInput synchronously redirects canvas focus to its textarea;
        // both elements belong to the same real game input surface.
        // Counting RAF turns or sleeping would not prove that read occurred.
        await expect.poll(() => page!.evaluate((epoch) => {
          const state = (window as unknown as { __krkrCursorPadDevice: PadFixture }).__krkrCursorPadDevice
          return state.samples.some((sample) => sample.epoch === epoch && sample.focusedGameSurface)
        }, epoch)).toBe(true)
        const sample = await page.evaluate((epoch) => {
          const state = (window as unknown as { __krkrCursorPadDevice: PadFixture }).__krkrCursorPadDevice
          return state.samples.find((sample) => sample.epoch === epoch && sample.focusedGameSurface)!
        }, epoch)
        assert.equal(sample.phase, phase)
        assert.equal(sample.documentFocused, true)
        assert.match(sample.activeElement?.windowId ?? '', /^\d+$/)
        assert.deepEqual(sample.axes, [horizontal, 0])
        assert.deepEqual(sample.pressedButtons, button < 0 ? [] : [button])
        assert.equal(sample.neutral, horizontal === 0 && button < 0)
        events.push({ phase, deviceRead: sample, boundary: gamepadBoundary })
        return sample
      }
      await sampleDevice('pad-initial-neutral')
      steps.push('pad-reloaded-original-links-and-observed-neutral')
      await capture('pad-neutral-ready')
      const holdDevice = async (label: string, horizontal: number, button: number, observe: () => Promise<void>) => {
        let failed = false, primary: unknown
        try {
          await sampleDevice(label, horizontal, button)
          await observe()
        } catch (error) { failed = true; primary = error }
        try { await sampleDevice(`${label}:neutral-after`) }
        catch (error) {
          if (failed) throw new AggregateError([primary, error], 'Pad observation and neutral release failed', { cause: primary })
          throw error
        }
        if (failed) throw primary
      }
      const navigatePad = async (horizontal: -1 | 1, index: number, label: string) => {
        assert(page)
        await sampleDevice(`${label}:neutral-before`)
        const held = horizontal > 0 ? '1\\|0\\|0' : '0\\|1\\|0',
          observed = page.locator('#logs p span').filter({ hasText: new RegExp(
            `^cursor-kag:pad-state:2\\|${index}\\|${index}\\|[^|]+\\|[^|]+\\|${held}$`) }),
          prior = await observed.count()
        await holdDevice(label, horizontal, -1, async () => {
          await expect.poll(() => observed.count()).toBeGreaterThan(prior)
          await expect(observed.last()).toBeVisible()
          events.push({ phase: label, virtualKey: horizontal > 0 ? 439 : 437, index,
            input: 'controlled device axes -> production sampler -> Worker -> original MainWindow/MessageLayer',
            heldObservation: await observed.last().innerText() })
        })
        await expect(page.locator('#logs p span').filter({ hasText: /^cursor-kag:pad-state:/ }).last())
          .toHaveText(new RegExp(`^cursor-kag:pad-state:2\\|${index}\\|${index}\\|[^|]+\\|[^|]+\\|0\\|0\\|0$`))
        await expect(marker).toHaveCount(1)
        await capture(label)
        steps.push(label)
      }
      await navigatePad(1, 0, 'pad-first-link-highlight')
      const padFirstPixels = await canvas.screenshot()
      await navigatePad(1, 1, 'pad-second-link-highlight')
      const padSecondPixels = await canvas.screenshot()
      await writeFile(resolve(prefix, 'pad-first-link-canvas.png'), padFirstPixels)
      await writeFile(resolve(prefix, 'pad-second-link-canvas.png'), padSecondPixels)
      assert.notEqual(hash(padFirstPixels), hash(padSecondPixels), 'Original pad link highlights must change the canvas')
      await navigatePad(-1, 0, 'pad-previous-link-highlight')
      await navigatePad(1, 1, 'pad-return-second-link-highlight')
      const selectedSecond = page.getByText('cursor-kag:selected:second', { exact: true }),
        selectedBeforePad = await selectedSecond.count()
      await sampleDevice('pad-confirm-target:neutral-before')
      // The pinned original MainWindow maps VK_PAD1 to VK_RETURN. This is
      // button index 0 at the public standard Gamepad snapshot boundary.
      await holdDevice('pad-confirm-target', 0, 0, async () => {
        await expect.poll(() => selectedSecond.count()).toBeGreaterThan(selectedBeforePad)
        await expect(selectedSecond.last()).toBeVisible()
      })
      await expect(page.getByText('cursor-kag:selected:first', { exact: true })).toHaveCount(0)
      steps.push('pad-confirm-runs-original-link-target')
      await capture('pad-entered-second-target')
      await evaluate(page, `[kag.current.setFocusToLink===cursorOriginalFocus,kag.current.onKeyDown===cursorOriginalKey,kag.current.onMouseMove===cursorOriginalMove,kag.current.processLink===cursorOriginalLink,kag.action===cursorOriginalAction,kag.onKeyDown===cursorOriginalWindowKey,kag.getKeyState===cursorOriginalGetKeyState].join("|")`, '1|1|1|1|1|1|1')
      steps.push('pad-original-mainwindow-and-messagelayer-methods-retained')
      await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
      await expect.poll(() => workers.map(({ closed }) => closed)).toEqual([true])
      steps.push('stop-releases-marker-and-worker')
      await capture('stopped')
      assert.deepEqual(errors, [])
      result.status = 'passed'
    } catch (error) {
      result.status = 'failed'
      result.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      console.error(`FAIL ${result.browser}/${result.backend}: ${result.error}`)
    } finally {
      if (page) await capture('final').catch((error) => evidenceErrors.push('final: ' + String(error)))
      if (page) await page.evaluate(() => {
        const state = (window as unknown as { __krkrCursorPadDevice: PadFixture }).__krkrCursorPadDevice
        return { ...state, axes: [...state.axes], buttons: [...state.buttons],
          samples: state.samples.map((sample) => ({ ...sample, axes: [...sample.axes], pressedButtons: [...sample.pressedButtons] })) }
      }).then((state) => { deviceEvidence = state }).catch((error) => evidenceErrors.push('device trace: ' + String(error)))
      if (deviceEvidence) {
        if (!deviceEvidence.installed || deviceEvidence.dropped !== 0)
          evidenceErrors.push('Gamepad device trace was not installed or lost samples')
        await writeFile(resolve(prefix, 'device-samples.json'), JSON.stringify({
          boundary: gamepadBoundary, hardwareMeasured: false, ...deviceEvidence,
        }, null, 2) + '\n')
      }
      if (page && tracing) await page.context().tracing.stop({ path: resolve(prefix, 'trace.zip') }).catch((error) => evidenceErrors.push('trace: ' + String(error)))
      await browser?.close().catch((error) => evidenceErrors.push('close: ' + String(error)))
      if (result.status === 'passed' && (errors.length || evidenceErrors.length)) {
        result.status = 'failed'
        result.error = 'Late page/evidence errors: ' + [...errors, ...evidenceErrors].join('; ')
      }
      await writeFile(resolve(prefix, 'events.json'), JSON.stringify(events, null, 2) + '\n')
      await writeFile(resolve(prefix, 'console.json'), JSON.stringify(consoleMessages, null, 2) + '\n')
      await writeFile(resolve(prefix, 'report.json'), JSON.stringify({
        ...result, sourceSha256, indexSha256, errors, evidenceErrors, steps, workers,
        originalXp3Bytes: true, originalMethods: true, observedWithoutError: result.status === 'passed',
        observer: 'Separate Timer logs original link/focus/cursor state; original handlers unchanged',
        gamepadBoundary, hardwareMeasured: false, padMapping,
        deviceTrace: 'device-samples.json', deviceReads: deviceEvidence?.reads ?? 0,
      }, null, 2) + '\n')
      await saveSummary()
    }
  }
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
  const summary = await readFile(resolve(directory, 'kag-cursor.json'))
  files.push({ path: 'kag-cursor.json', bytes: summary.length, sha256: hash(summary) })
  await writeFile(resolve(out, 'artifact-manifest.json'), JSON.stringify({
    recordedAt: new Date().toISOString(), githubRun: process.env.GITHUB_RUN_ID,
    githubSha: process.env.GITHUB_SHA, sourceSha256, indexSha256,
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
  }, null, 2) + '\n')
}
if (results.some(({ status }) => status !== 'passed')) process.exitCode = 1
