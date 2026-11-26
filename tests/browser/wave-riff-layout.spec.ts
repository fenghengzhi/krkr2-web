import { expect, test } from '@playwright/test'
import { waveRiffFiles, waveRiffNames, waveRiffSource } from '../helpers/wave-riff-layout.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a game plays original RIFF recordings and their first music chunk with real seek, pause and SLI playback`, async ({ page }, info) => {
    test.setTimeout(120000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let voiceId: number | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Legacy WAVE recordings$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }, capture = async (name: string, seconds = .5) => {
        const before = (await nativePhasePosition(page)).snapshot
        voiceId = before.id
        await beginPhaseCapture(page, seconds, { positionVoiceOnComplete: before.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, output, { before, expectedHz: 440 }),
          after = output.completionPosition?.observation?.snapshot
        expect(after).toBeDefined(); expect(after!.status).toBe('play'); expect(after!.id).toBe(before.id)
        expect(after!.sampleRate).toBe(48000); expect(after!.sampleCount).toBe(96000)
        for (const plane of metrics) {
          expect(plane.nonfinite).toBe(0); expect(plane.rms).toBeGreaterThan(.24)
          expect(Math.abs(plane.spectrum.peakHz - 440)).toBeLessThanOrEqual(1)
        }
        for (let frame = 0; frame < output.channels[0]!.length; frame++)
          if (output.channels[1]![frame] !== -output.channels[0]![frame]!) throw new Error(`${name}: wrong stereo sample at ${frame}`)
        observations.push({ name, before, after, metrics })
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("riff.tjs","savedata/riff.cjs",false,true,false);Scripts.execStorage("savedata/riff.cjs");riffMenu();'
          : 'Scripts.execStorage("riff.tjs");riffMenu();') },
        { name: 'riff.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveRiffSource) },
        ...Object.entries(waveRiffFiles(true)).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('riff-track:0', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      for (let index = 0; index < waveRiffNames.length; index++) {
        if (index) await click(38, `riff-track:${index}`)
        await capture(waveRiffNames[index]!, index === 3 ? 2.5 : .5)
      }
      await click(118, 'riff-seek'); await capture('public-seek-selected-payload')
      await click(198, 'riff-pause:1')
      const held = (await nativePhasePosition(page)).snapshot.position
      await beginPhaseCapture(page, .2)
      const silence = await endPhaseCapture(page); await attachPhaseCapture(info, 'actual-game-pause', silence)
      for (const plane of silence.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(held)
      await click(198, 'riff-pause:0'); await capture('resumed-recording')
      await click(278, 'riff-finish')
      await beginPhaseCapture(page, 2)
      const tail = await endPhaseCapture(page); await attachPhaseCapture(info, 'actual-end-without-following-chunks', tail)
      for (const plane of tail.channels) {
        const count = Math.round(tail.sampleRate / 5)
        expect(plane.slice(-count)).toEqual(Array(count).fill(0))
      }
      expect(voiceId).toBeDefined()
      expect((await nativePhasePosition(page, voiceId)).snapshot.status).toBe('stop')
      await info.attach('recording-menu', { body: await canvas.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-riff-game', { body: JSON.stringify({ observations, errors, logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'RIFF recording game or cleanup failed', { cause: failures[0] })
  })
