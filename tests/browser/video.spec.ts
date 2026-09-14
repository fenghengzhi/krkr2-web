import { test, expect, type Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { evaluate } from '../helpers/browser-expression.ts'
async function waitForPlayback(page: Page, marker: string): Promise<void> {
  // Console editing may scroll the stage out of view. Playback tests observe a visible stage.
  await page.locator('canvas').scrollIntoViewIfNeeded()
  const activate = page.getByRole('button', { name: '播放视频', exact: true })
  await expect(async () => {
    // play() may reject after the script has returned, exposing the gesture prompt later.
    if (await activate.isVisible()) await activate.click({ timeout: 500 })
    await expect(page.locator('#logs')).toContainText(marker, { timeout: 500 })
  }).toPass({ timeout: 12000 })
}
async function sample(page: Page, x: number, y: number) {
  const png = await page.locator('canvas').screenshot()
  return page.evaluate(
    async ({ url, x, y }) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
        ctx = canvas.getContext('2d')!
      ctx.drawImage(bitmap, 0, 0)
      const value = [
        ...ctx.getImageData(Math.floor(x * bitmap.width), Math.floor(y * bitmap.height), 1, 1).data,
      ]
      bitmap.close()
      return value
    },
    { url: 'data:image/png;base64,' + png.toString('base64'), x, y },
  )
}
for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: a delayed autoplay denial can be retried with the visible play button`, async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play
      let attempts = 0
      HTMLMediaElement.prototype.play = function () {
        if (this instanceof HTMLVideoElement) {
          document.documentElement.dataset.videoPlayAttempts = String(++attempts)
          if (attempts === 1)
            return new Promise<void>((_resolve, reject) =>
              setTimeout(
                () => reject(new DOMException('Delayed autoplay test denial', 'NotAllowedError')),
                250,
              ),
            )
        }
        return play.call(this)
      }
    })
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
          'var w=new Window();w.visible=true;w.setInnerSize(160,80);var root=new Layer(w,null);class Movie extends VideoOverlay {function Movie(w){super.VideoOverlay(w);}function onPeriod(reason){Debug.message("retry-period="+reason);}}var movie=new Movie(w);movie.visible=true;movie.open("colors.mp4");movie.setPeriodEvent(3);movie.play();Debug.message("retry-start");',
        ),
      },
      {
        name: 'colors.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      },
    ])
    await expect(page.locator('#logs')).toContainText('retry-start')
    await waitForPlayback(page, 'retry-period=1')
    expect(
      await page.locator('html').evaluate((el) => Number(el.dataset.videoPlayAttempts)),
    ).toBeGreaterThanOrEqual(2)
    await expect(page.getByRole('button', { name: '播放视频', exact: true })).toBeHidden()
    await page.locator('#stop').click()
  })
for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: video frames reach two layers with seeking, prepare, period and shutdown`, async ({
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
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(String.raw`
var window=new Window();window.setInnerSize(160,60);window.visible=true;
var root=new Layer(window,null);root.setSize(160,60);root.fillRect(0,0,160,60,0xff000000);
var left=new Layer(window,root);left.visible=true;
var right=new Layer(window,root);right.visible=true;right.left=80;
var states="",periods="",updates=0;
class Video extends VideoOverlay {
  function Video(window){super.VideoOverlay(window);}
  function onStatusChanged(status){states+=status+",";Debug.message("video-status="+status);}
  function onPeriod(reason){periods+=reason+",";Debug.message("video-period="+reason);}
  function onFrameUpdate(frame){updates++;}
}
var movie=new Video(window);movie.mode=vomLayer;movie.layer1=left;movie.layer2=right;
movie.open("colors.mp4");movie.prepare();
Debug.message("video-ready="+movie.originalWidth+","+movie.originalHeight+","+movie.numberOfFrame+","+movie.totalTime);
`),
      },
      {
        name: 'colors.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      },
    ])
    await expect(page.locator('#logs')).toContainText('video-ready=64,48,18,1500')
    await expect(page.locator('#logs')).toContainText('video-period=2')
    await expect(page.locator('#evaluate')).toBeEnabled()
    let color = await sample(page, 0.2, 0.4)
    expect(color[0]).toBeGreaterThan(220)
    expect(color[1]).toBeLessThan(30)
    await evaluate(page, '(function(){movie.frame=12;return movie.frame;})()', '12')
    for (const x of [0.2, 0.7]) {
      color = await sample(page, x, 0.4)
      expect(color[2]).toBeGreaterThan(220)
      expect(color[0]).toBeLessThan(30)
    }
    await evaluate(
      page,
      '(function(){movie.rewind();movie.setPeriodEvent(6);movie.play();return movie.status;})()',
      'play',
    )
    await waitForPlayback(page, 'video-period=1')
    await expect(page.locator('#logs')).toContainText('video-status=stop')
    await evaluate(page, 'updates>3', '1')
    await page.locator('#stop').click()
    await expect(page.locator('video')).toHaveCount(0)
    await expect(page.locator('.video-plane')).toHaveCount(0)
    expect(errors).toEqual([])
  })

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: overlay geometry, mixer alpha, segment loops and movie audio`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(String.raw`
var window=new Window();window.setInnerSize(160,80);window.visible=true;
var root=new Layer(window,null);root.setSize(160,80);root.fillRect(0,0,160,80,0xff0000ff);
class Movie extends VideoOverlay {
  function Movie(window){super.VideoOverlay(window);}
  function onPeriod(reason){Debug.message("overlay-period="+reason);}
}
var movie=new Movie(window);movie.mode=vomMixer;movie.visible=true;movie.setBounds(20,10,64,48);
movie.open("colors-sound.mp4");movie.frame=6;movie.mixingMovieBGColor=0xff0000;movie.mixingMovieAlpha=.5;
movie.audioVolume=50000;movie.audioBalance=-100000;Debug.message("overlay-ready="+movie.numberOfAudioStream);
`),
      },
      {
        name: 'colors-sound.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)),
      },
    ])
    await expect(page.locator('#logs')).toContainText('overlay-ready=1')
    await expect(page.locator('#evaluate')).toBeEnabled()
    const video = page.locator('video'),
      bounds = await video.boundingBox(),
      canvas = await page.locator('canvas').boundingBox()
    expect(bounds!.width / canvas!.width).toBeCloseTo(0.4, 2)
    expect((bounds!.x - canvas!.x) / canvas!.width).toBeCloseTo(0.125, 2)
    const png = await video.screenshot()
    const pixel = await page.evaluate(
      async (url) => {
        const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
          surface = new OffscreenCanvas(bitmap.width, bitmap.height),
          context = surface.getContext('2d')!
        context.drawImage(bitmap, 0, 0)
        return [
          ...context.getImageData(Math.floor(bitmap.width / 2), Math.floor(bitmap.height / 2), 1, 1)
            .data,
        ]
      },
      'data:image/png;base64,' + png.toString('base64'),
    )
    expect(pixel[0]).toBeGreaterThan(100)
    expect(pixel[1]).toBeGreaterThan(100)
    expect(pixel[2]).toBeLessThan(30)
    await evaluate(page, '(function(){window.setZoom(2,1);return window.zoomNumer;})()', '2')
    expect(
      (await video.boundingBox())!.width / (await page.locator('canvas').boundingBox())!.width,
    ).toBeCloseTo(0.8, 2)
    await evaluate(page, '(function(){movie.visible=false;return movie.visible;})()', '0')
    await expect(video).toBeHidden()
    await evaluate(
      page,
      '(function(){movie.visible=true;movie.setSegmentLoop(6,12);movie.setPeriodEvent(8);movie.play();return movie.status;})()',
      'play',
    )
    if ((await page.locator('#sound-toggle').textContent()) === '开启声音')
      await page.locator('#sound-toggle').click()
    await waitForPlayback(page, 'overlay-period=3')
    await expect(page.locator('#logs')).toContainText('overlay-period=1')
    await expect
      .poll(() =>
        page.locator('#sound-level').evaluate((el) => Number((el as HTMLElement).dataset.maxPeak)),
      )
      .toBeGreaterThan(0.02)
    await page.locator('#pause').click()
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(true)
    await page.locator('#pause').click()
    await expect.poll(() => video.evaluate((el) => (el as HTMLVideoElement).paused)).toBe(false)
    await page.locator('#stop').click()
    await expect(video).toHaveCount(0)
    await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
  })

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: stop aborts a pending video load and revokes its source`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const active = new Set<string>(),
        create = URL.createObjectURL,
        revoke = URL.revokeObjectURL
      URL.createObjectURL = (blob) => {
        const url = create(blob)
        active.add(url)
        return url
      }
      URL.revokeObjectURL = (url) => {
        active.delete(url)
        revoke(url)
      }
      Object.defineProperty(window, 'testVideoUrls', { get: () => active.size })
      // Fault injection: decoding may finish, but its readiness notification is
      // withheld, keeping the real host request pending until cancel aborts it.
      const add = HTMLMediaElement.prototype.addEventListener
      Object.defineProperty(HTMLMediaElement.prototype, 'addEventListener', {
        value: function (
          this: HTMLMediaElement,
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) {
          if (type === 'loadeddata') return
          add.call(this, type, listener, options)
        },
      })
    })
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
          'var window=new Window();var movie=new VideoOverlay(window);movie.open("colors.mp4");Debug.message("unexpected-open-complete");',
        ),
      },
      {
        name: 'colors.mp4',
        mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      },
    ])
    await expect(page.locator('video')).toHaveCount(1)
    expect(await page.evaluate(() => Reflect.get(window, 'testVideoUrls'))).toBe(1)
    await page.locator('#stop').click()
    await expect(page.locator('video')).toHaveCount(0)
    await expect(page.locator('.video-plane')).toHaveCount(0)
    expect(await page.evaluate(() => Reflect.get(window, 'testVideoUrls'))).toBe(0)
    await expect(page.locator('#logs')).not.toContainText('unexpected-open-complete')
    await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
    expect(errors).toEqual([])
  })
