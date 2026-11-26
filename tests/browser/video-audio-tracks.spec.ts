import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import type { Page } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluate } from '../helpers/browser-expression.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia, type VideoAudioObservation } from '../helpers/video-audio-probe.ts'
import { legacyFrameCode } from '../helpers/legacy-video-game.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'

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
for (const container of ['multitrack', 'fragmented', 'interleaved', 'bilingual-mpeg']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: VideoOverlay switches ${container === 'bilingual-mpeg' ? 'AC-3 and DVD LPCM dialogue' : 'real AAC tracks'} while preserving its media clock and layer`, async ({ page }, info) => {
    test.setTimeout(container === 'bilingual-mpeg' ? 180000 : 90000)
    const bilingual = container === 'bilingual-mpeg', directory = resolve('out/verification/video-tracks'),
      name = bilingual ? 'legacy-bilingual.mpg' : 'tracks.mp4',
      reference = bilingual ? JSON.parse(readFileSync(resolve(directory, 'dvd-audio-reference.json'), 'utf8')) as {
        complete: boolean; fixtures: { normalizedVideoTimes: number[]; audioTracks: { tone: number }[] }[]
      } : undefined
    const tones = reference?.fixtures[0]?.audioTracks.map((track) => track.tone) ?? [440, 880]
    if (bilingual) { expect(reference?.complete).toBe(true); expect([...tones].sort()).toEqual([440, 880]) }
    const errors: string[] = [], observations: { stage: string; value: VideoAudioObservation }[] = [],
      capture = async (stage: string) => observations.push({ stage, value: await observeVideoAudio(page) }),
      source = String.raw`
var win=new Window();win.visible=true;win.setInnerSize(96,${bilingual ? 88 : 64});
var root=new Layer(win,null);root.setSize(96,${bilingual ? 88 : 64});root.fillRect(0,0,96,64,0xff000000);
var image=new Layer(win,root);image.visible=true;
class TrackMovie extends VideoOverlay {
 function TrackMovie(w){super.VideoOverlay(w);}
 function onPeriod(reason){Debug.message("track-period="+reason);}
}
var movie=new TrackMovie(win);movie.mode=vomLayer;movie.layer1=image;
movie.open(${JSON.stringify(name)});movie.loop=true;movie.play();
${bilingual ? `var dub=new Layer(win,root);dub.setPos(0,64,96,24);dub.holdAlpha=false;
dub.fillRect(0,0,96,24,0xff205080);dub.drawText(2,2,"Language 2",0xffffff);dub.visible=true;
dub.onClick=function(){global.movie.position=2000;var before=global.movie.position;
 global.movie.selectAudioStream(1);var after=global.movie.position;
 Debug.message("dub-choice:"+global.movie.enabledAudioStream+","+global.movie.status+","+int(before>=2000 && after>=before-1 && after<=before+1000));};` : ''}
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
        { name, mimeType: bilingual ? 'video/mpeg' : 'video/mp4', buffer: readFileSync(resolve(directory, bilingual ? name : container + '.mp4')) },
      ])
      await expect(page.locator('#logs')).toContainText('tracks-ready=2,0', bilingual ? { timeout: 90000 } : {})
      await expect(page.locator('#evaluate')).toBeEnabled()
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await audible(page, tones[0]!)
      await capture('initial-' + tones[0])
      // Keep both clock samples inside one real TJS operation. Starting well
      // into the file makes a restart at zero fail even if its tone is correct.
      if (bilingual) {
        const point = await pointerPixel(page.locator('canvas[data-window-id]'), 40, 75)
        await page.mouse.click(point.x, point.y)
        await expect(page.getByText('dub-choice:1,play,1', { exact: true })).toBeVisible({ timeout: 30000 })
      } else await evaluate(page, '(function(){movie.position=2000;var before=movie.position;movie.selectAudioStream(1);var after=movie.position;Debug.message("playing-switch-position="+before+","+after);return movie.enabledAudioStream+","+movie.status+","+(before>=2000 && after>=before-1 && after<=before+1000);})()', '1,play,1')
      await audible(page, tones[1]!)
      await capture('selected-' + tones[1])
      await evaluate(page, '(function(){movie.audioVolume=0;return movie.enabledAudioStream;})()', '1')
      await expect.poll(async () => Math.max(0, ...(await observeVideoAudio(page)).graphs.map((graph) => graph.peak))).toBeLessThan(0.001)
      await capture('disabled')
      const disabledUrls = (await observeVideoAudio(page)).createdUrls
      await evaluate(page, '(function(){movie.enabledAudioStream=1;movie.audioVolume=100000;return movie.enabledAudioStream;})()', '1')
      await audible(page, tones[1]!)
      expect((await observeVideoAudio(page)).createdUrls).toBe(disabledUrls)

      // A paused switch must retain the same presented video frame. The layer
      // readback comes through the real Worker/TJS API, independently of audio.
      await evaluate(page, '(function(){movie.pause();movie.frame=6;global.beforeFrame=movie.frame;global.beforePosition=movie.position;global.beforePixel=image.getMainPixel(1,1);movie.enabledAudioStream=0;return movie.frame==beforeFrame && Math.abs(movie.position-beforePosition)<=1 && image.getMainPixel(1,1)==beforePixel && movie.status=="pause";})()', '1')
      // Also seek/switch a fractional-millisecond PTS. Frame 10 in the regular
      // 12 fps file is 833.333333... ms but Chromium presents 0.833333 seconds.
      // Keep the integer-boundary frame-6 check above and all original limits.
      await evaluate(page, '(function(){movie.frame=10;global.beforeFrame=movie.frame;global.beforePosition=movie.position;global.beforePixel=image.getMainPixel(1,1);movie.enabledAudioStream=1;return beforeFrame==10 && movie.frame==beforeFrame && Math.abs(movie.position-beforePosition)<=1 && image.getMainPixel(1,1)==beforePixel && movie.status=="pause";})()', '1')
      await evaluate(page, '(function(){movie.enabledAudioStream=0;return movie.frame==beforeFrame && image.getMainPixel(1,1)==beforePixel;})()', '1')
      if (reference) {
        const expected = reference.fixtures[0]!.normalizedVideoTimes.filter((time) => time <= 10 / 25 + 1e-6).length - 1
        await expect.poll(async () => {
          const pictures = await page.evaluate(() => {
            const picture = (node: HTMLVideoElement | HTMLCanvasElement) => {
              const ctx = new OffscreenCanvas(96, 64).getContext('2d', { willReadFrequently: true })!
              ctx.drawImage(node, 0, 0)
              return [...ctx.getImageData(0, 0, 96, 64).data]
            }
            return [picture(document.querySelector<HTMLVideoElement>('video[data-video-id]')!),
              picture(document.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!)]
          })
          return pictures.map(legacyFrameCode)
        }).toEqual([expected, expected])
      }
      await evaluate(page, '(function(){movie.selectAudioStream(2);movie.enabledAudioStream=-1;return movie.enabledAudioStream==0 && movie.frame==beforeFrame;})()', '1')
      await expect(page.locator('video[data-video-id]')).toHaveCount(1)
      await capture('paused-switch')
      await evaluate(page, '(function(){movie.playRate=2;movie.play();return movie.playRate;})()', '2')
      await audible(page, 2 * tones[0]!)
      await capture('track-' + tones[0] + '-at-double-rate')
      // The MPEG contains an intentional half-second of silence. Keep the
      // loop in the audible part of each fixture when measuring its language.
      const loop = bilingual ? [16, 38] : [6, 18]
      await evaluate(page, `(function(){movie.playRate=1;movie.selectAudioStream(1);movie.setSegmentLoop(${loop[0]},${loop[1]});return movie.enabledAudioStream;})()`, '1')
      await audible(page, tones[1]!)
      await expect(page.locator('#logs')).toContainText('track-period=3')
      await page.locator('#pause').click()
      await expect.poll(() => page.locator('video[data-video-id]').evaluate((node) => (node as HTMLVideoElement).paused)).toBe(true)
      await page.locator('#pause').click()
      await audible(page, tones[1]!)
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
        media: await observeVideoMedia(page).catch((error: unknown) => ({ observationError: String(error) })),
        logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' })
    }
  })
}
