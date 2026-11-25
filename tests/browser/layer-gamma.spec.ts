import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { layerGammaCases, layerGammaCanvas, layerGammaExpected, layerGammaSource } from '../helpers/layer-gamma.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Layer contrast adjustment preserves exact RGB and alpha through canvas`, async ({ page }, info) => {
    const game = await launchWindowAttention(page, backend, binary, layerGammaSource),
      canvas = game.surface('Gamma contrast').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      for (const row of layerGammaCases) {
        await evaluate(page, `layerGammaRun("${row.id}")`, layerGammaExpected(row))
        await evaluate(page, 'layerGammaShow()', 'shown')
        const actual = () => canvas.evaluate((element) => {
          const source = element as HTMLCanvasElement, copy = new OffscreenCanvas(source.width, source.height),
            context = copy.getContext('2d', { willReadFrequently: true })!
          context.drawImage(source, 0, 0)
          return { width: source.width, height: source.height,
            rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
        })
        await expect.poll(actual).toEqual(layerGammaCanvas(row))
        observations.push({ id: row.id, expectedRaw: layerGammaExpected(row), actualCanvas: await actual() })
      }
      await info.attach('gamma-contrast-canvas', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await evaluate(page, 'layerGammaClose()', 'closed')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('layer-gamma-observations', { contentType: 'application/json', body: JSON.stringify({
        backend, binary, observations, logs: await page.locator('#logs').innerText(),
        failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
        scope: 'Real source/compiled Layer.adjustGamma, literal raw RGB/mask/province/clip assertions and actual opaque RGB/mask canvas rows. No browser color filter or substituted decoder output.',
      }) })
    } catch (error) { failures.push(error) }
    try {
      await game.stop()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Layer gamma or cleanup failed', { cause: failures[0] })
  })
