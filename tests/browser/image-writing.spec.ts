import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { decodeTlg } from '../../src/formats/image/tlg/index.ts'
function finish<T>(work: Generator<void, T>): T {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
async function pixels(page: Page) {
  await expect(page.locator('canvas')).toHaveJSProperty('width', 12)
  await expect(page.locator('canvas')).toHaveJSProperty('height', 2)
  await page.locator('canvas').evaluate((node) => {
    const c = node as HTMLCanvasElement
    c.style.width = '384px'
    c.style.height = '64px'
    c.style.imageRendering = 'pixelated'
  })
  const screenshot = await page.locator('canvas').screenshot()
  return page.evaluate(
    async (url) => {
      const image = await createImageBitmap(await (await fetch(url)).blob()),
        canvas = new OffscreenCanvas(image.width, image.height),
        context = canvas.getContext('2d')!
      context.drawImage(image, 0, 0)
      const result = Array.from({ length: 12 }, (_, x) => [
        ...context.getImageData(
          Math.floor(((x + 0.5) * image.width) / 12),
          Math.floor(image.height / 4),
          1,
          1,
        ).data,
      ])
      image.close()
      return result
    },
    'data:image/png;base64,' + screenshot.toString('base64'),
  )
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: PNG and TLG image files preserve pixels, tags, exports and reloads`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const file = {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(String.raw`
var window=new Window();window.visible=true;window.setInnerSize(12,2);
var root=new Layer(window,null),source=new Layer(window,root);root.setSize(12,2);root.fillRect(0,0,12,2,0xff000000);
source.setImageSize(2,2);source.fillRect(0,0,1,1,0x00c86432);source.fillRect(1,0,1,1,0x800000ff);source.fillRect(0,1,1,1,0xff00ff00);source.fillRect(1,1,1,1,0x49ff0000);source.type=ltAddAlpha;source.setClip(1,0,1,2);
var existing=Storages.isExistentStorage("savedata/encoded-png.img"),formats=["png","png24","tlg5","tlg524","tlg6","tlg624"],loaded=[],ok=true;
for(var i=0;i<formats.count;i++){
 var format=formats[i],path="savedata/encoded-"+format+".img";if(!existing)source.saveLayerImage(path,format);
 var layer=new Layer(window,root),tags=layer.loadImages(path);layer.setSize(2,2);layer.setPos(i*2,0);layer.visible=true;loaded.add(layer);
 ok=ok && layer.getMainPixel(0,0)==0xc86432 && layer.getMainPixel(1,0)==0xff && (i%2?layer.getMaskPixel(1,0)==255:layer.getMaskPixel(1,0)==128) && (i<2?tags===null:tags.mode=="addalpha");
}
Debug.message("saved-ready:"+string(existing)+":"+string(ok));
`),
    }
    await page.locator('#files').setInputFiles(file)
    await expect(page.locator('#logs')).toContainText('saved-ready:0:1')
    const expected = Array.from({ length: 3 }, () => [
      [0, 0, 0, 255],
      [0, 0, 128, 255],
      [200, 100, 50, 255],
      [0, 0, 255, 255],
    ]).flat()
    expect(await pixels(page)).toEqual(expected)
    await expect(page.locator('#save-status')).toContainText('6 个存档文件，已保存')
    const waiting = page.waitForEvent('download')
    await page.locator('#export-saves').click()
    const download = await waiting,
      backup = JSON.parse(await readFile((await download.path())!, 'utf8')) as {
        files: { path: string; base64: string }[]
      }
    expect(backup.files).toHaveLength(6)
    for (const file of backup.files) {
      const bytes = Buffer.from(file.base64, 'base64'),
        opaque = /24\.img$/.test(file.path)
      if (file.path.includes('-tlg')) {
        const image = finish(decodeTlg(bytes)!)
        expect([...image.data.subarray(0, 8)]).toEqual([
          200,
          100,
          50,
          opaque ? 255 : 0,
          0,
          0,
          255,
          opaque ? 255 : 128,
        ])
        expect(image.metadata!.get('mode')).toBe('addalpha')
      } else {
        const values = await page.evaluate(async (base64) => {
          const image = await createImageBitmap(
              await (await fetch('data:image/png;base64,' + base64)).blob(),
            ),
            canvas = new OffscreenCanvas(2, 2),
            context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          image.close()
          return [...context.getImageData(0, 0, 2, 1).data]
        }, file.base64)
        expect(values).toEqual(
          opaque ? [200, 100, 50, 255, 0, 0, 255, 255] : [0, 0, 0, 0, 0, 0, 255, 128],
        )
      }
    }
    await page.reload()
    await page.locator('#files').setInputFiles(file)
    await expect(page.locator('#logs')).toContainText('saved-ready:1:1')
    expect(await pixels(page)).toEqual(expected)
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })
  for (const format of ['png', 'tlg5', 'tlg6'])
    test(`${backend}: prompt Stop after the ${format} encoding announcement discards unfinished output`, async ({
      page,
    }) => {
      await page.goto(`/?backend=${backend}`)
      test.skip(
        backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
        'JSPI unavailable',
      )
      // Match image-loading's observer: avoid a Playwright round trip and
      // actionability wait after a short-lived operation announces itself.
      // This orders the actual button handler; it is not an encoder-entry gate.
      await page.evaluate(() => {
        const logs = document.querySelector('#logs')!,
          button = document.querySelector('#stop') as HTMLButtonElement,
          seen = new Set<Element>(),
          report: { events: { kind: string; time: number }[]; enabledAtClick?: boolean } = {
            events: [],
          }
        Object.assign(window, { __imageWritingStop: report })
        let scheduled = false
        const collect = () => {
          for (const paragraph of logs.querySelectorAll('p')) {
            if (seen.has(paragraph)) continue
            seen.add(paragraph)
            const text = paragraph.querySelector('span')?.textContent
            if (text !== 'encode-start' && text !== 'encode-finished') continue
            report.events.push({ kind: text, time: performance.now() })
            if (text === 'encode-start' && !scheduled) {
              scheduled = true
              setTimeout(() => {
                collect()
                button.click()
              }, 0)
            }
          }
        }
        button.addEventListener(
          'click',
          () => {
            collect()
            report.enabledAtClick = !button.disabled
            report.events.push({ kind: 'stop-click', time: performance.now() })
          },
          { capture: true, once: true },
        )
        const observer = new MutationObserver(collect)
        observer.observe(logs, { childList: true, subtree: true, characterData: true })
      })
      const observation = () =>
        page.evaluate(
          () =>
            (
              window as unknown as {
                __imageWritingStop: {
                  events: { kind: string; time: number }[]
                  enabledAtClick?: boolean
                }
              }
            ).__imageWritingStop,
        )
      try {
        await page.locator('#files').setInputFiles({
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            `var window=new Window(),layer=new Layer(window,null);layer.setImageSize(4096,4096);layer.fillRect(0,0,4096,4096,0x80123456);Debug.message("encode-start");layer.saveLayerImage("savedata/pending.img","${format}");Debug.message("encode-finished");`,
          ),
        })
        await expect(page.locator('#logs')).toContainText('encode-start')
        await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
        await expect(page.locator('#logs')).not.toContainText('encode-finished')
        const report = await observation()
        expect(report.enabledAtClick).toBe(true)
        expect(report.events.map((event) => event.kind)).toEqual(['encode-start', 'stop-click'])
        expect(report.events[1]!.time).toBeGreaterThanOrEqual(report.events[0]!.time)
      } finally {
        await test.info().attach('image-stop-order', {
          body: Buffer.from(JSON.stringify(await observation(), null, 2)),
          contentType: 'application/json',
        })
      }
    })
}
