import { test, expect, type Page } from '@playwright/test'
import { tlgFixture, tlgSds, tlgTags, tlgU32 } from '../helpers/tlg-fixtures.ts'

async function evaluate(page: Page, source: string, value: string) {
  await page.locator('#expression').fill(source)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs p span').last()).toHaveText(value)
}
async function sample(page: Page) {
  const image = await page.locator('canvas').screenshot()
  return page.evaluate(
    async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = canvas.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const result = [1, 6].map((x) => [
        ...context.getImageData(
          Math.floor(((x + 0.5) * bitmap.width) / 8),
          Math.floor(bitmap.height / 2),
          1,
          1,
        ).data,
      ])
      bitmap.close()
      return result
    },
    'data:image/png;base64,' + image.toString('base64'),
  )
}

// A large all-zero RGBA image: literal filter codes, then one zero run of
// 32768 residuals per plane/group. Small input exercises expansion and stopping.
const large = Buffer.concat([
  Buffer.from('TLG6.0\x00raw\x1a'),
  Buffer.from([4, 0, 0, 0]),
  tlgU32(4096),
  tlgU32(4096),
  tlgU32(32),
  tlgU32(((512 * 512) / 8) * 9),
  Buffer.alloc(((512 * 512) / 8) * 9),
  ...Array.from({ length: 512 * 4 }, () => Buffer.from([32, 0, 0, 0, 0, 0, 1, 0])),
])

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: TLG images, SDS tags, alpha and grayscale transition rules render correctly`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles([
      {
        name: 'five.tlg5',
        mimeType: 'application/octet-stream',
        buffer: tlgFixture('5-3-solid-17x9-auto'),
      },
      {
        name: 'six.tlg',
        mimeType: 'application/octet-stream',
        buffer: tlgSds(tlgFixture('6-4-solid-17x9-auto'), [
          [
            'tags',
            tlgTags([
              ['LEFT', '20'],
              ['题😀', 'あ,=:文😀'],
            ]),
          ],
        ]),
      },
      {
        name: 'rule.tlg6',
        mimeType: 'application/octet-stream',
        buffer: tlgFixture('6-1-gradient-17x1-auto'),
      },
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(String.raw`
var window=new Window();window.visible=true;window.setInnerSize(8,4);
var root=new Layer(window,null),five=new Layer(window,root),six=new Layer(window,root),back=new Layer(window,root),saved=new Layer(window,root);
root.setSize(8,4);root.fillRect(0,0,8,4,0xff000000);
five.loadImages("five");five.setSize(4,4);five.visible=true;
var tags=six.loadImages("six");six.setPos(4,0);six.setSize(4,4);six.visible=true;
six.saveLayerImage("savedata/tlg.bmp");saved.loadImages("savedata/tlg.bmp");
Debug.message("tlg-ready:"+string(tags.LEFT=="20" && tags["题😀"]=="あ,=:文😀" && saved.getMainPixel(16,8)==0xca3511 && saved.getMaskPixel(16,8)==128));
var tick=0,completed=0;five.onTransitionCompleted=function(dest,src){completed++;};
`),
      },
    ])
    await expect(page.locator('#logs')).toContainText('tlg-ready:1')
    await expect(page.locator('canvas')).toHaveJSProperty('width', 8)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 4)
    await page.locator('canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      canvas.style.width = `${canvas.width * 16}px`
      canvas.style.height = `${canvas.height * 16}px`
      canvas.style.imageRendering = 'pixelated'
    })
    expect(await sample(page)).toEqual([
      [202, 53, 17, 255],
      [101, 27, 9, 255],
    ])
    await evaluate(
      page,
      '(function(){six.visible=false;five.setImageSize(8,4);five.setSize(8,4);five.fillRect(0,0,8,4,0xffff0000);back.setImageSize(8,4);back.setSize(8,4);back.fillRect(0,0,8,4,0xff0000ff);five.beginTransition("universal",false,back,%[rule:"rule",vague:0,time:1000,selfupdate:true,callback:function(){return tick;}]);return 0;})()',
      '0',
    )
    await evaluate(page, '(function(){tick=50;five.update();return 0;})()', '0')
    expect(await sample(page)).toEqual([
      [0, 0, 255, 255],
      [255, 0, 0, 255],
    ])
    await evaluate(page, '(function(){tick=1000;five.update();return 0;})()', '0')
    await evaluate(page, 'completed', '1')
    expect(await sample(page)).toEqual([
      [0, 0, 255, 255],
      [0, 0, 255, 255],
    ])
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })

  test(`${backend}: stopping during TLG expansion cancels without terminating the worker`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor(input: string | URL, options?: WorkerOptions) {
          const url = new URL(input, location.href)
          if (url.pathname.includes('/assets/session.worker-'))
            url.searchParams.set('tlg-stop-test', crypto.randomUUID())
          super(url, options)
        }
      }
    })
    await page.route('**/assets/session.worker-*.js*', async (route) => {
      const response = await route.fetch()
      const gate = `(() => {
        const state = self.__tlgStop = { allocated: false, held: false };
        const Bytes = self.Uint8Array, schedule = self.setTimeout.bind(self);
        let release;
        self.Uint8Array = new Proxy(Bytes, {
          construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget);
            if (args[0] === 4096 * 4096 * 4) state.allocated = true;
            return value;
          }
        });
        self.setTimeout = (callback, delay, ...args) => {
          if (state.allocated && !state.held && delay === 0 && typeof callback === 'function') {
            return schedule(() => {
              state.held = true;
              release = () => callback(...args);
            }, delay);
          }
          return schedule(callback, delay, ...args);
        };
        self.addEventListener('message', event => {
          const request = event.data;
          if (request?.type === 'APPLY' && request.argumentList?.[0]?.value === 'stop') {
            // Run after the real RPC listener has cancelled the execution control.
            schedule(() => { const resume = release; release = undefined; resume?.(); }, 0);
          }
        });
      })();`
      await route.fulfill({
        response,
        headers: { ...response.headers(), 'cache-control': 'no-store' },
        body: gate + '\n' + (await response.text()),
      })
    })
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles([
      { name: 'large.tlg', mimeType: 'application/octet-stream', buffer: large },
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'var window=new Window(),root=new Layer(window,null);Debug.message("tlg-start");root.loadImages("large");Debug.message("tlg-finished");',
        ),
      },
    ])
    await expect(page.locator('#logs')).toContainText('tlg-start')
    await expect
      .poll(() => page.workers().some((worker) => worker.url().includes('/assets/session.worker-')))
      .toBe(true)
    const worker = page
      .workers()
      .find((worker) => worker.url().includes('/assets/session.worker-'))!
    await expect
      .poll(() => worker.evaluate(() => Reflect.get(globalThis, '__tlgStop').held))
      .toBe(true)
    expect(await worker.evaluate(() => Reflect.get(globalThis, '__tlgStop').allocated)).toBe(true)
    await expect(page.locator('#logs')).not.toContainText('tlg-finished')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('tlg-finished')
  })
}
