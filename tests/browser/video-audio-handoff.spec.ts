import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['numbered-multitrack', 'numbered-interleaved']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: audio handoff preserves every decoded and drawn byte at a frozen clock`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], readings: unknown[] = []
    await observeVideoFrames(page)
    await installVideoAudioProbe(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined, sequence = 0
    const run = async (expression: string, expected: string) => {
      const marker = `handoff-${++sequence}:`, source = `${JSON.stringify(marker)}+string(${expression})`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.locator('#expression').fill(source)
      await expect(page.locator('#expression')).toHaveValue(source)
      await page.locator('#evaluate').click()
      // Observe the bounded host's 15 s error as well as a successful return;
      // exact clock/image expectations below are independent of this deadline.
      await expect(page.getByText(marker + expected, { exact: true })).toBeVisible({ timeout: 20000 })
    }
    try {
      game = await launchWindowAttention(page, backend, binary, `
var win=new Window();win.caption="handoff";win.setInnerSize(96,64);win.visible=true;
var root=new Layer(win,null);root.setSize(96,64);root.fillRect(0,0,96,64,0xff000000);
var image=new Layer(win,root);image.visible=true;
var movie=new VideoOverlay(win);movie.mode=vomLayer;movie.layer1=image;
movie.open("numbered.mp4");movie.pause();
movie.enabledAudioStream=1;
`, [{ name: 'numbered.mp4', mimeType: 'video/mp4',
        buffer: readFileSync(resolve(`out/verification/video-tracks/${container}.mp4`)) }], true)
      const surface = game.surface('handoff')
      const capture = async () => {
        const media = await page.locator('video[data-video-id]').evaluate((node) => {
          const video = node as HTMLVideoElement, canvas = new OffscreenCanvas(video.videoWidth, video.videoHeight),
            context = canvas.getContext('2d')!
          context.drawImage(video, 0, 0)
          return { position: video.currentTime, paused: video.paused, seeking: video.seeking,
            width: canvas.width, height: canvas.height, pixels: [...context.getImageData(0, 0, canvas.width, canvas.height).data] }
        })
        const png = await surface.locator('canvas[data-window-id]').screenshot()
        const screen = await page.evaluate(async (url) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
            context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
          try {
            context.drawImage(bitmap, 0, 0)
            return { width: bitmap.width, height: bitmap.height,
              pixels: [...context.getImageData(0, 0, bitmap.width, bitmap.height).data] }
          } finally { bitmap.close() }
        }, 'data:image/png;base64,' + png.toString('base64'))
        const value = { media, screen, resources: await observeVideoAudio(page) }
        readings.push(value)
        return value
      }
      // First cover the no-seek, completed-initial-presentation path at zero.
      const zero = await capture()
      await run('(function(){movie.selectAudioStream(0);return movie.enabledAudioStream+","+movie.status;})()', '0,pause')
      const zeroSelected = await capture()
      expect(zeroSelected.media.pixels).toEqual(zero.media.pixels)
      expect(zeroSelected.screen).toEqual(zero.screen)
      expect(Math.abs(zeroSelected.media.position - zero.media.position)).toBeLessThanOrEqual(0.000001)
      await run('(function(){movie.frame=10;return movie.frame;})()', '10')
      const before = await capture()
      expect(before.media.paused).toBe(true); expect(before.media.seeking).toBe(false)
      expect([before.media.width, before.media.height, before.media.pixels.length]).toEqual([64, 48, 12288])
      expect(before.media.pixels, 'the numbered source must distinguish these images').not.toEqual(zero.media.pixels)
      expect(before.screen.pixels, 'numbered frames must reach the actual game canvas').not.toEqual(zero.screen.pixels)
      for (const stream of [1, 0]) {
        await run(`(function(){movie.enabledAudioStream=${stream};return movie.enabledAudioStream+","+movie.frame+","+movie.status;})()`, `${stream},10,pause`)
        const after = await capture()
        expect(after.media.paused).toBe(true); expect(after.media.seeking).toBe(false)
        expect(Math.abs(after.media.position - before.media.position)).toBeLessThanOrEqual(0.000001)
        expect(after.media.pixels).toEqual(before.media.pixels)
        expect(after.screen).toEqual(before.screen)
        expect(after.resources.createdUrls).toBeGreaterThan(before.resources.createdUrls)
        expect(after.resources.liveUrls).toBe(1); expect(after.resources.graphs).toHaveLength(1)
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('numbered-complete-frame-handoff', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, container, readings, media: await observeVideoMedia(page), logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else await stopGeometryPage(page)
      await expect(page.locator('video,.video-plane')).toHaveCount(0)
      const resources = await observeVideoAudio(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Complete numbered image handoff and cleanup failed', { cause: failures[0] })
  })
}
