import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pngMetadataExpected, pngNativeFiles, pngNativeFrame, pngNativeSource } from '../helpers/png-native-contract.ts'

async function frame(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height,
      rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: native PNG transparency and metadata reach actual Layer pixels and cache consumers`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, pngNativeSource,
      Object.entries(pngNativeFiles()).map(([name, buffer]) => ({ name, mimeType: 'image/png', buffer }))),
      canvas = game.surface('PNG native contract').locator('canvas[data-window-id]'), failures: unknown[] = []
    try {
      await evaluate(page, 'pngAlpha()', '255,255,0,255,64,191')
      await expect.poll(() => frame(canvas)).toEqual(pngNativeFrame)
      await evaluate(page, 'pngMeta()', pngMetadataExpected)
      await evaluate(page, '(pngMetadata.offs_x="changed",pngMetadata.vpag_w="changed",[pngMetadata.offs_x,pngMetadata.vpag_w].join(","))', 'changed,changed')
      await evaluate(page, 'pngMeta()', pngMetadataExpected)
      await evaluate(page, 'pngEmptyMeta("native-tail.png")', '1')
      await evaluate(page, 'pngEmptyMeta("native-short.png")', '1')
      await evaluate(page, 'pngCrcMeta()', '1,1,-1,9,pixel')
      await expect.poll(() => frame(canvas)).toEqual(pngNativeFrame)
      await info.attach('png-native-complete-frame', { contentType: 'application/json',
        body: JSON.stringify({ backend, binary, frame: await frame(canvas),
          boundary: 'Selected PNG through real Worker, TJS/bytecode, Layer metadata/cache and committed canvas' }) })
    } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'PNG native browser consumer or cleanup failed', { cause: failures[0] })
  })
