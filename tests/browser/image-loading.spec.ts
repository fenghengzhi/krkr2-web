import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { imageFixture } from '../helpers/image-fixtures.ts'
async function evaluate(page: Page, source: string, value: string) {
  await page.locator('#expression').fill(source)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs p span').last()).toHaveText(value)
}
async function sample(page: Page) {
  const bytes = await page.locator('canvas').screenshot()
  return page.evaluate(
    async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const result = [0, 1, 2, 3].map((x) => [
        ...context.getImageData(
          Math.floor(((x + 0.5) * bitmap.width) / 4),
          Math.floor(bitmap.height / 2),
          1,
          1,
        ).data,
      ])
      bitmap.close()
      return result
    },
    'data:image/png;base64,' + bytes.toString('base64'),
  )
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: companion masks, province hit tests, palette keys and PNG metadata reach the canvas`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles([
      ...[
        ['hero.png', 'main.png'],
        ['hero_m.png', 'mask.png'],
        ['hero_p.png', 'palette-2x1.png'],
        ['palette.gif', 'palette-2x1.gif'],
        ['replacement.png', 'mask.png'],
      ].map(([name, fixture]) => ({
        name: name!,
        mimeType: 'application/octet-stream',
        buffer: imageFixture(fixture!),
      })),
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(String.raw`
var window=new Window();window.visible=true;window.setInnerSize(4,1);
var root=new Layer(window,null),hero=new Layer(window,root),keyed=new Layer(window,root),copy=new Layer(window,root);
root.setSize(4,1);root.fillRect(0,0,4,1,0xff000000);
var tags=hero.loadImages("hero");hero.setSize(2,1);hero.visible=true;hero.hitType=htProvince;hero.hitThreshold=0;
keyed.loadImages("palette",clPalIdx+1);keyed.setPos(2,0);keyed.setSize(2,1);keyed.visible=true;
var clicks=0;hero.onClick=function(x,y){clicks++;};hero.saveLayerImage("savedata/loaded.bmp");copy.loadImages("savedata/loaded.bmp");
Debug.message("images-ready:"+string(tags.offs_x=="12" && tags.offs_y=="-7" && tags.reso_unit=="meter" && copy.getMainPixel(0,0)==0xc86432 && copy.getMaskPixel(1,0)==128 && hero.getProvincePixel(1,0)==1));
`),
      },
    ])
    await expect(page.locator('#logs')).toContainText('images-ready:1')
    await expect(page.locator('canvas')).toHaveJSProperty('width', 4)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 1)
    await page.locator('canvas').evaluate((node) => {
      const c = node as HTMLCanvasElement
      c.style.width = `${c.width * 32}px`
      c.style.height = `${c.height * 32}px`
      c.style.imageRendering = 'pixelated'
    })
    expect(await sample(page)).toEqual([
      [0, 0, 0, 255],
      [101, 51, 26, 255],
      [255, 0, 0, 255],
      [0, 0, 0, 255],
    ])
    const bounds = (await page.locator('canvas').boundingBox())!
    await page.locator('canvas').click({ position: { x: bounds.width / 8, y: bounds.height / 2 } })
    await evaluate(page, 'clicks', '0')
    await page
      .locator('canvas')
      .click({ position: { x: (bounds.width * 3) / 8, y: bounds.height / 2 } })
    await evaluate(page, 'clicks', '1')
    await evaluate(
      page,
      '(function(){hero.setClip(1,0,1,1);hero.loadProvinceImage("replacement");return hero.getProvincePixel(1,0)==128 && hero.clipLeft==1 && hero.getMaskPixel(1,0)==128;})()',
      '1',
    )
    await evaluate(
      page,
      '(function(){hero.loadImages("hero",clAlphaMat+0xffffff);return hero.getMainPixel(1,0)==0xe4b299 && hero.getProvincePixel(1,0)==1;})()',
      '1',
    )
    expect(await sample(page)).toEqual([
      [255, 255, 255, 255],
      [228, 178, 153, 255],
      [255, 0, 0, 255],
      [0, 0, 0, 255],
    ])
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })
  test(`${backend}: stopping a large PNG load cancels its Web decode without worker termination`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    // Trigger the actual stop button as soon as the request is announced;
    // locator polling/scrolling can outlast an already optimized PNG decode.
    await page.evaluate(() => {
      const logs = document.querySelector('#logs')!,
        observer = new MutationObserver(() => {
          if (!logs.textContent?.includes('png-start')) return
          observer.disconnect()
          setTimeout(() => (document.querySelector('#stop') as HTMLButtonElement).click(), 0)
        })
      observer.observe(logs, { childList: true, subtree: true, characterData: true })
    })
    await page.locator('#files').setInputFiles([
      {
        name: 'large.png',
        mimeType: 'image/png',
        buffer: readFileSync(new URL('../fixtures/large-gray.png', import.meta.url)),
      },
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'var window=new Window(),layer=new Layer(window,null);Debug.message("png-start");layer.loadImages("large");Debug.message("png-finished");',
        ),
      },
    ])
    await expect(page.locator('#logs')).toContainText('png-start')
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('png-finished')
  })
}
