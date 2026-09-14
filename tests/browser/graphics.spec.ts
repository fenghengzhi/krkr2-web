import { test, expect } from '@playwright/test'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: image viewport, zoom, glyphs and window appearance render in the browser`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const source = String.raw`
var window=new Window();window.visible=true;window.setInnerSize(80,40);window.borderStyle=bsSingle;window.innerSunken=true;
var root=new Layer(window,null);root.setSize(80,40);root.fillRect(0,0,80,40,0xff0000ff);
var child=new Layer(window,root);child.setImageSize(40,20);child.fillRect(0,0,20,20,0xffff0000);child.fillRect(20,0,20,20,0xff00ff00);child.setSize(20,20);child.setImagePos(-20,0);child.setPos(20,0);child.visible=true;
var clicks="";child.onClick=function(x,y){clicks=x+","+y;Debug.message("viewport-click="+clicks);};
var width=root.font.getTextWidth("Hello");Debug.message("font-measured="+(width>0));
`
    await page
      .locator('#files')
      .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect(page.locator('#logs')).toContainText('font-measured=1')
    await expect(page.locator('#stage')).toHaveClass(/window-sunken/)
    const canvas = page.locator('canvas')
    const sample = async (x: number, y: number) => {
      const png = await canvas.screenshot()
      return page.evaluate(
        async ({ url, x, y }) => {
          const image = await createImageBitmap(await (await fetch(url)).blob()),
            surface = new OffscreenCanvas(image.width, image.height),
            context = surface.getContext('2d')!
          context.drawImage(image, 0, 0)
          const pixel = [
            ...context.getImageData(Math.floor(image.width * x), Math.floor(image.height * y), 1, 1)
              .data,
          ]
          image.close()
          return pixel
        },
        { url: 'data:image/png;base64,' + png.toString('base64'), x, y },
      )
    }
    expect(await sample(0.375, 0.25)).toEqual([0, 255, 0, 255])
    expect(await sample(0.125, 0.25)).toEqual([0, 0, 255, 255])
    const bounds = await canvas.boundingBox()
    // Use the center of a logical pixel: device/CSS coordinate rounding at an
    // exact pixel boundary is not a test of the engine's hit coordinates.
    await canvas.click({
      position: { x: (bounds!.width * 30.5) / 80, y: (bounds!.height * 10.5) / 40 },
    })
    await expect(page.locator('#logs')).toContainText('viewport-click=10,10')
    await page
      .locator('#expression')
      .fill(
        '(function(){root.font.height=-12;root.font.bold=true;root.font.underline=true;root.drawText(2,22,"Web",0xffffff);return root.imageModified;})()',
      )
    const before = await canvas.screenshot()
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('1')
    expect((await canvas.screenshot()).equals(before)).toBe(false)
    await page.locator('#expression').fill('window.fullScreen=true')
    await page.locator('#evaluate').click()
    await expect(page.getByRole('button', { name: '退出全屏' })).toBeVisible()
    await page.getByRole('button', { name: '退出全屏' }).click()
    await expect(page.locator('#stage')).not.toHaveClass(/window-fullscreen/)
  })
