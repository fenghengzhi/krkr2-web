import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: graph controls reset on reopening while native object preferences persist`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], readings: unknown[] = []
    await installVideoAudioProbe(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    const inspect = async (phase: string) => {
      const media = await page.locator('video[data-video-id]').evaluate((node) => {
        const video = node as HTMLVideoElement
        return { rate: video.playbackRate, opacity: getComputedStyle(video).opacity,
          background: getComputedStyle(video.parentElement!).backgroundColor, paused: video.paused }
      }), audio = await observeVideoAudio(page)
      readings.push({ phase, media, audio })
      return { media, audio }
    }
    const audible = async () => {
      await page.locator('canvas[data-window-id]').scrollIntoViewIfNeeded()
      await expect(async () => {
        const button = page.getByRole('button', { name: '播放视频', exact: true })
        if (await button.isVisible()) await button.click({ timeout: 500 })
        const audio = await observeVideoAudio(page)
        expect(audio.graphs).toHaveLength(1)
        expect(audio.graphs[0]!.state).toBe('running')
        expect(audio.graphs[0]!.peak).toBeGreaterThan(0.01)
      }).toPass({ timeout: 12000 })
    }
    try {
      game = await launchWindowAttention(page, backend, binary, `
var win=new Window();win.caption="graph-controls";win.setInnerSize(96,64);win.visible=true;
var root=new Layer(win,null);root.setSize(96,64);
var movie=new VideoOverlay(win);movie.mode=vomMixer;movie.visible=true;movie.loop=.5;movie.setBounds(4,5,64,48);
movie.playRate=4;movie.audioVolume=0;movie.audioBalance=-100000;movie.mixingMovieAlpha=0;movie.mixingMovieBGColor=0xff0000;
movie.open("sound.mp4");movie.play();
`, [{ name: 'sound.mp4', mimeType: 'video/mp4',
        buffer: readFileSync(new URL('../fixtures/video/colors-sound.mp4', import.meta.url)) }], true)
      await audible()
      let observed = await inspect('opened-after-closed-writes')
      expect(observed.media.rate).toBe(1); expect(observed.media.opacity).toBe('1')
      expect(observed.media.background).toBe('rgb(0, 0, 0)')
      await evaluate(page, '[movie.playRate,movie.audioVolume,movie.audioBalance,movie.mixingMovieAlpha,movie.loop].join(",")', '1,100000,0,1,1')
      await evaluate(page, '(function(){movie.playRate=2;movie.audioVolume=0;movie.audioBalance=100000;movie.mixingMovieAlpha=.25;movie.mixingMovieBGColor=0x102030;return movie.playRate;})()', '2')
      await expect(async () => {
        const audio = await observeVideoAudio(page)
        expect(audio.graphs).toHaveLength(1)
        expect(audio.graphs[0]!.state).toBe('running')
        expect(audio.liveUrls).toBe(1)
        expect(audio.graphs[0]!.peak).toBeLessThan(0.001)
      }).toPass()
      observed = await inspect('active-graph-controls')
      expect(observed.media.paused).toBe(false)
      expect(observed.audio.graphs).toHaveLength(1)
      expect(observed.audio.graphs[0]!.state).toBe('running')
      expect(observed.audio.liveUrls).toBe(1)
      expect(observed.media.rate).toBe(2); expect(observed.media.opacity).toBe('0.25')
      expect(observed.media.background).toBe('rgb(16, 32, 48)')
      await evaluate(page, '(function(){movie.playRate=0;movie.playRate=-1;return movie.playRate;})()', '2')
      await evaluate(page, '(function(){movie.close();return [movie.status,movie.playRate,movie.audioVolume,movie.audioBalance,movie.mixingMovieAlpha,movie.enabledAudioStream,movie.enabledVideoStream].join(",");})()', 'unload,+0.0,100000,0,+0.0,-1,-1')
      await expect(page.locator('video')).toHaveCount(0)
      const audio = await observeVideoAudio(page)
      expect(audio.graphs).toHaveLength(0); expect(audio.liveUrls).toBe(0)
      await evaluate(page, '(function(){movie.playRate=0;movie.audioVolume=0;movie.mixingMovieAlpha=0;movie.open("sound.mp4");movie.play();return [movie.playRate,movie.audioVolume,movie.audioBalance,movie.mixingMovieAlpha,movie.left,movie.top,movie.width,movie.height,movie.visible,movie.loop,movie.mode].join(",");})()', '1,100000,0,1,4,5,64,48,1,1,2')
      await audible()
      observed = await inspect('new-graph-defaults')
      expect(observed.media.rate).toBe(1); expect(observed.media.opacity).toBe('1')
      expect(observed.media.background).toBe('rgb(0, 0, 0)')
      expect(observed.audio.graphs).toHaveLength(1); expect(observed.audio.liveUrls).toBe(1)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('video-graph-owned-controls', { contentType: 'application/json', body: JSON.stringify({
      readings, media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else await stopGeometryPage(page)
      const audio = await observeVideoAudio(page)
      expect(audio.graphs).toHaveLength(0); expect(audio.liveUrls).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Graph controls and cleanup failed', { cause: failures[0] })
  })
}
