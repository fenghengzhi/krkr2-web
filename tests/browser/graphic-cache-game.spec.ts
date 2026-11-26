import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { graphicCacheButtons, graphicCacheGameFiles, graphicCacheGameSource } from '../helpers/graphic-cache-game.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

interface CacheState {
  label: string; generation: number; state: string; revision: number
  limit: number; entries: number; bytes: number; resident: number; pending: number; hits: number; misses: number
}
interface CacheObservation { label: string; states: CacheState[]; dropped: number; errors: string[] }
declare global { interface Window { graphicCacheObservation: CacheObservation } }

/** Receive-only listener on the owner's real Session event channel. No calls,
 * replies, decoder output, resource read or scheduling result are replaced. */
async function observeCache(page: Page) {
  await page.addInitScript(() => {
    const observation: CacheObservation = { label: '', states: [], dropped: 0, errors: [] }, NativeChannel = MessageChannel
    window.graphicCacheObservation = observation
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        for (const port of [channel.port1, channel.port2]) port.addEventListener('message', ({ data }) => {
          try {
            if (data?.type === 'log' && typeof data.text === 'string' && data.text.startsWith('graphic-cache:'))
              observation.label = data.text
            if (data?.type !== 'state' || typeof data.snapshot?.imageCacheHits !== 'number') return
            if (observation.states.length >= 4096) { observation.dropped++; return }
            const snapshot = data.snapshot
            observation.states.push({ label: observation.label, generation: data.generation, state: snapshot.state,
              revision: snapshot.revision, limit: snapshot.imageCacheLimit, entries: snapshot.imageCacheEntries,
              bytes: snapshot.imageCacheBytes, resident: snapshot.imageCacheResidentBytes, pending: snapshot.imageCachePending,
              hits: snapshot.imageCacheHits, misses: snapshot.imageCacheMisses })
          } catch (error) { if (observation.errors.length < 16) observation.errors.push(String(error)) }
        })
        // The real owner starts/transfers the port; the observer never does.
        return channel
      },
    })
  })
}

async function pixels(canvas: Locator, info: TestInfo, label: string, color: readonly number[]) {
  let png: Buffer | undefined
  await expect.poll(async () => {
    png = await canvas.screenshot()
    const image = readScreenshotPng(png), x0 = Math.ceil(image.width * 4 / 384), x1 = Math.floor(image.width * 380 / 384),
      y0 = Math.ceil(image.height * 4 / 160), y1 = Math.floor(image.height * 92 / 160)
    expect(x1).toBeGreaterThan(x0); expect(y1).toBeGreaterThan(y0)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const at = (y * image.width + x) * 4
      for (let channel = 0; channel < 4; channel++)
        if (image.rgba[at + channel] !== color[channel]) return { x, y, actual: [...image.rgba.subarray(at, at + 4)] }
    }
    return null
  }).toBeNull()
  if (png) await info.attach('graphic-cache-' + label, { body: png, contentType: 'image/png' })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game cache menu respects distribution MiB limits while preloading and reloading real pictures`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], pageErrors: string[] = [], samples: CacheState[] = [], mib = 1024 * 1024,
      configuredMiB = binary ? 2 : 1,
      canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Graphic cache game$/ }) })
        .locator('canvas[data-window-id]')
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await observeCache(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window canvas')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    try {
      const images = graphicCacheGameFiles()
      for (const limitMiB of [undefined, configuredMiB]) {
        const run = limitMiB === undefined ? 'default' : String(limitMiB), upper = (limitMiB ?? 64) * mib
        let step = 0, shown = 0x101010
        const check = async (action: string, limit: number, entries: number, hits: number, misses: number, bytes = entries * mib) => {
          const label = `graphic-cache:${run}:${step}:${action}:${limit}:${shown}`
          await expect(page.getByText(label, { exact: true })).toBeVisible({ timeout: 20000 })
          await expect.poll(async () => {
            const state = await page.evaluate((label) => window.graphicCacheObservation.states.filter((entry) => entry.label === label).at(-1), label)
            return state && { limit: state.limit, entries: state.entries, bytes: state.bytes, pending: state.pending, hits: state.hits, misses: state.misses }
          }).toEqual({ limit, entries, bytes, pending: 0, hits, misses })
          const state = await page.evaluate((label) => window.graphicCacheObservation.states.filter((entry) => entry.label === label).at(-1)!, label)
          expect(state.resident).toBeGreaterThanOrEqual(bytes)
          expect(state.resident).toBeLessThanOrEqual(64 * mib)
          if (!entries) expect(state.resident).toBe(0)
          samples.push(state)
          await evaluate(page, 'graphicCacheState()', [run, step, limit, shown].join('|'))
          await pixels(canvas, info, `${run}-${step}-${action}`, [(shown >>> 16) & 255, (shown >>> 8) & 255, shown & 255, 255])
        }, click = async (action: typeof graphicCacheButtons[number][0], color?: number) => {
          const index = graphicCacheButtons.findIndex(([name]) => name === action), bounds = await canvas.boundingBox()
          expect(bounds).not.toBeNull()
          await canvas.click({ position: { x: (index % 4 * 96 + 48) * bounds!.width / 384,
            y: (96 + Math.floor(index / 4) * 32 + 16) * bounds!.height / 160 } })
          step++
          if (color !== undefined) shown = color
        }
        await page.locator('#project-mode').selectOption('auto')
        await page.locator('#files').setInputFiles([
          { name: 'CacheGame.exe', mimeType: 'application/octet-stream', buffer: Buffer.from([77, 90]) },
          ...(limitMiB === undefined ? [] : [{ name: 'CacheGame.cf', mimeType: 'text/plain',
            buffer: Buffer.from(`gclim=${limitMiB}\r\n`, 'ascii') }]),
          { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
            ? 'Scripts.compileStorage("cache-game.tjs","savedata/cache-game.cjs",false,true,false);Scripts.execStorage("savedata/cache-game.cjs");'
            : 'Scripts.execStorage("cache-game.tjs");') },
          { name: 'cache-game.tjs', mimeType: 'text/plain', buffer: Buffer.from(graphicCacheGameSource) },
          ...Object.entries(images).map(([name, bytes]) => ({ name, mimeType: 'image/bmp', buffer: Buffer.from(bytes) })),
        ])
        await expect(canvas).toHaveJSProperty('width', 384); await expect(canvas).toHaveJSProperty('height', 160)
        await canvas.scrollIntoViewIfNeeded()
        await check('ready', 0, 0, 0, 0)
        await click('auto')
        const loaded = limitMiB ?? 3
        await check('auto', upper, loaded, 0, loaded)
        await click('red', 0xff0000); await check('red', upper, loaded, 1, loaded)
        if (limitMiB === undefined) { await stop(); continue }

        // One-MiB preloading stops before green; two-MiB preloading includes
        // it. Native trims before insertion, so the first case may retain two
        // images until the next explicit limit change.
        await click('green', 0x00ff00)
        const hits = limitMiB === 1 ? 1 : 2
        await check('green', upper, 2, hits, 2)
        await click('clamp'); await check('clamp', upper, limitMiB, hits, 2)
        await click('zero'); await check('zero', 0, 0, hits, 2)
        await click('blue', 0x0000ff); await check('blue', 0, 0, hits, 3)
        await click('blue', 0x0000ff); await check('blue', 0, 0, hits, 4)
        await click('auto'); await check('auto', upper, limitMiB, hits, 4 + limitMiB)
        await click('clear'); await check('clear', upper, 0, hits, 4 + limitMiB)
        await click('blue', 0x0000ff); await check('blue', upper, 1, hits, 5 + limitMiB)
        await click('blue', 0x0000ff); await check('blue', upper, 1, hits + 1, 5 + limitMiB)
        await click('small'); await check('small', 4096, 0, hits + 1, 5 + limitMiB)
        await click('red', 0xff0000); await check('red', 4096, 1, hits + 1, 6 + limitMiB)
        await click('red', 0xff0000); await check('red', 4096, 1, hits + 2, 6 + limitMiB)
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await stop()
      }
      const observation = await page.evaluate(() => window.graphicCacheObservation)
      expect(observation.dropped).toBe(0); expect(observation.errors).toEqual([]); expect(pageErrors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('graphic-cache-observation', { contentType: 'application/json', body: JSON.stringify({
      samples, pageErrors, observation: await page.evaluate(() => window.graphicCacheObservation), logs: await page.locator('#logs').innerText(),
      scope: 'Real clicked TJS buttons and BMP decoding; cache counts are received passively from original Session state events.',
    }, null, 2) }) } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Graphic cache game or cleanup failed', { cause: failures[0] })
  })
