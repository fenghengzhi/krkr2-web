import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const scene = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(160,80);
var root=new Layer(win,null);root.setSize(160,80);root.fillRect(0,0,160,80,0xff17202a);
`

async function launch(page: Page, backend: string, binary: boolean, source: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  const startup = binary
    ? 'Scripts.compileStorage("browser-province.tjs","savedata/browser-province.cjs",false,true,false);Scripts.execStorage("savedata/browser-province.cjs");'
    : 'Scripts.execStorage("browser-province.tjs");'
  await page.locator('#files').setInputFiles([
    { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(startup) },
    {
      name: 'browser-province.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(scene + source + '\nDebug.message("browser-province-ready");'),
    },
  ])
  await expect(page.getByText('browser-province-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  return async () => {
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('.game-text-input')).toHaveCount(0)
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    expect(errors).toEqual([])
  }
}

async function clickCanvas(page: Page, x: number, y: number, result: string) {
  const canvas = page.locator('canvas')
  await expect(canvas).toHaveJSProperty('width', 160)
  await expect(canvas).toHaveJSProperty('height', 80)
  const bounds = (await canvas.boundingBox())!
  await canvas.click({
    position: { x: (bounds.width * (x + 0.5)) / 160, y: (bounds.height * (y + 0.5)) / 80 },
  })
  // Both the target and the primary Layer acknowledge delivery. A miss is
  // proved by the primary's actual callback, not by immediately reading zero.
  await expect(page.getByText(result, { exact: true })).toBeVisible()
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: a province-only Layer receives real pointer hits and keeps its plane dimensions across Layer resize`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var pointerCount=0;
function recordPointer(target){pointerCount++;Debug.message("province-pointer-"+pointerCount+":"+target);}
root.onClick=function(x,y){recordPointer("root");};
var provinceLayer=new Layer(win,root);
provinceLayer.setImageSize(80,40);provinceLayer.setSize(40,20);provinceLayer.setPos(20,10);
provinceLayer.setImagePos(-4,-2);provinceLayer.hasImage=false;
provinceLayer.setProvincePixel(24,12,5);provinceLayer.setProvincePixel(36,16,7);
provinceLayer.visible=true;provinceLayer.focusable=false;provinceLayer.hitType=htProvince;provinceLayer.hitThreshold=0;
provinceLayer.onClick=function(x,y){recordPointer("province");};
function shrinkProvinceLayer(){
  provinceLayer.setSize(24,12);
  return [int(provinceLayer.hasImage),provinceLayer.getProvincePixel(36,16),provinceLayer.width,provinceLayer.height].join(",");
}
function growProvinceLayer(){
  provinceLayer.setSize(60,30);
  var outsideRejected=false;
  try{provinceLayer.setProvincePixel(44,10,9);}catch(error){outsideRejected=true;}
  return [int(provinceLayer.hasImage),provinceLayer.getProvincePixel(36,16),provinceLayer.getProvincePixel(44,10),int(outsideRejected),provinceLayer.width,provinceLayer.height].join(",");
}
`,
      )
      try {
        await evaluate(
          page,
          '[int(provinceLayer.hasImage),provinceLayer.getProvincePixel(24,12),provinceLayer.getProvincePixel(34,12),provinceLayer.clipWidth,provinceLayer.clipHeight].join(",")',
          '0,5,0,80,40',
        )
        // Negative image offsets map the Province point (24, 12) to local
        // (20, 10), hence Window point (40, 20).
        await clickCanvas(page, 40, 20, 'province-pointer-1:province')
        await clickCanvas(page, 50, 20, 'province-pointer-2:root')
        await evaluate(page, 'shrinkProvinceLayer()', '0,7,24,12')
        await clickCanvas(page, 52, 24, 'province-pointer-3:root')
        // (44, 10) remains inside the saved drawing clip but outside the
        // original 40 x 20 Province. Growing the Layer must not grow it.
        await evaluate(page, 'growProvinceLayer()', '0,7,0,1,60,30')
        await clickCanvas(page, 52, 24, 'province-pointer-4:province')
        await clickCanvas(page, 65, 20, 'province-pointer-5:root')
      } finally {
        await stop()
      }
    })

    test(`${mode}: image independence preserves exclusive pixels and validates live receivers without creating MainImage`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
var paint=new Layer(win,root);paint.setImageSize(6,5);paint.setSize(4,3);
paint.fillRect(0,0,6,5,0x7f112233);paint.setProvincePixel(2,1,77);paint.setClip(1,0,2,3);paint.setImagePos(-1,-2);paint.imageModified=false;
var bare=new Layer(win,root);bare.setImageSize(6,4);bare.setSize(4,3);bare.setClip(1,0,3,3);
bare.hasImage=false;bare.setProvincePixel(2,1,91);bare.imageModified=false;
var empty=new Layer(win,root);empty.setSize(4,3);empty.hasImage=false;empty.imageModified=false;
function independentCalls(layer){
  return [int(layer.independMainImage()===void),int(layer.independMainImage(void)===void),int(layer.independMainImage(false)===void),
    int(layer.independMainImage(0.5)===void),int(layer.independMainImage(-0.5)===void),
    int(layer.independProvinceImage()===void),int(layer.independProvinceImage(void)===void),int(layer.independProvinceImage(false)===void),
    int(layer.independProvinceImage(0.5)===void),int(layer.independProvinceImage(-0.5)===void)].join(",");
}
function paintState(){
  return [int(paint.hasImage),int(paint.imageModified),paint.getMainPixel(2,1),paint.getMaskPixel(2,1),paint.getProvincePixel(2,1),
    paint.clipLeft,paint.clipTop,paint.clipWidth,paint.clipHeight,paint.imageLeft,paint.imageTop,paint.width,paint.height].join(",");
}
function bareState(){
  var mainRejected=false;try{bare.getMainPixel(2,1);}catch(error){mainRejected=true;}
  return [int(bare.hasImage),int(bare.imageModified),bare.getProvincePixel(2,1),bare.clipLeft,bare.clipTop,bare.clipWidth,bare.clipHeight,
    bare.width,bare.height,int(mainRejected),int(empty.hasImage),int(empty.imageModified),empty.getProvincePixel(2,1)].join(",");
}
var savedMain=paint.independMainImage incontextof paint,savedProvince=paint.independProvinceImage incontextof paint;
function invalidatePaint(){
  invalidate paint;var rejected=0;
  try{paint.independMainImage();}catch(error){rejected++;}
  try{paint.independProvinceImage(false);}catch(error){rejected++;}
  try{savedMain();}catch(error){rejected++;}
  try{savedProvince(void);}catch(error){rejected++;}
  return [int(isvalid paint),rejected].join(",");
}
`,
      )
      try {
        for (const layer of ['paint', 'bare', 'empty']) {
          await evaluate(page, `independentCalls(${layer})`, '1,1,1,1,1,1,1,1,1,1')
        }
        await evaluate(page, 'paintState()', '1,0,1122867,127,77,1,0,2,3,-1,-2,4,3')
        await evaluate(page, 'bareState()', '0,0,91,1,0,3,3,4,3,1,0,0,0')
        await evaluate(page, 'invalidatePaint()', '0,4')
        await evaluate(page, 'bareState()', '0,0,91,1,0,3,3,4,3,1,0,0,0')
      } finally {
        await stop()
      }
    })
  }
}
