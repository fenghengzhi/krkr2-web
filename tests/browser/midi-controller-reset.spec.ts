import { expect, test } from '@playwright/test'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { midiControllerFiles, midiControllerSource } from '../helpers/midi-controller-reset.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real music buttons reset expression while preserving left-only volume, then explicitly restore centered sound`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^MIDI stereo controller reset$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(marker, { exact: true })).toHaveCount(1)
      }, capture = async (stage: string, centered: boolean) => {
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, .5, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), after = output.completionPosition?.observation?.snapshot
        await attachPhaseCapture(info, stage, output, { before, after, centered,
          scope: 'Actual Worklet stereo and amplitude ratios; not Windows GS timbre equivalence.' })
        expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id); expect(after!.position).toBeGreaterThan(before.snapshot.position)
        expect(output.channels).toHaveLength(2)
        const [left, right] = output.channels
        expect(left).toHaveLength(Math.ceil(output.sampleRate * .5)); expect(right).toHaveLength(left!.length)
        let real = 0, imaginary = 0
        for (let frame = 0; frame < left!.length; frame++) {
          const l = left![frame]!, r = right![frame]!
          if (!Number.isFinite(l) || !Number.isFinite(r) || (centered ? r !== l : r !== 0))
            throw new Error(`MIDI stereo differs at ${stage}/${frame}: ${l},${r}`)
          const angle = 2 * Math.PI * 440 * frame / output.sampleRate
          real += l * Math.cos(angle); imaginary += l * Math.sin(angle)
        }
        const amplitude = Math.hypot(real, imaginary) * 2 / left!.length
        expect(amplitude).toBeGreaterThan(.001)
        observations.push({ stage, before, after, centered, amplitude }); return amplitude
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("controller.tjs","savedata/controller.cjs",false,true,false);Scripts.execStorage("savedata/controller.cjs");controllerMenu();'
          : 'Scripts.execStorage("controller.tjs");controllerMenu();') },
        { name: 'controller.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiControllerSource) },
        ...Object.entries(midiControllerFiles()).map(([name, bytes]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('controller-menu-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      await expect.poll(async () => (await nativePhasePosition(page)).snapshot.position).toBeGreaterThan(4410)
      const original = await capture('file-selected-left-quiet-lead', false)
      await click(40, 'controller-zero'); const resetZero = await capture('raw-zero-keeps-volume-and-pan', false)
      expect(Math.abs(resetZero / original - 127 / 32)).toBeLessThan(.001)
      await click(120, 'controller-one'); const resetOne = await capture('raw-nonzero-restores-volume-and-pan', true)
      expect(Math.abs(resetOne / resetZero - 100 / 32)).toBeLessThan(.001)
      await click(200, 'controller-stopped')
      await beginPhaseCapture(page, .1)
      const silent = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'game-stopped', silent)
      for (const plane of silent.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await click(280, 'controller-replayed')
      await expect.poll(async () => (await nativePhasePosition(page)).snapshot.position).toBeGreaterThan(4410)
      const replay = await capture('same-song-replays-authored-controls', false)
      expect(Math.abs(replay / original - 1)).toBeLessThan(.001)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-controller-observations', { body: JSON.stringify({ observations, errors,
      logs: await page.locator('#logs').innerText() }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'MIDI controller playback or cleanup failed', { cause: failures[0] })
  })
