import type { Locator, Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { evaluate } from '../helpers/browser-expression.ts'
import { test, expect } from '../helpers/video-presentation-browser.ts'

type Color = readonly [number, number, number]
type Sample = { x: number; y: number; color: Color }
const magenta: Color = [255, 0, 255]
const green: Color = [0, 255, 0]
const cyan: Color = [0, 255, 255]
const yellow: Color = [255, 255, 0]
const red: Color = [255, 0, 0]
const blue: Color = [0, 0, 255]

/** Observe the host's pre-load frame request. A second subscription started at
 * loadedmetadata can miss the only frame of a paused movie. No requests are added. */
async function observeMixingFrames(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const request = HTMLVideoElement.prototype.requestVideoFrameCallback
    HTMLVideoElement.prototype.requestVideoFrameCallback = function (callback) {
      const video = this
      return request.call(video, function (this: unknown, now, metadata) {
        video.dataset.presentedTime = String(metadata.mediaTime)
        video.dataset.presentedFrames = String(metadata.presentedFrames)
        callback.call(this, now, metadata)
      })
    }
  })
}

async function launch(page: Page, backend: string, source: string) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await observeMixingFrames(page)
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + '\nDebug.message("mixing-ready");'),
    },
    {
      name: 'colors.mp4',
      mimeType: 'video/mp4',
      buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
    },
  ])
  await expect(page.getByText('mixing-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  return async () => {
    if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('video')).toHaveCount(0)
    await expect(page.locator('.video-mixing-bitmap')).toHaveCount(0)
    await expect(page.locator('.video-plane')).toHaveCount(0)
    expect(errors).toEqual([])
  }
}

function surface(page: Page, caption: string) {
  const window = page.locator(`.game-window[data-window-id][aria-label="${caption}"]`)
  return {
    window,
    // The added bitmap canvas is not the engine's presented Window surface.
    canvas: window.locator('canvas[data-window-id]'),
    video: window.locator('video'),
    container: window.locator('video').locator('..'),
  }
}

async function ready(video: Locator) {
  await expect(video).toHaveAttribute('data-presented-time', '0')
  await expect(video).toHaveJSProperty('paused', true)
  await expect(video).toHaveJSProperty('seeking', false)
}

/** Wait for the actual output rectangle after the completed TJS operation.
 * Ratios remove the app's responsive stage scale without assuming CSS pixels. */
async function geometry(
  canvas: Locator,
  container: Locator,
  windowWidth: number,
  windowHeight: number,
  rect: { left: number; top: number; width: number; height: number },
) {
  await container.scrollIntoViewIfNeeded()
  await expect(async () => {
    const output = await container.boundingBox(),
      root = await canvas.boundingBox()
    expect(output).not.toBeNull()
    expect(root).not.toBeNull()
    expect(output!.width / root!.width).toBeCloseTo(rect.width / windowWidth, 2)
    expect(output!.height / root!.height).toBeCloseTo(rect.height / windowHeight, 2)
    expect((output!.x - root!.x) / root!.width).toBeCloseTo(rect.left / windowWidth, 2)
    expect((output!.y - root!.y) / root!.height).toBeCloseTo(rect.top / windowHeight, 2)
  }).toPass({ timeout: 12_000 })
}

/** Capture the composed Movie container, including the real decoded video,
 * background and sibling bitmap. Interior samples exclude VMR edge rounding. */
