import { expect, test } from '@playwright/test'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'
import { spriteOpacityPreviews, spriteSamplingCases, spriteSamplingSource } from '../helpers/sprite-sampling.ts'

// Each page shows one row of actual main-image pixels above their mask bytes.
const pages = [
  ['sprite-third-stretch', 3, 0], ['sprite-third-reversed', 3, 0],
  ['sprite-hold-affine', 8, 0], ['sprite-cubic-clipped', 8, 0],
  ...spriteOpacityPreviews.filter(({ id }) => id === 'sprite-opacity-stretch' || id === 'sprite-opacity-rotated128')
    .map(({ id, cells, row }) => [id, cells, row] as const),
] as const
const gallery = spriteSamplingSource + `
var galleryIndex=0,galleryPages=${JSON.stringify(pages)};
function galleryShow(){
 var preview=galleryPages[galleryIndex],id=preview[0],cells=preview[1],row=preview[2],cell=96/cells;
 spriteSamplingRun(id);
 for(var x=0;x<cells;x++){
  var color=spriteOut.getMainPixel(x,row),mask=spriteOut.getMaskPixel(x,row);
  spriteRoot.fillRect(x*cell,2,cell,16,0xff000000|color);
  spriteRoot.fillRect(x*cell,20,cell,16,0xff000000|(mask*0x010101));
 }
 spriteRoot.update();Debug.message("gallery:"+id);
}
var galleryNext=new Layer(spriteW,spriteRoot);galleryNext.holdAlpha=false;galleryNext.setPos(0,40,96,20);
galleryNext.fillRect(0,0,96,20,0xff304868);galleryNext.font.height=11;
galleryNext.drawText(4,3,"Next preview",0xffffff);galleryNext.visible=true;
galleryNext.onClick=function(){global.galleryIndex=(global.galleryIndex+1)%global.galleryPages.count;global.galleryShow();};
spriteRoot.holdAlpha=false;galleryShow();spriteW.visible=true;
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: clicking through sprite previews displays scaled colors and masks`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    await page.locator('#files').setInputFiles([
      { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
        ? 'Scripts.compileStorage("gallery.tjs","savedata/gallery.cjs",false,true,false);Scripts.execStorage("savedata/gallery.cjs");'
        : 'Scripts.execStorage("gallery.tjs");') },
      { name: 'gallery.tjs', mimeType: 'text/plain', buffer: Buffer.from(gallery) },
    ])
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Sprite gallery$/ }),
    }).locator('canvas[data-window-id]')
    try {
      await expect(canvas).toBeVisible()
      for (const [index, [id]] of pages.entries()) {
        if (index !== 0) {
          const box = await canvas.boundingBox()
          if (!box) throw new Error('Sprite gallery closed while changing preview')
          await canvas.click({ position: { x: box.width / 2, y: box.height * 50 / 60 } })
        }
        await expect(page.getByText('gallery:' + id, { exact: true })).toBeVisible()
        const expected = spriteSamplingCases.find((entry) => entry.id === id)!.expected
          .split(',').map((cell) => cell.split('/').map(Number))
        let screenshot: Buffer | undefined
        try {
          await expect(async () => {
            screenshot = await canvas.screenshot()
            const { width, height, rgba } = readScreenshotPng(screenshot)
            for (const [i, cell] of expected.entries()) {
              for (const [track, y] of [10, 28].entries()) {
                const offset = 4 * (Math.floor(height * y / 60) * width + Math.floor((i + 0.5) * width / expected.length))
                const value = cell[track]!
                const rgb = track === 0 && id.startsWith('sprite-opacity-')
                  ? [value >>> 16, (value >>> 8) & 255, value & 255] : [value, value, value]
                expect([...rgba.subarray(offset, offset + 4)], `${id} cell ${i} track ${track}`).toEqual([...rgb, 255])
              }
            }
          }).toPass({ timeout: 8000 })
        } finally {
          if (screenshot) await info.attach(id, { body: screenshot, contentType: 'image/png' })
        }
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } finally {
      await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    expect(errors).toEqual([])
  })
}
