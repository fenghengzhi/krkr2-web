import { test, expect, type Locator, type Page } from '@playwright/test'
import { processedCacheFiles, processedCacheSource } from '../helpers/processed-cache-fixtures.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { magnifyPixelWindow } from '../helpers/pixel-window.ts'

async function sample(page: Page, canvas: Locator): Promise<number[][]> {
  const bytes = await canvas.screenshot()
  return page.evaluate(async (url) => {
    const image = await createImageBitmap(await (await fetch(url)).blob()), surface = new OffscreenCanvas(image.width, image.height), context = surface.getContext('2d')!
    context.drawImage(image, 0, 0)
    const result = []
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++)
      result.push([...context.getImageData(Math.floor((x + 0.5) * image.width / 3), Math.floor((y + 0.5) * image.height / 2), 1, 1).data])
    image.close(); return result
  }, 'data:image/png;base64,' + bytes.toString('base64'))
}
for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: processed AutoPath hits retain real pixels until clear and image saving clears every cached request`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    await page.locator('#files').setInputFiles([
      ...Object.entries(processedCacheFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      { name: 'cache.tjs', mimeType: 'text/plain', buffer: Buffer.from(processedCacheSource) },
      { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from((binary
        ? 'Scripts.compileStorage("cache.tjs","savedata/cache.cjs",false,true,false);Scripts.execStorage("savedata/cache.cjs");'
        : 'Scripts.execStorage("cache.tjs");') + 'Storages.addAutoPath("base/");cacheColor("scene");cacheDraw();Debug.message("processed-cache-ready");') },
    ])
    await expect(page.locator('#logs')).toContainText('processed-cache-ready')
    const canvas = page.locator('canvas')
    await expect(canvas).toHaveJSProperty('width', 3)
    await expect(canvas).toHaveJSProperty('height', 2)
    await magnifyPixelWindow(canvas)
    const red = Array.from({ length: 6 }, () => [255, 0, 0, 255]), green = Array.from({ length: 6 }, () => [0, 255, 0, 255])
    expect(await sample(page, canvas)).toEqual(red)
    await evaluate(page, '(function(){Storages.addAutoPath("patch/");return Storages.getPlacedPath("scene.bmp");})()', 'game://./patch/scene.bmp')
    await evaluate(page, '(cacheColor("scene"),cacheDraw())', String(0xff0000))
    expect(await sample(page, canvas)).toEqual(red)
    await evaluate(page, '(System.clearGraphicCache(),cacheColor("scene"),cacheDraw())', String(0x00ff00))
    expect(await sample(page, canvas)).toEqual(green)
    await evaluate(page, '(function(){Storages.removeAutoPath("patch/");cacheColor("scene");return cacheDraw();})()', String(0x00ff00))
    expect(await sample(page, canvas)).toEqual(green)
    // Saving an unrelated image clears the cached request. The following load
    // must now see base/, while the displayed old pixels survive the clear.
    await evaluate(page, '(function(){cacheBack.setImageSize(1,1);cacheBack.saveLayerImage("savedata/unrelated.bmp");return cacheImage.getMainPixel(0,0);})()', String(0x00ff00))
    expect(await sample(page, canvas)).toEqual(green)
    await evaluate(page, '(cacheColor("scene"),cacheDraw())', String(0xff0000))
    expect(await sample(page, canvas)).toEqual(red)
    // Metadata, mask and tiled province output must remain isolated on hits.
    await evaluate(page, '(function(){var tags=cacheImage.loadImages("hero");tags.offs_x="changed";cacheImage.setMainPixel(0,0,0);var again=cacheImage.loadImages("hero");return again.offs_x=="12" && cacheImage.getMainPixel(0,0)==0xc86432 && cacheImage.getMaskPixel(1,0)==128 && cacheImage.getProvincePixel(1,0)==1;})()', '1')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })
