import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'
import { layerColorOpacityFrame, layerColorOpacitySource, layerColorOpacityStates } from '../helpers/layer-color-opacity.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: restoring a shaded chapter across zero opacity keeps its pixels and Continue button working`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], observations: unknown[] = [],
      game = await launchWindowAttention(page, backend, binary, layerColorOpacitySource + '\ncolorOpacityMenu();'),
      canvas = game.surface('Chapter fade').locator('canvas[data-window-id]')
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      await expect(canvas).toHaveJSProperty('width', 320); await expect(canvas).toHaveJSProperty('height', 160)
      for (let phase = 0; phase < 3; phase++) {
        if (phase) {
          const point = await pointerPixel(canvas, 40, 130)
          await page.mouse.click(point.x, point.y)
        }
        await expect(page.getByText((phase ? 'color-opacity:' : 'color-opacity-ready:') + layerColorOpacityStates[phase],
          { exact: true })).toBeVisible()
        await evaluate(page, 'colorOpacityState()', layerColorOpacityStates[phase]!)
        const expected = layerColorOpacityFrame(phase)
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.width !== 320 || image.height !== 160) return { dimensions: [image.width, image.height] }
          if (image.bounds.width !== 320 || image.bounds.height !== 160) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          for (let at = 0; at < expected.length; at++) if (image.rgba[at] !== expected[at])
            return { at, expected: expected[at], actual: image.rgba[at] }
          return null
        }).toBeNull()
        observations.push({ phase, state: layerColorOpacityStates[phase], width: captured!.width, height: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        await info.attach('chapter-opacity-' + phase, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach('chapter-opacity-' + phase + '-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('chapter-opacity-observations', { contentType: 'application/json', body: JSON.stringify({
        source: layerColorOpacitySource, observations, logs: await page.locator('#logs').innerText(),
        failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
        scope: 'Two real Layer button clicks restore then continue a chapter. The ordinary fade visits 96,32,-32 opacity; each complete scene RGBA byte and the raw intermediate pixels are literal assertions. Platform button glyphs remain visible in the unmodified screenshots and full canvas attachments.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Chapter opacity or cleanup failed', { cause: failures[0] })
  })
