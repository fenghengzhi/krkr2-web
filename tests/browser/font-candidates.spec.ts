import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fontCandidateCases, fontCandidateFrameMismatch, fontCandidateGameSource } from '../helpers/font-candidate-game.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real font choices display the first available packaged family without opening a font dialog`, async ({ page }, info) => {
    test.setTimeout(90000)
    const files = await Promise.all(['narrow.ttf', 'wide.ttf'].map(async (name) => ({ name, mimeType: 'font/ttf',
      buffer: await readFile(new URL('../fixtures/font/' + name, import.meta.url)) }))),
      game = await launchWindowAttention(page, backend, binary, fontCandidateGameSource, files),
      canvas = game.surface('Dialogue font choices').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      await expect(canvas).toHaveJSProperty('width', 360); await expect(canvas).toHaveJSProperty('height', 100)
      await canvas.scrollIntoViewIfNeeded()
      for (const [phase, row] of fontCandidateCases.entries()) {
        if (phase) { const point = await pointerPixel(canvas, 60, 80); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`candidate-font:${phase}:${row.width}:${row.face}`, { exact: true })).toBeVisible({ timeout: 15000 })
        let png: Buffer | undefined
        await expect.poll(async () => {
          png = await canvas.screenshot({ scale: 'css' }); const image = readScreenshotPng(png)
          return fontCandidateFrameMismatch(image.rgba, image.width, image.height, phase)
        }).toBeNull()
        observations.push({ phase, ...row })
        await info.attach(`font-candidate-${phase}`, { body: png!, contentType: 'image/png' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('font-candidate-game', { contentType: 'application/json', body: JSON.stringify({
      source: fontCandidateGameSource, observations, logs: await page.locator('#logs').innerText(),
      scope: 'Ordinary text performs the first font-family discovery. Real clicks change ordered candidates. The entire selected panel equals the direct-file reference, differs from the other font, and contains visible AA glyphs; the bottom status has an authored literal color. Missing/local system names are a browser availability policy, not a Windows EnumFonts equivalence claim.' }, null, 2) }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Font candidate gameplay or cleanup failed', { cause: failures[0] })
  })
