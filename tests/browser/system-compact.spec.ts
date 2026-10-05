import { expect, test, type Page, type Locator, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { cursorDib, cursorFile } from '../helpers/cursor-fixtures.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const source = String.raw`
var win=new Window();win.caption="System compact";win.setInnerSize(160,64);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(160,64);root.setImageSize(160,64);
root.font.face="wide.ttf";root.font.faceIsFileName=true;root.font.height=18;
function paintText(){root.fillRect(0,0,160,64,0xff112233);root.drawText(40,10,"AB",0xffffff);}
paintText();var measured=root.font.getTextWidth("AB");
var sourceImage=new Layer(win,root);win.add(sourceImage);sourceImage.setImageSize(16,16);sourceImage.fillRect(0,0,16,16,0xffff2200);
sourceImage.saveLayerImage("savedata/image.png","png");
var visibleImage=new Layer(win,root);win.add(visibleImage);visibleImage.loadImages("savedata/image.png");visibleImage.setPos(8,8);visibleImage.visible=true;
System.touchImages(["savedata/image.png"]);visibleImage.cursor="solid.cur";var cursorId=visibleImage.cursor;
Storages.addAutoPath("pack.xp3>");var fromArchive=[].load("inside.txt","utf-8")[0];
function compactAndPaint(){
 System.doCompact(clIdle);System.doCompact(clDeactivate);System.doCompact(clMinimize);System.doCompact();
 paintText();visibleImage.cursor="solid.cur";
 return int(root.font.getTextWidth("AB")==measured)+","+int(visibleImage.cursor==cursorId)+","+
   int([].load("inside.txt","utf-8")[0]==fromArchive)+","+visibleImage.getMainPixel(1,1);
}
function reloadAfterCompact(){visibleImage.loadImages("savedata/image.png");return visibleImage.getMainPixel(1,1);}
`

async function rgba(page: Page, canvas: Locator, info: TestInfo, name: string) {
  await expect(canvas).toHaveJSProperty('width', 160)
  await expect(canvas).toHaveJSProperty('height', 64)
  const png = await canvas.screenshot()
  await info.attach(name, { body: png, contentType: 'image/png' })
  return page.evaluate(async (url) => {
    const image = await createImageBitmap(await (await fetch(url)).blob()),
      context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
    try { context.drawImage(image, 0, 0); return { width: image.width, height: image.height,
      bytes: [...context.getImageData(0, 0, image.width, image.height).data] } }
    finally { image.close() }
  }, 'data:image/png;base64,' + png.toString('base64'))
}

for (const backend of ['asyncify','jspi']) for (const binary of [false,true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: compact reloads real font/image caches while complete live pixels, archive access and cursor identity survive`, async ({ page }, info) => {
    test.setTimeout(90000)
    const cursor = cursorFile([{ width: 1, height: 1,
      payload: cursorDib({ width: 1, height: 1, depth: 24, xorRows: [[0,255,0]] }) }]),
      game = await launchWindowAttention(page, backend, binary, source, [
        { name: 'wide.ttf', mimeType: 'font/ttf', buffer: await readFile('tests/fixtures/font/wide.ttf') },
        { name: 'solid.cur', mimeType: 'application/octet-stream', buffer: cursor },
        { name: 'pack.xp3', mimeType: 'application/octet-stream', buffer: xp3Fixture({ 'inside.txt': 'archive bytes' }).bytes },
      ]), canvas = game.surface('System compact').locator('canvas[data-window-id]'), errors: unknown[] = []
    try {
      const before = await rgba(page, canvas, info, 'compact-before')
      expect(before.bytes.some((value, index) => index % 4 === 0 && value > 200 &&
        before.bytes[index + 1]! > 200 && before.bytes[index + 2]! > 200)).toBe(true)
      await evaluate(page, 'compactAndPaint()', '1,1,1,16720384')
      const after = await rgba(page, canvas, info, 'compact-after-font-reload')
      expect(after).toEqual(before)
      await evaluate(page, 'reloadAfterCompact()', '16720384')
      expect(await rgba(page, canvas, info, 'compact-after-image-reload')).toEqual(before)
    } catch (error) { errors.push(error) }
    try { await game.stop() } catch (error) { errors.push(error) }
    if (errors.length) throw new AggregateError(errors, 'Compact browser scenario or cleanup failed')
  })
}
