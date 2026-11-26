import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { fontCandidateCases, fontCandidateFrameMismatch, fontCandidateGameSource } from '../helpers/font-candidate-game.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real font choices display the first available packaged family without opening a font dialog`, async ({ page }, info) => {
    test.setTimeout(90000)
    const files = await Promise.all(['narrow.ttf', 'wide.ttf'].map(async (name) => ({ name, mimeType: 'font/ttf',
      buffer: await readFile(new URL('../fixtures/font/' + name, import.meta.url)) }))),
      game = await launchWindowAttention(page, backend, binary, fontCandidateGameSource, files),
      canvas = game.surface('Dialogue font choices').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      await expect(canvas).toHaveJSProperty('width', 360); await expect(canvas).toHaveJSProperty('height', 100)
      await canvas.scrollIntoViewIfNeeded()
      for (const [phase, row] of fontCandidateCases.entries()) {
        if (phase) { const point = await pointerPixel(canvas, 60, 80); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`candidate-font:${phase}:${row.width}:${row.face}`, { exact: true })).toBeVisible({ timeout: 15000 })
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.bounds.width !== 360 || image.bounds.height !== 100) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          return fontCandidateFrameMismatch(Uint8Array.from(image.rgba), image.width, image.height, phase)
        }).toBeNull()
        observations.push({ phase, ...row, width: captured!.width, height: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        await info.attach(`font-candidate-${phase}`, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach(`font-candidate-${phase}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length && captured) for (const attach of [
      () => info.attach('font-candidate-last-captured-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' }),
      async () => info.attach('font-candidate-failed-screen', { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    try { await info.attach('font-candidate-game', { contentType: 'application/json', body: JSON.stringify({
      source: fontCandidateGameSource, observations, logs: await page.locator('#logs').innerText(),
      lastCanvas: captured && { width: captured.width, height: captured.height, bounds: captured.bounds, devicePixelRatio: captured.devicePixelRatio },
      scope: 'Ordinary text performs the first font-family discovery. Real clicks change ordered candidates. The entire selected backing-canvas panel equals the direct-file reference, differs from the other font, and contains visible AA glyphs; the bottom status has an authored literal color. Exact intrinsic/CSS extents and unmodified screen PNGs are retained separately from fractional placement. Missing/local system names are a browser availability policy, not a Windows EnumFonts equivalence claim.' }, null, 2) }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Font candidate gameplay or cleanup failed', { cause: failures[0] })
  })
