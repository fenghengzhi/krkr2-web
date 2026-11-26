import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

interface ClockObservation { element: number; position: number; paused: boolean; committed: boolean }
interface SwitchProbe { pauseReturns: ClockObservation[]; freezes: ClockObservation[];
  resumes: ClockObservation[]; seeks: (ClockObservation & { requested: number })[] }
interface PresentationReference {
  commit: string
  fixtures: { file: string; bytes: number; sha256: string;
    streams: { codec_type: string; time_base: string }[];
    frames: { frame: { best_effort_timestamp?: number | string; pts?: number | string } }[] }[]
}
declare global { interface Window { playingAudioSwitch: SwitchProbe } }

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['numbered-fragmented', 'numbered-interleaved']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: playing audio switches preserve the frozen clock and resume one selected graph`, async ({ page }, info) => {
    test.setTimeout(120000)
    const movieBytes = readFileSync(resolve(`out/verification/video-tracks/${container}.mp4`)),
      references = JSON.parse(readFileSync(resolve('out/verification/video-tracks/presentation-reference.json'), 'utf8')) as PresentationReference,
      reference = references.fixtures.find((entry) => entry.file === container + '.mp4')
    if (!reference) throw new Error('Independent presentation reference is missing')
    if (process.env.GITHUB_SHA) expect(references.commit).toBe(process.env.GITHUB_SHA)
    expect(movieBytes.length).toBe(reference.bytes)
    expect(createHash('sha256').update(movieBytes).digest('hex')).toBe(reference.sha256)
    const video = reference.streams.find((stream) => stream.codec_type === 'video'),
      sourceFrame = reference.frames[0]?.frame
    if (!video || !sourceFrame) throw new Error('Independent first picture timestamp is missing')
    const [numerator, denominator] = video.time_base.split('/').map(Number),
      firstPts = Number(sourceFrame.best_effort_timestamp ?? sourceFrame.pts),
      firstSeconds = firstPts * numerator! / denominator!
    expect(Number.isSafeInteger(firstPts)).toBe(true)
    expect(numerator).toBeGreaterThan(0); expect(denominator).toBeGreaterThan(0)
    expect(Number.isFinite(firstSeconds)).toBe(true); expect(firstSeconds).toBeGreaterThanOrEqual(0)
    await installVideoAudioProbe(page)
    await page.addInitScript(() => {
      const probe: SwitchProbe = { pauseReturns: [], freezes: [], resumes: [], seeks: [] }, ids = new WeakMap<HTMLMediaElement, number>(),
        pause = HTMLMediaElement.prototype.pause, play = HTMLMediaElement.prototype.play
      let serial = 0
      window.playingAudioSwitch = probe
      const observation = (element: HTMLMediaElement) => {
        if (!ids.has(element)) ids.set(element, ++serial)
        return { element: ids.get(element)!, position: element.currentTime, paused: element.paused,
          committed: !!element.dataset.videoId }
      }
      const clock = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!
      Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', { ...clock,
        set(this: HTMLMediaElement, requested: number) {
          if (this instanceof HTMLVideoElement) probe.seeks.push({ ...observation(this), requested })
          clock.set!.call(this, requested)
        },
      })
      HTMLMediaElement.prototype.pause = function () {
        const moving = this instanceof HTMLVideoElement && !!this.dataset.videoId && !this.paused
        const element = this, stopped = () => probe.freezes.push(observation(element))
        if (moving) element.addEventListener('pause', stopped, { once: true })
        try {
          pause.call(element)
          if (moving) probe.pauseReturns.push(observation(element))
        } catch (error) {
          element.removeEventListener('pause', stopped)
          throw error
        }
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
      buffer: movieBytes }]),
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
        await page.evaluate(() => { window.playingAudioSwitch.pauseReturns = []; window.playingAudioSwitch.freezes = []; window.playingAudioSwitch.resumes = []; window.playingAudioSwitch.seeks = [] })
        await evaluate(page, `(movie.enabledAudioStream=${stream},movie.enabledAudioStream+"|"+movie.status)`, `${stream}|play`)
        const proof = await page.evaluate(() => window.playingAudioSwitch)
        expect(proof.pauseReturns).toHaveLength(1)
        expect(proof.freezes).toHaveLength(1)
        const frozen = proof.freezes[0]!, resumed = proof.resumes.find((value) => value.element !== frozen.element)
        expect(proof.pauseReturns[0]!.element).toBe(frozen.element)
        expect(proof.pauseReturns[0]!.paused).toBe(true)
        expect(frozen.paused).toBe(true)
        expect(frozen.position).toBeGreaterThan(1)
        expect(resumed).toBeDefined()
        expect(resumed!.paused).toBe(true)
        expect(frozen.committed).toBe(true); expect(resumed!.committed).toBe(true)
        const seeks = proof.seeks.filter((value) => value.element === resumed!.element),
          preparation = seeks.slice(0, -1), final = seeks.at(-1)
        expect(final).toBeDefined(); expect(final!.requested).toBe(frozen.position)
        expect(seeks.filter((value) => value.requested === frozen.position)).toHaveLength(1)
        expect(seeks.every((value) => !value.committed && value.paused)).toBe(true)
        // Initial empty edits and muted first-frame recovery may seek this
        // private decoder before its handoff. They must stay at source start;
        // only the final assignment carries the old graph's frozen seconds.
        expect(preparation.length).toBeLessThanOrEqual(3)
        for (const value of preparation)
          expect(Math.min(Math.abs(value.requested), Math.abs(value.requested - firstSeconds))).toBeLessThanOrEqual(0.000001)
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
      scope: 'Passive pause() returns and actual pause events are recorded separately. The actual stopped-event seconds must reach the selected graph unchanged before its committed play. Bounded private first-picture preparation is checked against independent source PTS/zero; all original frequency, resource and precise clock gates remain.',
      reference: { file: reference.file, sha256: reference.sha256, firstPts, timeBase: video.time_base, firstSeconds },
      backend, binary, container, readings, latest: await page.evaluate(() => window.playingAudioSwitch),
      media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText(),
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
