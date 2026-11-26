import { expect, test } from '@playwright/test'
import { layerInputBooleanSource, layerInputFrame, layerInputStates } from '../helpers/layer-input-booleans.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real clicks and Tab follow native boolean choice visibility and enabled state`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], observations: unknown[] = [],
      game = await launchWindowAttention(page, backend, binary, layerInputBooleanSource + '\nlayerInputMenu();'),
      surface = game.surface('Selectable choices'), canvas = surface.locator('canvas[data-window-id]')
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      await expect(canvas).toHaveJSProperty('width', 240); await expect(canvas).toHaveJSProperty('height', 120)
      const check = async (state: string, phase: number) => {
        await evaluate(page, 'layerInputState()', state)
        const expected = layerInputFrame(phase)
        await canvas.scrollIntoViewIfNeeded()
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.width !== 240 || image.height !== 120) return { dimensions: [image.width, image.height] }
          if (image.bounds.width !== 240 || image.bounds.height !== 120) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          for (let at = 0; at < expected.length; at++) if (image.rgba[at] !== expected[at])
            return { at, expected: expected[at], actual: image.rgba[at] }
          return null
        }).toBeNull()
        observations.push({ state, phase, width: captured!.width, height: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        await info.attach(`layer-choice-${observations.length}-${phase}`, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach(`layer-choice-${observations.length}-${phase}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
      }
      const key = async (name: string) => {
        await canvas.focus(); await expect(surface.locator('.game-text-input')).toBeFocused()
        await page.keyboard.press(name)
      }
      const click = async () => {
        const point = await pointerPixel(canvas, 40, 30)
        await page.mouse.click(point.x, point.y)
      }
      await check(layerInputStates[0], 0)
      await key('Tab'); await check(layerInputStates[0], 0)
      await click(); await check(layerInputStates[1], 1)
      await click(); await check(layerInputStates[1], 1)
      await key('Enter'); await check(layerInputStates[2], 2)
      await key('Tab'); await check(layerInputStates[2], 2)
      await key('Enter'); await check(layerInputStates[3], 3)
      await key('Tab'); await check(layerInputStates[4], 3)
      await key('Enter'); await check(layerInputStates[5], 4)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length && captured) for (const attach of [
      () => info.attach('layer-choice-last-captured-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' }),
      async () => info.attach('layer-choice-failed-screen', { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    try {
      await info.attach('layer-boolean-choices', { contentType: 'application/json', body: JSON.stringify({
        source: layerInputBooleanSource, observations, logs: await page.locator('#logs').innerText(),
        lastCanvas: captured && { width: captured.width, height: captured.height, bounds: captured.bounds, devicePixelRatio: captured.devicePixelRatio },
        scope: 'Real player mouse/Tab/Enter on the actual Layer tree. Exact focus/choice state and every backing-canvas RGBA byte are checked; unmodified screen PNGs retain fractional CSS placement separately. Nonzero reals, objects and Octet activate native bool properties; numeric strings retain original integer truth conversion.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer boolean browser choices or cleanup failed', { cause: failures[0] })
  })
