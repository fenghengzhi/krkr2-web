import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['multitrack', 'interleaved']) for (const mode of [1, 2]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}/mode${mode}: video selection changes the complete image while retaining audio, clock and bindings`, async ({ page }, info) => {
    test.setTimeout(150000)
    const failures: unknown[] = [], readings: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    await installVideoAudioProbe(page)
    await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      game = await launchWindowAttention(page, backend, binary, `
var win=new Window();win.caption="video-streams";win.setInnerSize(240,60);win.visible=true;
var root=new Layer(win,null);root.setSize(240,60);root.fillRect(0,0,240,60,0xff000000);
var a=new Layer(win,root),b=new Layer(win,root);a.visible=b.visible=true;b.left=80;
var r0=new Layer(win,root),r1=new Layer(win,root);r0.left=r1.left=160;r0.visible=true;r1.visible=false;
var movie=new VideoOverlay(win);movie.mode=${mode};movie.layer1=a;movie.layer2=b;
movie.setBounds(0,0,80,60);movie.open("tracks.mp4");movie.visible=true;movie.pause();movie.position=1000;
movie.enabledAudioStream=1;
var ref0=new VideoOverlay(win);ref0.mode=vomLayer;ref0.layer1=r0;ref0.open("ref0.mp4");ref0.audioVolume=0;ref0.pause();ref0.position=1000;
var ref1=new VideoOverlay(win);ref1.mode=vomLayer;ref1.layer1=r1;ref1.open("ref1.mp4");ref1.audioVolume=0;ref1.pause();ref1.position=1000;
`, [
        { name: 'tracks.mp4', mimeType: 'video/mp4', buffer: readFileSync(resolve(`out/verification/video-tracks/video-${container}.mp4`)) },
        ...[0, 1].map((index) => ({ name: `ref${index}.mp4`, mimeType: 'video/mp4',
          buffer: readFileSync(resolve(`out/verification/video-tracks/video-reference-${index}.mp4`)) })),
      ], true)
      await expect(page.locator('video[data-video-id]')).toHaveCount(3)
      const capture = async (stream: number) => {
        const media = await page.locator('video[data-video-id]').evaluateAll((nodes) => nodes.map((node) => {
          const video = node as HTMLVideoElement, canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight),
            context = canvas.getContext('2d')!
          context.drawImage(video, 0, 0)
          return { position: video.currentTime, paused: video.paused, seeking: video.seeking,
            width: canvas.width, height: canvas.height, pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] }
        }))
        expect(media).toHaveLength(3)
        const actual = media[0]!, reference = media[stream + 1]!
        expect([actual.width, actual.height]).toEqual(stream ? [80, 60] : [64, 48])
        expect(actual.pixels).toEqual(reference.pixels)
        expect(actual.paused).toBe(true); expect(actual.seeking).toBe(false)
        expect(Math.abs(actual.position - 1)).toBeLessThanOrEqual(0.000001)
        if (mode === 1) {
          // Independent FFmpeg stream-copy references use one video track.
          // Compare both bound Layer regions against that reference through
          // a real game-canvas screenshot, in addition to complete decoder RGBA.
          const png = await game!.surface('video-streams').locator('canvas[data-window-id]').screenshot()
          const screen = await page.evaluate(async (url) => {
            const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
              context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
            try {
              context.drawImage(bitmap, 0, 0)
              const width = bitmap.width / 3
              if (!Number.isInteger(width)) throw new Error('Unexpected game screenshot width')
              return [0, 1, 2].map((index) => [...context.getImageData(index * width, 0, width, bitmap.height).data])
            } finally { bitmap.close() }
          }, 'data:image/png;base64,' + png.toString('base64'))
          expect(screen[0]).toEqual(screen[2]); expect(screen[1]).toEqual(screen[2])
          await info.attach(`video-track-${stream}-${readings.length}`, { body: png, contentType: 'image/png' })
        }
        const resources = await observeVideoAudio(page)
        expect(resources.liveUrls).toBe(3); expect(resources.graphs).toHaveLength(3)
        readings.push({ stream, media, resources })
      }
      await capture(0)
      for (const stream of [1, 0, 1]) {
        const fps = mode === 2 || stream === 0 ? 12 : 10,
          dimensions = mode === 2 || stream === 0 ? '64,48' : '80,60'
        await evaluate(page, `(function(){movie.enabledVideoStream=${stream};r0.visible=${stream === 0};r1.visible=${stream === 1};
return [movie.enabledVideoStream,movie.enabledAudioStream,movie.status,movie.position,movie.fps,movie.frame,
movie.originalWidth,movie.originalHeight,movie.numberOfVideoStream,movie.layer1===a,movie.layer2===b,a.left,b.left].join(",");})()`,
        `${stream},1,pause,1000,${fps},${fps},${dimensions},2,1,1,0,80`)
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
      await evaluate(page, '(movie.close(),movie.enabledVideoStream+","+movie.numberOfVideoStream)', '-1,0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('video-stream-selection', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, container, mode, readings, media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop(); else await stopGeometryPage(page)
      const resources = await observeVideoAudio(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
      expect(resources.revokedUrls).toBe(resources.createdUrls)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Video stream selection or cleanup failed', { cause: failures[0] })
  })
}
