import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { imageReadFiles, imageReadSource, imageReadLiteral, imageReadSecondLiteral,
  imageReadInitialGeometry, imageReadPartialGeometry } from '../helpers/image-read-errors.ts'

async function pixels(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height,
      rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}
function frame(rows: number, solid = false) {
  return { width: 20, height: 24, rgba: Array.from({ length: 20 * 24 }, (_, index) => {
    const x = index % 20, y = Math.floor(index / 20)
    return x < 5 && (solid || x > 0) && y < rows ? [200, 100, 50, 255] : [0, 0, 0, 255]
  }).flat() }
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real selected image short reads use dynamic literal TJS messages and retain native main/mask write phases`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = [], observations: unknown[] = [], files = Object.entries(imageReadFiles())
      .map(([name, buffer]) => ({ name, buffer, mimeType: 'application/octet-stream' }))
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      game = await launchWindowAttention(page, backend, binary, imageReadSource, files, true)
      const canvas = game.surface('Image read errors').locator('canvas[data-window-id]'),
        reset = () => evaluate(page, '(resetPartialImage(),0)', '0'),
        failed = (name: string, expected = imageReadLiteral, key = 'clNone') =>
          evaluate(page, `partialLoad(${JSON.stringify(name)},${key})`, 'failed:' + expected),
        show = async (rows: number, solid = false) => {
          // Native main-read failure does not request Update. Publish explicitly
          // only after proving the old display/offset/clip/province state.
          await evaluate(page, '(partialLayer.setImagePos(0,0),partialLayer.setSize(5,17),partialLayer.setClip(0,0,5,17),partialLayer.update(),0)', '0')
          await expect.poll(() => pixels(canvas)).toEqual(frame(rows, solid))
          observations.push({ rows, solid, pixels: await pixels(canvas) })
        }
      await expect(canvas).toHaveJSProperty('width', 20)
      await expect(canvas).toHaveJSProperty('height', 24)
      await failed('read-bmp-header.bmp', 'Read error')
      await evaluate(page, `System.assignMessage("TJSReadError",${JSON.stringify(imageReadLiteral)})`, '1')
      for (const name of ['read-bmp-header.bmp', 'read-bmp-palette.bmp', 'read-tlg-header.tlg',
        'read-png-signature.png', 'read-png-header.png']) {
        await failed(name)
        await evaluate(page, 'partialGeometry()', imageReadInitialGeometry)
        await evaluate(page, 'partialPlaneState()', '1193046,74,91,0,0')
      }
      for (const [name, solid] of [['read-bmp-late.bmp', false], ['read-tlg-late.tlg', true]] as const) {
        await reset(); await failed(name, imageReadLiteral, '0x112233')
        await evaluate(page, 'partialGeometry()', imageReadPartialGeometry)
        await evaluate(page, 'partialPlaneState()', '13132850,255,91,0,0')
        await evaluate(page, '[partialLayer.getMainPixel(1,7),partialLayer.getMainPixel(1,8),partialLayer.getMaskPixel(1,8)].join(",")', '13132850,0,0')
        await show(8, solid)
      }
      await reset(); await failed('read-png-idat.png')
      await evaluate(page, 'partialGeometry()', imageReadPartialGeometry)
      await evaluate(page, 'partialPlaneState()', '0,0,91,0,0')
      for (const [name, solid] of [['read-png-tail.png', false], ['read-tlg-tags.tlg', true]] as const) {
        await reset(); await failed(name, imageReadLiteral, '0x112233')
        await evaluate(page, 'partialGeometry()', imageReadPartialGeometry)
        await evaluate(page, 'partialPlaneState()', '13132850,255,91,0,0')
        await show(17, solid)
      }
      for (const [name, lastAlpha] of [['read-mask.bmp', 255], ['read-png-mask.bmp', 128]] as const) {
        await reset(); await failed(name, imageReadLiteral, 'clAlphaMat+0xffffff')
        await evaluate(page, 'partialGeometry()', imageReadPartialGeometry)
        await evaluate(page, 'partialPlaneState()', '13132850,64,91,0,0')
        await evaluate(page, '[partialLayer.getMainPixel(1,7),partialLayer.getMaskPixel(1,7),partialLayer.getMainPixel(1,16),partialLayer.getMaskPixel(1,16)].join(",")',
          `13132850,92,13132850,${lastAlpha}`)
      }
      await evaluate(page, `System.assignMessage("TJSReadError",${JSON.stringify(imageReadSecondLiteral)})`, '1')
      await reset(); await failed('read-bmp-late.bmp', imageReadSecondLiteral, '0x112233')
      await evaluate(page, 'partialGeometry()', imageReadPartialGeometry)
      await reset(); await failed('codec-bad-crc.png', 'partial-png:IHDR: CRC error')
      await failed('codec-bad-header.tlg', 'read-tlg:Invalid TLG header or unsupported TLG version.')
      await evaluate(page, 'partialGeometry()', imageReadInitialGeometry)
      await evaluate(page, 'partialLoad("tlg-short-optional-name.tlg")', 'null:')
      await evaluate(page, 'int(partialLayer.imageModified)', '1')
      await show(17, true)
      await game.stop(); game = undefined

      // The real new Worker/VM must restore its default holder, despite the
      // previous Session's literal percent-bearing message assignments.
      game = await launchWindowAttention(page, backend, binary, imageReadSource, files, true)
      await evaluate(page, 'partialLoad("read-png-signature.png")', 'failed:Read error')
      await evaluate(page, 'partialGeometry()', imageReadInitialGeometry)
    } catch (error) { failures.push(error) }
    try { await info.attach('image-read-errors', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, observations, literal: imageReadLiteral, reassigned: imageReadSecondLiteral,
      scope: 'Actual selected BMP/TLG/PNG bytes in the real Worker; partial frames are shown only by explicit script Update.',
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Image short-read browser scenario and cleanup failed', { cause: failures[0] })
  })
