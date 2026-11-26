import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installVideoSeekRegistrations, observeVideoSeekRegistrations } from '../helpers/video-seek-registration.ts'
import { installHandoffReadbacks } from '../helpers/video-handoff-capture.ts'
import { selectionReadbacks, referencePanel, selectionRegion, selectionScreen } from '../helpers/video-selection-capture.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['multitrack', 'interleaved']) for (const mode of [1, 2]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}/mode${mode}: video selection changes the complete image while retaining audio, clock and bindings`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], readings: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    await installVideoAudioProbe(page)
    await installVideoSeekRegistrations(page)
    await installHandoffReadbacks(page)
    await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      game = await launchWindowAttention(page, backend, binary, `
var win=new Window();win.caption="video-streams";win.setInnerSize(256,64);win.visible=true;
var root=new Layer(win,null);root.setSize(256,64);root.fillRect(0,0,256,64,0xff000000);
var holder=new Layer(win,root);holder.setPos(2,2,252,60);holder.fillRect(0,0,252,60,0xff000000);holder.visible=true;
var a=new Layer(win,holder),b=new Layer(win,holder);a.visible=b.visible=true;b.left=84;
var r0=new Layer(win,holder),r1=new Layer(win,holder);r0.left=r1.left=168;r0.visible=true;r1.visible=false;
var movie=new VideoOverlay(win);movie.mode=${mode};movie.layer1=a;movie.layer2=b;
movie.setBounds(2,2,80,60);movie.open("tracks.mp4");movie.visible=true;movie.pause();movie.position=1000;
movie.enabledAudioStream=1;
var ref0=new VideoOverlay(win);ref0.mode=vomLayer;ref0.layer1=r0;ref0.open("ref0.mp4");ref0.audioVolume=0;ref0.pause();ref0.position=1000;
var ref1=new VideoOverlay(win);ref1.mode=vomLayer;ref1.layer1=r1;ref1.open("ref1.mp4");ref1.audioVolume=0;ref1.pause();ref1.position=1000;
`, [
        { name: 'tracks.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve(`out/verification/video-tracks/video-${container}.mp4`)) },
        ...[0, 1].map((index) => ({ name: `ref${index}.mp4`, mimeType: 'video/mp4',
          buffer: readFileSync(resolve(`out/verification/video-tracks/video-${container}-reference-${index}.mp4`)) })),
      ], true)
      await expect(page.locator('video[data-video-id]')).toHaveCount(3)
      const capture = async (stream: number) => {
        const canvas = game!.surface('video-streams').locator('canvas[data-window-id]'),
          readbacks = await selectionReadbacks(canvas), rawName = `video-selection-readbacks-${readings.length}.json.gz`,
          hash = (pixels: readonly number[]) => ({ bytes: pixels.length,
            sha256: createHash('sha256').update(Uint8Array.from(pixels)).digest('hex') }),
          reading: Record<string, unknown> = { stream, rawAttachment: rawName,
            media: readbacks.videos.map(({ before, after, capture, error }) => ({ before, after, error,
              ...(capture ? { width: capture.media.width, height: capture.media.height,
                cpu: hash(capture.reads.cpu), default: hash(capture.reads.default),
                production: capture.production && { ...capture.production, pixels: hash(capture.production.pixels) } } : {}) })) }
        readings.push(reading)
        // Complete CPU/default/repeated/redrawn/production bytes and all
        // deltas survive an assertion failure, without huge numeric JSON in
        // every successful report row. These are observations, not tolerances.
        await info.attach(rawName, { contentType: 'application/gzip', body: gzipSync(Buffer.from(JSON.stringify(readbacks))) })
        expect(readbacks.videos.map(({ before }) => before.id)).toEqual(['1', '2', '3'])
        for (const observation of readbacks.videos) {
          expect(observation.error).toBeUndefined()
          expect(observation.after).toEqual(observation.before)
          expect(observation.before.paused).toBe(true); expect(observation.before.seeking).toBe(false)
          expect(Math.abs(observation.before.position - 1)).toBeLessThanOrEqual(0.000001)
          // rVFC reports the sample's media time, not necessarily the seek
          // clock. The interleaved reference's frame containing 1 s starts
          // earlier. Preserve that observation; the independent stream-copy
          // decoder and complete pixels below identify the selected image.
          const presented = Number(observation.before.presentedTime)
          expect(Number.isFinite(presented)).toBe(true)
          expect(presented).toBeGreaterThanOrEqual(0)
          expect(presented).toBeLessThanOrEqual(observation.before.duration)
          expect(Number(observation.before.presentedFrames)).toBeGreaterThan(0)
          const sample = observation.capture!
          expect(sample.reads.cpuRepeated).toEqual(sample.reads.cpu)
          expect(sample.reads.cpuRedrawn).toEqual(sample.reads.cpu)
        }
        const actual = readbacks.videos[0]!.capture!.media, reference = readbacks.videos[stream + 1]!.capture!.media
        expect([actual.width, actual.height]).toEqual(stream ? [80, 60] : [64, 48])
        expect(actual.pixels).toEqual(reference.pixels)
        expect(actual.paused).toBe(true); expect(actual.seeking).toBe(false)
        expect(Math.abs(actual.position - 1)).toBeLessThanOrEqual(0.000001)
        if (mode === 1) {
          // Independent FFmpeg stream-copy references use one video track
          // from this exact container, with packet hashes and PTS/DTS checked
          // during generation (the historical regular references are retained).
          // Production layer readback also has to match; merely observing two
          // identical test-owned decoders would not prove the actual picture.
          for (const index of [0, stream + 1]) {
            const production = readbacks.videos[index]!.capture!.production!
            expect(production).toBeDefined(); expect(production.willReadFrequently).toBe(true)
            expect(production.source).toBe(readbacks.videos[index]!.before.source)
            expect(Math.abs(production.position - 1)).toBeLessThanOrEqual(0.000001)
            expect([production.width, production.height]).toEqual([reference.width, reference.height])
            expect(production.pixels).toEqual(reference.pixels)
          }
          const paint = readbacks.paint!, expected = referencePanel(reference.width, reference.height, reference.pixels)
          expect([paint.width, paint.height]).toEqual([256, 64])
          for (const x of [2, 86, 170]) expect(selectionRegion(paint.pixels, paint.width, x, 2)).toEqual(expected)
          const screen = await selectionScreen(page, canvas, info, `video-track-${stream}-${readings.length}`)
          reading.screen = { ...screen, panels: screen.panels.map(hash) }
          expect(screen.rectangles.map(({ width, height }) => [width, height])).toEqual(Array(3).fill([
            screen.rectangles[0]!.width, screen.rectangles[0]!.height]))
          expect(screen.panels[0]).toEqual(screen.panels[2]); expect(screen.panels[1]).toEqual(screen.panels[2])
        }
        const resources = await observeVideoAudio(page)
        expect(resources.liveUrls).toBe(3); expect(resources.graphs).toHaveLength(3)
        reading.resources = resources
      }
      await capture(0)
      for (const stream of [1, 0, 1]) {
        const fps = mode === 2 || stream === 0 ? 12 : 10,
          dimensions = mode === 2 || stream === 0 ? '64,48' : '80,60'
        await evaluate(page, `(function(){movie.enabledVideoStream=${stream};r0.visible=${stream === 0};r1.visible=${stream === 1};
return [movie.enabledVideoStream,movie.enabledAudioStream,movie.status,movie.position,movie.fps,movie.frame,
movie.originalWidth,movie.originalHeight,movie.numberOfVideoStream,movie.layer1===a,movie.layer2===b,a.left,b.left].join(",");})()`,
        `${stream},1,pause,1000,${fps},${fps},${dimensions},2,1,1,0,84`)
        await capture(stream)
      }
      const urls = (await observeVideoAudio(page)).createdUrls
      await evaluate(page, '(function(){movie.enabledVideoStream=1;movie.enabledVideoStream=-1;movie.enabledVideoStream=2;return movie.enabledVideoStream;})()', '1')
      expect((await observeVideoAudio(page)).createdUrls).toBe(urls)
      // Replacing audio must retain the selected video, including its full
      // image. Switching back proves the original multi-track source survived.
      await evaluate(page, '(movie.enabledAudioStream=0,movie.enabledVideoStream+","+movie.enabledAudioStream)', '1,0')
      await capture(1)
      if ((await page.locator('#sound-toggle').textContent()) === '开启声音') await page.locator('#sound-toggle').click()
      await evaluate(page, '(movie.loop=true,movie.play(),movie.status)', 'play')
      const audible = async () => {
        await expect(async () => {
          const activation = page.getByRole('button', { name: '播放视频', exact: true })
          if (await activation.isVisible()) await activation.click({ timeout: 500 })
          const graphs = (await observeVideoAudio(page)).graphs.filter((graph) => graph.peak > 0.01)
          expect(graphs).toHaveLength(1)
          expect(Math.abs(graphs[0]!.frequency - 440)).toBeLessThan(25)
        }).toPass({ timeout: 12000 })
      }
      await audible()
      await evaluate(page, '(function(){var before=movie.position;movie.enabledVideoStream=0;var after=movie.position;return movie.status=="play" && movie.enabledAudioStream==0 && after>=before-1 && after<=before+1000;})()', '1')
      await audible()
      await evaluate(page, '(movie.pause(),movie.position=1000,r0.visible=true,r1.visible=false,movie.enabledVideoStream)', '0')
      await capture(0)
      const registrations = await observeVideoSeekRegistrations(page),
        stagedSeeks = registrations.events.filter((event) => event.event === 'seek' && event.staged &&
          event.target! > 0 && Math.abs(event.target! - event.from!) > 1e-8)
      expect(registrations.dropped).toBe(0)
      expect(stagedSeeks.length).toBeGreaterThanOrEqual(3)
      // observeVideoFrames owns one independent callback. The transaction must
      // already own another before the real native currentTime setter runs;
      // compositor work is not serialized with subsequent main-thread calls.
      expect(stagedSeeks.every((event) => event.pending >= 2)).toBe(true)
      await evaluate(page, '(movie.close(),movie.enabledVideoStream+","+movie.numberOfVideoStream)', '-1,0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) {
      failures.push(error)
      try {
        const staged = page.locator('.video-parking video:not([data-video-id])')
        if (await staged.count()) {
          const decoded = await staged.first().evaluate((node) => {
            const candidate = node as HTMLVideoElement
            const pixels = (video: HTMLVideoElement) => {
              if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return
              const ctx = new OffscreenCanvas(video.videoWidth, video.videoHeight).getContext('2d')!
              ctx.drawImage(video, 0, 0)
              return ctx.getImageData(0, 0, video.videoWidth, video.videoHeight).data
            }
            const image = pixels(candidate)
            return { clock: candidate.currentTime, submittedTime: candidate.dataset.presentedTime,
              submittedFrames: candidate.dataset.presentedFrames, visibility: getComputedStyle(candidate).visibility,
              parkingOpacity: getComputedStyle(candidate.closest('.video-parking')!).opacity,
              comparisons: [...document.querySelectorAll<HTMLVideoElement>('video[data-video-id]')].map((video) => {
                const other = pixels(video)
                let differences: number | null = null
                if (image && other && video.videoWidth === candidate.videoWidth && video.videoHeight === candidate.videoHeight) {
                  differences = 0
                  for (let i = 0; i < image.length; i++) if (image[i] !== other[i]) differences++
                }
                return { id: video.dataset.videoId, clock: video.currentTime, width: video.videoWidth,
                  height: video.videoHeight, differentChannels: differences }
              }) }
          })
          await info.attach('parked-decoder-at-failure', { body: JSON.stringify(decoded), contentType: 'application/json' })
          // The assertion above keeps its original 12 s limit. Let the active
          // transaction record its own 15 s timeout/rollback before teardown.
          await staged.first().waitFor({ state: 'detached', timeout: 17000 })
        }
        const firstFrame = page.locator('.video-presentation-surface')
        if (await firstFrame.count()) {
          await info.attach('pending-initial-video-frame', { body: JSON.stringify(await observeVideoMedia(page)),
            contentType: 'application/json' })
          // Keep the failed 12 s startup assertion. Preserve the decoder's own
          // bounded timeout/error before Stop, including a committed-id ref0
          // which is not a staged audio/video replacement in .video-parking.
          await firstFrame.first().waitFor({ state: 'detached', timeout: 17000 })
        }
      } catch (diagnostic) { failures.push(diagnostic) }
    }
    try { await info.attach('video-stream-selection', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, container, mode, readings, media: await observeVideoMedia(page),
      seekRegistrations: await observeVideoSeekRegistrations(page), logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else {
        // Failed startup is cleanup, not a physical-input test. Firefox's
        // archived failure waited on click stability until the global timeout;
        // invoke the real Stop button once, then retain the actual retirement
        // and resource assertions without waiting for a compositor tick.
        const stop = page.locator('#stop')
        if (await stop.isEnabled()) await stop.dispatchEvent('click')
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('.game-window[data-window-id],.game-text-input')).toHaveCount(0)
      }
      const resources = await observeVideoAudio(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
      expect(resources.revokedUrls).toBe(resources.createdUrls)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Video stream selection or cleanup failed', { cause: failures[0] })
  })
}
