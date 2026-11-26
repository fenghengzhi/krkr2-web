import { test, expect } from '@playwright/test'
import { fontMappingHeightFiles, fontMappingHeightSource, fontMappingHeightMismatch } from '../helpers/font-mapping-height.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: player switches independent default and normalized subtitle mappings`, async ({ page }, info) => {
    test.setTimeout(90000)
    const files = fontMappingHeightFiles(), game = await launchWindowAttention(page, backend, binary,
      fontMappingHeightSource + '\nsignedFontMenu();',
      Object.entries(files).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }))),
      canvas = game.surface('Signed subtitle mappings').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      for (let phase = 0; phase < 3; phase++) {
        if (phase) { const point = await pointerPixel(canvas, 160, 120); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`signed-font-phase:${phase}:${phase === 1 ? 12 : -12}:${phase === 1 ? 106 : 74}:106`, { exact: true })).toBeVisible()
        let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
        await expect.poll(async () => {
          captured = await canvasPixels(canvas)
          return fontMappingHeightMismatch(Uint8Array.from(captured.rgba), captured.width, captured.height, phase)
        }).toBeNull()
        observations.push({ phase, width: captured!.width, height: captured!.height, bounds: captured!.bounds,
          devicePixelRatio: captured!.devicePixelRatio })
        await info.attach(`signed-font-${phase}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
        await info.attach(`signed-font-${phase}-screen`, { body: await canvas.screenshot({ scale: 'css' }), contentType: 'image/png' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    for (const report of [
      ...Object.entries(files).map(([name, bytes]) => () => info.attach(name, { body: Buffer.from(bytes), contentType: 'application/octet-stream' })),
      async () => info.attach('signed-font-observations', { body: JSON.stringify({ source: fontMappingHeightSource, observations,
        scope: 'Two authored TFT files and real Next clicks. Complete displayed-canvas RGBA is compared at its 320x144 backing resolution, with unmodified CSS screenshots retained separately.',
        logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Signed subtitle game or cleanup failed', { cause: failures[0] })
  })
