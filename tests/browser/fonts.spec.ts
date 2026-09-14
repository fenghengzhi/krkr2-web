import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'
import { injectActivity, visibility } from '../helpers/activity-browser.ts'
const file = async (name: string) => ({
  name,
  mimeType: 'application/octet-stream',
  buffer: await readFile(new URL('../fixtures/font/' + name, import.meta.url)),
})
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: font files and shared pre-rendered glyphs reach the Worker canvas and saved bitmap`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
var w=new Window();w.visible=true;w.setInnerSize(120,70);var a=new Layer(w,null);a.setSize(120,70);a.type=ltAlpha;
var b=new Layer(w,a);b.setSize(120,70);b.type=ltAlpha;
a.font.height=20;a.font.face="narrow.ttf";a.font.faceIsFileName=true;
b.font.height=20;b.font.face="narrow.ttf";b.font.faceIsFileName=true;
Debug.message("file-width="+a.font.getTextWidth("AV"));
a.drawText(0,0,"AV",0xffffff);
a.font.mapPrerenderedFont("coverage-v1.tft");
Debug.message("mapped-width="+b.font.getTextWidth("AB"));
a.drawText(20,0,"AB",0x123456);
a.saveLayerImage("savedata/font.bmp","bmp32");
Debug.message("fonts-ready");
`),
      },
      await file('narrow.ttf'),
      await file('wide.ttf'),
      await file('coverage-v1.tft'),
    ])
    await expect(page.locator('#logs')).toContainText('file-width=24')
    await expect(page.locator('#logs')).toContainText('mapped-width=11')
    await expect(page.locator('#logs')).toContainText('fonts-ready')
    await evaluate(page, 'a.getMainPixel(21,15)', String(0x123456))
    await evaluate(page, 'a.getMaskPixel(21,14)', '64')
    await evaluate(
      page,
      'Scripts.exec("var copy=new Layer(w,a);copy.loadImages(\\\"savedata/font.bmp\\\");")',
      '',
    )
    await evaluate(page, 'copy.getMainPixel(21,15)', String(0x123456))
    await evaluate(page, 'b.font.unmapPrerenderedFont()', '')
    await evaluate(page, 'a.font.getTextWidth("AV")', '24')
    await evaluate(page, 'Scripts.exec("a.font.face=\\\"wide.ttf\\\";")', '')
    await evaluate(page, 'a.font.getTextWidth("AV")', '32')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
  })
  test(`${backend}: physical cursor bypasses blocked script input and ignores hidden movement`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 1200 })
    await injectActivity(page)
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(`
var w=new Window();w.visible=true;w.setInnerSize(120,80);var a=new Layer(w,null);a.setSize(120,80);
var last="";w.onKeyDown=function(){last=a.cursorX+","+a.cursorY;};System.eventDisabled=true;Debug.message("cursor-ready");
`),
    })
    await expect(page.locator('#logs')).toContainText('cursor-ready')
    await page.locator('#pause-background').uncheck()
    const canvas = page.locator('canvas')
    await expect(canvas).toHaveJSProperty('width', 120)
    await expect(canvas).toHaveJSProperty('height', 80)
    await canvas.scrollIntoViewIfNeeded()
    await canvas.evaluate((el) => el.focus({ preventScroll: true }))
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25)
    await page.keyboard.down('a') // Its script delivery remains pending.
    await page.mouse.move(box.x + box.width * (90.5 / 120), box.y + box.height * (60.5 / 80))
    await page.keyboard.up('a')
    await evaluate(page, 'a.cursorX+","+a.cursorY', '90,60')
    await evaluate(page, 'System.eventDisabled=false', '0')
    await evaluate(page, 'last', '90,60')
    await visibility(page, 'hidden')
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height * 0.1)
    await visibility(page, 'visible')
    await evaluate(page, 'a.cursorX+","+a.cursorY', '90,60')
    await page.locator('#stop').click()
  })
}
