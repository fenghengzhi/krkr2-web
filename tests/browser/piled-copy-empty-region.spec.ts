import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const scene = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(4,2);
var root=new Layer(win,null);root.setSize(4,2);root.fillRect(0,0,4,2,0xff000000);
var source=new Layer(win,root),target=new Layer(win,root);
source.setSize(4,2);source.setImageSize(4,2);
target.setSize(4,2);target.setImageSize(4,2);
for(var y=0;y<2;y++)for(var x=0;x<4;x++){
  source.setMainPixel(x,y,0x010000*(1+x)+y);source.setMaskPixel(x,y,100+x+y);
}
target.fillRect(0,0,4,2,0x55102030);target.setProvincePixel(1,0,37);
var paints=0;source.onPaint=function(){paints++;};
`

async function launch(page: Page, backend: string, binary: boolean, body: string) {
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
          ? 'Scripts.compileStorage("browser-piled-copy.tjs","savedata/browser-piled-copy.cjs",false,true,false);Scripts.execStorage("savedata/browser-piled-copy.cjs");'
          : 'Scripts.execStorage("browser-piled-copy.tjs");',
      ),
    },
    {
      name: 'browser-piled-copy.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(scene + body + '\nDebug.message("piled-copy-empty-ready");'),
    },
  ])
  await expect(page.getByText('piled-copy-empty-ready', { exact: true })).toBeVisible()
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

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: piledCopy empty target regions leave paint pending and still validate both images`, async ({
      page,
    }) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
target.setClip(1,0,2,1);target.imageModified=false;source.callOnPaint=true;
target.piledCopy(0,0,source,0,0,1,1);
var outsideProof=paints+","+int(source.callOnPaint)+","+int(target.imageModified)+","+target.getMainPixel(1,0);
target.piledCopy(1,0,source,0,0,0,1);
var emptyProof=paints+","+int(source.callOnPaint)+","+int(target.imageModified)+","+target.getMaskPixel(1,0);
source.hasImage=false;var sourceErrors=0;
try{target.piledCopy(1,0,source,0,0,0,1);}catch(error){sourceErrors++;}
var missingSourceProof=sourceErrors+","+paints+","+int(source.callOnPaint)+","+int(source.hasImage);
source.hasImage=true;target.hasImage=false;var targetErrors=0;
try{target.piledCopy(9,0,source,0,0,1,1);}catch(error){targetErrors++;}
var missingTargetProof=targetErrors+","+paints+","+int(source.callOnPaint)+","+int(target.hasImage);
target.hasImage=true;
`,
      )
      try {
        // These records are captured before the same script returns to its
        // ordinary frame; a later frame is allowed to consume pending onPaint.
        await evaluate(page, 'outsideProof', '0,1,0,1056816')
        await evaluate(page, 'emptyProof', '0,1,0,85')
        await evaluate(page, 'missingSourceProof', '1,0,1,0')
        await evaluate(page, 'missingTargetProof', '1,0,1,0')
        await evaluate(page, 'paints+","+int(source.callOnPaint)', '1,0')
      } finally {
        await stop()
      }
    })

    test(`${mode}: piledCopy preserves source mapping and the destination clip captured before onPaint`, async ({
      page,
    }, testInfo) => {
      const stop = await launch(
        page,
        backend,
        binary,
        String.raw`
function partialCopy(){
  target.setClip(1,0,2,2);source.setClip(0,0,0,0);
  target.imageModified=false;source.callOnPaint=true;
  target.piledCopy(0,-1,source,0,0,4,3);
  var proof=paints+","+int(source.callOnPaint)+","+int(target.imageModified);
  var pixels=[target.getMainPixel(1,0),target.getMaskPixel(1,0),target.getMainPixel(2,0),target.getMaskPixel(2,0)].join(",");
  var untouched=target.getMainPixel(0,0)==0x102030 && target.getMainPixel(3,0)==0x102030 && target.getMainPixel(1,1)==0x102030 && target.getMaskPixel(1,1)==85 && target.getProvincePixel(1,0)==37;
  return proof+"|"+pixels+"|"+int(untouched);
}
function reentrantCopy(){
  target.setClip(0,0,4,2);target.fillRect(0,0,4,2,0x55102030);target.setClip(1,0,2,1);
  source.onPaint=function(){paints++;global.target.setClip(0,0,0,0);};
  target.imageModified=false;source.callOnPaint=true;
  target.piledCopy(0,0,source,0,0,4,1);
  var proof=paints+","+target.clipWidth+","+target.clipHeight+","+int(target.imageModified);
  var pixels=[target.getMainPixel(0,0),target.getMainPixel(1,0),target.getMaskPixel(1,0),target.getMainPixel(2,0),target.getMaskPixel(2,0),target.getMainPixel(3,0)].join(",");
  return proof+"|"+pixels;
}
function showCopied(){target.type=ltOpaque;target.visible=true;return 0;}
`,
      )
      try {
        // Both phases, including onPaint functions, are compiled in bytecode mode.
        await evaluate(page, 'partialCopy()', '1,0,1|131073,102,196609,103|1')
        await evaluate(page, 'reentrantCopy()', '2,0,0,1|1056816,131072,101,196608,102,1056816')
        await evaluate(page, 'showCopied()', '0')
        const canvas = page.locator('canvas')
        await expect(canvas).toHaveJSProperty('width', 4)
        await expect(canvas).toHaveJSProperty('height', 2)
        await canvas.evaluate((node) => {
          const surface = node as HTMLCanvasElement
          surface.style.width = '192px'
          surface.style.height = '96px'
          surface.style.imageRendering = 'pixelated'
        })
        await testInfo.attach('piled-copy-captured-clip', {
          body: await canvas.screenshot(),
          contentType: 'image/png',
        })
      } finally {
        await stop()
      }
    })
  }
}
