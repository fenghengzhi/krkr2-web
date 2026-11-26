import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { authoredMinchoFont, localizedMinchoCases, localizedMinchoFrameMismatch, localizedMinchoGameSource } from '../helpers/font-localized-mincho.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a player switches localized Mincho dialogue faces using the packaged font before host substitutes`, async ({ page }, info) => {
    test.setTimeout(90000)
    const narrow = await readFile(new URL('../fixtures/font/narrow.ttf', import.meta.url)),
      wide = await readFile(new URL('../fixtures/font/wide.ttf', import.meta.url)),
      files = [
        { name: 'narrow.ttf', mimeType: 'font/ttf', buffer: narrow }, { name: 'wide.ttf', mimeType: 'font/ttf', buffer: wide },
        { name: 'pmincho.ttf', mimeType: 'font/ttf', buffer: Buffer.from(authoredMinchoFont(narrow, 'MS PMincho')) },
        { name: 'mincho.ttf', mimeType: 'font/ttf', buffer: Buffer.from(authoredMinchoFont(wide, 'MS Mincho')) },
      ], game = await launchWindowAttention(page, backend, binary, localizedMinchoGameSource, files),
      canvas = game.surface('Dialogue font choices').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      await expect(canvas).toHaveJSProperty('width', 360); await expect(canvas).toHaveJSProperty('height', 100)
      await canvas.scrollIntoViewIfNeeded()
      for (const [phase, row] of localizedMinchoCases.entries()) {
        if (phase) { const point = await pointerPixel(canvas, 60, 80); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`candidate-font:${phase}:${row.width}:${row.face}`, { exact: true })).toBeVisible({ timeout: 15000 })
        let observed: Awaited<ReturnType<typeof canvasPixels>> | undefined
        await expect.poll(async () => {
          observed = await canvasPixels(canvas)
          return localizedMinchoFrameMismatch(Uint8Array.from(observed.rgba), observed.width, observed.height, phase)
        }).toBeNull()
        observations.push({ phase, ...row, canvas: observed })
        await info.attach(`localized-mincho-${phase}`, { body: await canvas.screenshot({ scale: 'css' }), contentType: 'image/png' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('localized-mincho-dialogue', { contentType: 'application/json', body: JSON.stringify({
      source: localizedMinchoGameSource, observations, logs: await page.locator('#logs').innerText(),
      scope: 'Project-owned 500/900-unit outlines renamed to the two English Mincho family identities. Real clicks select localized/English names and reverse candidate priority; every displayed RGBA pixel matches the independent direct-file panel and differs from the other face. This verifies Web family-name resolution, not Microsoft font outlines or cross-locale Windows enumeration.' }, null, 2) }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Localized Mincho dialogue or cleanup failed', { cause: failures[0] })
  })
