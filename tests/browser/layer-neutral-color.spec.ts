import { test, expect, type Page, type TestInfo } from '@playwright/test'

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
          ? 'Scripts.compileStorage("browser-neutral-color.tjs","savedata/browser-neutral-color.cjs",false,true,false);Scripts.execStorage("savedata/browser-neutral-color.cjs");'
          : 'Scripts.execStorage("browser-neutral-color.tjs");',
      ),
    },
    { name: 'browser-neutral-color.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
  ])
  await expect(page.locator('#evaluate')).toBeEnabled()
  await expect(page.getByText('neutral-color-ready:1', { exact: true })).toBeVisible()
  return async () => {
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    expect(errors).toEqual([])
  }
}

async function pixels(
  page: Page,
  testInfo: TestInfo,
  name: string,
  width: number,
  samples: number[][],
) {
  const canvas = page.locator('canvas')
  await expect(canvas).toHaveJSProperty('width', width)
  await expect(canvas).toHaveJSProperty('height', 4)
  // Keep each source pixel an integer block, including on HiDPI runners.
  await canvas.evaluate((node) => {
    const surface = node as HTMLCanvasElement
    surface.style.width = `${surface.width * 16}px`
    surface.style.height = `${surface.height * 16}px`
    surface.style.imageRendering = 'pixelated'
  })
  const png = await canvas.screenshot()
  await testInfo.attach(name, { body: png, contentType: 'image/png' })
  return page.evaluate(
    async ({ url, width, samples }) => {
      const image = await createImageBitmap(await (await fetch(url)).blob())
      const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
      context.drawImage(image, 0, 0)
      const result = samples.map(([x, y]) => [
        ...context.getImageData(
          Math.floor(((x! + 0.5) * image.width) / width),
          Math.floor(((y! + 0.5) * image.height) / 4),
          1,
          1,
        ).data,
      ])
      image.close()
      return result
    },
    { url: 'data:image/png;base64,' + png.toString('base64'), width, samples },
  )
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: neutralColor preserves old pixels and fills expanded and recreated images`, async ({
      page,
    }, testInfo) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var win=new Window();win.visible=true;win.setInnerSize(12,4);
var root=new Layer(win,null);root.setSize(12,4);root.fillRect(0,0,12,4,0xff202020);
var expanded=new Layer(win,root);expanded.setImageSize(2,2);
expanded.fillRect(0,0,2,2,0xffff0000);expanded.neutralColor=0xff00ff00;
expanded.setImageSize(4,4);expanded.setSize(4,4);expanded.visible=true;
var recreated=new Layer(win,root);recreated.setImageSize(4,4);recreated.setSize(4,4);
recreated.left=4;recreated.fillRect(0,0,4,4,0xffff0000);recreated.neutralColor=0xff0000ff;
recreated.hasImage=false;recreated.hasImage=true;recreated.visible=true;
var unchanged=new Layer(win,root);unchanged.type=ltOpaque;
unchanged.setImageSize(4,4);unchanged.setSize(4,4);unchanged.left=8;
unchanged.fillRect(0,0,4,4,0xffff0000);unchanged.neutralColor=0xffffff00;
unchanged.type=unchanged.type;unchanged.hasImage=false;unchanged.hasImage=true;unchanged.visible=true;
Debug.message("neutral-color-ready:"+int(expanded.neutralColor==0xff00ff00 && recreated.neutralColor==0xff0000ff && unchanged.neutralColor==0xffffff00));
`,
      )
      try {
        expect(
          await pixels(page, testInfo, 'neutral-color-expansion-and-recreation', 12, [
            [0, 0],
            [1, 1],
            [3, 1],
            [1, 3],
            [3, 3],
            [4, 0],
            [7, 3],
            [8, 0],
            [11, 3],
          ]),
        ).toEqual([
          [255, 0, 0, 255],
          [255, 0, 0, 255],
          [0, 255, 0, 255],
          [0, 255, 0, 255],
          [0, 255, 0, 255],
          [0, 0, 255, 255],
          [0, 0, 255, 255],
          [255, 255, 0, 255],
          [255, 255, 0, 255],
        ])
      } finally {
        await stop()
      }
    })

    test(`${mode}: affine clear uses neutralColor within the clip and changing type resets the fill`, async ({
      page,
    }, testInfo) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var win=new Window();win.visible=true;win.setInnerSize(12,4);
var root=new Layer(win,null);root.setSize(12,4);root.fillRect(0,0,12,4,0xff202020);
var source=new Layer(win,root);source.setImageSize(2,2);source.fillRect(0,0,2,2,0xff0000ff);
var cleared=new Layer(win,root);cleared.setImageSize(8,4);cleared.setSize(8,4);
cleared.fillRect(0,0,8,4,0xffff0000);cleared.neutralColor=0xff00ffff;
cleared.setClip(2,0,6,4);cleared.affineCopy(source,0,0,2,2,true,1,0,0,1,4,1,stNearest,true);
cleared.visible=true;
var changed=new Layer(win,root);changed.setImageSize(4,4);changed.setSize(4,4);changed.left=8;
changed.fillRect(0,0,4,4,0xffff0000);changed.neutralColor=0xffffff00;changed.type=ltOpaque;
changed.hasImage=false;changed.hasImage=true;changed.visible=true;
Debug.message("neutral-color-ready:"+int(cleared.neutralColor==0xff00ffff && changed.neutralColor==0x00ffffff));
`,
      )
      try {
        expect(
          await pixels(page, testInfo, 'neutral-color-affine-clip-and-type-reset', 12, [
            [0, 0],
            [1, 3],
            [2, 0],
            [3, 2],
            [4, 0],
            [4, 1],
            [5, 2],
            [5, 3],
            [7, 3],
            [8, 0],
            [11, 3],
          ]),
        ).toEqual([
          [255, 0, 0, 255],
          [255, 0, 0, 255],
          [0, 255, 255, 255],
          [0, 255, 255, 255],
          [0, 255, 255, 255],
          [0, 0, 255, 255],
          [0, 0, 255, 255],
          [0, 255, 255, 255],
          [0, 255, 255, 255],
          [255, 255, 255, 255],
          [255, 255, 255, 255],
        ])
      } finally {
        await stop()
      }
    })
  }
}
