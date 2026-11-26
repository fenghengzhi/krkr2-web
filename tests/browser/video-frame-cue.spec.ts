import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { installHandoffReadbacks, type ProbeWindow } from '../helpers/video-handoff-capture.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { videoFrameCueSource } from '../helpers/video-frame-cue.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: movie frame callbacks change the current scene cue before it fires, including the last decoded frame`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], readings: unknown[] = [], traces: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await observeVideoFrames(page); await installHandoffReadbacks(page); await installVideoAudioProbe(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Movie frame cue order$/ }) }).locator('canvas[data-window-id]'),
      read = async (expression: string) => {
        const prefix = `frame-cue-read-${++sequence}:`
        await page.locator('#expression').fill(`${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
        await page.locator('#expression').press('Enter')
        const line = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
        await expect(line).toBeVisible({ timeout: 5000 })
        return ((await line.textContent()) ?? '').slice(prefix.length)
      }, capture = async (phase: string) => {
        const value = await canvas.evaluate((node) => {
          const canvas = node as HTMLCanvasElement,
            video = document.querySelector<HTMLVideoElement>(`video[data-video-id][data-window-id="${canvas.dataset.windowId}"]`)
          if (!video || video.readyState < 2 || !video.paused || video.seeking) throw new Error('Cue capture needs a real settled paused decoder')
          return { ...((window as unknown as ProbeWindow).handoffReadbacks.capture(video, canvas)),
            presentedFrames: Number(video.dataset.presentedFrames) }
        })
        readings.push({ phase, ...value })
        expect(value.dropped).toBe(0); expect(value.presentedFrames).toBeGreaterThan(0)
        expect(value.reads.cpuRepeated).toEqual(value.reads.cpu); expect(value.reads.cpuRedrawn).toEqual(value.reads.cpu)
        expect(value.production?.pixels).toEqual(value.media.pixels)
        expect([value.paint.width, value.paint.height]).toEqual([160, 80])
        for (const x of [0, 80]) {
          const pixels: number[] = []
          for (let y = 0; y < 48; y++) pixels.push(...value.paint.pixels.slice((y * 160 + x) * 4, (y * 160 + x + 64) * 4))
          expect(pixels, `${phase}, complete Layer at x=${x}`).toEqual(value.media.pixels)
        }
        return value.media.pixels
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("cue-game.tjs",System.dataPath+"cue-game.cjs",false,true,false);Scripts.execStorage(System.dataPath+"cue-game.cjs");'
          : 'Scripts.execStorage("cue-game.tjs");') },
        { name: 'cue-game.tjs', mimeType: 'text/plain', buffer: Buffer.from(videoFrameCueSource) },
        { name: 'colors.mp4', mimeType: 'video/mp4', buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)) },
      ])
      await expect(page.getByText('frame-cue-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      await expect(canvas).toBeVisible()
      const red = await capture('initial-red')
      for (const name of ['cancel', 'future', 'tail', 'close']) {
        const point = await pointerPixel(canvas, 80, 68); await page.mouse.click(point.x, point.y)
        await expect(page.getByText('frame-cue-start:' + name, { exact: true })).toBeVisible()
        const expected = `frame-cue-done:${name}:${name === 'cancel' ? 0 : 1}:${name === 'close' ? 'unload' : 'pause'}:-1`
        await expect(async () => {
          const activation = page.getByRole('button', { name: '播放视频', exact: true })
          if (await activation.isVisible()) await activation.click({ timeout: 500 })
          await expect(page.getByText(expected, { exact: true })).toHaveCount(1, { timeout: 500 })
        }).toPass({ timeout: 15000 })
        const trace = (await read('fcLog.join("|")')).split('|'),
          period = trace.findIndex((entry) => entry.startsWith('period:')),
          frames = trace.filter((entry) => entry.startsWith('frame:')).map((entry) => Number(entry.split(':')[1]))
        traces.push({ name, trace })
        expect(frames.length).toBeGreaterThan(0)
        if (name === 'cancel') {
          expect(trace).toContain('cancel'); expect(period).toBe(-1); expect(frames.at(-1)).toBeGreaterThanOrEqual(12)
        } else {
          expect(trace.filter((entry) => entry.startsWith('period:'))).toEqual([`period:1:${name === 'close' ? 'unload' : 'play'}`])
          expect(period).toBeGreaterThan(trace.findLastIndex((entry) => entry.startsWith('frame:')))
          if (name === 'future') { expect(trace.indexOf('future:8')).toBeLessThan(period); expect(frames.at(-1)).toBeGreaterThanOrEqual(8) }
          if (name === 'tail') expect(frames.at(-1)).toBe(17)
          if (name === 'close') expect(trace.indexOf('closed')).toBeLessThan(period)
        }
        if (name === 'close') {
          await expect(page.locator('video')).toHaveCount(0)
          const paint = await canvas.evaluate((node) => {
            const out = new OffscreenCanvas(160, 80), ctx = out.getContext('2d', { willReadFrequently: true })!
            ctx.drawImage(node as HTMLCanvasElement, 0, 0)
            return [0, 80].map((x) => [...ctx.getImageData(x, 0, 64, 48).data])
          })
          for (const pixels of paint) expect(pixels).toEqual(red)
          expect((await observeVideoAudio(page)).liveUrls).toBe(0)
        } else {
          const pixels = await capture(name)
          expect(pixels).not.toEqual(red)
        }
        await expect(page.locator('#logs .error')).toHaveCount(0)
      }
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('frame-cue-readbacks.json.gz', { body: gzipSync(JSON.stringify(readings)), contentType: 'application/gzip' })
      await info.attach('frame-cue-order', { body: JSON.stringify({ traces, errors,
        media: await observeVideoMedia(page), resources: await observeVideoAudio(page), logs: await page.locator('#logs').innerText() }), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(page.locator('video,.game-window')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const left = await observeVideoAudio(page)
      expect(left.liveUrls).toBe(0); expect(left.graphs).toHaveLength(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Movie frame cue or cleanup failed', { cause: failures[0] })
  })