async function pixels(
  page: Page,
  container: Locator,
  label: string,
  width: number,
  height: number,
  samples: Sample[],
) {
  // Locator screenshots wait for the visible container's layout to be stable.
  const png = await container.screenshot()
  const actual = await page.evaluate(
    async ({ url, points }) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
      try {
        context.drawImage(bitmap, 0, 0)
        return points.map(([x, y]) => [
          ...context.getImageData(
            Math.floor(x! * bitmap.width),
            Math.floor(y! * bitmap.height),
            1,
            1,
          ).data,
        ])
      } finally {
        bitmap.close()
      }
    },
    {
      url: 'data:image/png;base64,' + png.toString('base64'),
      points: samples.map(({ x, y }) => [x / width, y / height]),
    },
  )
  await test.info().attach(label, { body: png, contentType: 'image/png' })
  await test.info().attach(label + '-pixels', {
    body: JSON.stringify({ width, height, samples, actual }),
    contentType: 'application/json',
  })
  for (let i = 0; i < samples.length; i++) {
    const expected = samples[i]!
    for (let channel = 0; channel < 3; channel++)
      expect(
        Math.abs(actual[i]![channel]! - expected.color[channel]!),
        `${label}: (${expected.x}, ${expected.y}), RGB channel ${channel}`,
      ).toBeLessThanOrEqual(12)
    expect(actual[i]![3]).toBe(255)
  }
}

const singleWindow = String.raw`
var w=new Window();w.caption="Mixing pixels";w.setInnerSize(400,220);w.visible=true;
var root=new Layer(w,null);root.type=ltOpaque;root.setSize(400,220);root.fillRect(0,0,400,220,0xff000000);
var parent=new Layer(w,root);parent.setPos(100,70);parent.opacity=0;parent.visible=false;
var source=new Layer(w,parent);source.type=ltAlpha;source.setSize(40,20);source.setImageSize(40,20);source.setPos(8,6);source.visible=true;
source.fillRect(0,0,40,20,0xffff00ff);
for(var y=0;y<20;y++)for(var x=0;x<20;x++)source.setMaskPixel(x,y,0);
var child=new Layer(w,source);child.setSize(40,20);child.fillRect(0,0,40,20,0xffffff00);child.visible=true;
source.setClip(15,8,2,2);
var movie=new VideoOverlay(w);movie.mode=vomMixer;movie.visible=true;movie.setBounds(20,10,160,100);movie.open("colors.mp4");
movie.setMixingLayer(source);
`

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}/source: mixer snapshots RGB independently of mask, children and movie alpha`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const stop = await launch(page, backend, singleWindow),
      f = surface(page, 'Mixing pixels')
    try {
      await ready(f.video)
      await geometry(f.canvas, f.container, 400, 220, {
        left: 20,
        top: 10,
        width: 160,
        height: 100,
      })
      const check = (label: string, color: Color) =>
        pixels(page, f.container, label, 160, 100, [
          { x: 16, y: 14, color },
          { x: 40, y: 14, color },
          { x: 100, y: 60, color: red },
        ])
      await check('zero-and-full-mask-snapshot', magenta)
      await evaluate(
        page,
        '[source.getMainPixel(8,8),source.getMaskPixel(8,8),source.getMaskPixel(30,8)].join(",")',
        '16711935,0,255',
      )
      await evaluate(
        page,
        '(function(){source.setClip();source.fillRect(0,0,40,20,0xff00ff00);source.setPos(90,60);source.setImageSize(28,12);source.visible=false;return 1;})()',
        '1',
      )
      await check('edits-move-resize-hide-do-not-update-snapshot', magenta)
      await evaluate(
        page,
        '(function(){source.setImageSize(40,20);source.setImagePos(0,0);source.setPos(8,6);source.setClip();source.fillRect(0,0,40,20,0xff00ff00);source.visible=true;source.opacity=128;movie.setMixingLayer(source);return 1;})()',
        '1',
      )
      await check('recapture-uses-only-own-half-opacity', [127, 128, 0])
      await evaluate(
        page,
        '(function(){movie.mixingMovieBGColor=0x0000ff;movie.mixingMovieAlpha=0;return movie.mixingMovieAlpha;})()',
        '+0.0',
      )
      await pixels(page, f.container, 'bitmap-above-zero-alpha-movie', 160, 100, [
        { x: 16, y: 14, color: [0, 128, 127] },
        { x: 40, y: 14, color: [0, 128, 127] },
        { x: 100, y: 60, color: blue },
      ])
      await evaluate(
        page,
        '(function(){source.opacity=0;movie.setMixingLayer(source);return 1;})()',
        '1',
      )
      await pixels(page, f.container, 'zero-layer-opacity', 160, 100, [
        { x: 16, y: 14, color: blue },
        { x: 40, y: 14, color: blue },
      ])
      await evaluate(
        page,
        '(function(){source.opacity=255;movie.setMixingLayer(source);invalidate source;return int(isvalid source);})()',
        '0',
      )
      await pixels(page, f.container, 'invalidated-layer-snapshot-survives', 160, 100, [
        { x: 16, y: 14, color: green },
        { x: 40, y: 14, color: green },
      ])
      await evaluate(
        page,
        '(function(){movie.resetMixingLayer();return movie.mixingMovieAlpha+","+movie.mixingMovieBGColor;})()',
        '+0.0,255',
      )
      await expect(f.container.locator('.video-mixing-bitmap')).toHaveCount(0)
      await pixels(page, f.container, 'reset-leaves-movie-background', 160, 100, [
        { x: 16, y: 14, color: blue },
        { x: 100, y: 60, color: blue },
      ])
    } finally {
      await stop()
    }
  })

  test(`${backend}/source: mixer geometry freezes output normalization through resize and Window zoom`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const stop = await launch(
      page,
      backend,
      String.raw`
