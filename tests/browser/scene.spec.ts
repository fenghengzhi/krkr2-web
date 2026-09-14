import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
async function sample(page: Page, x: number, y: number) {
  const screenshot = await page.locator('canvas').screenshot()
  return page.evaluate(
    async ({ url, x, y }) => {
      const image = await createImageBitmap(await (await fetch(url)).blob()),
        canvas = new OffscreenCanvas(image.width, image.height),
        context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const pixel = [
        ...context.getImageData(Math.floor(x * image.width), Math.floor(y * image.height), 1, 1)
          .data,
      ]
      image.close()
      return pixel
    },
    { url: 'data:image/png;base64,' + screenshot.toString('base64'), x, y },
  )
}
for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: subtree opacity, transition pixels and saved bitmap masks agree in the browser`, async ({
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
var window=new Window();window.visible=true;window.setInnerSize(8,4);
var root=new Layer(window,null),fore=new Layer(window,root),child=new Layer(window,fore),back=new Layer(window,root),saved=new Layer(window,root);
root.setSize(8,4);root.fillRect(0,0,8,4,0xff000000);
fore.setSize(8,4);fore.visible=true;fore.opacity=128;fore.fillRect(0,0,8,4,0xffff0000);
child.setSize(4,4);child.visible=true;child.fillRect(0,0,4,4,0xff0000ff);
back.setSize(8,4);back.fillRect(0,0,8,4,0xff0000ff);
saved.setImageSize(8,4);saved.piledCopy(0,0,root,0,0,8,4);saved.saveLayerImage("savedata/screen.bmp","bmp24");
saved.loadImages("savedata/screen.bmp");
var tick=0,completed=0;fore.onTransitionCompleted=function(dest,src){completed++;};Debug.message("scene-ready");
`
    await page
      .locator('#files')
      .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect(page.locator('#logs')).toContainText('scene-ready')
    await expect(page.locator('#evaluate')).toBeEnabled()
    await expect(page.locator('canvas')).toHaveJSProperty('width', 8)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 4)
    expect(await sample(page, 0.25, 0.5)).toEqual([0, 0, 128, 255])
    expect(await sample(page, 0.75, 0.5)).toEqual([128, 0, 0, 255])
    await evaluate(
      page,
      'saved.getMainPixel(2,2)==0x000080 && saved.getMainPixel(6,2)==0x800000',
      '1',
    )
    await evaluate(
      page,
      '(function(){saved.setMaskPixel(0,0,73);saved.saveLayerImage("savedata/mask.bmp");saved.loadImages("savedata/mask.bmp");return saved.getMaskPixel(0,0);})()',
      '73',
    )
    await evaluate(
      page,
      '(function(){fore.opacity=255;child.visible=false;fore.beginTransition("crossfade",true,back,%[time:1000,selfupdate:true,callback:function(){return tick;}]);return 0;})()',
      '0',
    )
    await evaluate(page, '(function(){tick=500;fore.update();return 0;})()', '0')
    expect(await sample(page, 0.25, 0.5)).toEqual([128, 0, 127, 255])
    await evaluate(page, '(function(){tick=1000;fore.update();return 0;})()', '0')
    await evaluate(page, 'completed==1 && root.children[0]===back && !fore.visible', '1')
    expect(await sample(page, 0.25, 0.5)).toEqual([0, 0, 255, 255])
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })
