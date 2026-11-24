import { test, expect } from '@playwright/test'
import { imageSelectionFiles, imageSelectionSource, imageSelectionErrors } from '../helpers/image-selection.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { magnifyPixelWindow } from '../helpers/pixel-window.ts'
import { jpegFixture } from '../helpers/jpeg-contract.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: selected image formats, modes and companion storage reach real pixels`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    // Independent hosted IJG6b encoder: 3x2 direct RGB, quality100, each
    // component a constant DC plane [32,96,160]. Original null_convert keeps
    // that order and TVP packs it as BGR, giving literal RGBA [160,96,32,255].
    // The C reference also requires every physical pixel [32,96,160,255].
    const jpeg = jpegFixture('constant-rgb')
    const startup = binary
      ? 'Scripts.compileStorage("selection.tjs","savedata/selection.cjs",false,true,false);Scripts.execStorage("savedata/selection.cjs");Debug.message("selection-ready");'
      : 'Scripts.execStorage("selection.tjs");Debug.message("selection-ready");'
    await page.locator('#files').setInputFiles([
      ...Object.entries(imageSelectionFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ...['jpeg', 'JPG', 'JIF'].map((extension) => ({ name: `photo.${extension}`, mimeType: 'image/jpeg', buffer: jpeg })),
      { name: 'selection.tjs', mimeType: 'text/plain', buffer: Buffer.from(imageSelectionSource) },
      { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(startup) },
    ])
    await expect(page.locator('#logs')).toContainText('selection-ready')
    await evaluate(page, 'imageSelectionMessages()', '1')
    await evaluate(page, 'imageSelectionOrder()', '1')
    await evaluate(page, 'imageSelectionErrors()', imageSelectionErrors)
    await evaluate(page, 'imageSelectionWrongFormat()', '1')
    await evaluate(page, 'imageSelectionModes()', '1')
    await evaluate(page, 'imageSelectionCompanions()', '1')
    await evaluate(page, 'imageSelectionArchive()', '1')
    await evaluate(page, 'imageSelectionDraw()', '1')
    const canvas = page.locator('canvas')
    await expect(canvas).toHaveJSProperty('width', 3)
    await expect(canvas).toHaveJSProperty('height', 2)
    await magnifyPixelWindow(canvas)
    const screenshot = await canvas.screenshot()
    const pixels = await page.evaluate(async (url) => {
      const image = await createImageBitmap(await (await fetch(url)).blob()), surface = new OffscreenCanvas(image.width, image.height), context = surface.getContext('2d')!
      context.drawImage(image, 0, 0)
      const result = []
      for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++)
        result.push([...context.getImageData(Math.floor((x + 0.5) * image.width / 3), Math.floor((y + 0.5) * image.height / 2), 1, 1).data])
      image.close(); return result
    }, 'data:image/png;base64,' + screenshot.toString('base64'))
    expect(pixels).toEqual(Array.from({ length: 6 }, () => [18, 52, 86, 255]))
    for (const extension of ['JPEG', 'jpg', 'jif']) {
      await evaluate(page, `(function(){selectionLayer.loadImages("photo.${extension}");
        if(selectionLayer.imageWidth!=3 || selectionLayer.imageHeight!=2)return false;
        for(var y=0;y<2;y++)for(var x=0;x<3;x++)
          if(selectionLayer.getMainPixel(x,y)!=0xa06020 || selectionLayer.getMaskPixel(x,y)!=255)return false;
        return true;})()`, '1')
      await expect.poll(() => canvas.evaluate((element) => {
        const source = element as HTMLCanvasElement, target = new OffscreenCanvas(source.width, source.height),
          context = target.getContext('2d', { willReadFrequently: true })!
        context.drawImage(source, 0, 0)
        return { width: source.width, height: source.height,
          rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
      })).toEqual({ width: 3, height: 2, rgba: Array.from({ length: 6 }, () => [160, 96, 32, 255]).flat() })
    }
    await evaluate(page, 'imageFailure("photo.JIF",1)', 'jpeg:JPEG does not support palettized image')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })
}
