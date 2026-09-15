import { test, expect, type Page } from '@playwright/test'
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
        surface = new OffscreenCanvas(bitmap.width, bitmap.height),
        context = surface.getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const values = [
        [1, 1],
        [2, 1],
        [4, 1],
        [5, 1],
      ].map(([x, y]) => [
        ...context.getImageData(
          Math.floor(((x! + 0.5) * bitmap.width) / 8),
          Math.floor(((y! + 0.5) * bitmap.height) / 4),
          1,
          1,
        ).data,
      ])
      bitmap.close()
      return values
    },
    'data:image/png;base64,' + image.toString('base64'),
  )
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: box blur, alpha conversion, grayscale and whole-image flip render consistently`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(String.raw`
var window=new Window();window.visible=true;window.setInnerSize(8,4);
var root=new Layer(window,null),blurred=new Layer(window,root),gray=new Layer(window,root),saved=new Layer(window,root);
root.setSize(8,4);root.fillRect(0,0,8,4,0xff000000);
blurred.setImageSize(2,2);blurred.setPos(1,1);blurred.visible=true;blurred.fillRect(0,0,1,2,0x00ff0000);blurred.fillRect(1,0,1,2,0xff0000ff);
blurred.setProvincePixel(0,0,11);blurred.setProvincePixel(1,0,22);blurred.doBoxBlur(1,0);
blurred.saveLayerImage("savedata/blur.bmp");saved.loadImages("savedata/blur.bmp");
gray.setImageSize(2,2);gray.setPos(4,1);gray.visible=true;gray.fillRect(0,0,2,2,0xff00ff00);gray.setClip(0,0,1,2);gray.face=dfProvince;gray.doGrayScale();
Debug.message("processing-ready:"+string(saved.getMainPixel(0,0)==0xff && saved.getMaskPixel(0,0)==128 && blurred.getProvincePixel(0,0)==11));
`),
    })
    await expect(page.locator('#logs')).toContainText('processing-ready:1')
    await expect(page.locator('canvas')).toHaveJSProperty('width', 8)
    await expect(page.locator('canvas')).toHaveJSProperty('height', 4)
    // Isolate pixel output from the page's smooth CSS enlargement.
    await page.locator('canvas').evaluate((node) => {
      const canvas = node as HTMLCanvasElement
      canvas.style.width = `${canvas.width * 16}px`
      canvas.style.height = `${canvas.height * 16}px`
      canvas.style.imageRendering = 'pixelated'
    })
    expect(await sample(page)).toEqual([
      [0, 0, 128, 255],
      [0, 0, 128, 255],
      [182, 182, 182, 255],
      [0, 255, 0, 255],
    ])
    await evaluate(
      page,
      '(function(){blurred.type=ltAddAlpha;blurred.convertType(dfAlpha);gray.flipLR();return blurred.getMainPixel(0,0)==0x00007f && blurred.getMaskPixel(0,0)==128;})()',
      '1',
    )
    expect(await sample(page)).toEqual([
      [0, 0, 127, 255],
      [0, 0, 127, 255],
      [0, 255, 0, 255],
      [182, 182, 182, 255],
    ])
    await evaluate(
      page,
      '(function(){blurred.setClip(0,0,1,1);blurred.flipLR();return blurred.getProvincePixel(0,0)==22 && blurred.getProvincePixel(1,0)==11;})()',
      '1',
    )
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })

  test(`${backend}: a large box blur can stop without the Worker timeout fallback`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const NativeWorker = window.Worker
      window.Worker = class extends NativeWorker {
        constructor(input: string | URL, options?: WorkerOptions) {
          const url = new URL(input, location.href)
          if (url.pathname.includes('/assets/session.worker-'))
            url.searchParams.set('box-stop-test', crypto.randomUUID())
          super(url, options)
        }
      }
    })
    await page.route('**/assets/session.worker-*.js*', async (route) => {
      const response = await route.fetch()
      // Hold the real cooperative yield only after boxBlur has acquired its
      // column sums, four-channel accumulator and full-size output bitmap.
      // A log marker alone can reach Playwright after the operation finished.
      const gate = `(() => {
        const state = self.__boxBlurStop = { columns: 0, accumulator: 0, output: 0, selected: false, held: false };
        const schedule = self.setTimeout.bind(self);
        let release;
        self.Uint32Array = new Proxy(self.Uint32Array, {
          construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget);
            if (args[0] === 4096 * 4) state.columns = value.byteLength;
            return value;
          }
        });
        self.Float64Array = new Proxy(self.Float64Array, {
          construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget);
            if (state.columns && args[0] === 4) state.accumulator = value.byteLength;
            return value;
          }
        });
        self.Uint8Array = new Proxy(self.Uint8Array, {
          construct(target, args, newTarget) {
            const value = Reflect.construct(target, args, newTarget);
            if (state.accumulator && args[0] === 4096 * 4096 * 4) state.output = value.byteLength;
            return value;
          }
        });
        self.setTimeout = (callback, delay, ...args) => {
          if (state.output && !state.selected && delay === 0 && typeof callback === 'function') {
            state.selected = true;
            return schedule(() => { state.held = true; release = () => callback(...args); }, delay);
          }
          return schedule(callback, delay, ...args);
        };
        self.addEventListener('message', event => {
          const request = event.data;
          if (request?.type === 'APPLY' && request.argumentList?.[0]?.value === 'stop') {
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
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(String.raw`
var window=new Window(),root=new Layer(window,null);root.setImageSize(4096,4096);root.fillRect(0,0,4096,4096,0xff123456);
Debug.message("box-start");root.doBoxBlur(63,63);Debug.message("box-finished");
`),
    })
    await expect(page.locator('#logs')).toContainText('box-start')
    await expect
      .poll(() => page.workers().some((worker) => worker.url().includes('/assets/session.worker-')))
      .toBe(true)
    const worker = page
      .workers()
      .find((worker) => worker.url().includes('/assets/session.worker-'))!
    await expect
      .poll(() => worker.evaluate(() => Reflect.get(globalThis, '__boxBlurStop').held))
      .toBe(true)
    const observed = await worker.evaluate(() => Reflect.get(globalThis, '__boxBlurStop'))
    expect(observed).toEqual({
      columns: 65536,
      accumulator: 32,
      output: 67108864,
      selected: true,
      held: true,
    })
    await test
      .info()
      .attach('box-blur-cancellation', {
        body: Buffer.from(JSON.stringify(observed)),
        contentType: 'application/json',
      })
    await expect(page.locator('#logs')).not.toContainText('box-finished')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('box-finished')
  })
}
