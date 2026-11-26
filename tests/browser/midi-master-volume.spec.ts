import { expect, test } from '@playwright/test'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { midiMasterFiles, midiMasterSource } from '../helpers/midi-master-volume.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: music buttons fade and mute a held MIDI score, then restore playback without losing its clock`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      half = (8192 / 16383) ** 2, fine = (8193 / 16383) ** 2,
      // Authored wire values and KRKR's floor(100*63/127)=49 owner CC7.
      gains = [1, half, 0, fine, fine * 49 / 100, fine * 49 / 100, 49 / 100, 49 / 100]
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^MIDI music fade$/ }) }).locator('canvas[data-window-id]')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("master.tjs","savedata/master.cjs",false,true,false);Scripts.execStorage("savedata/master.cjs");masterMenu();'
          : 'Scripts.execStorage("master.tjs");masterMenu();') },
        { name: 'master.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiMasterSource) },
        ...Object.entries(midiMasterFiles()).map(([name, data]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(data) })),
      ])
      await expect(page.getByText('master-stage:0:play', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      let original = 0
      for (let stage = 0; stage < gains.length; stage++) {
        if (stage) {
          const point = await pointerPixel(canvas, 80, 30); await page.mouse.click(point.x, point.y)
          await expect(page.getByText(`master-stage:${stage}:play`, { exact: true })).toHaveCount(1)
        }
        await expect.poll(async () => (await nativePhasePosition(page)).snapshot.position).toBeGreaterThan(4410)
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, .5, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), after = output.completionPosition?.observation?.snapshot
        await attachPhaseCapture(info, `master-stage-${stage}`, output, { before, after, gain: gains[stage],
          scope: 'Actual Web Worklet PCM and DLS-style master gain; not physical GS timbre/noise-floor equivalence.' })
        expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id); expect(after!.status).toBe('play')
        expect(after!.position).toBeGreaterThan(before.snapshot.position)
        expect(output.channels).toHaveLength(2)
        const [left, right] = output.channels
        expect(left).toHaveLength(Math.ceil(output.sampleRate * .5)); expect(right).toHaveLength(left!.length)
        let real = 0, imaginary = 0
        for (let frame = 0; frame < left!.length; frame++) {
          const value = left![frame]!
          if (!Number.isFinite(value) || value !== right![frame] || (stage === 2 && value !== 0))
            throw new Error(`MIDI master output differs at ${stage}/${frame}: ${value},${right![frame]}`)
          const angle = 2 * Math.PI * 440 * frame / output.sampleRate
          real += value * Math.cos(angle); imaginary += value * Math.sin(angle)
        }
        const amplitude = Math.hypot(real, imaginary) * 2 / left!.length
        if (!stage) { original = amplitude; expect(original).toBeGreaterThan(.01) }
        expect(Math.abs(amplitude / original - gains[stage]!)).toBeLessThan(.001)
        observations.push({ stage, gain: gains[stage], amplitude, before, after })
      }
      await page.keyboard.press('Escape')
      await expect(page.getByText('master-stopped', { exact: true })).toHaveCount(1)
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page); await attachPhaseCapture(info, 'master-stopped', stopped)
      for (const plane of stopped.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('master-music-observations', { contentType: 'application/json',
      body: JSON.stringify({ observations, errors, logs: await page.locator('#logs').innerText() }) }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'MIDI music master volume or cleanup failed', { cause: failures[0] })
  })
