import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

async function launch(page: Page, backend: string, binary: boolean, source: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("browser-redraw.tjs","savedata/browser-redraw.cjs",false,true,false);Scripts.execStorage("savedata/browser-redraw.cjs");'
          : 'Scripts.execStorage("browser-redraw.tjs");',
      ),
    },
    { name: 'browser-redraw.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
  ])
  await expect(page.locator('#evaluate')).toBeEnabled()
  return async () => {
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    expect(errors).toEqual([])
  }
}

async function pixels(page: Page, testInfo: TestInfo, name: string, positions: number[]) {
  const canvas = page.locator('canvas')
  const png = await canvas.screenshot()
  await testInfo.attach(name, { body: png, contentType: 'image/png' })
  return page.evaluate(
    async ({ url, positions }) => {
      const image = await createImageBitmap(await (await fetch(url)).blob())
      const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
      context.drawImage(image, 0, 0)
      const result = positions.map((x) => [
        ...context.getImageData(Math.floor(image.width * x), Math.floor(image.height / 2), 1, 1)
          .data,
      ])
      image.close()
      return result
    },
    { url: 'data:image/png;base64,' + png.toString('base64'), positions },
  )
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: Layer.update coalesces default onPaint actions and presents their pixels`, async ({
      page,
    }, testInfo) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var win=new Window();win.visible=true;win.setInnerSize(8,4);
var root=new Layer(win,null);root.setSize(8,4);root.fillRect(0,0,8,4,0xff202020);
var painted=0,paintColor=0xffff0000,targets=true,contexts=true,cleared=true;
win.action=function(event){
  if(event.type!="onPaint")return;
  painted++;targets=targets && event.target===root;contexts=contexts && this===win;
  cleared=cleared && !event.target.callOnPaint;
  event.target.fillRect(0,0,4,4,paintColor);
  Debug.message("default-paint:"+painted);
};
function invalidUpdates(){
  var rejected=0;
  try{root.update(1);}catch(error){rejected++;}
  try{root.update(1,2);}catch(error){rejected++;}
  try{root.update(1,2,3);}catch(error){rejected++;}
  return rejected+","+int(root.callOnPaint);
}
function requestBlue(){
  paintColor=0xff0000ff;root.update(0,0,4,4);root.update();return painted;
}
root.update();root.update(0,0,4,4);root.update(0,0,4,4,"ignored");
`,
      )
      try {
        await expect(page.getByText('default-paint:1', { exact: true })).toBeVisible()
        await expect(page.locator('canvas')).toHaveJSProperty('width', 8)
        await expect(page.locator('canvas')).toHaveJSProperty('height', 4)
        await evaluate(page, 'painted+","+targets+","+contexts+","+cleared', '1,1,1,1')
        expect(await pixels(page, testInfo, 'default-paint-red', [0.25, 0.75])).toEqual([
          [255, 0, 0, 255],
          [32, 32, 32, 255],
        ])
        await evaluate(page, 'invalidUpdates()', '3,0')
        await evaluate(page, 'requestBlue()', '1')
        await expect(page.getByText('default-paint:2', { exact: true })).toBeVisible()
        expect(await pixels(page, testInfo, 'default-paint-blue', [0.25, 0.75])).toEqual([
          [0, 0, 255, 255],
          [32, 32, 32, 255],
        ])
        await evaluate(page, 'painted+","+int(root.callOnPaint)', '2,0')
      } finally {
        await stop()
      }
    })

    test(`${mode}: update inside onPaint advances autonomously and leaves the final frame visible`, async ({
      page,
    }, testInfo) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var win=new Window();win.visible=true;win.setInnerSize(12,4);
var root=new Layer(win,null);root.setSize(12,4);root.fillRect(0,0,12,4,0xff202020);
var painted=0,depth=0,maxDepth=0,flags=[],colors=[0xffff0000,0xff00ff00,0xff0000ff];
root.onPaint=function(){
  depth++;if(depth>maxDepth)maxDepth=depth;
  flags.add(int(root.callOnPaint));
  root.fillRect(painted*4,0,4,4,colors[painted]);painted++;
  if(painted<3){root.update();root.update(0,0,12,4);}
  depth--;
  if(painted==3)Debug.message("redraw-finished:"+painted+","+maxDepth+","+flags.join(","));
};
root.update();
`,
      )
      try {
        // No console evaluation or input is sent while the callback requests
        // its subsequent frames. The renderer must schedule that work itself.
        await expect(page.getByText('redraw-finished:3,1,0,0,0', { exact: true })).toBeVisible()
        await expect(page.locator('canvas')).toHaveJSProperty('width', 12)
        await expect(page.locator('canvas')).toHaveJSProperty('height', 4)
        expect(await pixels(page, testInfo, 'autonomous-redraw', [1 / 6, 0.5, 5 / 6])).toEqual([
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
        ])
        await evaluate(page, 'painted+","+int(root.callOnPaint)+","+depth', '3,0,0')
      } finally {
        await stop()
      }
    })
  }
}
