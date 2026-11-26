import { test, expect } from '@playwright/test'
import { mappedTextFiles, mappedTextSource, mappedTextFrameMismatch } from '../helpers/mapped-text.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: player clicks fade the mapped subtitle with exact native coverage colors`, async ({ page }, info) => {
    test.setTimeout(90000)
    const files = mappedTextFiles(), game = await launchWindowAttention(page, backend, binary, mappedTextSource + '\nmappedTextMenu();',
      Object.entries(files).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }))),
      canvas = game.surface('Mapped subtitle opacity').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      for (let phase = 0; phase < 4; phase++) {
        if (phase) { const point = await pointerPixel(canvas, 160, 96); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`mapped-subtitle-phase:${phase}:48`, { exact: true })).toBeVisible()
        let png: Buffer | undefined
        await expect.poll(async () => {
          png = await canvas.screenshot({ scale: 'css' }); const image = readScreenshotPng(png)
          return mappedTextFrameMismatch(image.rgba, image.width, image.height, phase)
        }).toBeNull()
        await info.attach(`mapped-subtitle-${phase}`, { body: png!, contentType: 'image/png' })
        observations.push({ phase, opacity: [255, 192, 128, 64][phase] })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('mapped-subtitle-input', { body: Buffer.from(files['mapped-subtitle.tft']!), contentType: 'application/octet-stream' }),
      async () => info.attach('mapped-subtitle-observations', { body: JSON.stringify({ source: mappedTextSource, observations,
        scope: 'Authored mapped TFT, actual player clicks and complete 320x112 RGBA against literal subtitle colors. System-font glyph rasterization is outside this comparison.',
        logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Mapped subtitle frame or cleanup failed', { cause: failures[0] })
  })
