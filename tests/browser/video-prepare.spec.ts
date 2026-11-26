import { readFileSync } from 'node:fs'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { installHandoffReadbacks, type ProbeWindow } from '../helpers/video-handoff-capture.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

const actions = ['basic', 'play', 'reopen', 'close'] as const
const game = String.raw`
System.exitOnNoWindowStartup=false;
var prepareWindow=new Window();prepareWindow.caption="Prepare movie";prepareWindow.setInnerSize(160,80);
var prepareRoot=new Layer(prepareWindow,null);prepareRoot.setSize(160,80);prepareRoot.holdAlpha=false;prepareRoot.fillRect(0,0,160,80,0xff102030);
var prepareLeft=new Layer(prepareWindow,prepareRoot),prepareRight=new Layer(prepareWindow,prepareRoot);
prepareLeft.setSize(64,48);prepareRight.setPos(80,0,64,48);prepareLeft.visible=prepareRight.visible=true;
var prepareLog=[],prepareAction="",prepareArmed=false,prepareCount=0,prepareIndex=0,prepareBlueCount=0;
var prepareActions=["basic","play","reopen","close"];
function preparePixel(){return [prepareLeft.getMainPixel(0,0),prepareLeft.getMaskPixel(0,0),
 prepareRight.getMainPixel(0,0),prepareRight.getMaskPixel(0,0)].join(",");}
class PrepareMovie extends VideoOverlay {
 function PrepareMovie(w){super.VideoOverlay(w);}
 function onStatusChanged(value){if(global.prepareArmed)global.prepareLog.add("status:"+value);}
 function onFrameUpdate(frame){
  if(global.prepareArmed)global.prepareLog.add("frame:"+frame+":"+status+":"+global.preparePixel());
 }
 function onPeriod(reason){
  if(!global.prepareArmed)return;
  global.prepareLog.add("period:"+reason+":"+status+":"+global.preparePixel());
  if(reason==2){
   global.prepareCount++;
   if(global.prepareAction=="play"){
    play();global.prepareLog.add("inner-play:"+status);
   }else if(global.prepareAction=="reopen"){
    open("colors.mp4");play();global.prepareLog.add("inner-reopen:"+status);
   }else if(global.prepareAction=="close"){
    close();global.prepareLog.add("inner-close:"+status);
   }
  }
 }
}
var prepareMovie=new PrepareMovie(prepareWindow);prepareMovie.mode=vomLayer;
prepareMovie.layer1=prepareLeft;prepareMovie.layer2=prepareRight;
prepareMovie.open("colors.mp4");prepareMovie.pause();prepareMovie.frame=0;
function prepareBlue(){
 global.prepareArmed=false;prepareMovie.pause();prepareMovie.frame=12;
 global.prepareBlueCount++;Debug.message("prepare-blue:"+prepareBlueCount);
}
function prepareNext(){
 if(prepareIndex>=prepareActions.count)return;
 global.prepareAction=prepareActions[prepareIndex++];prepareLog.clear();global.prepareCount=0;global.prepareArmed=true;
 prepareMovie.prepare();prepareLog.add("return:"+prepareMovie.status);
 Debug.message("prepare-return:"+prepareAction+":"+prepareMovie.status);
}
function prepareState(){
 var st=prepareMovie.status;
 return [prepareAction,prepareCount,st,st=="unload"?"closed":string(prepareMovie.frame),
  st=="unload"?"closed":string(prepareMovie.position)].join("|");
}
function prepareTrace(){return prepareLog.join("|");}
var prepareButton=new Layer(prepareWindow,prepareRoot),blueButton=new Layer(prepareWindow,prepareRoot);
prepareButton.setPos(0,56,76,24);blueButton.setPos(80,56,76,24);
prepareButton.holdAlpha=blueButton.holdAlpha=false;
prepareButton.fillRect(0,0,76,24,0xff408060);blueButton.fillRect(0,0,76,24,0xff406080);
prepareButton.visible=blueButton.visible=true;
prepareButton.onClick=function(){global.prepareNext();};blueButton.onClick=function(){global.prepareBlue();};
prepareWindow.visible=true;Debug.message("prepare-buttons-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: prepare publishes both movie layers before its callback and finishes callback playback at frame zero`, async ({ page }, info) => {
    test.setTimeout(120000)
    const errors: string[] = [], failures: unknown[] = [], readings: unknown[] = [], traces: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await observeVideoFrames(page)
    await installHandoffReadbacks(page)
    await installVideoAudioProbe(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Prepare movie$/ }),
    }).locator('canvas[data-window-id]')
    const read = async (expression: string) => {
      const prefix = `prepare-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Prepare observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(line).toBeVisible({ timeout: 5000 })
      return ((await line.textContent()) ?? '').slice(prefix.length)
    }
    const click = async (x: number) => {
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: x * box!.width / 160, y: 68 * box!.height / 80 }, timeout: 5000 })
    }
    const capture = async (phase: string, clock: number, prepared = false, retainedSource?: string) => {
      const sample = await canvas.evaluate((node, retainedSource) => {
        const canvas = node as HTMLCanvasElement,
          video = document.querySelector<HTMLVideoElement>(`video[data-video-id][data-window-id="${canvas.dataset.windowId}"]`)
        if (!video || video.readyState < 2 || !video.paused || video.seeking)
          throw new Error('Prepare capture requires the actual settled paused decoder')
        const probe = (window as unknown as ProbeWindow).handoffReadbacks, current = probe.capture(video, canvas)
        return { ...current, source: video.currentSrc || video.src,
          retainedProduction: retainedSource === null ? undefined : probe.readProduction(retainedSource),
          presentedTime: Number(video.dataset.presentedTime), presentedFrames: Number(video.dataset.presentedFrames) }
      }, retainedSource ?? null)
      readings.push({ phase, ...sample })
      expect(sample.dropped).toBe(0)
      expect(sample.media.position).toBe(clock); expect(sample.media.paused).toBe(true); expect(sample.media.seeking).toBe(false)
      expect([sample.media.width, sample.media.height, sample.media.pixels.length]).toEqual([64, 48, 12288])
      // perPrepare may replace the decoder after the old frame was published.
      // Native then pauses/rewinds the replacement without redrawing the Layer.
      // Keep both observations: current decoder readback (possibly absent) and
      // the last actual production readback from the explicitly retained source.
      const layerProduction = retainedSource === undefined ? sample.production : sample.retainedProduction
      expect(layerProduction).toBeDefined(); expect(layerProduction!.willReadFrequently).toBe(true)
      expect(layerProduction!.source).toBe(retainedSource ?? sample.source)
      if (retainedSource !== undefined) expect(sample.source).not.toBe(retainedSource)
      expect([layerProduction!.width, layerProduction!.height]).toEqual([64, 48])
      if (prepared) {
        // Native Prepare keeps the Layer from its first delivered frame;
        // its final rewind changes the clock without another Layer update.
        // The fixture's first six actual frames share the initial red image.
        expect(layerProduction!.position).toBeGreaterThanOrEqual(0)
        expect(layerProduction!.position).toBeLessThan(0.5)
      } else expect(layerProduction!.position).toBe(clock)
      expect(sample.reads.cpuRepeated).toEqual(sample.reads.cpu); expect(sample.reads.cpuRedrawn).toEqual(sample.reads.cpu)
      expect(layerProduction!.pixels).toEqual(sample.media.pixels)
      expect([sample.paint.width, sample.paint.height]).toEqual([160, 80])
      for (const x of [0, 80]) {
        const pixels: number[] = []
        for (let y = 0; y < 48; y++) {
          const start = (y * sample.paint.width + x) * 4
          pixels.push(...sample.paint.pixels.slice(start, start + 64 * 4))
        }
        expect(pixels, phase + ' complete bound Layer at x=' + x).toEqual(sample.media.pixels)
      }
      expect(Number.isFinite(sample.presentedTime)).toBe(true)
      if (prepared) {
        expect(sample.presentedTime).toBeGreaterThanOrEqual(0)
        expect(sample.presentedTime).toBeLessThan(0.5)
      }
      expect(sample.presentedFrames).toBeGreaterThan(0)
      return sample
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("prepare-game.tjs",System.dataPath+"prepare-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"prepare-game.cjs");'
          : 'Scripts.execStorage("prepare-game.tjs");') },
        { name: 'prepare-game.tjs', mimeType: 'text/plain', buffer: Buffer.from(game) },
        { name: 'colors.mp4', mimeType: 'video/mp4', buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)) },
      ])
      await expect(page.getByText('prepare-buttons-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      await expect(canvas).toBeVisible()
      expect(await read('[prepareMovie.originalWidth,prepareMovie.originalHeight,prepareMovie.numberOfFrame,prepareMovie.totalTime,prepareMovie.fps].join("|")'))
        .toBe('64|48|18|1500|12')
      const initial = await capture('initial-frame-zero', 0),
        firstPixel = initial.media.pixels.slice(0, 4),
        pixelText = [(firstPixel[0]! << 16) | (firstPixel[1]! << 8) | firstPixel[2]!, firstPixel[3],
          (firstPixel[0]! << 16) | (firstPixel[1]! << 8) | firstPixel[2]!, firstPixel[3]].join(',')
      for (const [index, action] of actions.entries()) {
        await click(118)
        await expect(page.getByText('prepare-blue:' + (index + 1), { exact: true })).toBeVisible()
        expect(await read('prepareMovie.frame+"|"+prepareMovie.position+"|"+prepareMovie.status')).toBe('12|1000|pause')
        const blue = await capture(action + '-blue-before-prepare', 1)
        expect(blue.media.pixels).not.toEqual(initial.media.pixels)
        const createdUrls = (await observeVideoAudio(page)).createdUrls
        await click(38)
        await expect(page.getByText('prepare-return:' + action + ':play', { exact: true })).toBeVisible()
        await expect(async () => {
          const activation = page.getByRole('button', { name: '播放视频', exact: true })
          if (await activation.isVisible()) await activation.click({ timeout: 500 })
          expect(await read('prepareState()')).toBe(action === 'close'
            ? 'close|1|unload|closed|closed' : `${action}|1|pause|0|0`)
        }).toPass({ timeout: 20000 })
        const trace = (await read('prepareTrace()')).split('|')
        traces.push({ action, trace })
        const returned = trace.indexOf('return:play'), frame = trace.findIndex((entry) => entry.startsWith('frame:')),
          periods = trace.filter((entry) => entry.startsWith('period:')), period = trace.findIndex((entry) => entry.startsWith('period:'))
        expect(returned).toBeGreaterThanOrEqual(0); expect(frame).toBeGreaterThan(returned)
        expect(period).toBeGreaterThan(frame); expect(periods).toEqual(['period:2:play:' + pixelText])
        const firstFrame = trace[frame]!.split(':')
        expect(firstFrame).toHaveLength(4); expect(Number(firstFrame[1])).toBeGreaterThanOrEqual(0)
        expect(Number(firstFrame[1])).toBeLessThan(6)
        expect(firstFrame[2]).toBe('play'); expect(firstFrame[3]).toBe(pixelText)
        if (action !== 'basic') expect(trace).toContain(`inner-${action}:${action === 'close' ? 'unload' : 'play'}`)
        if (action === 'close') {
          await expect(page.locator('video')).toHaveCount(0)
          expect((await observeVideoAudio(page)).liveUrls).toBe(0)
        } else {
          const after = await capture(action + '-complete', 0, true, action === 'reopen' ? blue.source : undefined)
          expect(after.media.pixels).toEqual(initial.media.pixels)
          if (action !== 'reopen') expect(after.presentedFrames).toBeGreaterThan(blue.presentedFrames)
          else expect((await observeVideoAudio(page)).createdUrls).toBeGreaterThan(createdUrls)
          expect((await observeVideoAudio(page)).liveUrls).toBe(1)
          await info.attach('prepare-' + action, { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
        }
        await expect(page.locator('#logs .error')).toHaveCount(0)
      }
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    const reports = [
      () => info.attach('video-prepare-completed-readbacks', { body: JSON.stringify({ backend, binary, readings, traces, errors }), contentType: 'application/json' }),
      () => info.attach('video-prepare-authored-source', { body: game, contentType: 'text/plain' }),
      async () => info.attach('video-prepare-media', { body: JSON.stringify({ media: await observeVideoMedia(page), resources: await observeVideoAudio(page), logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }),
    ]
    for (const report of reports) try { await report() } catch (error) { failures.push(error) }
    try {
      const modalStop = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modalStop.count()) await modalStop.last().press('Enter', { timeout: 5000 })
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video,.video-plane,.game-window')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const remaining = await observeVideoAudio(page)
      expect(remaining.liveUrls).toBe(0); expect(remaining.graphs).toHaveLength(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Video prepare frame, callback or cleanup failed', { cause: failures[0] })
  })
