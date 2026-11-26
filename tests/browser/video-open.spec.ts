import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { videoOpenSource } from '../helpers/video-open.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installVideoAudioChannelProbe, observeVideoAudioChannels } from '../helpers/video-audio-channel-probe.ts'

const controls = String.raw`
var openWindow=new Window();openWindow.caption="Movie open";openWindow.setInnerSize(112,88);openWindow.visible=true;
var openRoot=new Layer(openWindow,null);openRoot.setSize(112,88);openRoot.fillRect(0,0,112,88,0xff102030);
var openImage=new Layer(openWindow,openRoot);openImage.visible=true;
var openButton=new Layer(openWindow,openRoot);openButton.setPos(0,56,100,24);openButton.fillRect(0,0,100,24,0xff408060);openButton.visible=true;
var openMovie=new OpenMovie(openWindow),openStage=0;
openMovie.onPeriod=function(reason){this.periods.add(reason);global.Debug.message("movie-open-period:"+reason+":"+this.periodEventFrame);};
openMovie.mode=vomLayer;openMovie.layer1=openImage;openMovie.visible=true;openMovie.loop=true;
openMovie.open("clip.mp4");openMovie.audioVolume=50000;openMovie.play();
function openNext(){
 var result;
 switch(openStage){
  case 0:videoOpenHolders("playing");openMovie.states.clear();result=videoOpenErrors(openMovie);break;
  case 1:openMovie.pause();openMovie.frame=0;openMovie.setPeriodEvent(6);openMovie.periods.clear();openMovie.states.clear();result="pause";break;
  case 2:videoOpenHolders("paused");result=videoOpenErrors(openMovie)+"|cue="+openMovie.periodEventFrame;break;
  case 3:openMovie.play();result="resume";break;
  case 4:
   openMovie.states.clear();result=videoOpenMissing(openMovie,"absent.mp4");
   if(result=="unexpected-success")throw new Exception(result);
   Debug.message("movie-open-missing:"+result);result="missing";break;
  case 5:openMovie.open("clip.mp4",<%00%>,%[]);openMovie.play();result="reopened";break;
  default:return;
 }
 Debug.message("movie-open:"+openStage+":"+result+":"+openMovie.status+":"+openMovie.states.join(","));
 openStage++;
}
openButton.onClick=function(){global.openNext();};Debug.message("movie-open-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: invalid open keeps real movie playback, audio and paused pixels until a converted replacement retires them`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], readings: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await installVideoAudioProbe(page); await installVideoAudioChannelProbe(page); await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const audio = async (attenuation: number) => {
      await expect(async () => {
        const activation = page.getByRole('button', { name: '播放视频', exact: true })
        if (await activation.isVisible()) await activation.click({ timeout: 500 })
        const observed = await observeVideoAudioChannels(page)
        expect(observed.errors).toEqual([]); expect(observed.graphs).toHaveLength(1)
        const graph = observed.graphs[0]!, amplitude = 10 ** (attenuation / 2000)
        expect(graph.state).toBe('running')
        for (const channel of [0, 1] as const) {
          const input = graph.input[channel], output = graph.output[channel]
          expect(input.rms).toBeGreaterThan(0.02); expect(input.peak).toBeGreaterThan(0.04)
          expect(Math.abs(input.frequency - 440)).toBeLessThan(25)
          expect(Math.abs(output.frequency - 440)).toBeLessThan(25)
          expect(Math.abs(graph.gains[channel] - amplitude)).toBeLessThan(Math.max(1e-10, amplitude * 2e-6))
          expect(Math.abs(20 * Math.log10(output.rms / input.rms) - attenuation / 100)).toBeLessThan(0.5)
        }
      }).toPass({ timeout: 12000 })
      return observeVideoAudioChannels(page)
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("open.tjs","savedata/open.cjs",false,true,false);Scripts.execStorage("savedata/open.cjs");'
          : 'Scripts.execStorage("open.tjs");') },
        { name: 'open.tjs', mimeType: 'text/plain', buffer: Buffer.from(videoOpenSource + controls) },
        { name: 'clip.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve('out/verification/video-tracks/multitrack.mp4')) },
      ])
      await expect(page.getByText('movie-open-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      const beforeAudio = await audio(-1505), beforeMedia = (await observeVideoMedia(page)).videos[0]!,
        beforeResources = await observeVideoAudio(page), beforeGraph = beforeAudio.graphs[0]!.id,
        canvas = page.locator('canvas[data-window-id]').first(), click = () => canvas.click({ position: { x: 40, y: 65 } })
      expect(beforeMedia.presentedFrames).not.toBeNull()
      await click()
      await expect(page.getByText('movie-open:0:playing-count|playing-string:play:', { exact: true })).toHaveCount(1)
      const afterAudio = await audio(-1505)
      expect(afterAudio.graphs[0]!.id).toBe(beforeGraph)
      await expect.poll(async () => Number((await observeVideoMedia(page)).videos[0]?.presentedFrames)).toBeGreaterThan(Number(beforeMedia.presentedFrames))
      let current = (await observeVideoMedia(page)).videos
      expect(current).toHaveLength(1); expect(current[0]!.identity).toBe(beforeMedia.identity)
      expect(current[0]!.source).toBe(beforeMedia.source); expect(current[0]!.paused).toBe(false)
      let resources = await observeVideoAudio(page)
      expect(resources.createdUrls).toBe(beforeResources.createdUrls); expect(resources.revokedUrls).toBe(beforeResources.revokedUrls)
      readings.push({ phase: 'playing-errors', beforeMedia, current, beforeAudio, afterAudio, resources })

      await click()
      await expect(page.getByText('movie-open:1:pause:pause:', { exact: true })).toHaveCount(1)
      const pixels = () => page.locator('video[data-video-id]').evaluate((node) => {
        const video = node as HTMLVideoElement, context = new OffscreenCanvas(video.videoWidth, video.videoHeight)
          .getContext('2d', { willReadFrequently: true })!
        context.drawImage(video, 0, 0)
        return { time: video.currentTime, width: video.videoWidth, height: video.videoHeight,
          paused: video.paused, seeking: video.seeking, data: [...context.getImageData(0, 0, video.videoWidth, video.videoHeight).data] }
      })
      const paused = await pixels()
      expect(paused.paused).toBe(true); expect(paused.seeking).toBe(false); expect(paused.width).toBeGreaterThan(0)
      expect(paused.data.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(true)
      await click()
      await expect(page.getByText('movie-open:2:paused-count|paused-string|cue=6:pause:', { exact: true })).toHaveCount(1)
      expect(await pixels(), 'Both rejected opens retain every channel of the pre-existing paused image').toEqual(paused)
      await expect(async () => {
        const observation = await observeVideoAudioChannels(page)
        expect(observation.graphs).toHaveLength(1); expect(observation.graphs[0]!.id).toBe(beforeGraph)
        for (const channel of observation.graphs[0]!.output) expect(channel.peak).toBeLessThan(0.00000001)
      }).toPass({ timeout: 12000 })
      expect(await pixels(), 'The complete actual paused image and clock stay frozen').toEqual(paused)
      readings.push({ phase: 'paused-errors', pixels: paused })
      await click()
      await expect(page.getByText('movie-open:3:resume:play:play', { exact: true })).toHaveCount(1)
      expect((await audio(-1505)).graphs[0]!.id).toBe(beforeGraph)
      await expect(page.getByText('movie-open-period:1:-1', { exact: true })).toHaveCount(1)

      await click()
      await expect(page.getByText('movie-open:4:missing:unload:unload', { exact: true })).toHaveCount(1)
      await expect(page.locator('video')).toHaveCount(0)
      resources = await observeVideoAudio(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
      const retired = await observeVideoAudioChannels(page)
      expect(retired.createdGraphs).toBe(retired.releasedGraphs); expect(retired.liveProbeNodes).toBe(0)
      await click()
      await expect(page.getByText('movie-open:5:reopened:play:unload,stop,play', { exact: true })).toHaveCount(1)
      expect((await audio(0)).graphs[0]!.id).not.toBe(beforeGraph)
      current = (await observeVideoMedia(page)).videos
      expect(current).toHaveLength(1); expect(current[0]!.identity).not.toBe(beforeMedia.identity)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('movie-open-playback', { body: JSON.stringify({ readings,
      media: await observeVideoMedia(page), audio: await observeVideoAudioChannels(page), logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(page.locator('video')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const resources = await observeVideoAudio(page), channels = await observeVideoAudioChannels(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
      expect(resources.createdUrls).toBe(resources.revokedUrls)
      expect(channels.liveProbeNodes).toBe(0); expect(channels.createdGraphs).toBe(channels.releasedGraphs)
      expect(channels.errors).toEqual([]); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Movie open playback or cleanup failed', { cause: failures[0] })
  })
