import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
var win=new Window();win.caption="Layer setPos";win.setInnerSize(160,100);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(160,100);root.fillRect(0,0,160,100,0xff112233);
var child=new Layer(win,root);win.add(child);child.setImageSize(20,20);child.setSize(20,20);child.setPos(10,10);
child.fillRect(0,0,20,20,0xffee2200);child.neutralColor=0xff00dd44;child.visible=true;
function rectangle(layer){return [layer.left,layer.top,layer.width,layer.height].join(",");}
function rejectedBounds(){var failed=0;try{child.setPos(70,30,-1,16);}catch(error){failed++;}return failed+"|"+rectangle(child);}
function fourBounds(){child.setPos(70,30,30,16);return rectangle(child);}
function fivePosition(){child.setPos(20,60,2,3,"extra");return rectangle(child);}
var armed=false,reentered=false,callbacks=[];
child.onMouseLeave=function(){if(armed){callbacks.add("leave:"+rectangle(this));Debug.message("set-pos-leave:"+rectangle(this));}};
child.onMouseMove=function(x,y,shift){
 if(!armed)return;
 callbacks.add(rectangle(this));Debug.message("set-pos-move:"+rectangle(this));
 if(!reentered){reentered=true;this.setPos(100,65,12,10);callbacks.add(rectangle(this));Debug.message("set-pos-reentered:"+rectangle(this));}
};
win.onKeyDown=function(key,shift){
 if(key==77){armed=true;child.setPos(80,40,30,20);Debug.message("set-pos-return:"+callbacks.count+"|"+rectangle(child));}
};
`

async function samples(page: Page, canvas: Locator, info: TestInfo, name: string, points: number[][]) {
  await expect(canvas).toHaveJSProperty('width', 160)
  await expect(canvas).toHaveJSProperty('height', 100)
  const png = await canvas.screenshot()
  await info.attach(name, { body: png, contentType: 'image/png' })
  return page.evaluate(async ({ url, points }) => {
    const image = await createImageBitmap(await (await fetch(url)).blob()),
      context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
    try {
      context.drawImage(image, 0, 0)
      return points.map(([x, y]) => [...context.getImageData(
        Math.floor((x! + 0.5) * image.width / 160), Math.floor((y! + 0.5) * image.height / 100), 1, 1).data])
    } finally { image.close() }
  }, { url: 'data:image/png;base64,' + png.toString('base64'), points })
}

async function finish(info: TestInfo, page: Page, stop: () => Promise<void>, failures: unknown[]) {
  try { await info.attach('layer-set-pos-log', { body: Buffer.from(await page.locator('#logs').innerText()), contentType: 'text/plain' }) }
  catch (error) { failures.push(error) }
  try { await stop() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Layer setPos scenario or cleanup failed')
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

  test(`${variant}: real Layer bounds move preserves rejected geometry and presents old exposure plus grown image`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source),
      canvas = game.surface('Layer setPos').locator('canvas[data-window-id]'), failures: unknown[] = [],
      background = [17,34,51,255], red = [238,34,0,255], green = [0,221,68,255]
    try {
      expect(await samples(page, canvas, info, 'initial', [[15,15],[75,35]])).toEqual([red,background])
      await evaluate(page, 'rejectedBounds()', '1|10,10,20,20')
      expect(await samples(page, canvas, info, 'rejected', [[15,15],[75,35]])).toEqual([red,background])
      await evaluate(page, 'fourBounds()', '70,30,30,16')
      expect(await samples(page, canvas, info, 'four-argument-bounds', [[15,15],[75,35],[95,35],[95,48]]))
        .toEqual([background,red,green,background])
      await evaluate(page, 'fivePosition()', '20,60,30,16')
      expect(await samples(page, canvas, info, 'five-argument-position', [[75,35],[25,65],[45,65],[45,78]]))
        .toEqual([background,red,green,background])
    } catch (error) { failures.push(error) }
    await finish(info, page, game.stop, failures)
  })

  test(`${variant}: keyboard setPos has no intermediate hover and real mouse callback can reenter complete bounds`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source), surface = game.surface('Layer setPos'),
      canvas = surface.locator('canvas[data-window-id]'), failures: unknown[] = []
    try {
      const initial = (await canvas.boundingBox())!
      await page.mouse.click(initial.x + initial.width * 15 / 160, initial.y + initial.height * 15 / 100)
      await expect(surface.locator('.game-text-input')).toBeFocused()
      await page.keyboard.press('KeyM')
      await expect(page.getByText('set-pos-return:0|80,40,30,20', { exact: true })).toBeVisible()
      await expect(page.locator('#logs')).not.toContainText('set-pos-leave:')
      await expect(page.locator('#logs')).not.toContainText('set-pos-move:')
      const moved = (await canvas.boundingBox())!
      await page.mouse.move(moved.x + moved.width * 85 / 160, moved.y + moved.height * 45 / 100)
      await expect(page.getByText('set-pos-move:80,40,30,20', { exact: true })).toBeVisible()
      await expect(page.getByText('set-pos-reentered:100,65,12,10', { exact: true })).toBeVisible()
      await page.mouse.move(moved.x + moved.width * 130 / 160, moved.y + moved.height * 90 / 100)
      await expect(page.getByText('set-pos-leave:100,65,12,10', { exact: true })).toBeVisible()
      await evaluate(page, 'callbacks.join("|")', '80,40,30,20|100,65,12,10|leave:100,65,12,10')
    } catch (error) { failures.push(error) }
    await finish(info, page, game.stop, failures)
  })
}
