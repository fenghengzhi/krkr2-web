import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { transformWithOxc } from 'vite'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: vertical game faces select forms and preserve their glyph origins in the real Worker`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page
      .locator('#files')
      .setInputFiles([
        {
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'var w=new Window(),a=new Layer(w,null);w.visible=true;w.setInnerSize(64,128);a.setSize(64,128);a.type=ltAlpha;a.font.getList(0);a.font.face="@Krkr Vertical vert";a.font.height=20;a.font.angle=2700;a.drawText(24,4,"漢A、（ぁ",0xffffff);Debug.message("vertical-worker-ready");',
          ),
        },
        ...(await Promise.all(
          ['vert', 'novmetrics'].map(async (name) => ({
            name: name + '.ttf',
            mimeType: 'font/ttf',
            buffer: await readFile('tests/fixtures/text-layout/' + name + '.ttf'),
          })),
        )),
      ])
    await expect(page.getByText('vertical-worker-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'a.font.getTextWidth("漢A")', '32')
    await evaluate(
      page,
      '[a.getMaskPixel(7,10),a.getMaskPixel(10,27),a.getMaskPixel(18,37),a.getMaskPixel(10,59),a.getMaskPixel(13,78)].join(",")',
      '255,255,255,255,255',
    )
    await evaluate(page, 'a.getMaskPixel(10,32)', '0')
    await evaluate(
      page,
      '(function(){var r=a.font.getGlyphDrawRect("漢");return [r.left,r.top,r.right,r.bottom].join(",");})()',
      '2,4,16,18',
    )
    await evaluate(
      page,
      '(function(){a.fillRect(0,0,64,128,0);a.font.face="@Krkr Vertical novmetrics";a.drawText(24,0,"漢",0xffffff);return [a.font.getTextWidth("漢"),a.getMaskPixel(7,4),a.getMaskPixel(7,2)].join(",");})()',
      '20,255,0',
    )
    await page.locator('#stop').click()
  })

test('a vertical browser face keeps ideographs upright and rotates Latin glyphs', async ({
  page,
}) => {
  const modules = new Set([
    'src/backends/text/browser/graphics.ts',
    'src/backends/text/browser/families.ts',
    'src/engine/graphics/font.ts',
    'src/engine/graphics/vertical.ts',
    'src/formats/font/vertical-data.ts',
    'src/formats/image/bmp.ts',
  ])
  await page.route('**/__vertical-test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/__vertical-test/'.length)
    if (!modules.has(path)) return route.fulfill({ status: 404 })
    await route.fulfill({
      contentType: 'text/javascript',
      body: (await transformWithOxc(await readFile(path, 'utf8'), path)).code,
    })
  })
  await page.goto('/')
  const bytes = [...(await readFile('tests/fixtures/text-layout/vert.ttf'))]
  const result = await page.evaluate(async (bytes) => {
    const code = `
import {BrowserGraphics} from '${location.origin}/__vertical-test/src/backends/text/browser/graphics.ts';
const box=p=>{let l=p.width,t=p.height,r=0,b=0;
 for(let y=0;y<p.height;y++)for(let x=0;x<p.width;x++)if(p.data[(y*p.width+x)*4+3]){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x+1);b=Math.max(b,y+1)}
 const alpha=[];for(let y=t;y<b;y++)for(let x=l;x<r;x++)alpha.push(p.data[(y*p.width+x)*4+3]);
 return {width:r-l,height:b-t,alpha};};
self.onmessage=async({data})=>{const backend=new BrowserGraphics();
 try{const loaded=await backend.loadFont(new Uint8Array(data)),font={height:20,face:loaded.face,angle:0,bold:false,italic:false,underline:false,strikeout:false};
 const draw=(ch,vertical,angle=vertical?2700:0)=>box(backend.text(ch,20,0xffffff,{...font,face:(vertical?'@':'')+font.face,angle}));
 postMessage({han:draw('漢',false),verticalHan:draw('漢',true),latin:draw('A',false,2700),verticalLatin:draw('A',true)});
 }catch(e){postMessage({error:String(e)})}finally{backend.dispose()}};`
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
      worker = new Worker(url, { type: 'module' })
    try {
      return await new Promise<{
        han: { width: number; height: number; alpha: number[] }
        verticalHan: { width: number; height: number; alpha: number[] }
        latin: { width: number; height: number; alpha: number[] }
        verticalLatin: { width: number; height: number; alpha: number[] }
        error?: string
      }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Vertical Worker timed out')), 12000)
        worker.onmessage = (e) => {
          clearTimeout(timer)
          resolve(e.data)
        }
        worker.onerror = (e) => {
          clearTimeout(timer)
          reject(new Error(e.message))
        }
        worker.postMessage(bytes)
      })
    } finally {
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  }, bytes)
  expect(result.error).toBeUndefined()
  expect(result.verticalHan).toEqual(result.han)
  // Rotated Canvas hinting is not the transpose of horizontal hinting. Compare
  // to the browser's real rotated non-vertical face, including every alpha byte.
  expect(result.verticalLatin).toEqual(result.latin)
  expect(result.verticalLatin.width).toBeGreaterThan(result.verticalLatin.height)
})
