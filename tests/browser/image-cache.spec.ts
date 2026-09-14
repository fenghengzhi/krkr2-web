import { test, expect } from '@playwright/test'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: preloaded PNG/TLG copies survive mutation, overwrites and cache clearing`, async ({
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
var w=new Window();w.visible=true;w.setInnerSize(4,1);
var root=new Layer(w,null),src=new Layer(w,root);root.setSize(4,1);root.fillRect(0,0,4,1,0xff000000);src.setImageSize(1,1);
src.fillRect(0,0,1,1,0xffff0000);src.saveLayerImage("savedata/red.tlg","tlg6");src.fillRect(0,0,1,1,0xff00ff00);src.saveLayerImage("savedata/green.png","png");
System.graphicCacheLimit=4096;var ret=System.touchImages(["missing", "savedata/red.tlg", "savedata/green.png"],-128,1000);
var a=new Layer(w,root),b=new Layer(w,root),c=new Layer(w,root),d=new Layer(w,root),layers=[a,b,c,d];
for(var i=0;i<4;i++){layers[i].loadImages(i<2?"savedata/red.tlg":"savedata/green.png");layers[i].setSize(1,1);layers[i].setPos(i,0);layers[i].visible=true;}
a.fillRect(0,0,1,1,0xff0000ff);var isolated=b.getMainPixel(0,0)==0xff0000;
src.fillRect(0,0,1,1,0xffffff00);src.saveLayerImage("savedata/red.tlg","tlg6");b.loadImages("savedata/red.tlg");
System.clearGraphicCache();var preserved=a.getMainPixel(0,0)==0xff && b.getMainPixel(0,0)==0xffff00 && c.getMainPixel(0,0)==0xff00;
System.graphicCacheLimit=0;d.loadImages("savedata/green.png");var disabled=System.graphicCacheLimit==0;
System.graphicCacheLimit=gcsAuto;Debug.message("cache-ready:"+string(isolated && preserved && disabled && ret===void && System.graphicCacheLimit==33554432));
`),
    })
    await expect(page.locator('#logs')).toContainText('cache-ready:1')
    await expect(page.locator('canvas')).toHaveJSProperty('width', 4)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 1)
    await page.locator('canvas').evaluate((node) => {
      const c = node as HTMLCanvasElement
      c.style.width = '256px'
      c.style.height = '64px'
      c.style.imageRendering = 'pixelated'
    })
    const screenshot = await page.locator('canvas').screenshot()
    const pixels = await page.evaluate(
      async (url) => {
        const image = await createImageBitmap(await (await fetch(url)).blob()),
          canvas = new OffscreenCanvas(image.width, image.height),
          context = canvas.getContext('2d')!
        context.drawImage(image, 0, 0)
        const result = Array.from({ length: 4 }, (_, x) => [
          ...context.getImageData(((x + 0.5) * image.width) / 4, image.height / 2, 1, 1).data,
        ])
        image.close()
        return result
      },
      'data:image/png;base64,' + screenshot.toString('base64'),
    )
    expect(pixels).toEqual([
      [0, 0, 255, 255],
      [255, 255, 0, 255],
      [0, 255, 0, 255],
      [0, 255, 0, 255],
    ])
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })

  test(`${backend}: large image preloading stops cooperatively`, async ({ page }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#logs').evaluate((node) => {
      const observer = new MutationObserver(() => {
        if (!node.textContent?.includes('preload-start')) return
        observer.disconnect()
        setTimeout(() => document.querySelector<HTMLButtonElement>('#stop')!.click(), 0)
      })
      observer.observe(node, { childList: true, subtree: true, characterData: true })
    })
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'Debug.message("preload-start");System.touchImages(["large-gray.png"]);Debug.message("preload-finished");',
        ),
      },
      {
        name: 'large-gray.png',
        mimeType: 'image/png',
        buffer: await (await import('node:fs/promises')).readFile('tests/fixtures/large-gray.png'),
      },
    ])
    await expect(page.locator('#logs')).toContainText('preload-start')
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('preload-finished')
  })
}
