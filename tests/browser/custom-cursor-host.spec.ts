import { expect, test, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { createCursorCompositionFixture } from '../helpers/web-cursor-composition.ts'

declare global {
  interface Window {
    cursorCompositionFixture: ReturnType<typeof createCursorCompositionFixture>
  }
}
let fixture: string
test.beforeAll(async () => {
  const result = await build({ configFile: false, publicDir: false, logLevel: 'error', build: {
    write: false, minify: false, lib: { entry: resolve('tests/helpers/web-cursor-composition.ts'),
      formats: ['es'], fileName: () => 'cursor-composition.mjs' },
  } }), entry = (Array.isArray(result) ? result : [result])
    .flatMap((item) => 'output' in item ? item.output : [])
    .find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing cursor composition fixture bundle')
  fixture = entry.code
})
test.beforeEach(async ({ page }) => {
  await page.route('**/cursor-composition.html', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><html><head><title>Cursor composition host</title></head><body style="background:#bada55"></body></html>' }))
  await page.route('**/cursor-composition.mjs', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.goto('/cursor-composition.html')
  await page.mouse.move(2, 2)
  await page.evaluate(async () => {
    const url = '/cursor-composition.mjs', module = await import(url) as typeof import('../helpers/web-cursor-composition.ts')
    window.cursorCompositionFixture = module.createCursorCompositionFixture()
  })
})
test.afterEach(async ({ page }) => {
  const evidence = await page.evaluate(() => {
    const fixture = window.cursorCompositionFixture
    if (!fixture) return undefined
    const evidence = fixture.inspect()
    fixture.close()
    return evidence
  })
  await test.info().attach('cursor-host-lifecycle', { body: JSON.stringify(evidence ?? {}), contentType: 'application/json' })
  expect(evidence?.errors ?? []).toEqual([])
  await expect(page.locator('.game-custom-cursor')).toHaveCount(0)
})

test('custom cursor retries an uncommitted backdrop, uses an explicit second image and clips the client edge', async ({ page }) => {
  const marker = page.locator('#cursor-host-1 .game-custom-cursor')
  await page.evaluate(() => window.cursorCompositionFixture.write(1, 1))
  await expect(marker).toHaveCount(0)
  // No new asset or cursor write: readiness itself must recover presentation.
  await page.evaluate(() => window.cursorCompositionFixture.paint(1, '#123456'))
  await expect(marker).toBeVisible()
  expect(await marker.evaluate((node) => [...(node as HTMLCanvasElement).getContext('2d')!
    .getImageData(4, 4, 1, 1).data])).toEqual([237, 203, 169, 255])
  await page.evaluate(() => window.cursorCompositionFixture.write(1, 2, 0, 0, 0))
  await expect(marker).toHaveCSS('clip-path', 'inset(2px 0px 0px 3px)')
  const geometry = await marker.evaluate((node) => {
    const marker = node.getBoundingClientRect(), canvas = document.querySelector('#cursor-surface-1')!.getBoundingClientRect()
    return { x: marker.left + 3 - canvas.left, y: marker.top + 2 - canvas.top }
  })
  expect(geometry).toEqual({ x: 0, y: 0 })
  // Transparent pixels have an explicit actual HTML backdrop contract.
  await page.evaluate(() => {
    window.cursorCompositionFixture.paint(1)
    window.cursorCompositionFixture.background(1, '#204060')
    window.cursorCompositionFixture.write(1, 3)
  })
  await expect.poll(() => marker.evaluate((node) => [...(node as HTMLCanvasElement).getContext('2d')!
    .getImageData(4, 4, 1, 1).data])).toEqual([223, 191, 159, 255])
  await page.evaluate(() => window.cursorCompositionFixture.pixelated(1))
  expect(await marker.evaluate((node) => [...(node as HTMLCanvasElement).getContext('2d')!
    .getImageData(0, 0, 2, 1).data])).toEqual([223, 191, 159, 255, 127, 95, 63, 255])
  await page.evaluate(() => window.cursorCompositionFixture.writeOutside(1, 4))
  expect(await marker.evaluate((node) => {
    const marker = node.getBoundingClientRect(), canvas = document.querySelector('#cursor-surface-1')!.getBoundingClientRect()
    return [marker.left + 11 - canvas.left, marker.top + 13 - canvas.top]
  })).toEqual([48, 32])
  await page.evaluate(() => window.cursorCompositionFixture.writeOutside(1, 5, 4, 5))
  await expect(marker).toHaveCSS('clip-path', 'inset(3px 0px 0px 3px)')
  await page.evaluate(() => window.cursorCompositionFixture.retireAssets())
  await expect(marker).toHaveCount(0)
  await expect(page.locator('#cursor-surface-1')).toHaveCSS('cursor', 'default')
})

test('physical takeover, stale snapshots, two Windows and replacement epochs use one input stream', async ({ page }) => {
  await page.evaluate(() => {
    window.cursorCompositionFixture.paint(1, '#123456')
    window.cursorCompositionFixture.write(1, 1)
    window.cursorCompositionFixture.write(2, 2)
  })
  const a = page.locator('#cursor-host-1 .game-custom-cursor'), b = page.locator('#cursor-host-2 .game-custom-cursor')
  await expect(a).toBeVisible()
  await expect(b).toBeVisible()
  await page.mouse.move(96, 72)
  await expect(a).not.toHaveClass(/game-virtual-cursor/)
  await expect(b).toHaveClass(/game-virtual-cursor/)
  const sequence = await page.evaluate(() => window.cursorCompositionFixture.inspect().pointers.at(-1)!.sequence!)
  expect(sequence).toBeGreaterThan(0)
  await page.evaluate(() => window.cursorCompositionFixture.write(1, 100, 0))
  await expect(a).not.toHaveClass(/game-virtual-cursor/)
  await page.mouse.move(2, 2)
  await page.evaluate(() => window.cursorCompositionFixture.suspend(true))
  await expect(page.locator('.game-custom-cursor')).toHaveCount(0)
  await page.evaluate(() => window.cursorCompositionFixture.suspend(false))
  await expect(page.locator('.game-custom-cursor')).toHaveCount(0)
  await page.evaluate((sequence) => window.cursorCompositionFixture.write(1, 101, sequence), sequence)
  await expect(a).toBeVisible()
  await page.evaluate(() => {
    window.cursorCompositionFixture.hidden(1, true)
    window.cursorCompositionFixture.hidden(1, false)
  })
  await expect(a).toHaveCount(0)
  const oldEpoch = await page.evaluate(() => window.cursorCompositionFixture.replace(1))
  await page.evaluate((sequence) => window.cursorCompositionFixture.write(1, 101, sequence), sequence)
  await expect(a).toHaveCount(0)
  await page.evaluate((sequence) => window.cursorCompositionFixture.write(1, 102, sequence), sequence)
  await expect(a).toBeVisible()
  await page.evaluate((epoch) => window.cursorCompositionFixture.detach(1, epoch), oldEpoch)
  await expect(a).toBeVisible()
  await page.mouse.move(98, 74)
  await expect(a).not.toHaveClass(/game-virtual-cursor/)
  const evidence = await page.evaluate(() => window.cursorCompositionFixture.inspect())
  expect(evidence.pointers.length).toBeGreaterThanOrEqual(2)
  expect(evidence.pointers.map((point) => point.windowId)).toEqual(evidence.observed.map((event) => event.windowId))
  expect(evidence.pointers.map((point) => point.sequence))
    .toEqual(evidence.pointers.map((_, index) => index + 1))
  expect(evidence.packets.filter((packet) => packet.type === 'move').map((packet) => packet.pointerSequence))
    .toEqual(evidence.pointers.map((point) => point.sequence))
})

async function screenshotRgba(page: Page, png: Buffer) {
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
      context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    try {
      context.drawImage(bitmap, 0, 0)
      return { width: bitmap.width, height: bitmap.height,
        data: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data] }
    } finally { bitmap.close() }
  }, 'data:image/png;base64,' + png.toString('base64'))
}

test('custom cursor AND/XOR matches actual CSS canvas rasterization at noninteger scales', async ({ page }, info) => {
  const marker = page.locator('#cursor-host-1 .game-custom-cursor'),
    readings: { scale: number; rendering: string; computedRendering: string; devicePixelRatio: number;
      sourceRectangle: { x: number; y: number; width: number; height: number };
      clip: { x: number; y: number; width: number; height: number };
      background: Awaited<ReturnType<typeof screenshotRgba>>;
      expected: number[]; raw: number[]; screenshot: Awaited<ReturnType<typeof screenshotRgba>>;
      rawMismatches: number; screenshotMismatches: number }[] = []
  let revision = 200
  for (const scale of [1.5, 2.25]) for (const rendering of ['auto', 'pixelated'] as const) {
    await page.evaluate(({ scale, rendering }) => {
      window.cursorCompositionFixture.suspend(true)
      window.cursorCompositionFixture.raster(1, scale, rendering)
    }, { scale, rendering })
    await expect(marker).toHaveCount(0)
    const canvas = (await page.locator('#cursor-surface-1').boundingBox())!,
      clip = { x: Math.round(canvas.x + 24 * canvas.width / 64 - 3),
        y: Math.round(canvas.y + 16 * canvas.height / 48 - 2), width: 8, height: 8 },
      backgroundPng = await page.screenshot({ clip, scale: 'css' }),
      background = await screenshotRgba(page, backgroundPng),
      // The selected fixture is AND=255, XOR=255 in every RGB channel. This
      // expectation uses the actual hidden-cursor page screenshot exclusively.
      expected = background.data.map((value, index) => index % 4 === 3 ? 255 : value ^ 255)
    await info.attach(`css-${rendering}-${scale}-background`, { body: backgroundPng, contentType: 'image/png' })
    await page.evaluate((revision) => {
      window.cursorCompositionFixture.suspend(false)
      window.cursorCompositionFixture.write(1, revision)
    }, ++revision)
    await expect(marker).toBeVisible()
    const raw = await marker.evaluate((node) => [...(node as HTMLCanvasElement).getContext('2d')!
      .getImageData(0, 0, 8, 8).data]),
      cursorPng = await page.screenshot({ clip, scale: 'css' }),
      screenshot = await screenshotRgba(page, cursorPng)
    await info.attach(`css-${rendering}-${scale}-cursor`, { body: cursorPng, contentType: 'image/png' })
    readings.push({ scale, rendering, clip, sourceRectangle: canvas,
      computedRendering: await page.locator('#cursor-surface-1').evaluate((canvas) => getComputedStyle(canvas).imageRendering),
      devicePixelRatio: await page.evaluate(() => devicePixelRatio),
      background, expected, raw, screenshot,
      rawMismatches: raw.filter((value, index) => value !== expected[index]).length,
      screenshotMismatches: screenshot.data.filter((value, index) => value !== expected[index]).length })
  }
  // Finish the finite matrix before asserting, preserving the other algorithms'
  // observations even when one browser uses a different CSS sampling path.
  await info.attach('css-raster-readings', { body: JSON.stringify({
    scope: 'Actual CSS canvas screenshots versus cursor composition; not Windows cursor scaling',
    userAgent: await page.evaluate(() => navigator.userAgent),
    source: { width: 64, height: 48 }, cursor: { width: 8, height: 8 }, readings,
  }), contentType: 'application/json' })
  expect(readings.map((reading) => ({ scale: reading.scale, rendering: reading.rendering,
    computedRendering: reading.computedRendering,
    backgroundSize: [reading.background.width, reading.background.height],
    cursorSize: [reading.screenshot.width, reading.screenshot.height],
    rawMismatches: reading.rawMismatches, screenshotMismatches: reading.screenshotMismatches })))
    .toEqual([1.5, 2.25].flatMap((scale) => ['auto', 'pixelated'].map((rendering) => ({
      scale, rendering, computedRendering: rendering, backgroundSize: [8, 8], cursorSize: [8, 8],
      rawMismatches: 0, screenshotMismatches: 0,
    }))))
})
