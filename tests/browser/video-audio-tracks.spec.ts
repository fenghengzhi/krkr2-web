import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluate } from '../helpers/browser-expression.ts'
import { installVideoAudioProbe, observeVideoAudio, type VideoAudioObservation } from '../helpers/video-audio-probe.ts'

async function audible(page: Page, frequency: number) {
  await page.locator('canvas').scrollIntoViewIfNeeded()
  await expect(async () => {
    const button = page.getByRole('button', { name: '播放视频', exact: true })
    if (await button.isVisible()) await button.click({ timeout: 500 })
    const observation = await observeVideoAudio(page)
    expect(observation.graphs).toHaveLength(1)
    const graph = observation.graphs[0]!
    expect(graph.state).toBe('running')
    expect(graph.peak).toBeGreaterThan(0.01)
    expect(graph.db).toBeGreaterThan(-55)
    expect(Math.abs(graph.frequency - frequency)).toBeLessThan(25)
  }).toPass({ timeout: 12000 })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['multitrack', 'fragmented']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: VideoOverlay switches real AAC tracks while preserving its media clock and layer`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], observations: { stage: string; value: VideoAudioObservation }[] = [],
      capture = async (stage: string) => observations.push({ stage, value: await observeVideoAudio(page) }),
      source = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(96,64);
var root=new Layer(win,null);root.setSize(96,64);root.fillRect(0,0,96,64,0xff000000);
var image=new Layer(win,root);image.visible=true;
class TrackMovie extends VideoOverlay {
 function TrackMovie(w){super.VideoOverlay(w);}
 function onPeriod(reason){Debug.message("track-period="+reason);}
}
var movie=new TrackMovie(win);movie.mode=vomLayer;movie.layer1=image;
movie.open("tracks.mp4");movie.loop=true;movie.play();
Debug.message("tracks-ready="+movie.numberOfAudioStream+","+movie.enabledAudioStream);
`
    await installVideoAudioProbe(page)
    await observeVideoFrames(page)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("tracks.tjs","savedata/tracks.cjs",false,true,false);Scripts.execStorage("savedata/tracks.cjs");'
          : 'Scripts.execStorage("tracks.tjs");') },
        { name: 'tracks.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
        { name: 'tracks.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve(`out/verification/video-tracks/${container}.mp4`)) },
      ])
      await expect(page.locator('#logs')).toContainText('tracks-ready=2,0')
      await expect(page.locator('#evaluate')).toBeEnabled()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await audible(page, 440)
      await capture('initial-440')
      // Keep both clock samples inside one real TJS operation. Starting well
      // into the file makes a restart at zero fail even if its tone is correct.
      await evaluate(page, '(function(){movie.position=2000;var before=movie.position;movie.selectAudioStream(1);var after=movie.position;Debug.message("playing-switch-position="+before+","+after);return movie.enabledAudioStream+","+movie.status+","+(before>=2000 && after>=before-1 && after<=before+1000);})()', '1,play,1')
      await audible(page, 880)
      await capture('selected-880')
      await evaluate(page, '(function(){movie.audioVolume=0;return movie.enabledAudioStream;})()', '1')
      await expect.poll(async () => Math.max(0, ...(await observeVideoAudio(page)).graphs.map((graph) => graph.peak))).toBeLessThan(0.001)
      await capture('disabled')
      const disabledUrls = (await observeVideoAudio(page)).createdUrls
      await evaluate(page, '(function(){movie.enabledAudioStream=1;movie.audioVolume=100000;return movie.enabledAudioStream;})()', '1')
      await audible(page, 880)
      expect((await observeVideoAudio(page)).createdUrls).toBe(disabledUrls)

      // A paused switch must retain the same presented video frame. The layer
      // readback comes through the real Worker/TJS API, independently of audio.
      await evaluate(page, '(function(){movie.pause();movie.frame=6;global.beforeFrame=movie.frame;global.beforePosition=movie.position;global.beforePixel=image.getMainPixel(1,1);movie.enabledAudioStream=0;return movie.frame==beforeFrame && Math.abs(movie.position-beforePosition)<=1 && image.getMainPixel(1,1)==beforePixel && movie.status=="pause";})()', '1')
      await evaluate(page, '(function(){movie.selectAudioStream(2);movie.enabledAudioStream=-1;return movie.enabledAudioStream==0 && movie.frame==beforeFrame;})()', '1')
      await expect(page.locator('video[data-video-id]')).toHaveCount(1)
      await capture('paused-switch')
      await evaluate(page, '(function(){movie.playRate=2;movie.play();return movie.playRate;})()', '2')
      await audible(page, 880)
      await capture('track-440-at-double-rate')
      await evaluate(page, '(function(){movie.playRate=1;movie.selectAudioStream(1);movie.setSegmentLoop(6,18);return movie.enabledAudioStream;})()', '1')
      await audible(page, 880)
      await expect(page.locator('#logs')).toContainText('track-period=3')
      await page.locator('#pause').click()
      await expect.poll(() => page.locator('video[data-video-id]').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
      await page.locator('#pause').click()
      await audible(page, 880)
      await capture('segment-loop-resumed')
      expect((await observeVideoAudio(page)).liveUrls).toBe(1)
      await page.locator('#stop').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已关闭。')
      await expect(page.locator('video')).toHaveCount(0)
      await expect.poll(async () => (await observeVideoAudio(page)).graphs.length).toBe(0)
      const stopped = await observeVideoAudio(page)
      expect(stopped.liveUrls).toBe(0)
      expect(stopped.revokedUrls).toBe(stopped.createdUrls)
      expect(errors).toEqual([])
      await capture('stopped')
    } finally {
      await info.attach('video-track-output', { body: JSON.stringify({ backend, binary, container, observations, errors,
        logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' })
    }
  })
}
