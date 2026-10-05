import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

interface ClockObservation { element: number; position: number; paused: boolean }
interface SwitchProbe { freezes: ClockObservation[]; resumes: ClockObservation[] }
declare global { interface Window { playingAudioSwitch: SwitchProbe } }

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['numbered-fragmented', 'numbered-interleaved']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: playing audio switches preserve the frozen clock and resume one selected graph`, async ({ page }, info) => {
    test.setTimeout(120000)
    await installVideoAudioProbe(page)
    await page.addInitScript(() => {
      const probe: SwitchProbe = { freezes: [], resumes: [] }, ids = new WeakMap<HTMLMediaElement, number>(),
        pause = HTMLMediaElement.prototype.pause, play = HTMLMediaElement.prototype.play
      let serial = 0
      window.playingAudioSwitch = probe
      const observation = (element: HTMLMediaElement) => {
        if (!ids.has(element)) ids.set(element, ++serial)
        return { element: ids.get(element)!, position: element.currentTime, paused: element.paused }
      }
      HTMLMediaElement.prototype.pause = function () {
        const moving = this instanceof HTMLVideoElement && !!this.dataset.videoId && !this.paused
        pause.call(this)
        if (moving) probe.freezes.push(observation(this))
      }
      HTMLMediaElement.prototype.play = function () {
        if (this instanceof HTMLVideoElement && this.dataset.videoId) probe.resumes.push(observation(this))
        return play.call(this)
      }
    })
    const game = await launchWindowAttention(page, backend, binary, String.raw`
var win=new Window();win.caption="Playing audio switch";win.setInnerSize(96,64);win.visible=true;
var root=new Layer(win,null);win.add(root);root.setSize(96,64);root.fillRect(0,0,96,64,0xff000000);
var image=new Layer(win,root);image.visible=true;
var movie=new VideoOverlay(win);movie.mode=vomLayer;movie.layer1=image;
movie.open("numbered.mp4");movie.pause();movie.frame=12;
`, [{ name: 'numbered.mp4', mimeType: 'video/mp4',
      buffer: readFileSync(resolve(`out/verification/video-tracks/${container}.mp4`)) }]),
      failures: unknown[] = [], readings: unknown[] = []
    try {
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      for (const stream of [1, 0, 1]) {
        await evaluate(page, '(movie.position=1000,movie.play(),movie.status)', 'play')
        const previous = await page.locator('video[data-video-id]').evaluate((node) => (node as HTMLVideoElement).currentTime)
        // Wait for actual media time, rather than sleeping and assuming that
        // autoplay or decoding has started. Selection begins during playback.
        await expect(async () => {
          const activation = page.getByRole('button', { name: '播放视频', exact: true })
          if (await activation.isVisible()) await activation.click({ timeout: 500 })
          expect(await page.locator('video[data-video-id]').evaluate((node) => (node as HTMLVideoElement).currentTime))
            .toBeGreaterThan(previous + 0.02)
        }).toPass({ timeout: 12000 })
        await page.evaluate(() => { window.playingAudioSwitch.freezes = []; window.playingAudioSwitch.resumes = [] })
        await evaluate(page, `(movie.enabledAudioStream=${stream},movie.enabledAudioStream+"|"+movie.status)`, `${stream}|play`)
        const proof = await page.evaluate(() => window.playingAudioSwitch)
        expect(proof.freezes).toHaveLength(1)
        const frozen = proof.freezes[0]!, resumed = proof.resumes.find((value) => value.element !== frozen.element)
        expect(frozen.paused).toBe(true)
        expect(frozen.position).toBeGreaterThan(1)
        expect(resumed).toBeDefined()
        expect(resumed!.paused).toBe(true)
        expect(Math.abs(resumed!.position - frozen.position)).toBeLessThanOrEqual(0.000001)
        await expect.poll(() => page.locator('video[data-video-id]').evaluate((node) => (node as HTMLVideoElement).currentTime))
          .toBeGreaterThan(frozen.position + 0.02)
        await expect.poll(async () => {
          const graph = (await observeVideoAudio(page)).graphs[0]
          return graph && graph.peak > 0.01 ? Math.abs(graph.frequency - (stream ? 880 : 440)) : 10000
        }).toBeLessThan(25)
        const resources = await observeVideoAudio(page)
        expect(resources.liveUrls).toBe(1)
        expect(resources.graphs).toHaveLength(1)
        await expect(page.locator('video[data-video-id]')).toHaveCount(1)
        readings.push({ stream, proof, resources })
      }
      await evaluate(page, '(movie.pause(),movie.frame=10,movie.frame)', '10')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('playing-audio-switch-clocks', { contentType: 'application/json', body: JSON.stringify({
      scope: 'Passive actual pause/play clock observations; playback is not required to freeze the preceding frame pixels.',
      backend, binary, container, readings, media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      await game.stop()
      const resources = await observeVideoAudio(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
      expect(resources.createdUrls).toBe(resources.revokedUrls)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Playing audio switch or cleanup failed', { cause: failures[0] })
  })
}
