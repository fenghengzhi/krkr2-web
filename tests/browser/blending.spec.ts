import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { blendCases } from '../helpers/blend-vectors.ts'

const reference = readFileSync(new URL('../fixtures/blend-reference.bin', import.meta.url))
const expected: Array<{ mode: number; rgba: number[] }> = []
let index = 0
for (const c of blendCases()) {
  const pixel = reference.subarray(index++ * 4, index * 4)
  if (
    ![1, 2, 12].includes(c.mode) &&
    c.face === 1 &&
    !c.hold &&
    c.opacity === 255 &&
    c.destination === 0x807f0080 &&
    c.source === 0x7f80ff7f
  )
    expected.push({ mode: c.mode, rgba: [...pixel.subarray(0, 3), 255] })
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: every destination-dependent blend renders the reference colors and exports the same snapshot`, async ({
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
var window=new Window();window.visible=true;window.setInnerSize(${expected.length * 4},4);
var root=new Layer(window,null),layers=[],saved=new Layer(window,root);
root.setSize(${expected.length * 4},4);root.fillRect(0,0,root.width,4,0x8080007f);
var modes=[${expected.map((x) => x.mode).join(',')}];
for(var i=0;i<modes.count;i++){
 var layer=new Layer(window,root);layer.setSize(4,4);layer.left=i*4;
 layer.fillRect(0,0,4,4,0x7f7fff80);layer.type=modes[i];layer.visible=true;layers.add(layer);
}
saved.setImageSize(root.width,4);saved.piledCopy(0,0,root,0,0,root.width,4);saved.saveLayerImage("savedata/blends.bmp","bmp24");saved.loadImages("savedata/blends.bmp");
var correct=true;
${expected.map((item, i) => `correct=correct && saved.getMainPixel(${i * 4},0)==${item.rgba[0]! * 65536 + item.rgba[1]! * 256 + item.rgba[2]!};`).join('\n')}
Debug.message("blend-ready:"+string(correct));
`
    await page
      .locator('#files')
      .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect(page.locator('#logs')).toContainText('blend-ready:1')
    const sample = async () => {
      const screenshot = await page.locator('canvas').screenshot()
      return page.evaluate(
        async ({ url, count }) => {
          const image = await createImageBitmap(await (await fetch(url)).blob())
          const canvas = new OffscreenCanvas(image.width, image.height),
            context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          const colors = Array.from({ length: count }, (_, i) => [
            ...context.getImageData(
              Math.floor(((i + 0.5) * image.width) / count),
              Math.floor(image.height / 2),
              1,
              1,
            ).data,
          ])
          image.close()
          return colors
        },
        { url: 'data:image/png;base64,' + screenshot.toString('base64'), count: expected.length },
      )
    }
    expect(await sample()).toEqual(expected.map((item) => item.rgba))
    await page
      .locator('#expression')
      .fill('(function(){layers[0].fillRect(0,0,4,4,0x00000000);return 17;})()')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('17')
    const changed = await sample()
    expect(changed[0]).toEqual([128, 0, 127, 255])
    expect(changed.slice(1)).toEqual(expected.slice(1).map((item) => item.rgba))
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })
