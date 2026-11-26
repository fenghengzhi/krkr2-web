import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { largeVideoGame } from '../helpers/large-video-game.ts'
import { receivedMovieBytes, videoRangeServer } from '../helpers/video-range-server.ts'
import { installVideoSourceObservation, observeVideoSources } from '../helpers/video-source-observation.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { installWorkerRpcObservation, observeWorkerRpc } from '../helpers/worker-rpc-observation.ts'

const game = String.raw`
System.exitOnNoWindowStartup=false;
var rangeWindow=new Window();rangeWindow.caption="Range fallback movie";rangeWindow.setInnerSize(96,80);rangeWindow.visible=true;
var rangeRoot=new Layer(rangeWindow,null);rangeRoot.setSize(96,80);rangeRoot.fillRect(0,0,96,80,0xff102030);
var rangePlay=new Layer(rangeWindow,rangeRoot);rangePlay.setPos(0,56,96,24);rangePlay.fillRect(0,0,96,24,0xff408060);rangePlay.visible=true;
var rangeMovie=new VideoOverlay(rangeWindow);rangeMovie.mode=vomMixer;rangeMovie.setBounds(0,0,64,48);rangeMovie.visible=true;
Debug.message("range-before-open");
rangeMovie.open("cutscene.mp4");rangeMovie.pause();
rangePlay.onClick=function(){global.rangeMovie.loop=true;global.rangeMovie.play();global.Debug.message("range-playing");};
Debug.message("range-open:"+[rangeMovie.originalWidth,rangeMovie.originalHeight,rangeMovie.numberOfVideoStream,rangeMovie.numberOfAudioStream,rangeMovie.status].join(","));
`

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: HTTP XP3 builds a large movie Blob in chunks, plays it and cancels an unfinished second load`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let directory: string | undefined, server: Awaited<ReturnType<typeof videoRangeServer>> | undefined,
      asset: Awaited<ReturnType<typeof largeVideoGame>> | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await installVideoSourceObservation(page)
    await installVideoAudioProbe(page)
    await installWorkerRpcObservation(page)
    await observeVideoFrames(page)
    await page.goto('/?backend=' + backend)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({
      has: page.locator('.game-window-title', { hasText: /^Range fallback movie$/ }),
    }).locator('canvas[data-window-id]'), movieOffset = 19 + Buffer.byteLength(game),
      holdAt = movieOffset + 8 * 1024 * 1024,
      ready = page.getByText('range-open:64,48,2,2,pause', { exact: true }),
      stop = async () => {
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('#stop')).toBeDisabled()
        await expect(page.locator('#stage canvas,video')).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
        const audio = await observeVideoAudio(page)
        expect(audio.graphs).toHaveLength(0); expect(audio.liveUrls).toBe(0)
        expect(audio.revokedUrls).toBe(audio.createdUrls)
        for (const worker of (await observeWorkerRpc(page)).workers) {
          expect(worker.terminated).toBe(1); expect(worker.pending).toEqual([])
          expect(worker.calls).toBe(worker.replies)
          expect(worker.duplicateReplies).toBe(0); expect(worker.droppedPending).toBe(0)
        }
      },
      load = async (path: string) => {
        await expect(page.locator('#load-url')).toBeEnabled()
        await page.locator('#remote-url').fill(server!.url + path)
        await page.locator('#load-url').click()
      }
    try {
      directory = await mkdtemp(join(tmpdir(), 'krkr-range-video-'))
      asset = await largeVideoGame(directory, true, game, 68 * 1024 * 1024)
      expect(asset.size).toBeGreaterThan(64 * 1024 * 1024)
      expect(asset.size).toBeLessThan(76 * 1024 * 1024)
      expect(holdAt - movieOffset).toBeLessThan(asset.mediaStart)
      server = await videoRangeServer(asset.paths[0]!, holdAt)
      await load('/play.xp3')
      await expect(ready).toHaveCount(1, { timeout: 45000 })
      await expect(page.locator('#evaluate')).toBeEnabled()
      const source = await observeVideoSources(page)
      expect(source.dropped).toBe(0); expect(source.opens).toHaveLength(1)
      expect(source.opens[0]!.name).toMatch(/cutscene\.mp4$/)
      expect(source.opens[0]!.kind).toBe('blob')
      expect(source.opens[0]!.buffered).toBe(true)
      expect(source.opens[0]!.bytes).toBe(asset.size)
      const coverageAtReady = receivedMovieBytes(server.responses, '/play.xp3', movieOffset, asset.size)
      expect(coverageAtReady).toBe(asset.size)
      const bodyRanges = server.responses.filter((row) => row.path === '/play.xp3' && row.to >= movieOffset && row.from < movieOffset + asset!.size)
      expect(bodyRanges.length).toBeGreaterThan(3)
      expect(bodyRanges.every((row) => row.to - row.from + 1 < 64 * 1024 * 1024)).toBe(true)
      expect(server.requests.filter((request) => request.method === 'GET').every((request) =>
        request.range !== undefined && (request.range === 'bytes=0-0' || request.match === server!.tag))).toBe(true)
      const video = page.locator('video[data-video-id]')
      await expect(video).toHaveCount(1)
      const first = await video.evaluate((node) => {
        const video = node as HTMLVideoElement, context = new OffscreenCanvas(video.videoWidth, video.videoHeight).getContext('2d')!
        context.drawImage(video, 0, 0)
        return { width: video.videoWidth, height: video.videoHeight, paused: video.paused, position: video.currentTime,
          frames: Number(video.dataset.presentedFrames), pixel: [...context.getImageData(30, 25, 1, 1).data] }
      })
      expect([first.width, first.height]).toEqual([64, 48])
      expect(first.frames).toBeGreaterThan(0); expect(first.paused).toBe(true)
      expect(first.pixel[0]).toBeGreaterThan(175); expect(first.pixel[2]).toBeLessThan(105)
      expect(first.pixel[3]).toBe(255)
      observations.push({ phase: 'ready-after-complete-Blob', source, coverageAtReady, first,
        transport: server.stats() })
      await info.attach('range-movie-first-frame', { body: await video.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      const bounds = await canvas.boundingBox(); expect(bounds).not.toBeNull()
      await canvas.click({ position: { x: 40 * bounds!.width / 96, y: 68 * bounds!.height / 80 } })
      await expect(page.getByText('range-playing', { exact: true })).toHaveCount(1)
      const activate = page.getByRole('button', { name: '播放视频', exact: true })
      await expect.poll(async () => await activate.isVisible() || await video.evaluate((node) => !(node as HTMLVideoElement).paused)).toBe(true)
      if (await activate.isVisible()) await activate.click()
      await expect.poll(() => video.evaluate((node) => (node as HTMLVideoElement).currentTime)).toBeGreaterThan(first.position + 0.25)
      await expect.poll(() => video.evaluate((node) => Number((node as HTMLElement).dataset.presentedFrames))).toBeGreaterThan(first.frames)
      observations.push({ phase: 'playing', media: await observeVideoMedia(page), audio: await observeVideoAudio(page) })
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await stop()

      // A distinct URL creates a new HTTP source/cache. The held byte is in
      // mdat padding, far from the XP3 index and MP4 moov/real packet regions.
      // Reaching it proves a complete-Blob fallback read is actually pending.
      await load('/held.xp3')
      await expect.poll(() => server!.responses.filter((row) => row.held).length).toBe(1)
      const held = server.responses.find((row) => row.held)!
      expect(held.path).toBe('/held.xp3'); expect(held.sent).toBe(0); expect(held.closed).toBe(false)
      expect(receivedMovieBytes(server.responses, '/held.xp3', movieOffset, asset.size)).toBeLessThan(asset.size)
      expect((await observeVideoSources(page)).opens).toEqual(source.opens)
      await expect(ready).toHaveCount(1)
      const pending = (await observeWorkerRpc(page)).workers
      expect(pending).toHaveLength(2)
      expect(pending[1]!.pending.some((call) => call.method === 'start')).toBe(true)
      observations.push({ phase: 'held-fallback-body', held: { ...held }, rpc: pending, transport: server.stats() })
      const aborted = server.stats().aborted
      await stop()
      await expect.poll(() => held.aborted).toBe(true)
      await expect.poll(() => server!.stats().aborted).toBeGreaterThan(aborted)
      await expect.poll(() => server!.stats().pendingResponses).toBe(0)
      await expect.poll(() => server!.stats().pendingFileReads).toBe(0)
      expect(held.finished).toBe(false)
      expect((await observeVideoSources(page)).opens).toEqual(source.opens)
      await expect(ready).toHaveCount(1)
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(server.errors).toEqual([]); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try {
      await info.attach('range-video-fallback', { contentType: 'application/json', body: JSON.stringify({
        backend, movieBytes: asset?.size, firstPacketRegion: asset?.mediaStart, movieOffset, holdAt,
        observations, source: await observeVideoSources(page), media: await observeVideoMedia(page),
        audio: await observeVideoAudio(page), rpc: await observeWorkerRpc(page), requests: server?.requests,
        responses: server?.responses, transport: server?.stats(), serverErrors: server?.errors,
        pageErrors: errors, logs: await page.locator('#logs').innerText(),
        failures: failures.map((error) => error instanceof Error ? error.message : String(error)),
        scope: 'Real HTTP Range raw-XP3 source with no borrowable Blob. The fallback reads the complete 68+ MiB movie in bounded chunks before opening its Blob; no early playback claim. Actual first frame/play and cancellation of a held second fallback body.',
      }, null, 2) })
    } catch (error) { failures.push(error) }
    try { await server?.close() } catch (error) { failures.push(error) }
    try { if (directory) await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'HTTP large-video fallback or cleanup failed', { cause: failures[0] })
  })
