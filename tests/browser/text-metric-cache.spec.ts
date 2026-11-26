import { test, expect } from '@playwright/test'
import { textMetricSource, textMetricFrameMismatch } from '../helpers/text-metric-cache.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: advancing a dialogue preserves the bitmap's measured empty row until its font changes`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, textMetricSource + '\ntextMetricMenu();'),
      canvas = game.surface('Empty dialogue rows').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      for (const [phase, height] of [0, 24, 24, 0].entries()) {
        if (phase) { const point = await pointerPixel(canvas, 160, 96); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`text-metric-phase:${phase}:${height}`, { exact: true })).toBeVisible()
        let png: Buffer | undefined
        await expect.poll(async () => {
          png = await canvas.screenshot({ scale: 'css' }); const image = readScreenshotPng(png)
          return textMetricFrameMismatch(image.rgba, image.width, image.height, phase)
        }).toBeNull()
        await info.attach(`text-metric-${phase}`, { body: png!, contentType: 'image/png' })
        observations.push({ phase, height })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('text-metric-observations', { body: JSON.stringify({ source: textMetricSource, observations,
      scope: 'Six discarded metric calls must leave the first empty dialogue at zero. Real Next clicks then consume text height and preserve whole-frame equality against authored row positions 0/24/24/0. System glyph pixels are compared within the same frame; Windows raster identity is not asserted.',
      logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Dialogue blank row or cleanup failed', { cause: failures[0] })
  })
