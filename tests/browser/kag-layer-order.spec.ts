import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

const scene = String.raw`
class OrderMenuLayer extends global.KAGLayer {
 function OrderMenuLayer(win,par){super.KAGLayer(win,par);}
}
var orderGroup,orderHistory,orderButton;
function orderKagLayer(title,color){
 var layer=new OrderMenuLayer(kag,orderGroup);kag.add(layer);
 layer.name=title;layer.type=ltOpaque;layer.setSize(32,24);
 layer.fillRect(0,0,32,24,color);layer.visible=true;return layer;
}
function orderKagSetup(){
 orderGroup=new Layer(kag,kag.fore.base);kag.add(orderGroup);
 orderGroup.setPos(24,24,32,24);orderGroup.absolute=2100000;orderGroup.visible=true;
 orderHistory=orderKagLayer("history",0xff204080);orderHistory.absolute=2000000;
 orderButton=orderKagLayer("button",0xffc83c14);
 orderButton.store().saveStruct(System.dataPath+"menu-layer.tjs");
 return orderKagState();
}
function orderKagState(){
 return orderButton.absolute+","+orderHistory.getLayerAt(16,12).name;
}
Debug.message("layer-order-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: KAG restores the saved depth of a menu layer above the history panel`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    try {
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'layer-order.tjs', mimeType: 'text/plain', buffer: Buffer.from(scene) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("layer-order.tjs","savedata/layer-order.cjs",false,true,false);Scripts.execStorage("savedata/layer-order.cjs");'
          : 'Scripts.execStorage("layer-order.tjs");') },
      ])
      await expect(page.getByText('layer-order-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      const canvas = page.locator('.game-window[data-window-id] canvas[data-window-id]')
      await expect(canvas).toHaveCount(1)
      const steps = [
        { expression: 'orderKagSetup()', state: '2000001,button', rgb: [200,60,20] },
        { expression: '(orderButton.setOptions(%[index:2000000]),orderKagState())', state: '2000000,history', rgb: [32,64,128] },
        { expression: '(orderHistory.absolute=orderHistory.absolute,orderKagState())', state: '2000000,button', rgb: [200,60,20] },
        { expression: '(orderButton.setOptions(%[index:1000]),orderKagState())', state: '1000,history', rgb: [32,64,128] },
        { expression: '(orderButton.restore(Scripts.evalStorage(System.dataPath+"menu-layer.tjs")),orderKagState())', state: '2000001,button', rgb: [200,60,20] },
      ]
      for (const step of steps) {
        await evaluate(page, step.expression, step.state)
        await expect.poll(async () => {
          const image = readScreenshotPng(await canvas.screenshot())
          const at = (Math.floor(image.height * 36 / 480) * image.width + Math.floor(image.width * 40 / 640)) * 4
          return [...image.rgba.subarray(at, at + 4)]
        }).toEqual([...step.rgb, 255])
      }
      await info.attach('restored-kag-layer', { body: await canvas.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } finally {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
    }
  })
