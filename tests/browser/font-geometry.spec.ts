import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { transformWithOxc } from 'vite'
import { evaluate } from '../helpers/browser-expression.ts'

test('Worker font coordinates match all 25200 native reference vectors', async ({ page }) => {
  const source = await readFile('src/engine/graphics/font.ts', 'utf8'),
    compiled = await transformWithOxc(source, 'font.ts')
  const { coordinates } = JSON.parse(
    await readFile('tests/fixtures/font-geometry/reference.json', 'utf8'),
  ) as { coordinates: number[][] }
  await page.route('**/__geometry-module.js', (route) =>
    route.fulfill({ contentType: 'application/javascript', body: compiled.code }),
  )
  await page.route('**/__geometry-worker.js', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
import {fontGeometry} from '/__geometry-module.js';
self.onmessage=({data})=>{const differences=[];for(const row of data){const [angle,ascent,width,...expected]=row,g=fontGeometry(angle,ascent),a=g.advance(width),actual=[g.ascentX,g.ascentY,a.x,a.y];if(actual.some((v,i)=>v!==expected[i])){differences.push({angle,ascent,width,actual,expected});if(differences.length>=10)break;}}postMessage({cases:data.length,differences});};
`,
    }),
  )
  await page.goto('/')
  const report = await page.evaluate(
    (rows) =>
      new Promise((resolve, reject) => {
        const worker = new Worker('/__geometry-worker.js', { type: 'module' }),
          timer = setTimeout(() => {
            worker.terminate()
            reject(new Error('Geometry worker timed out'))
          }, 12000)
        worker.onmessage = ({ data }) => {
          clearTimeout(timer)
          worker.terminate()
          resolve(data)
        }
        worker.onerror = (event) => {
          clearTimeout(timer)
          worker.terminate()
          reject(new Error(event.message))
        }
        worker.postMessage(rows)
      }),
    coordinates,
  )
  expect(report).toEqual({ cases: 25200, differences: [] })
})

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: glyph bounds, Rect values and rotated pre-rendered pixels work in the game Worker`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
var w=new Window();w.visible=true;w.setInnerSize(128,64);var a=new Layer(w,null);a.setSize(128,64);a.type=ltAlpha;
a.font.height=20;a.font.face="narrow.ttf";a.font.faceIsFileName=true;
function describeRect(r){return [r.left,r.top,r.right,r.bottom].join(",");}
var measured=a.font.getGlyphDrawRect("AV");
a.drawText(0,0,"AV",0xffffff);
a.font.angle=300;a.font.mapPrerenderedFont("coverage-v1.tft");a.drawText(40,20,"A",0x123456);
Debug.message("glyph-ready");
`),
      },
      ...(await Promise.all(
        ['narrow.ttf', 'wide.ttf', 'coverage-v1.tft'].map(async (name) => ({
          name,
          mimeType: 'application/octet-stream',
          buffer: await readFile(`tests/fixtures/font/${name}`),
        })),
      )),
    ])
    await expect(page.getByText('glyph-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'describeRect(measured)', '0,2,18,16')
    await evaluate(page, 'a.font.getTextWidth("A")+":"+a.font.getGlyphDrawRect("A").width', '4:8')
    await evaluate(page, 'describeRect(a.font.getGlyphDrawRect(" A "))', '0,2,14,16')
    await evaluate(page, 'describeRect(a.font.getGlyphDrawRect(" "))', '0,16,0,16')
    await evaluate(page, 'describeRect(a.font.getGlyphDrawRect(""))', '0,0,0,0')
    await evaluate(
      page,
      '(function(){var copy=new Rect(measured);copy.addOffset(2,3);copy.clip(new Rect(3,4,10,11));return (copy instanceof "Rect")+":"+describeRect(copy)+":"+describeRect(measured);})()',
      '1:3,5,10,11:0,2,18,16',
    )
    await evaluate(page, 'a.getMaskPixel(50,32)+","+a.getMaskPixel(47,32)', '255,0')
    const canvas = page.locator('canvas')
    await expect(canvas).toHaveJSProperty('width', 128)
    await expect(canvas).toHaveJSProperty('height', 64)
    await canvas.evaluate((element) => {
      element.style.width = '128px'
      element.style.height = '64px'
    })
    await canvas.scrollIntoViewIfNeeded()
    await canvas.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      element.style.translate = `${Math.ceil(rect.left) - rect.left}px ${Math.ceil(rect.top) - rect.top}px`
      element.style.imageRendering = 'pixelated'
    })
    const shot = await canvas.screenshot()
    const pixel = await page.evaluate(
      async (url) => {
        const image = await createImageBitmap(await (await fetch(url)).blob()),
          surface = new OffscreenCanvas(image.width, image.height),
          ctx = surface.getContext('2d')!
        ctx.drawImage(image, 0, 0)
        image.close()
        return [
          ...ctx.getImageData(
            Math.floor((50.5 * surface.width) / 128),
            Math.floor((32.5 * surface.height) / 64),
            1,
            1,
          ).data,
        ]
      },
      'data:image/png;base64,' + shot.toString('base64'),
    )
    expect(pixel).toEqual([18, 52, 86, 255])
    await evaluate(
      page,
      '(function(){a.font.angle=2700;return describeRect(a.font.getGlyphDrawRect("AV"));})()',
      '0,2,18,16',
    )
    await evaluate(
      page,
      '(function(){a.font.face="wide.ttf";return describeRect(a.font.getGlyphDrawRect("AV"));})()',
      '0,2,26,16',
    )
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })
