import { expect, test } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { sharedImageCases, sharedImageSource } from '../helpers/layer-image-sharing.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

const scene = String.raw`
var win=new Window();win.caption="Gallery";win.borderStyle=bsNone;win.innerSunken=false;win.setInnerSize(160,80);
var root=new Layer(win,null);win.add(root);root.setSize(160,80);root.fillRect(0,0,160,80,0xff182028);
var sheet=new Layer(win,root);win.add(sheet);sheet.setImageSize(2048,1536);
sheet.fillRect(0,0,160,80,0xff204080);sheet.setProvincePixel(24,18,7);
var pages=[];
for(var i=0;i<8;i++){
 var panel=new Layer(win,root);win.add(panel);panel.type=ltOpaque;panel.assignImages(sheet);
 panel.setSize(160,80);panel.hitType=htProvince;panel.hitThreshold=0;pages.add(panel);
}
var clicks=0;
function choosePage(){
 pages[0].fillRect(0,0,160,80,0xffc06020);pages[0].setProvincePixel(24,18,0);
 Debug.message("gallery-selected:"+ (++clicks));
}
pages[0].onClick=function(x,y){global.choosePage();};
pages[1].onClick=function(x,y){global.Debug.message("gallery-other:"+ (++global.clicks));};
root.onClick=function(x,y){global.Debug.message("gallery-background:"+ (++global.clicks));};
function restoreGalleryPage(){
 pages[0].visible=false;pages[1].visible=true;win.update();
 return [sheet.getProvincePixel(24,18),pages[0].getProvincePixel(24,18),pages[1].getProvincePixel(24,18)].join(",");
}
pages[0].visible=true;win.visible=true;win.update();
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a gallery can reuse a large picture and edit one page's art and hit map`, async ({ page }) => {
    const game = await launchWindowAttention(page, backend, binary, sharedImageSource + scene)
    try {
      const canvas = game.surface('Gallery').locator('canvas[data-window-id]')
      await expect(canvas).toHaveJSProperty('width', 160)
      const color = async () => {
        const shot = readScreenshotPng(await canvas.screenshot())
        const offset = (Math.floor(shot.height / 2) * shot.width + Math.floor(shot.width / 2)) * 4
        return [...shot.rgba.subarray(offset, offset + 4)]
      }
      const click = async (marker: string) => {
        const point = await pointerPixel(canvas, 24, 18)
        await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }
      await expect.poll(color).toEqual([32, 64, 128, 255])
      await click('gallery-selected:1')
      await expect.poll(color).toEqual([192, 96, 32, 255])
      await click('gallery-background:2')
      await evaluate(page, 'restoreGalleryPage()', '7,0,7')
      await expect.poll(color).toEqual([32, 64, 128, 255])
      await click('gallery-other:3')
      for (const { id, expected } of sharedImageCases) await evaluate(page, `sharedImageRun("${id}")`, expected)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } finally { await game.stop() }
  })
