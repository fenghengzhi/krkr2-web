import { test, expect, type Page } from '@playwright/test'
async function evaluate(page: Page, source: string, value: string) {
  await page.locator('#expression').fill(source)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs p span').last()).toHaveText(value)
}
async function sample(page: Page) {
  const image = await page.locator('canvas').screenshot()
  return page.evaluate(
    async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = surface.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const values = [
        [1, 1],
        [2, 1],
        [4, 1],
        [5, 1],
      ].map(([x, y]) => [
        ...context.getImageData(
          Math.floor(((x! + 0.5) * bitmap.width) / 8),
          Math.floor(((y! + 0.5) * bitmap.height) / 4),
          1,
          1,
        ).data,
      ])
      bitmap.close()
      return values
    },
    'data:image/png;base64,' + image.toString('base64'),
  )
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: box blur, alpha conversion, grayscale and whole-image flip render consistently`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(String.raw`
var window=new Window();window.visible=true;window.setInnerSize(8,4);
var root=new Layer(window,null),blurred=new Layer(window,root),gray=new Layer(window,root),saved=new Layer(window,root);
root.setSize(8,4);root.fillRect(0,0,8,4,0xff000000);
blurred.setImageSize(2,2);blurred.setPos(1,1);blurred.visible=true;blurred.fillRect(0,0,1,2,0x00ff0000);blurred.fillRect(1,0,1,2,0xff0000ff);
blurred.setProvincePixel(0,0,11);blurred.setProvincePixel(1,0,22);blurred.doBoxBlur(1,0);
blurred.saveLayerImage("savedata/blur.bmp");saved.loadImages("savedata/blur.bmp");
gray.setImageSize(2,2);gray.setPos(4,1);gray.visible=true;gray.fillRect(0,0,2,2,0xff00ff00);gray.setClip(0,0,1,2);gray.face=dfProvince;gray.doGrayScale();
Debug.message("processing-ready:"+string(saved.getMainPixel(0,0)==0xff && saved.getMaskPixel(0,0)==128 && blurred.getProvincePixel(0,0)==11));
`),
    })
    await expect(page.locator('#logs')).toContainText('processing-ready:1')
    await expect(page.locator('canvas')).toHaveJSProperty('width', 8)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 4)
    // Isolate pixel output from the page's smooth CSS enlargement.
    await page.locator('canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      canvas.style.width = `${canvas.width * 16}px`
      canvas.style.height = `${canvas.height * 16}px`
      canvas.style.imageRendering = 'pixelated'
    })
    expect(await sample(page)).toEqual([
      [0, 0, 128, 255],
      [0, 0, 128, 255],
      [182, 182, 182, 255],
      [0, 255, 0, 255],
    ])
    await evaluate(
      page,
      '(function(){blurred.type=ltAddAlpha;blurred.convertType(dfAlpha);gray.flipLR();return blurred.getMainPixel(0,0)==0x00007f && blurred.getMaskPixel(0,0)==128;})()',
      '1',
    )
    expect(await sample(page)).toEqual([
      [0, 0, 127, 255],
      [0, 0, 127, 255],
      [0, 255, 0, 255],
      [182, 182, 182, 255],
    ])
    await evaluate(
      page,
      '(function(){blurred.setClip(0,0,1,1);blurred.flipLR();return blurred.getProvincePixel(0,0)==22 && blurred.getProvincePixel(1,0)==11;})()',
      '1',
    )
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })

  test(`${backend}: a large box blur can stop without the Worker timeout fallback`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(String.raw`
var window=new Window(),root=new Layer(window,null);root.setImageSize(4096,4096);root.fillRect(0,0,4096,4096,0xff123456);
Debug.message("box-start");root.doBoxBlur(63,63);Debug.message("box-finished");
`),
    })
    await expect(page.locator('#logs')).toContainText('box-start')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('box-finished')
  })
}
