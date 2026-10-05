import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { build } from 'vite'

let fixture: string, styles: string
test.beforeAll(async () => {
  const result = await build({ configFile: false, publicDir: false, logLevel: 'error',
    build: { write: false, minify: false, lib: { entry: resolve('tests/helpers/web-window-region.ts'),
      formats: ['es'], fileName: () => 'web-window-region.mjs' } } })
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) => 'output' in item ? item.output : []),
    entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing real region host bundle')
  fixture = entry.code
  styles = output.filter((item) => item.type === 'asset' && item.fileName.endsWith('.css')).map((item) =>
    item.type === 'asset' ? typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source) : '').join('\n')
  if (!styles) throw new Error('Missing real game window CSS')
})

async function launch(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/window-region-host.html', (route) => route.fulfill({ contentType: 'text/html',
    body: '<!doctype html><meta charset="utf-8"><title>Window region host</title><link rel="stylesheet" href="/web-window-region.css"><style>body{margin:0}</style>' }))
  await page.route('**/web-window-region.mjs', (route) => route.fulfill({ contentType: 'text/javascript', body: fixture }))
  await page.route('**/web-window-region.css', (route) => route.fulfill({ contentType: 'text/css', body: styles }))
  await page.goto('/window-region-host.html')
  await page.evaluate(async () => {
    const url = '/web-window-region.mjs', module = await import(url) as typeof import('../helpers/web-window-region.ts')
    window.windowRegionHost = module.installWindowRegionHost()
  })
  return errors
}
async function hit(page: Page, x: number, y: number, expected: number) {
  await expect.poll(() => page.evaluate(({ x, y }) => window.windowRegionHost.hit(22, x, y), { x, y })).toBe(expected)
}
async function click(page: Page, x: number, y: number, expected: number) {
  const point = await page.evaluate(({ x, y }) => {
    window.windowRegionHost.clear()
    return window.windowRegionHost.point(22, x, y)
  }, { x, y })
  await page.mouse.click(point.x, point.y)
  expect(await page.evaluate(() => window.windowRegionHost.pointer().map(({ windowId, trusted }) => ({ windowId, trusted }))))
    .toEqual([{ windowId: expected, trusted: true }])
}

test('real hit testing passes through a region hole, an empty region, and restores after removal', async ({ page }, info) => {
  const errors = await launch(page)
  try {
    await page.evaluate(() => window.windowRegionHost.publish(22, 1, { width: 320, height: 180,
      rectangles: [0, 0, 320, 40, 0, 40, 80, 140, 240, 40, 80, 140] }))
    await hit(page, 40, 80, 22)
    await hit(page, 160, 80, 11)
    await click(page, 40, 80, 22)
    await click(page, 160, 80, 11)
    await info.attach('region-hole', { body: await page.screenshot(), contentType: 'image/png' })
    await page.evaluate(() => window.windowRegionHost.publish(22, 2, { width: 320, height: 180, rectangles: [] }))
    await hit(page, 40, 80, 11)
    await click(page, 40, 80, 11)
    await page.evaluate(() => window.windowRegionHost.publish(22, 3, null))
    await hit(page, 160, 80, 22)
    await click(page, 160, 80, 22)
    expect(errors).toEqual([])
  } finally { await page.evaluate(() => window.windowRegionHost.dispose()) }
})

test('the outer header origin and captured logical mask survive CSS resize, caller mutation and game zoom', async ({ page }) => {
  const errors = await launch(page)
  try {
    await page.evaluate(() => window.windowRegionHost.publish(22, 1, { width: 320, height: 180,
      rectangles: [0, 0, 80, 20] }, 1, true))
    const initial = await page.evaluate(() => window.windowRegionHost.snapshot(22))
    expect(initial.canvas.y - initial.outer.y).toBeGreaterThan(20)
    // Keeping y=10 and rejecting y=45 proves no canvas/header offset was added.
    await hit(page, 30, 10, 22)
    await hit(page, 30, 45, 11)
    await page.evaluate(() => window.windowRegionHost.canvasWidth(22, 160))
    await expect.poll(() => page.evaluate(() => window.windowRegionHost.snapshot(22).canvas.width)).toBe(160)
    await hit(page, 30, 5, 22)
    await hit(page, 60, 5, 11)
    await hit(page, 30, 15, 11)
    await page.evaluate(() => window.windowRegionHost.update(22, { zoomNumer: 3, zoomDenom: 2, layerLeft: 29, layerTop: 17 }))
    await hit(page, 30, 5, 22)
    await hit(page, 60, 5, 11)
    await page.evaluate(() => window.windowRegionHost.canvasWidth(22, 320))
    await hit(page, 60, 10, 22)
    await hit(page, 90, 10, 11)
    expect(errors).toEqual([])
  } finally { await page.evaluate(() => window.windowRegionHost.dispose()) }
})

test('region revisions belong to an exact surface epoch and invalid updates preserve the prior clip', async ({ page }) => {
  const errors = await launch(page)
  try {
    await page.evaluate(() => window.windowRegionHost.publish(22, 10, { width: 320, height: 180, rectangles: [0, 0, 80, 180] }))
    await hit(page, 40, 80, 22)
    await hit(page, 160, 80, 11)
    const clip = await page.evaluate(() => window.windowRegionHost.snapshot(22).clip)
    expect(clip).not.toBe('none')
    expect(await page.evaluate(() => window.windowRegionHost.snapshot(22).definitions)).toBe(1)
    for (const kind of ['tuple', 'bounds', 'type', 'dimension', 'empty-rectangle'] as const) {
      expect(await page.evaluate((kind) => window.windowRegionHost.invalid(22, 11, kind), kind)).not.toBe('')
      expect(await page.evaluate(() => window.windowRegionHost.snapshot(22).clip)).toBe(clip)
      await hit(page, 160, 80, 11)
    }
    await page.evaluate(() => {
      window.windowRegionHost.publish(22, 9, null)
      window.windowRegionHost.publish(22, 10, null)
      window.windowRegionHost.publish(22, 100, null, 0)
      window.windowRegionHost.publish(22, 100, null, 2)
    })
    await hit(page, 160, 80, 11)
    // An invalid revision-11 update did not consume that revision.
    await page.evaluate(() => window.windowRegionHost.publish(22, 11, null))
    await hit(page, 160, 80, 22)
    await page.evaluate(() => window.windowRegionHost.publish(22, 12, { width: 320, height: 180, rectangles: [] }))
    await hit(page, 40, 80, 11)
    await page.evaluate(() => window.windowRegionHost.detach(22, 1))
    await expect(page.locator('clipPath')).toHaveCount(0)
    await page.evaluate(() => window.windowRegionHost.replace(22, 2))
    await hit(page, 160, 80, 22)
    expect(await page.evaluate(() => window.windowRegionHost.snapshot(22).clip)).toBe('none')
    await page.evaluate(() => window.windowRegionHost.publish(22, 999, { width: 320, height: 180, rectangles: [] }, 1))
    await hit(page, 160, 80, 22)
    await page.evaluate(() => window.windowRegionHost.publish(22, 1, { width: 320, height: 180, rectangles: [0, 0, 80, 180] }, 2))
    await hit(page, 160, 80, 11)
    expect(errors).toEqual([])
  } finally { await page.evaluate(() => window.windowRegionHost.dispose()) }
  await expect(page.locator('.game-window')).toHaveCount(0)
  await expect(page.locator('clipPath')).toHaveCount(0)
})
