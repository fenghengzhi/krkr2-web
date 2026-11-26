import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installHandoffReadbacks } from '../helpers/video-handoff-capture.ts'
import { selectionReadbacks } from '../helpers/video-selection-capture.ts'

const source = String.raw`
var fragmentWindow=new Window();fragmentWindow.caption="Cutscene language";fragmentWindow.setInnerSize(160,96);fragmentWindow.visible=true;
var fragmentRoot=new Layer(fragmentWindow,null);fragmentWindow.add(fragmentRoot);fragmentRoot.setSize(160,96);fragmentRoot.holdAlpha=false;fragmentRoot.fillRect(0,0,160,96,0xff102030);
var fragmentImage=new Layer(fragmentWindow,fragmentRoot),fragmentCopy=new Layer(fragmentWindow,fragmentRoot);
fragmentWindow.add(fragmentImage);fragmentWindow.add(fragmentCopy);fragmentImage.visible=fragmentCopy.visible=true;fragmentCopy.left=80;
var fragmentMovie=new VideoOverlay(fragmentWindow);fragmentMovie.mode=vomLayer;fragmentMovie.layer1=fragmentImage;fragmentMovie.layer2=fragmentCopy;fragmentMovie.visible=true;
fragmentMovie.open("cutscene.mp4");fragmentMovie.loop=true;fragmentMovie.pause();
var fragmentDuration=fragmentMovie.totalTime,fragmentSerial=0;
if(fragmentDuration<6000 || fragmentDuration>7000)throw new Exception("Incomplete cutscene duration: "+fragmentDuration);
function fragmentAction(action){
 if(action==0){fragmentMovie.position=2000;fragmentMovie.play();}
 else if(action==1){
  var before=fragmentMovie.position,state=fragmentMovie.status;
  fragmentMovie.selectAudioStream(1-fragmentMovie.enabledAudioStream);
  var after=fragmentMovie.position;
  if(fragmentMovie.status!=state || after<before-1 || after>before+(state=="play"?1000:1))throw new Exception("Language changed the cutscene clock");
 }else{fragmentMovie.pause();fragmentMovie.position=2000;}
 if(fragmentMovie.totalTime!=fragmentDuration)throw new Exception("Language changed the cutscene duration");
 Debug.message("fragment-button:__CONTAINER__:"+(fragmentSerial++)+":"+action+":"+fragmentMovie.status+":"+fragmentMovie.enabledAudioStream);
}
var fragmentPlay=new Layer(fragmentWindow,fragmentRoot),fragmentLanguage=new Layer(fragmentWindow,fragmentRoot),fragmentPause=new Layer(fragmentWindow,fragmentRoot);
fragmentWindow.add(fragmentPlay);fragmentWindow.add(fragmentLanguage);fragmentWindow.add(fragmentPause);
fragmentPlay.setPos(0,60,50,32);fragmentLanguage.setPos(55,60,50,32);fragmentPause.setPos(110,60,50,32);
fragmentPlay.holdAlpha=fragmentLanguage.holdAlpha=fragmentPause.holdAlpha=false;
fragmentPlay.fillRect(0,0,50,32,0xff307040);fragmentLanguage.fillRect(0,0,50,32,0xff305080);fragmentPause.fillRect(0,0,50,32,0xff804030);
fragmentPlay.visible=fragmentLanguage.visible=fragmentPause.visible=true;
fragmentPlay.onClick=function(){global.fragmentAction(0);};fragmentLanguage.onClick=function(){global.fragmentAction(1);};fragmentPause.onClick=function(){global.fragmentAction(2);};
Debug.message("fragment-menu-ready:__CONTAINER__");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: finite fragmented cutscenes seek past the initial fragment and switch audible languages from real buttons`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], readings: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await installVideoAudioProbe(page); await installHandoffReadbacks(page); await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Cutscene language$/ }) }).locator('canvas[data-window-id]'),
      audio = async (hz: number) => {
        await expect(async () => {
          const activation = page.getByRole('button', { name: '播放视频', exact: true })
          if (await activation.isVisible()) await activation.click({ timeout: 500 })
          const value = await observeVideoAudio(page)
          expect(value.graphs).toHaveLength(1); expect(value.liveUrls).toBe(1)
          expect(value.graphs[0]!.state).toBe('running'); expect(value.graphs[0]!.peak).toBeGreaterThan(.01)
          expect(Math.abs(value.graphs[0]!.frequency - hz)).toBeLessThan(25)
        }).toPass({ timeout: 12000 })
        return observeVideoAudio(page)
      }, stop = async () => {
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('video')).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
        const value = await observeVideoAudio(page)
        expect(value.graphs).toHaveLength(0); expect(value.liveUrls).toBe(0); expect(value.createdUrls).toBe(value.revokedUrls)
      }
    try {
      for (const container of ['fragmented', 'interleaved']) {
        await page.locator('#files').setInputFiles([
          { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
            ? 'Scripts.compileStorage("language.tjs","savedata/language.cjs",false,true,false);Scripts.execStorage("savedata/language.cjs");'
            : 'Scripts.execStorage("language.tjs");') },
          { name: 'language.tjs', mimeType: 'text/plain', buffer: Buffer.from(source.replaceAll('__CONTAINER__', container)) },
          { name: 'cutscene.mp4', mimeType: 'video/mp4', buffer: readFileSync(`out/verification/video-tracks/${container}.mp4`) },
        ])
        await expect(page.getByText(`fragment-menu-ready:${container}`, { exact: true })).toBeVisible()
        await expect(page.locator('#evaluate')).toBeEnabled()
        if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
        let serial = 0
        const click = async (action: number, status: string, stream: number) => {
          const point = await pointerPixel(canvas, action * 55 + 25, 76)
          await page.mouse.click(point.x, point.y)
          await expect(page.getByText(`fragment-button:${container}:${serial++}:${action}:${status}:${stream}`, { exact: true })).toBeVisible()
        }, capture = async (label: string, expectedSeconds = 2) => {
          const result = await selectionReadbacks(canvas)
          await info.attach(`${container}-${label}`, { contentType: 'application/gzip', body: gzipSync(Buffer.from(JSON.stringify(result))) })
          expect(result.videos).toHaveLength(1)
          const video = result.videos[0]!
          expect(video.error).toBeUndefined(); expect(video.after).toEqual(video.before)
          expect(video.before.paused).toBe(true); expect(video.before.seeking).toBe(false)
          expect(Math.abs(video.before.position - expectedSeconds)).toBeLessThanOrEqual(.000001)
          expect(video.before.duration).toBeGreaterThan(6)
          expect(Number(video.before.presentedFrames)).toBeGreaterThan(0)
          const image = video.capture!
          expect([image.media.width, image.media.height]).toEqual([64, 48])
          expect(image.reads.cpuRepeated).toEqual(image.reads.cpu); expect(image.reads.cpuRedrawn).toEqual(image.reads.cpu)
          expect(image.production).toBeDefined(); expect(image.production!.willReadFrequently).toBe(true)
          expect(image.production!.source).toBe(video.before.source)
          expect(Math.abs(image.production!.position - video.before.position)).toBeLessThanOrEqual(.000001)
          expect(image.production!.pixels).toEqual(image.reads.cpu)
          expect([result.paint!.width, result.paint!.height]).toEqual([160, 96])
          for (const x of [0, 80]) {
            const panel: number[] = []
            for (let y = 0; y < 48; y++) panel.push(...result.paint!.pixels.slice((y * 160 + x) * 4, (y * 160 + x + 64) * 4))
            expect(panel).toEqual(image.reads.cpu)
          }
          readings.push({ container, label, state: video.before, rgbaSha256: createHash('sha256').update(Uint8Array.from(image.reads.cpu)).digest('hex') })
          return image.reads.cpu
        }
        const origin = await page.locator('video[data-video-id]').evaluate((node) => {
          const video = node as HTMLVideoElement
          return { clock: video.currentTime, first: Number(video.dataset.presentedTime),
            frames: Number(video.dataset.presentedFrames),
            seekable: Array.from({ length: video.seekable.length }, (_, at) =>
              [video.seekable.start(at), video.seekable.end(at)]) }
        }), firstClock = origin.seekable[0]?.[0]
        readings.push({ container, phase: 'initial-addressable-clock', ...origin })
        expect(firstClock).toBeDefined()
        expect(firstClock!).toBeGreaterThanOrEqual(0)
        // Authored streams have a two-frame initial offset at 12 fps. Engines
        // may expose the empty edit at zero or start their seekable range at
        // its end. Both must submit the actual first PTS, without moving A/V.
        expect(firstClock!).toBeLessThanOrEqual(1 / 6 + .000001)
        expect(Math.abs(origin.clock - firstClock!)).toBeLessThanOrEqual(.000001)
        expect(Math.abs(origin.first - 1 / 6)).toBeLessThanOrEqual(.000001)
        expect(origin.frames).toBeGreaterThan(0)
        const firstImage = await capture('opened-first-sample', firstClock!)
        await evaluate(page, '(function(){fragmentMovie.frame=0;return fragmentMovie.position;})()',
          String(Math.trunc(firstClock! * 1000 + .5)))
        expect(await capture('frame-zero-addressable-sample', firstClock!)).toEqual(firstImage)
        await evaluate(page, '(function(){fragmentMovie.position=0;return fragmentMovie.position;})()',
          String(Math.trunc(firstClock! * 1000 + .5)))
        expect(await capture('time-zero-addressable-sample', firstClock!)).toEqual(firstImage)
        await click(2, 'pause', 0)
        const before = await capture('initial-two-second-frame')
        expect(before).not.toEqual(firstImage)
        await click(1, 'pause', 1)
        expect(await capture('paused-language-one')).toEqual(before)
        await click(0, 'play', 1); readings.push({ container, phase: 'language-one-playing', audio: await audio(880) })
        await click(1, 'play', 0); readings.push({ container, phase: 'language-zero-playing', audio: await audio(440) })
        await click(2, 'pause', 0)
        expect(await capture('returned-two-second-frame')).toEqual(before)
        await click(1, 'pause', 1)
        expect(await capture('paused-language-one-again')).toEqual(before)
        await evaluate(page, 'fragmentMovie.position+"|"+fragmentMovie.status+"|"+fragmentMovie.frame', '2000|pause|24')
        await info.attach(`${container}-game`, { body: await canvas.screenshot(), contentType: 'image/png' })
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await stop()
      }
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('fragment-cutscene-observations', { body: JSON.stringify({ readings, errors,
      media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Fragmented cutscene or cleanup failed', { cause: failures[0] })
  })
