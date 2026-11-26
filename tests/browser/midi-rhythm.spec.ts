import { expect, test } from '@playwright/test'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { midiRhythmFiles, midiRhythmSource } from '../helpers/midi-rhythm.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: music buttons select real GS drum parts and melodic channel ten through complete looping audio`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [], energies: number[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^GS rhythm parts$/ }) }).locator('canvas[data-window-id]')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("rhythm.tjs","savedata/rhythm.cjs",false,true,false);Scripts.execStorage("savedata/rhythm.cjs");rhythmMenu();'
          : 'Scripts.execStorage("rhythm.tjs");rhythmMenu();') },
        { name: 'rhythm.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiRhythmSource) },
        ...Object.entries(midiRhythmFiles()).map(([name, data]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(data) })),
      ])
      await expect(page.getByText('rhythm-menu-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      for (let stage = 0; stage < 4; stage++) {
        const point = await pointerPixel(canvas, stage * 80 + 38, 30); await page.mouse.click(point.x, point.y)
        await expect(page.getByText(`rhythm-selected:${stage + 1}:${stage}:play`, { exact: true })).toHaveCount(1)
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        // Two complete one-second loops give phase-independent energy and
        // silence occupancy. The reference buttons play independent GM-only
        // files, not modified observations of the GS file.
        await beginPhaseCapture(page, 2, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), after = output.completionPosition?.observation?.snapshot
        await attachPhaseCapture(info, `rhythm-stage-${stage}`, output, { before, after,
          scope: 'Web procedural PCM and GS part routing; not a physical GS kit or device capture.' })
        expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
        expect(after!.id).toBe(before.snapshot.id); expect(after!.status).toBe('play')
        expect(after!.position).toBeGreaterThanOrEqual(0); expect(after!.position).toBeLessThanOrEqual(44100)
        expect(output.channels).toHaveLength(2)
        const [left, right] = output.channels
        expect(left).toHaveLength(output.sampleRate * 2); expect(right).toHaveLength(left!.length)
        let energy = 0, audible = 0
        for (let at = 0; at < left!.length; at++) {
          const sample = left![at]!
          if (!Number.isFinite(sample) || sample !== right![at])
            throw new Error(`GS rhythm PCM differs at stage ${stage}, sample ${at}: ${sample},${right![at]}`)
          energy += sample * sample; if (sample !== 0) audible++
        }
        energy /= left!.length
        const occupancy = audible / left!.length
        expect(energy).toBeGreaterThan(.00001)
        if (stage < 2) { expect(occupancy).toBeGreaterThan(.48); expect(occupancy).toBeLessThan(.51) }
        else { expect(occupancy).toBeGreaterThan(.89); expect(occupancy).toBeLessThan(.91) }
        energies.push(energy); observations.push({ stage, energy, occupancy, before, after })
      }
      expect(Math.abs(energies[1]! / energies[0]! - 1)).toBeLessThan(.001)
      expect(Math.abs(energies[2]! / energies[3]! - 1)).toBeLessThan(.001)
      await page.keyboard.press('Escape'); await expect(page.getByText('rhythm-stopped', { exact: true })).toHaveCount(1)
      await beginPhaseCapture(page, .1)
      const stopped = await endPhaseCapture(page); await attachPhaseCapture(info, 'rhythm-stopped', stopped)
      for (const plane of stopped.channels) expect(plane).toEqual(Array(plane.length).fill(0))
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-rhythm-observations', { contentType: 'application/json',
      body: JSON.stringify({ observations, errors, logs: await page.locator('#logs').innerText() }) }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机'); await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length) throw new AggregateError(failures, 'Game GS rhythm PCM or cleanup failed', { cause: failures[0] })
  })
