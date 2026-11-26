import { test, expect } from '@playwright/test'
import { mappedTextFiles, mappedTextSource, mappedTextFrameMismatch } from '../helpers/mapped-text.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: player clicks fade the mapped subtitle with exact native coverage colors`, async ({ page }, info) => {
    test.setTimeout(90000)
    const files = mappedTextFiles(), game = await launchWindowAttention(page, backend, binary, mappedTextSource + '\nmappedTextMenu();',
      Object.entries(files).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }))),
      canvas = game.surface('Mapped subtitle opacity').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      for (let phase = 0; phase < 4; phase++) {
        if (phase) { const point = await pointerPixel(canvas, 160, 96); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`mapped-subtitle-phase:${phase}:48`, { exact: true })).toBeVisible()
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.bounds.width !== 320 || image.bounds.height !== 112) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          return mappedTextFrameMismatch(Uint8Array.from(image.rgba), image.width, image.height, phase)
        }).toBeNull()
        await info.attach(`mapped-subtitle-${phase}`, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach(`mapped-subtitle-${phase}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
        observations.push({ phase, opacity: [255, 192, 128, 64][phase], width: captured!.width, height: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length && captured) for (const attach of [
      () => info.attach('mapped-subtitle-last-captured-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' }),
      async () => info.attach('mapped-subtitle-failed-screen', { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('mapped-subtitle-input', { body: Buffer.from(files['mapped-subtitle.tft']!), contentType: 'application/octet-stream' }),
      async () => info.attach('mapped-subtitle-observations', { body: JSON.stringify({ source: mappedTextSource, observations,
        lastCanvas: captured && { width: captured.width, height: captured.height, bounds: captured.bounds, devicePixelRatio: captured.devicePixelRatio },
        scope: 'Authored mapped TFT, actual player clicks and complete 320x112 backing-canvas RGBA against literal subtitle colors. Unmodified screen PNGs retain fractional CSS placement separately. System-font glyph rasterization is outside this comparison.',
        logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Mapped subtitle frame or cleanup failed', { cause: failures[0] })
  })
