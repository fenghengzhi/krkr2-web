import { readFileSync } from 'node:fs'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { videoPeriodCases, videoPeriodSource } from '../helpers/video-period.ts'
import { installVideoAudioProbe, observeVideoAudio, observeVideoMedia } from '../helpers/video-audio-probe.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real movie buttons distinguish time, frame, rewind and retained one-shot cues`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await installVideoAudioProbe(page); await observeVideoFrames(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("cue.tjs","savedata/cue.cjs",false,true,false);Scripts.execStorage("savedata/cue.cjs");'
          : 'Scripts.execStorage("cue.tjs");') },
        { name: 'cue.tjs', mimeType: 'text/plain', buffer: Buffer.from(videoPeriodSource) },
        { name: 'colors.mp4', mimeType: 'video/mp4', buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)) },
      ])
      await expect(page.getByText('cue-button-ready', { exact: true })).toBeVisible()
      const canvas = page.locator('canvas[data-window-id]').first()
      for (const [name, expected] of videoPeriodCases) {
        await canvas.click({ position: { x: 40, y: 60 } })
        await expect(page.getByText(`cue-start:${name}`, { exact: true })).toHaveCount(1)
        await expect(async () => {
          const activation = page.getByRole('button', { name: '播放视频', exact: true })
          if (await activation.isVisible()) await activation.click({ timeout: 500 })
          await expect(page.getByText(`cue-done:${name}:${expected}`, { exact: true })).toHaveCount(1, { timeout: 500 })
        }).toPass({ timeout: 12000 })
        const videos = await observeVideoMedia(page)
        expect(videos.videos).toHaveLength(1)
        expect(videos.videos[0]!.paused).toBe(true)
        expect(videos.videos[0]!.seeking).toBe(false)
        expect(videos.videos[0]!.presentedFrames).not.toBeNull()
        // Inspect the independent game-drawn cue marker, safely inside its
        // rectangle. Every captured channel is exact black or full green.
        const png = await canvas.screenshot(), marker = await page.evaluate(async (url) => {
          const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
            ctx = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
          try {
            ctx.drawImage(bitmap, 0, 0)
            const x = Math.floor(bitmap.width * 84 / 112), y = Math.floor(bitmap.height * 4 / 72),
              width = Math.max(1, Math.floor(bitmap.width * 8 / 112)), height = Math.max(1, Math.floor(bitmap.height * 8 / 72))
            return [...ctx.getImageData(x, y, width, height).data]
          } finally { bitmap.close() }
        }, 'data:image/png;base64,' + png.toString('base64'))
        const color = expected.startsWith('1:') ? [0, 255, 0, 255] : [0, 0, 0, 255]
        expect(marker).toEqual(Array.from({ length: marker.length }, (_, index) => color[index % 4]))
        await info.attach(`cue-${name}`, { body: png, contentType: 'image/png' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('video-cue-evidence', { body: JSON.stringify({ logs: await page.locator('#logs').innerText(),
      media: await observeVideoMedia(page), audio: await observeVideoAudio(page) }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('video')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const audio = await observeVideoAudio(page)
      expect(audio.liveUrls).toBe(0); expect(audio.revokedUrls).toBe(audio.createdUrls); expect(audio.graphs).toHaveLength(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Movie cues or cleanup failed', { cause: failures[0] })
  })
