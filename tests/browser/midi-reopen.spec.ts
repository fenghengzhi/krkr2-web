import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { midiReopenFiles, midiReopenSource } from '../helpers/midi-reopen.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition, phaseCommand } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual music buttons keep the old MIDI on a missing next song and carry its fade into a real replacement`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    let voiceId: number | undefined
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^MIDI song replacement$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number) => {
        const box = await canvas.boundingBox(); expect(box).not.toBeNull()
        await canvas.click({ position: { x: x * box!.width / 320, y: 30 * box!.height / 60 }, timeout: 5000 })
      }, capture = async (name: string, frequency: number | null) => {
        const before = frequency === null
          ? (await phaseCommand(page, { op: 'inspect', id: voiceId! })).snapshot!
          : (await nativePhasePosition(page)).snapshot
        expect(before).toBeDefined(); voiceId = before.id
        await beginPhaseCapture(page, 0.3, { positionVoiceOnComplete: before.id })
        const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, name, output, { before, frequency })
        expect(output.channels).toHaveLength(2)
        expect(output.channels[0]).toEqual(output.channels[1])
        expect(output.completionPosition?.error).toBeUndefined()
        for (let index = 0; index < 2; index++) {
          expect(metrics[index]!.nonfinite).toBe(0)
          if (frequency === null) expect(output.channels[index]).toEqual(Array(output.channels[index]!.length).fill(0))
          else {
            expect(metrics[index]!.rms).toBeGreaterThan(0.01)
            expect(Math.abs(metrics[index]!.spectrum.peakHz - frequency)).toBeLessThanOrEqual(2)
          }
        }
        return { before, after: output.completionPosition!.observation!.snapshot }
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("reopen.tjs","savedata/reopen.cjs",false,true,false);Scripts.execStorage("savedata/reopen.cjs");midiReopenMenu();'
          : 'Scripts.execStorage("reopen.tjs");midiReopenMenu();') },
        { name: 'reopen.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiReopenSource) },
        ...Object.entries(midiReopenFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('midi-reopen-buttons-ready', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      const original = await capture('midi-original-a4', 440)
      expect(original.before.fading).toBe(true); expect(original.after.position).toBeGreaterThan(original.before.position)
      await click(38)
      await expect(page.getByText('midi-missing:rejected:play', { exact: true })).toBeVisible()
      await evaluate(page, '[reopenMusic.status,reopenMusic.volume,reopenMusic.completed.count,reopenMusic.states.join(",")].join("|")', 'play|80000|0|stop,play')
      const kept = await capture('midi-missing-keeps-a4', 440)
      expect(kept.before.epoch).toBe(original.before.epoch)
      expect(kept.before.position).toBeGreaterThan(original.before.position)
      expect(kept.after.position).toBeGreaterThan(kept.before.position); expect(kept.after.fading).toBe(true)
      await click(118)
      await expect(page.getByText('midi-next:opened:stop', { exact: true })).toBeVisible()
      await evaluate(page, '[reopenMusic.status,reopenMusic.volume,reopenMusic.completed.count,reopenMusic.states.join(",")].join("|")', 'play|80000|0|stop,play,stop,play')
      const replacement = await capture('midi-replacement-a5', 880)
      expect(replacement.before.epoch).not.toBe(kept.before.epoch); expect(replacement.after.fading).toBe(true)
      await click(198)
      await expect(page.getByText('midi-bad:rejected:unload', { exact: true })).toBeVisible()
      await evaluate(page, '[reopenMusic.status,reopenMusic.volume,reopenMusic.completed.count].join("|")', 'unload|80000|0')
      const stopped = await capture('midi-opened-invalid-silence', null)
      expect(stopped.after.fading).toBe(true); expect(stopped.after.position).toBe(0)
      await click(278)
      await expect(page.getByText('midi-recovered:play', { exact: true })).toBeVisible()
      await capture('midi-recovered-a4', 440)
      await evaluate(page, '(reopenMusic.stopFade(),reopenMusic.volume+":"+reopenMusic.completed.join(","))', '20000:20000')
      const faded = await capture('midi-stop-fade-a4', 440)
      expect(faded.after.fading).toBe(false); expect(faded.after.volume).toBe(20000)
      await evaluate(page, '(invalidate reopenMusic,0)', '0')
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-reopen-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI replacement browser or cleanup failed', { cause: failures[0] })
  })
