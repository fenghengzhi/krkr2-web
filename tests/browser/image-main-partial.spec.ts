import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { imagePartialFiles, imagePartialSource, partialColor, partialKey } from '../helpers/image-partial-fixtures.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

async function pixels(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement,
      output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height,
      rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}

// Independent full-frame oracle: the root is opaque black; the first image
// column is keyed transparent. Unwritten portable rows use the Web zero policy,
// not a claimed match for the native allocator's uninitialized memory.
const displayed = (rows: number) => ({ width: 20, height: 24,
  rgba: Array.from({ length: 20 * 24 }, (_, index) => {
    const x = index % 20, y = Math.floor(index / 20)
    return x >= 1 && x < 5 && y < rows ? [200, 100, 50, 255] : [0, 0, 0, 255]
  }).flat() })

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: failed main and mask decoders retain native partial pixels before successful Layer finalization`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], observations: unknown[] = []
    const game = await launchWindowAttention(page, backend, binary,
      imagePartialSource + '\nSystem.assignMessage("TJSReadError","partial-stream-short-read");',
      Object.entries(imagePartialFiles()).map(([name, buffer]) => ({ name, mimeType: 'application/octet-stream', buffer }))),
      canvas = game.surface('Image partial').locator('canvas[data-window-id]'),
      initial = '0,0,3,2,7,19,-2,-1,1,1,2,2', partial = '0,0,3,2,5,17,-2,-1,1,1,2,2'
    const showPartial = async (rows: number) => {
      // Failure itself skips native Update. This explicit script update is
      // what makes its already-mutated bitmap observable on the real canvas.
      await evaluate(page, '(partialLayer.setImagePos(0,0),partialLayer.setSize(5,17),partialLayer.setClip(0,0,5,17),partialLayer.update(),0)', '0')
      await expect.poll(() => pixels(canvas)).toEqual(displayed(rows))
      observations.push({ rows, frame: await pixels(canvas) })
    }
    try {
      await expect(canvas).toHaveJSProperty('width', 20)
      await expect(canvas).toHaveJSProperty('height', 24)
      await evaluate(page, 'partialGeometry()', initial)
      await evaluate(page, 'partialLoad("early.bmp")', 'failed:partial-stream-short-read')
      await evaluate(page, 'partialGeometry()', initial)
      await evaluate(page, 'partialPlaneState()', '1193046,74,91,0,0')

      await evaluate(page, `partialLoad("main-truncated.bmp",${partialKey})`, 'failed:partial-stream-short-read')
      await evaluate(page, 'partialGeometry()', partial)
      await evaluate(page, 'partialPlaneState()', `${partialColor},255,91,0,0`)
      await evaluate(page, '[partialLayer.getMainPixel(1,7),partialLayer.getMaskPixel(0,7),partialLayer.getMainPixel(1,8),partialLayer.getMaskPixel(1,8)].join(",")', `${partialColor},0,0,0`)
      await showPartial(8)

      await evaluate(page, '(resetPartialImage(),0)', '0')
      // A failed mask has already bound its first complete eight rows. Alpha
      // matting must not run after that failure; the main RGB stays original.
      await evaluate(page, 'partialLoad("mask-truncated.bmp",0x04ffffff)', 'failed:partial-stream-short-read')
      await evaluate(page, 'partialGeometry()', partial)
      await evaluate(page, 'partialPlaneState()', `${partialColor},64,91,0,0`)
      await evaluate(page, '[partialLayer.getMainPixel(1,7),partialLayer.getMaskPixel(1,7),partialLayer.getMainPixel(1,8),partialLayer.getMaskPixel(1,8)].join(",")', `${partialColor},92,${partialColor},255`)

      await evaluate(page, '(resetPartialImage(),0)', '0')
      await evaluate(page, `partialLoad("png-tail.png",${partialKey})`, 'failed:partial-png:IEND: CRC error')
      await evaluate(page, 'partialGeometry()', partial)
      await evaluate(page, 'partialPlaneState()', `${partialColor},255,91,0,0`)
      await evaluate(page, '[partialLayer.getMainPixel(1,16),partialLayer.getMaskPixel(0,16),partialLayer.getMaskPixel(1,16)].join(",")', `${partialColor},0,255`)
      await showPartial(17)
      // A failed normal image is never a successful processed cache entry.
      await evaluate(page, '(resetPartialImage(),0)', '0')
      await evaluate(page, `partialLoad("png-tail.png",${partialKey})`, 'failed:partial-png:IEND: CRC error')
      await evaluate(page, 'partialGeometry()', partial)
    } catch (error) { failures.push(error) }
    try { await info.attach('partial-main-display', { contentType: 'application/json',
      body: JSON.stringify({ backend, binary, observations,
        boundary: 'Real Worker selected decoders and complete committed canvas bytes after an explicit script Update' }) }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Partial image loading or cleanup failed', { cause: failures[0] })
  })
