import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { captureHandoff, installHandoffReadbacks } from '../helpers/video-handoff-capture.ts'
import { installVideoSeekRegistrations, observeVideoSeekRegistrations } from '../helpers/video-seek-registration.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
for (const container of ['numbered-multitrack', 'numbered-interleaved']) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}/${container}: audio handoff preserves every decoded and drawn byte at a frozen clock`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], readings: unknown[] = [], rawReadbacks: unknown[] = [], gpuComparisons: unknown[] = []
    await installVideoSeekRegistrations(page)
    await observeVideoFrames(page)
    await installVideoAudioProbe(page)
    await installHandoffReadbacks(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined, sequence = 0
    const run = async (expression: string, expected: string) => {
      const marker = `handoff-${++sequence}:`, source = `${JSON.stringify(marker)}+string(${expression})`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.locator('#expression').fill(source)
      await expect(page.locator('#expression')).toHaveValue(source)
      // Submit the real console form with a keyboard action. Firefox's archived
      // viewport-capture case never passed Playwright's mouse stability wait,
      // although this same input remained editable and the form was enabled.
      await page.locator('#expression').press('Enter', { timeout: 5000 })
      // Observe the bounded host's 15 s error as well as a successful return;
      // exact clock/image expectations below are independent of this deadline.
      await expect(page.getByText(marker + expected, { exact: true })).toBeVisible({ timeout: 20000 })
      await expect(page.getByText(marker + expected, { exact: true })).toHaveCount(1)
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
        const value = { ...await captureHandoff(page, surface, (raw) => rawReadbacks.push(raw)),
          resources: await observeVideoAudio(page) }
        readings.push(value)
        expect(value.production, 'the host must have read the real current source').toBeDefined()
        expect(value.production!.willReadFrequently).toBe(true)
        expect([value.production!.width, value.production!.height]).toEqual([64, 48])
        expect(Math.abs(value.production!.position - value.media.position)).toBeLessThanOrEqual(0.000001)
        expect(value.reads.cpu).toEqual(value.production!.pixels)
        expect(value.reads.cpuRepeated).toEqual(value.reads.cpu)
        expect(value.reads.cpuRedrawn).toEqual(value.reads.cpu)
        const painted: number[] = []
        expect([value.paint.width, value.paint.height]).toEqual([96, 64])
        for (let row = 0; row < 48; row++) {
          const from = row * value.paint.width * 4
          painted.push(...value.paint.pixels.slice(from, from + 64 * 4))
        }
        expect(painted, 'all decoded bytes must reach the actual bound Layer').toEqual(value.reads.cpu)
        return value
      }
      // First cover the no-seek, completed-initial-presentation path at zero.
      const zero = await capture()
      await run('(function(){movie.selectAudioStream(0);return movie.enabledAudioStream+","+movie.status;})()', '0,pause')
      const zeroSelected = await capture()
      gpuComparisons.push({ phase: 'zero-audio-switch', before: zero.reads.default, after: zeroSelected.reads.default,
        difference: zeroSelected.reads.default.map((value, at) => value - zero.reads.default[at]!) })
      expect(zeroSelected.reads.cpu).toEqual(zero.reads.cpu)
      expect(zeroSelected.paint).toEqual(zero.paint)
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
        gpuComparisons.push({ phase: `frame-10-audio-${stream}`, before: before.reads.default, after: after.reads.default,
          difference: after.reads.default.map((value, at) => value - before.reads.default[at]!) })
        expect(after.media.paused).toBe(true); expect(after.media.seeking).toBe(false)
        expect(Math.abs(after.media.position - before.media.position)).toBeLessThanOrEqual(0.000001)
        expect(after.reads.cpu).toEqual(before.reads.cpu)
        expect(after.paint).toEqual(before.paint)
        expect(after.media.pixels).toEqual(before.media.pixels)
        expect(after.screen).toEqual(before.screen)
        expect(after.resources.createdUrls).toBeGreaterThan(before.resources.createdUrls)
        expect(after.resources.liveUrls).toBe(1); expect(after.resources.graphs).toHaveLength(1)
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    // These already copied bytes do not depend on a responsive page. A
    // compositor/protocol error must not erase the completed readback evidence.
    try { await info.attach('handoff-completed-readbacks', { contentType: 'application/json',
      body: JSON.stringify({ backend, binary, container, readings, rawReadbacks, gpuComparisons }) }) }
    catch (error) { failures.push(error) }
    try { await info.attach('numbered-complete-frame-handoff', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, container, readings, rawReadbacks, gpuComparisons,
      media: await observeVideoMedia(page), registrations: await observeVideoSeekRegistrations(page),
      logs: await page.locator('#logs').innerText(),
    }) }) } catch (error) { failures.push(error) }
    try {
      const modalStop = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modalStop.count()) await modalStop.last().press('Enter', { timeout: 5000 })
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      if (game) await game.waitForStopped()
      else await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video,.video-plane')).toHaveCount(0)
      const resources = await observeVideoAudio(page)
      expect(resources.liveUrls).toBe(0); expect(resources.graphs).toHaveLength(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Complete numbered image handoff and cleanup failed', { cause: failures[0] })
  })
}
