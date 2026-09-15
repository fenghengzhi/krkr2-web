import { test, expect } from '@playwright/test'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: affine rotation, shear, clipping and saved masks reach the canvas`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const source = String.raw`
var window=new Window();window.visible=true;window.setInnerSize(20,8);
var root=new Layer(window,null),source=new Layer(window,root),saved=new Layer(window,root);
root.setSize(20,8);root.fillRect(0,0,20,8,0xff202020);source.setImageSize(3,2);
var colors=[0xffff0000,0xff00ff00,0xff0000ff,0xff00ffff,0xffff00ff,0xffffff00];
for(var y=0;y<2;y++)for(var x=0;x<3;x++)source.fillRect(x,y,1,1,colors[y*3+x]);
root.affineCopy(source,0,0,3,2,true,0,1,-1,0,4,1);
source.type=ltAdditive;root.operateAffine(source,0,0,3,2,true,1,0,1,1,8,1);
// This fixture tests a transparent-white clear in the saved mask plane. A
// primary's native default is opaque white; choose the intended clear value.
root.neutralColor=0x00ffffff;
root.setClip(14,0,6,6);root.affineCopy(source,0,0,3,2,false,14.5,0.5,17.5,0.5,14.5,2.5,stNearest,true);
root.saveLayerImage("savedata/affine.bmp");saved.loadImages("savedata/affine.bmp");
Debug.message("affine-ready:"+string(saved.getMaskPixel(14,0)==0 && saved.getMaskPixel(15,1)==255 && saved.getMainPixel(4,1)==0xff0000));
`
    await page
      .locator('#files')
      .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect(page.locator('#logs')).toContainText('affine-ready:1')
    await expect(page.locator('canvas')).toHaveJSProperty('width', 20)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 8)
    // Use integer pixel blocks for this adjacent-single-pixel fixture. This
    // removes CSS interpolation and screenshot clipping at fractional edges.
    await page.locator('canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      canvas.style.width = `${canvas.width * 8}px`
      canvas.style.height = `${canvas.height * 8}px`
      canvas.style.imageRendering = 'pixelated'
    })
    const samples = [
      [4, 1],
      [4, 2],
      [4, 3],
      [3, 1],
      [3, 2],
      [3, 3],
      [5, 2],
      [8, 1],
      [9, 1],
      [10, 1],
      [9, 2],
      [8, 2],
      [14, 0],
      [15, 1],
      [16, 1],
      [17, 2],
      [13, 1],
    ]
    const screenshot = await page.locator('canvas').screenshot()
    const actual = await page.evaluate(
      async ({ url, samples }) => {
        const image = await createImageBitmap(await (await fetch(url)).blob()),
          surface = new OffscreenCanvas(image.width, image.height),
          context = surface.getContext('2d')!
        context.drawImage(image, 0, 0)
        const result = samples.map(([x, y]) => [
          ...context.getImageData(
            Math.floor(((x! + 0.5) * image.width) / 20),
            Math.floor(((y! + 0.5) * image.height) / 8),
            1,
            1,
          ).data,
        ])
        image.close()
        return result
      },
      { url: 'data:image/png;base64,' + screenshot.toString('base64'), samples },
    )
    expect(actual).toEqual([
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [0, 0, 255, 255],
      [0, 255, 255, 255],
      [255, 0, 255, 255],
      [255, 255, 0, 255],
      [32, 32, 32, 255],
      [255, 32, 32, 255],
      [32, 255, 32, 255],
      [32, 32, 255, 255],
      [32, 255, 255, 255],
      [32, 32, 32, 255],
      [255, 255, 255, 255],
      [255, 0, 0, 255],
      [0, 255, 0, 255],
      [255, 255, 0, 255],
      [32, 32, 32, 255],
    ])
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })

  test(`${backend}: stop cancels expensive affine filtering without terminating a hung Worker`, async ({
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
var window=new Window(),root=new Layer(window,null),source=new Layer(window,root),target=new Layer(window,root);
source.setImageSize(2048,2048);target.setImageSize(2048,2048);source.fillRect(0,0,2048,2048,0xff123456);
Debug.message("filtering-start");target.affineCopy(source,0,0,2048,2048,true,1,0,0,1,0,0,stGaussian);Debug.message("filtering-finished");
`),
    })
    await expect(page.locator('#logs')).toContainText('filtering-start')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#choose-files')).toBeEnabled()
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('filtering-finished')
  })
}
