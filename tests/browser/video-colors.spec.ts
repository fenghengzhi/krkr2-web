import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect } from '@playwright/test'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

const stages = ['unopened', 'overlay', 'layer', 'mixer-default', 'saturation-zero',
  'brightness-up', 'contrast-half', 'hue-turn', 'background', 'reopened-default'] as const
const source = String.raw`
System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;
var colorWindow=new Window();colorWindow.caption="Movie color controls";colorWindow.setInnerSize(240,232);
var colorRoot=new Layer(colorWindow,null);colorRoot.setSize(240,232);colorRoot.holdAlpha=false;
colorRoot.fillRect(0,0,240,232,0xff182838);
var colorLayer=new Layer(colorWindow,colorRoot);colorLayer.setPos(20,10,64,48);colorLayer.visible=false;
var colorMixParent=new Layer(colorWindow,colorRoot);colorMixParent.visible=false;
var colorMix=new Layer(colorWindow,colorMixParent);colorMix.setSize(16,12);colorMix.setImageSize(16,12);
colorMix.setPos(8,8);colorMix.holdAlpha=false;colorMix.fillRect(0,0,16,12,0xffff00ff);colorMix.visible=true;
var colorMovie=new VideoOverlay(colorWindow),colorStage=0,colorStages=${JSON.stringify(stages)};
function colorValues(){return [int(colorMovie.brightness*1000),int(colorMovie.hue*1000),int(colorMovie.contrast*1000),int(colorMovie.saturation*1000)].join("|");}
function colorSet(brightness,hue,contrast,saturation){
 colorMovie.brightness=brightness;colorMovie.hue=hue;colorMovie.contrast=contrast;colorMovie.saturation=saturation;
}
function colorOpen(mode){
 colorMovie.close();colorMovie.mode=mode;colorMovie.setBounds(20,10,200,150);colorMovie.visible=true;
 colorLayer.visible=mode==vomLayer;colorMovie.layer1=colorLayer;
 colorMovie.open("movie.mp4");colorMovie.pause();colorMovie.frame=0;
 if(mode==vomMixer){
  colorMovie.mixingMovieBGColor=0x204060;colorMovie.mixingMovieAlpha=1;colorMovie.setMixingLayer(colorMix);
 }
}
function colorNext(){
 if(colorStage+1>=colorStages.count)return;
 global.colorStage++;
 if(colorStage==1){colorOpen(vomOverlay);colorSet(40,90,.5,0);}
 else if(colorStage==2){colorOpen(vomLayer);colorSet(40,90,.5,0);}
 else if(colorStage==3 || colorStage==9)colorOpen(vomMixer);
 else if(colorStage==4)colorSet(0,0,1,0);
 else if(colorStage==5)colorSet(40,0,1,1);
 else if(colorStage==6)colorSet(0,0,.5,1);
 else if(colorStage==7)colorSet(0,90,1,1);
 else if(colorStage==8){colorSet(40,90,.5,0);colorMovie.mixingMovieAlpha=0;}
 Debug.message("movie-color-stage:"+colorStages[colorStage]);
}
var colorButton=new Layer(colorWindow,colorRoot);colorButton.setPos(0,184,240,40);colorButton.holdAlpha=false;
colorButton.fillRect(0,0,240,40,0xff305878);colorButton.font.height=16;
colorButton.drawText(20,9,"Next movie color setting",0xffffff);colorButton.visible=true;
colorButton.onClick=function(){global.colorNext();};
colorSet(40,90,.5,0);colorWindow.visible=true;Debug.message("movie-color-stage:unopened");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: mixer movie color controls alter the paused picture without tinting its bitmap or background`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], readings: unknown[] = []
    let sequence = 0, baseline: number[] | undefined, rawBaseline: number[] | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await installVideoAudioProbe(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const window = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Movie color controls$/ }) }),
      canvas = window.locator('canvas[data-window-id]'), video = window.locator('video[data-video-id]'), container = video.locator('..')
    const read = async (expression: string) => {
      const prefix = `movie-color-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((text) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Movie color observer is unavailable')
        input.focus({ preventScroll: true }); input.value = text; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      return ((await line.textContent()) ?? '').slice(prefix.length)
    }
    const next = async () => {
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: box!.width / 2, y: box!.height * 204 / 232 }, timeout: 5000 })
    }
    const rawPixel = () => video.evaluate((node) => {
      const video = node as HTMLVideoElement
      if (video.readyState < 2 || !video.paused || video.seeking) throw new Error('Color controls require a settled paused frame')
      const surface = new OffscreenCanvas(video.videoWidth, video.videoHeight), context = surface.getContext('2d', { willReadFrequently: true })!
      context.drawImage(video, 0, 0)
      return { pixel: [...context.getImageData(48, 32, 1, 1).data], position: video.currentTime,
        width: video.videoWidth, height: video.videoHeight, paused: video.paused, seeking: video.seeking }
    })
    const near = (actual: readonly number[], expected: readonly number[], tolerance: number, label: string) => {
      for (let channel = 0; channel < 3; channel++)
        expect(Math.abs(actual[channel]! - expected[channel]!), `${label} RGB ${channel}`).toBeLessThanOrEqual(tolerance)
      expect(actual[3], label + ' alpha').toBe(255)
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("color-game.tjs",System.dataPath+"color-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"color-game.cjs");'
          : 'Scripts.execStorage("color-game.tjs");') },
        { name: 'color-game.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        // Its authored [32,64,96] background keeps a half-luma adjustment
        // away from clipping, unlike a saturated red test frame.
        { name: 'movie.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve('out/verification/video-tracks/numbered-multitrack.mp4')) },
      ])
      for (const [index, stage] of stages.entries()) {
        if (index) await next()
        await expect(page.getByText('movie-color-stage:' + stage, { exact: true })).toBeVisible({ timeout: 30000 })
        await expect(canvas).toBeVisible()
        const values = (await read('colorValues()')).split('|').map(Number), expected = index < 3 ? [-1000, -1000, -1000, -1000]
          : stage === 'saturation-zero' ? [0, 0, 1000, 0]
          : stage === 'brightness-up' ? [40000, 0, 1000, 1000]
          : stage === 'contrast-half' ? [0, 0, 500, 1000]
          : stage === 'hue-turn' ? [0, 90000, 1000, 1000]
          : stage === 'background' ? [40000, 90000, 500, 0] : [0, 0, 1000, 1000]
        expect(values, stage + ' public values').toEqual(expected)
        if (index === 0) { await expect(video).toHaveCount(0); readings.push({ stage, values }); continue }
        expect(await read('colorMovie.status+"|"+colorMovie.frame+"|"+colorMovie.position')).toBe('pause|0|0')
        const raw = await rawPixel()
        expect([raw.width, raw.height, raw.position, raw.paused, raw.seeking]).toEqual([64, 48, 0, true, false])
        if (!rawBaseline) rawBaseline = raw.pixel
        else expect(raw.pixel, stage + ' original decoded pixel').toEqual(rawBaseline)
        if (stage === 'layer') {
          const pixel = Number(await read('colorLayer.getMainPixel(48,32)'))
          near([pixel >>> 16, (pixel >>> 8) & 255, pixel & 255, 255], raw.pixel, 3, 'ordinary Layer')
          readings.push({ stage, values, raw, layerPixel: pixel }); continue
        }
        let screenshot: Buffer | undefined, screen: number[] = [], overlay: number[] = [], mixingGeometry: unknown
        const stageFailures: unknown[] = []
        try {
          await expect(async () => {
            if (index >= 3) {
              const bitmap = container.locator('canvas.video-mixing-bitmap'), captured = await bitmap.evaluate((node) => {
                const canvas = node as HTMLCanvasElement, bounds = canvas.getBoundingClientRect(),
                  output = canvas.parentElement!.getBoundingClientRect(), context = canvas.getContext('2d')!
                return { width: canvas.width, height: canvas.height,
                  relative: [(bounds.x - output.x) / output.width, (bounds.y - output.y) / output.height,
                    bounds.width / output.width, bounds.height / output.height],
                  pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] }
              })
              mixingGeometry = { width: captured.width, height: captured.height, relative: captured.relative }
              expect([captured.width, captured.height]).toEqual([16, 12])
              // Fixed dsmixer.cpp SetMixingBitmap uses the output rectangle
              // (200x150), explicitly not the video's 64x48 dimensions. Its
              // half-pixel bias places this bitmap at (8.5,8.5), size 16x12.
              for (const [axis, value] of [8.5 / 200, 8.5 / 150, 16 / 200, 12 / 150].entries())
                expect(captured.relative[axis]).toBeCloseTo(value, 3)
              expect(captured.pixels).toEqual(Array.from({ length: 16 * 12 }, () => [255, 0, 255, 255]).flat())
            }
            screenshot = await container.screenshot({ timeout: 5000 })
            const image = readScreenshotPng(screenshot), at = (x: number, y: number) => {
              const offset = (Math.floor(y / 150 * image.height) * image.width + Math.floor(x / 200 * image.width)) * 4
              return [...image.rgba.subarray(offset, offset + 4)]
            }
            // (40,40) is outside the native destination and samples the movie
            // barcode. Use an interior point of the independently derived
            // rectangle, keeping the original per-channel tolerance unchanged.
            screen = at(150, 100); overlay = at(16, 14)
            expect(screen[3]).toBe(255)
            if (stage === 'overlay' || stage === 'mixer-default' || stage === 'reopened-default') near(screen, raw.pixel, 12, stage)
            if (index >= 3) near(overlay, [255, 0, 255], 3, stage + ' captured mixing Layer')
            if (stage === 'saturation-zero') {
              expect(Math.max(...screen.slice(0, 3)) - Math.min(...screen.slice(0, 3))).toBeLessThanOrEqual(4)
              expect(screen.slice(0, 3).reduce((sum, value, channel) => sum + Math.abs(value - raw.pixel[channel]!), 0)).toBeGreaterThan(40)
            } else if (stage === 'brightness-up') {
              expect(screen[0]).toBeGreaterThanOrEqual(baseline![0]! - 3)
              expect(screen.slice(0, 3).reduce((a, b) => a + b, 0) - baseline!.slice(0, 3).reduce((a, b) => a + b, 0)).toBeGreaterThan(25)
            } else if (stage === 'contrast-half') {
              const luma = (rgb: readonly number[]) => .299 * rgb[0]! + .587 * rgb[1]! + .114 * rgb[2]!
              expect(Math.abs(luma(screen) - luma(baseline!) * .5)).toBeLessThanOrEqual(4)
              // ProcAmp contrast scales Y, retaining chroma rather than
              // reducing each RGB channel's distance from mid-gray.
              expect(Math.abs((screen[0]! - screen[1]!) - (baseline![0]! - baseline![1]!))).toBeLessThanOrEqual(4)
              expect(Math.abs((screen[2]! - screen[1]!) - (baseline![2]! - baseline![1]!))).toBeLessThanOrEqual(4)
            } else if (stage === 'hue-turn') {
              expect(screen.slice(0, 3).reduce((sum, value, channel) => sum + Math.abs(value - baseline![channel]!), 0)).toBeGreaterThan(60)
            } else if (stage === 'background') near(screen, [32, 64, 96], 3, 'unfiltered mixer background')
          }).toPass({ timeout: 10000 })
        } catch (error) { stageFailures.push(error) }
        finally {
          readings.push({ stage, values, raw, screen, overlay, mixingGeometry })
          if (screenshot) try { await info.attach('video-color-' + stage, { body: screenshot, contentType: 'image/png' }) }
          catch (error) { stageFailures.push(error) }
        }
        if (stageFailures.length === 1) throw stageFailures[0]
        if (stageFailures.length) throw new AggregateError(stageFailures, 'Movie color picture or evidence failed', { cause: stageFailures[0] })
        if (stage === 'mixer-default') baseline = screen
        if (stage === 'reopened-default') near(screen, baseline!, 3, 'reopened default picture')
        expect((await observeVideoAudio(page)).liveUrls).toBe(1)
        await expect(page.locator('#logs .error')).toHaveCount(0)
      }
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('video-color-observations', { body: JSON.stringify({ backend, binary, readings, errors }), contentType: 'application/json' }),
      () => info.attach('video-color-game', { body: source, contentType: 'text/plain' }),
      async () => info.attach('video-color-runtime', { body: JSON.stringify({ media: await observeVideoMedia(page),
        audio: await observeVideoAudio(page), logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      const modal = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modal.count()) await modal.last().press('Enter', { timeout: 5000 })
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video,.video-mixing-bitmap,.video-plane,.game-window')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const resources = await observeVideoAudio(page)
      expect(resources.graphs).toHaveLength(0); expect(resources.liveUrls).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Movie color controls or cleanup failed', { cause: failures[0] })
  })
