import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pngStreamConsumerFiles, pngStreamConsumerSource, streamMainKey } from '../helpers/png-stream-consumer-fixtures.ts'

async function pixels(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height, rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}
const completeFrame = { width: 8, height: 6, rgba: Array.from({ length: 8 * 6 }, (_, index) =>
  index % 8 === 1 && Math.floor(index / 8) < 2 ? [200,100,50,255] : [0,0,0,255]).flat() }

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: pull PNG separates raw main writes from mask completion and replays a complete cached image`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], observations: unknown[] = [],
      game = await launchWindowAttention(page, backend, binary, pngStreamConsumerSource,
        Object.entries(pngStreamConsumerFiles()).map(([name, buffer]) => ({ name, mimeType: 'application/octet-stream', buffer }))),
      canvas = game.surface('PNG stream').locator('canvas[data-window-id]')
    try {
      await expect(canvas).toHaveJSProperty('width', 8)
      await expect(canvas).toHaveJSProperty('height', 6)
      await evaluate(page, `streamLoad("raw-main.png",${streamMainKey})`, 'stream-png:IDAT: CRC error')
      await evaluate(page, 'streamPixels()', '1122867,0,13132850,255,1122867,99,13132850,110')
      await evaluate(page, 'streamState()', '3,3,2,2,-1,-1,1,1,1,1,0,91')
      observations.push({ phase: 'main raw row retained before completion' })
      await evaluate(page, '(resetStream(),0)', '0')
      await evaluate(page, 'streamLoad("raw-mask.bmp",0x04ffffff)', 'stream-png:IDAT: CRC error')
      await evaluate(page, 'streamPixels()', '1122867,32,13132850,48,1122867,200,13132850,200')
      await evaluate(page, 'streamState()', '3,3,2,2,-1,-1,1,1,1,1,0,91')
      observations.push({ phase: 'mask incomplete row left main alpha unchanged; no matte' })
      await evaluate(page, '(resetStream(),0)', '0')
      await evaluate(page, `streamLoad("good.png",${streamMainKey})`, 'ok')
      await evaluate(page, 'streamPixels()', '1122867,0,13132850,255,1122867,0,13132850,255')
      await evaluate(page, 'streamState()', '2,2,2,2,0,0,0,0,2,2,1,0')
      await expect.poll(() => pixels(canvas)).toEqual(completeFrame)
      await evaluate(page, '(streamLayer.setMainPixel(1,1,0xabcdef),0)', '0')
      await evaluate(page, `streamLoad("good.png",${streamMainKey})`, 'ok')
      await expect.poll(() => pixels(canvas)).toEqual(completeFrame)
      observations.push({ phase: 'complete split trailer and immutable replay', frame: await pixels(canvas) })
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('png-stream-consumer', { contentType: 'application/json', body: JSON.stringify({ backend, binary, observations }) }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'PNG stream browser assertion and cleanup failed', { cause: failures[0] })
  })