var w=new Window();w.caption="Mixing geometry";w.setInnerSize(640,400);w.visible=true;
var root=new Layer(w,null);root.type=ltOpaque;root.setSize(640,400);root.fillRect(0,0,640,400,0xff000000);
var parent=new Layer(w,root);parent.setPos(170,90);parent.visible=false;
var source=new Layer(w,parent);source.setSize(30,16);source.setImageSize(40,24);source.fillRect(0,0,40,24,0xff00ff00);source.setPos(26,20);source.setImagePos(-6,-4);source.visible=true;source.setClip(0,0,1,1);
var movie=new VideoOverlay(w);movie.mode=vomMixer;movie.visible=true;movie.setBounds(20,14,120,80);movie.open("colors.mp4");movie.setMixingLayer(source);
`,
    )
    const f = surface(page, 'Mixing geometry')
    try {
      await ready(f.video)
      const layout = (left: number, top: number, width: number, height: number) =>
        geometry(f.canvas, f.container, 640, 400, { left, top, width, height })
      await layout(20, 14, 120, 80)
      await pixels(
        page,
        f.container,
        'image-offset-ignores-parent-clip-and-video-origin',
        120,
        80,
        [
          { x: 30, y: 24, color: green },
          { x: 10, y: 24, color: red },
          { x: 75, y: 24, color: red },
        ],
      )
      await evaluate(
        page,
        '(function(){movie.setSize(240,160);return movie.width+","+movie.height;})()',
        '240,160',
      )
      await layout(20, 14, 240, 160)
      await pixels(page, f.container, 'resize-scales-frozen-bitmap', 240, 160, [
        { x: 80, y: 50, color: green },
        { x: 30, y: 50, color: red },
        { x: 150, y: 50, color: red },
      ])
      await evaluate(page, '(function(){movie.setMixingLayer(source);return 1;})()', '1')
      await pixels(page, f.container, 'recapture-uses-current-output-size', 240, 160, [
        { x: 30, y: 24, color: green },
        { x: 80, y: 50, color: red },
      ])
      await evaluate(page, '(function(){w.setZoom(2,1);return w.zoomNumer;})()', '2')
      await layout(40, 28, 480, 320)
      await pixels(page, f.container, 'zoom-scales-frozen-bitmap', 480, 320, [
        { x: 60, y: 50, color: green },
        { x: 25, y: 25, color: red },
        { x: 150, y: 50, color: red },
      ])
      await evaluate(page, '(function(){movie.setMixingLayer(source);return 1;})()', '1')
      await pixels(page, f.container, 'recapture-includes-current-window-zoom', 480, 320, [
        { x: 30, y: 24, color: green },
        { x: 80, y: 50, color: red },
      ])
      await evaluate(
        page,
        '(function(){movie.setPos(60,30);return movie.left+","+movie.top;})()',
        '60,30',
      )
      await layout(120, 60, 480, 320)
      await pixels(page, f.container, 'move-preserves-video-relative-bitmap', 480, 320, [
        { x: 30, y: 24, color: green },
        { x: 80, y: 50, color: red },
      ])
      await evaluate(
        page,
        '(function(){source.setPos(-10,-8);source.setImagePos(0,0);movie.setMixingLayer(source);return 1;})()',
        '1',
      )
      await pixels(page, f.container, 'negative-bitmap-origin-clips-at-output', 480, 320, [
        { x: 8, y: 8, color: green },
        { x: 42, y: 8, color: red },
        { x: 8, y: 26, color: red },
      ])
      await evaluate(
        page,
        '(function(){source.setPos(26,20);source.setImagePos(-6,-4);movie.setBounds(1,1,241,161);w.setZoom(1,2);movie.setMixingLayer(source);return 1;})()',
        '1',
      )
      await f.container.scrollIntoViewIfNeeded()
      await expect(async () => {
        const output = await f.container.boundingBox(),
          root = await f.canvas.boundingBox()
        expect(output).not.toBeNull()
        expect(root).not.toBeNull()
        const actual = [
          ((output!.x - root!.x) * 640) / root!.width,
          ((output!.y - root!.y) * 400) / root!.height,
          (output!.width * 640) / root!.width,
          (output!.height * 400) / root!.height,
        ]
        for (const [index, expected] of [1, 1, 120, 80].entries())
          expect(
            Math.abs(actual[index]! - expected),
            `fractional zoom output rectangle component ${index}`,
          ).toBeLessThanOrEqual(0.1)
      }).toPass({ timeout: 12_000 })
      await pixels(page, f.container, 'fractional-zoom-rounds-each-output-edge', 120, 80, [
        { x: 30, y: 24, color: green },
        { x: 10, y: 24, color: red },
        { x: 75, y: 24, color: red },
      ])
    } finally {
      await stop()
    }
  })

  test(`${backend}/source: cross-Window snapshots outlive their source and reset on destination close or reopen`, async ({
    page,
  }) => {
    test.setTimeout(90_000)
    const stop = await launch(
      page,
      backend,
      String.raw`
