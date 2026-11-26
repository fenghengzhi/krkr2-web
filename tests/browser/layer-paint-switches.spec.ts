import { expect, test } from '@playwright/test'
import { layerPaintFrame, layerPaintPixels, layerPaintSource, layerPaintStates } from '../helpers/layer-paint-switches.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: player clicks change cached group rendering and an explicitly enabled paint callback`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], observations: unknown[] = [],
      game = await launchWindowAttention(page, backend, binary, layerPaintSource + '\npaintSwitchMenu();'),
      canvas = game.surface('Painted choices').locator('canvas[data-window-id]')
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      await expect(canvas).toHaveJSProperty('width', 240); await expect(canvas).toHaveJSProperty('height', 160)
      for (let phase = 0; phase < 4; phase++) {
        if (phase) {
          const point = await pointerPixel(canvas, 40, 130)
          await page.mouse.click(point.x, point.y)
        }
        const state = layerPaintStates[phase] + '|' + layerPaintPixels[phase], expected = layerPaintFrame(phase)
        await evaluate(page, 'paintSwitchState()+"|"+paintSwitchPixels()', state)
        await canvas.scrollIntoViewIfNeeded()
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.width !== 240 || image.height !== 160) return { dimensions: [image.width, image.height] }
          if (image.bounds.width !== 240 || image.bounds.height !== 160) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          for (let at = 0; at < expected.length; at++) if (image.rgba[at] !== expected[at])
            return { at, expected: expected[at], actual: image.rgba[at] }
          return null
        }).toBeNull()
        observations.push({ phase, state, width: captured!.width, height: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        await info.attach('paint-switch-' + phase, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach('paint-switch-' + phase + '-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length && captured) for (const attach of [
      () => info.attach('paint-switch-last-captured-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' }),
      async () => info.attach('paint-switch-failed-screen', { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    try {
      await info.attach('paint-switch-observations', { contentType: 'application/json', body: JSON.stringify({
        source: layerPaintSource, observations, logs: await page.locator('#logs').innerText(),
        lastCanvas: captured && { width: captured.width, height: captured.height, bounds: captured.bounds, devicePixelRatio: captured.devicePixelRatio },
        scope: 'Actual left-button choices, script onPaint counts/consumed flag, original image-less group cached/exposed pixels, raw piledCopy samples and every backing-canvas RGBA byte. Unmodified screen PNGs retain fractional CSS placement separately. The suppressed paint keeps its previous visible pixels; the following click restores it.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer paint switch browser path or cleanup failed', { cause: failures[0] })
  })
