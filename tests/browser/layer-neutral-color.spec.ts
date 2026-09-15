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
  height = 4,
) {
  const canvas = page.locator('canvas')
  await expect(canvas).toHaveJSProperty('width', width)
  await expect(canvas).toHaveJSProperty('height', height)
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
    async ({ url, width, height, samples }) => {
      const image = await createImageBitmap(await (await fetch(url)).blob())
      const context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
      context.drawImage(image, 0, 0)
      const result = samples.map(([x, y]) => [
        ...context.getImageData(
          Math.floor(((x! + 0.5) * image.width) / width),
          Math.floor(((y! + 0.5) * image.height) / height),
          1,
          1,
        ).data,
      ])
      image.close()
      return result
    },
    { url: 'data:image/png;base64,' + png.toString('base64'), width, height, samples },
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

    test(`${mode}: opaque layers without images fill their frame and ancestor snapshots after neutralColor changes`, async ({
      page,
    }, testInfo) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var win=new Window();win.visible=true;win.setInnerSize(20,8);
var root=new Layer(win,null);root.setSize(20,8);root.fillRect(0,0,20,8,0xff000000);
var scene=new Layer(win,root);scene.type=ltOpaque;scene.setImageSize(20,4);scene.setSize(20,4);
scene.fillRect(0,0,20,4,0xff000000);scene.visible=true;
var solid=new Layer(win,scene);solid.type=ltOpaque;solid.setSize(4,4);solid.hasImage=false;
solid.neutralColor=0x00800000;solid.visible=true;
var group=new Layer(win,scene);group.type=ltOpaque;group.setSize(8,4);group.left=4;
group.hasImage=false;group.neutralColor=0x00800000;group.opacity=128;group.visible=true;
var child=new Layer(win,group);child.type=ltOpaque;child.setImageSize(4,4);child.setSize(4,4);child.left=4;
child.fillRect(0,0,4,4,0xff008000);child.visible=true;
var alpha=new Layer(win,scene);alpha.setSize(4,4);alpha.left=12;alpha.hasImage=false;
alpha.neutralColor=0xffff00ff;alpha.opacity=128;alpha.visible=true;
var binder=new Layer(win,scene);binder.type=ltBinder;binder.setSize(4,4);binder.left=16;
binder.neutralColor=0xffffff00;binder.opacity=128;binder.visible=true;
var snapshot=new Layer(win,root);snapshot.type=ltOpaque;snapshot.setImageSize(20,4);snapshot.setSize(20,4);snapshot.top=4;
var rejected=0;try{snapshot.piledCopy(0,0,solid,0,0,4,4);}catch(error){rejected++;}
snapshot.piledCopy(0,0,scene,0,0,20,4);snapshot.visible=true;
function changeNeutral(){
  solid.neutralColor=0x00000080;group.neutralColor=0x00000080;
  alpha.neutralColor=0xff00ff00;binder.neutralColor=0xff00ff00;
  solid.update();group.update();alpha.update();binder.update();
  snapshot.piledCopy(0,0,scene,0,0,20,4);
  return int(!solid.hasImage && !group.hasImage && !alpha.hasImage && !binder.hasImage);
}
Debug.message("neutral-color-ready:"+int(rejected==1 && !solid.hasImage && !group.hasImage && !alpha.hasImage && !binder.hasImage));
`,
      )
      try {
        // The upper row is the live tree; the lower row is piledCopy through
        // its drawable ancestor. The snapshot is opaque like that ancestor:
        // piledCopy preserves masks, including the opaque child's zero alpha.
        // Opaque 128-valued colors give an exact half-opacity result of 64.
        const samples = [1, 5].flatMap((y) => [1, 6, 10, 14, 18].map((x) => [x, y]))
        const red = [
          [128, 0, 0, 255],
          [64, 0, 0, 255],
          [0, 64, 0, 255],
          [0, 0, 0, 255],
          [0, 0, 0, 255],
        ]
        expect(await pixels(page, testInfo, 'neutral-color-no-image-red', 20, samples, 8)).toEqual([
          ...red,
          ...red,
        ])
        await evaluate(page, 'changeNeutral()', '1')
        const blue = [
          [0, 0, 128, 255],
          [0, 0, 64, 255],
          [0, 64, 0, 255],
          [0, 0, 0, 255],
          [0, 0, 0, 255],
        ]
        expect(await pixels(page, testInfo, 'neutral-color-no-image-blue', 20, samples, 8)).toEqual(
          [...blue, ...blue],
        )
      } finally {
        await stop()
      }
    })
  }
}