System.exitOnWindowClose=false;
var a=new Window();a.caption="Mixing source";a.setInnerSize(240,160);a.visible=true;
var rootA=new Layer(a,null);rootA.type=ltOpaque;rootA.setSize(240,160);rootA.fillRect(0,0,240,160,0xff000000);
var source=new Layer(a,rootA);source.setSize(32,16);source.setImageSize(32,16);source.fillRect(0,0,32,16,0xffff00ff);source.setPos(4,4);source.visible=true;
var own=new Layer(a,rootA);own.setSize(32,16);own.setImageSize(32,16);own.fillRect(0,0,32,16,0xffffff00);own.setPos(4,4);own.visible=true;
var b=new Window();b.caption="Mixing destination";b.setInnerSize(360,200);b.setPos(280,0);b.visible=true;
var rootB=new Layer(b,null);rootB.type=ltOpaque;rootB.setSize(360,200);rootB.fillRect(0,0,360,200,0xff000000);
var movieA=new VideoOverlay(a);movieA.mode=vomMixer;movieA.visible=true;movieA.setBounds(10,10,128,80);movieA.open("colors.mp4");movieA.setMixingLayer(own);
var movieB=new VideoOverlay(b);movieB.mode=vomMixer;movieB.visible=true;movieB.setBounds(10,10,128,80);movieB.open("colors.mp4");movieB.setMixingLayer(source);
`,
    )
    const a = surface(page, 'Mixing source'),
      b = surface(page, 'Mixing destination')
    try {
      await ready(a.video)
      await ready(b.video)
      await geometry(a.canvas, a.container, 240, 160, {
        left: 10,
        top: 10,
        width: 128,
        height: 80,
      })
      await geometry(b.canvas, b.container, 360, 200, {
        left: 10,
        top: 10,
        width: 128,
        height: 80,
      })
      const check = (container: Locator, label: string, color: Color) =>
        pixels(page, container, label, 128, 80, [
          { x: 16, y: 12, color },
          { x: 70, y: 40, color: red },
        ])
      await check(a.container, 'first-movie-owned-bitmap', yellow)
      await check(b.container, 'second-movie-cross-window-bitmap', magenta)
      await evaluate(page, '(function(){movieA.resetMixingLayer();return 1;})()', '1')
      await check(a.container, 'reset-only-first-movie', red)
      await check(b.container, 'second-movie-unchanged-after-other-reset', magenta)
      await evaluate(
        page,
        '(function(){movieA.setMixingLayer(own);a.close();return int(isvalid a)+","+int(isvalid source);})()',
        '0,1',
      )
      await expect(a.window).toHaveCount(0)
      await expect(page.locator('video')).toHaveCount(1)
      await expect(page.locator('.video-mixing-bitmap')).toHaveCount(1)
      await check(b.container, 'source-window-retirement-keeps-destination-snapshot', magenta)
      await evaluate(
        page,
        '(function(){var detached=source.window===null,original=source.getMainPixel(8,8);invalidate source;return int(detached)+","+original+","+int(isvalid source);})()',
        '1,16711935,0',
      )
      await check(b.container, 'retired-window-source-invalidation-keeps-snapshot', magenta)
      await evaluate(
        page,
        '(function(){var hidden=new Layer(b,rootB);hidden.visible=false;hidden.hasImage=false;movieB.setMixingLayer(hidden);return 1;})()',
        '1',
      )
      await expect(b.container.locator('.video-mixing-bitmap')).toHaveCount(0)
      await check(b.container, 'hidden-no-image-layer-resets', red)
      await evaluate(
        page,
        '(function(){movieB.close();global.fresh=new Layer(b,rootB);fresh.setSize(32,16);fresh.setImageSize(32,16);fresh.fillRect(0,0,32,16,0xff00ffff);fresh.setPos(4,4);fresh.visible=true;movieB.setMixingLayer(fresh);return 1;})()',
        '1',
      )
      await expect(page.locator('video')).toHaveCount(0)
      await evaluate(page, '(function(){movieB.open("colors.mp4");return 1;})()', '1')
      await ready(b.video)
      await expect(b.container.locator('.video-mixing-bitmap')).toHaveCount(0)
      await check(b.container, 'unopened-set-does-not-cache-for-open', red)
      await evaluate(page, '(function(){movieB.setMixingLayer(fresh);return 1;})()', '1')
      await check(b.container, 'replacement-movie-new-bitmap', cyan)
      await evaluate(page, '(function(){movieB.setMixingLayer(null);return 1;})()', '1')
      await check(b.container, 'null-resets-current-bitmap', red)
      await evaluate(
        page,
        '(function(){movieB.setMixingLayer(fresh);movieB.open("colors.mp4");return 1;})()',
        '1',
      )
      await ready(b.video)
      await expect(b.container.locator('.video-mixing-bitmap')).toHaveCount(0)
      await check(b.container, 'reopen-discards-previous-bitmap', red)
      await evaluate(
        page,
        '(function(){movieB.setMixingLayer(fresh);b.close();return int(isvalid b);})()',
        '0',
      )
      await expect(b.window).toHaveCount(0)
      await expect(page.locator('video')).toHaveCount(0)
      await expect(page.locator('.video-mixing-bitmap')).toHaveCount(0)
    } finally {
      await stop()
    }
  })
}
