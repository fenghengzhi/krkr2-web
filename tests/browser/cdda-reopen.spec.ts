import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { cddaReopenDiscs, cddaReopenFiles, cddaReopenSource } from '../helpers/cdda-reopen.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real CD music buttons carry an audible fade across tracks and discs until one completion`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^CD music fade$/ }) }).locator('canvas[data-window-id]'),
      click = async (action: number) => {
        const point = await pointerPixel(canvas, action * 80 + 38, 30)
        await page.mouse.click(point.x, point.y)
        await expect(page.getByText(`disc-button:${action}:play:${action === 3 ? 1 : 0}`, { exact: true })).toBeVisible()
      }, capture = async (name: string, hz: number | null, fading = false) => {
        const before = (await nativePhasePosition(page)).snapshot
        expect(before.status).toBe('play'); expect(before.fading).toBe(fading)
        await beginPhaseCapture(page, .4, { positionVoiceOnComplete: before.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, output, { before, hz }),
          after = output.completionPosition?.observation?.snapshot
        expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
        expect(after!.id).toBe(before.id); expect(after!.status).toBe('play'); expect(after!.fading).toBe(fading)
        expect(output.channels).toHaveLength(2)
        expect(output.channels[0]).toHaveLength(Math.ceil(output.sampleRate * .4))
        expect(output.channels[1]).toHaveLength(output.channels[0]!.length)
        for (let frame = 0; frame < output.channels[0]!.length; frame++) {
          const left = output.channels[0]![frame]!, right = output.channels[1]![frame]!
          if (!Number.isFinite(left) || !Number.isFinite(right) || right !== -left)
            throw new Error(`${name}: opposite stereo planes changed at frame ${frame}: ${left}, ${right}`)
          if (hz === null && (left !== 0 || right !== 0))
            throw new Error(`${name}: completed fade was audible at frame ${frame}: ${left}, ${right}`)
        }
        if (hz !== null) {
          expect(before.volume).toBeGreaterThan(0); expect(after!.volume).toBeGreaterThan(0)
          for (const metric of metrics) {
            expect(metric.nonfinite).toBe(0)
            expect(Math.abs(metric.spectrum.peakHz - hz)).toBeLessThanOrEqual(1)
            // Independent source amplitude .25, measured over whole tone
            // cycles; bound the real envelope by its observed end volumes.
            expect(metric.rms).toBeGreaterThanOrEqual(.25 / Math.SQRT2 * after!.volume / 100000 - .002)
            expect(metric.rms).toBeLessThanOrEqual(.25 / Math.SQRT2 * before.volume / 100000 + .002)
          }
          if (fading) expect(after!.volume).toBeLessThan(before.volume)
        } else { expect(after!.volume).toBe(0); expect(after!.fading).toBe(false) }
        observations.push({ name, before, after, metrics })
        return { before, after: after! }
      }
    try {
      await page.locator('#cdda-discs').fill(cddaReopenDiscs.map(({ drive, cue }) => `${drive}=${cue}`).join('\n'))
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("disc-control.tjs","savedata/disc-control.cjs",false,true,false);Scripts.execStorage("savedata/disc-control.cjs");discReopenMenu();'
          : 'Scripts.execStorage("disc-control.tjs");discReopenMenu();') },
        { name: 'disc-control.tjs', mimeType: 'text/plain', buffer: Buffer.from(cddaReopenSource) },
        ...Object.entries(cddaReopenFiles(true)).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream',
          buffer: Buffer.from(typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes) })),
      ])
      await expect(page.getByText('disc-reopen-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await capture('original-disc-track-440', 440)
      await click(0); const original = await capture('fading-original-440', 440, true)
      await click(1)
      await evaluate(page, 'discMusic.states.join(",")+"|"+discMusic.completed.count', 'stop,play,stop,play|0')
      const same = await capture('same-disc-track-880', 880, true)
      expect(same.before.id).toBe(original.before.id); expect(same.before.epoch).not.toBe(original.before.epoch)
      expect(same.before.volume).toBeLessThanOrEqual(original.after.volume)
      await click(2)
      await evaluate(page, 'discMusic.states.join(",")+"|"+discMusic.completed.count', 'stop,play,stop,play,stop,unload,stop,play|0')
      const other = await capture('other-disc-track-660', 660, true)
      expect(other.before.id).toBe(same.before.id); expect(other.before.epoch).not.toBe(same.before.epoch)
      expect(other.before.volume).toBeLessThanOrEqual(same.after.volume)
      await click(3)
      await expect(page.getByText('disc-fade-complete:0:1', { exact: true })).toHaveCount(1)
      await capture('completed-disc-fade-silence', null)
      // The normal public finish action is idempotent after that one event.
      const finish = await pointerPixel(canvas, 278, 30); await page.mouse.click(finish.x, finish.y)
      await expect(page.getByText('disc-button:3:play:1', { exact: true })).toHaveCount(2)
      await expect(page.getByText('disc-fade-complete:0:1', { exact: true })).toHaveCount(1)
      await evaluate(page, 'discMusic.completed.join(",")', '0')
      await info.attach('disc-fade-menu', { body: await canvas.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('disc-fade-observations', { body: JSON.stringify({ observations, errors,
      logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'CDDA game fade or cleanup failed', { cause: failures[0] })
  })
