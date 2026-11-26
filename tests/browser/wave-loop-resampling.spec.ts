import { expect, test } from '@playwright/test'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { waveLoopResamplingFiles, waveLoopResamplingSource } from '../helpers/wave-loop-resampling.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real music buttons keep whole and SLI loop joins free of abandoned samples at the device rate`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Music loop joins$/ }) }).locator('canvas[data-window-id]'),
      click = async (action: number, state: string) => {
        const point = await pointerPixel(canvas, action * 80 + 38, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(`resample-action:${action}:${state}`, { exact: true })).toBeVisible()
      }, capture = async (phase: string) => {
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, .4, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), left = output.channels[0]!, right = output.channels[1]!
        await attachPhaseCapture(info, phase, output, { before, sourceRate: 1000, logicalPhrase: [-.5, -.5, .5, .5],
          scope: 'Existing Web linear resampling of concatenated PCM, not a physical DirectSound resampler comparison.' })
        expect(output.channels).toHaveLength(2); expect(left).toHaveLength(Math.ceil(output.sampleRate * .4)); expect(right).toHaveLength(left.length)
        let real = 0, imaginary = 0, peak = 0, biggestStep = 0
        for (let frame = 0; frame < left.length; frame++) {
          const value = left[frame]!, previous = left[frame - 1], delta = previous === undefined ? 0 : Math.abs(value - previous)
          if (!Number.isFinite(value) || value < -.5 || value > .5 || right[frame] !== -value / 2 ||
              delta > 1000 / output.sampleRate + 2 ** -23)
            throw new Error(`Non-concatenated loop sample at ${phase}/${frame}: ${previous} -> ${value}, right=${right[frame]}`)
          peak = Math.max(peak, Math.abs(value)); biggestStep = Math.max(biggestStep, delta)
          const angle = 2 * Math.PI * 250 * frame / output.sampleRate
          real += value * Math.cos(angle); imaginary += value * Math.sin(angle)
        }
        expect(peak).toBe(.5)
        expect(Math.hypot(real, imaginary) * 2 / left.length).toBeGreaterThan(.4)
        expect(output.completionPosition?.error).toBeUndefined()
        expect(output.completionPosition?.observation?.snapshot.status).toBe('play')
        observations.push({ phase, sourceRate: 1000, sampleRate: output.sampleRate, peak, biggestStep })
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("resample.tjs","savedata/resample.cjs",false,true,false);Scripts.execStorage("savedata/resample.cjs");resampleMenu();'
          : 'Scripts.execStorage("resample.tjs");resampleMenu();') },
        { name: 'resample.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveLoopResamplingSource) },
        ...Object.entries(waveLoopResamplingFiles()).map(([name, data]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(data) })),
      ])
      await expect(page.getByText('resample-menu-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await capture('whole-song-join')
      await click(1, 'play:0'); await capture('streamed-hard-sli-join')
      await click(2, 'play:1')
      const paused = await nativePhasePosition(page)
      await beginPhaseCapture(page, .1)
      const silent = await endPhaseCapture(page); await attachPhaseCapture(info, 'paused-loop', silent)
      for (const plane of silent.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      expect((await nativePhasePosition(page)).snapshot.position).toBe(paused.snapshot.position)
      await click(2, 'play:0'); await capture('resumed-hard-sli-join')
      await click(0, 'play:0'); await capture('whole-song-restored')
      await click(3, 'stop:0')
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page); await attachPhaseCapture(info, 'stopped-loop', stopped)
      for (const plane of stopped.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('loop-resampling-observations', { contentType: 'application/json',
      body: JSON.stringify({ observations, errors, logs: await page.locator('#logs').innerText() }) }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Real WAVE loop resampling or cleanup failed', { cause: failures[0] })
  })
