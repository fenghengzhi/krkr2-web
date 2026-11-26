import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { midiProgramReplayFiles, midiProgramReplaySource } from '../helpers/midi-program-replay.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

/** Phase-independent projections of real recorded PCM, not the product's
 * oscillator. A 2 s window contains 880 fundamental periods and ten loops. */
function harmonics(samples: number[], rate: number): number[] {
  return [1, 2, 3, 4].map((harmonic) => {
    let real = 0, imaginary = 0
    for (let frame = 0; frame < samples.length; frame++) {
      const phase = 2 * Math.PI * 440 * harmonic * frame / rate
      real += samples[frame]! * Math.cos(phase); imaginary += samples[frame]! * Math.sin(phase)
    }
    return Math.hypot(real, imaginary) * 2 / samples.length
  })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: game music retains the selected instrument across loops and real Stop/Play buttons`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^MIDI instrument replay$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number, marker: string) => {
        const box = await canvas.boundingBox(); expect(box).not.toBeNull()
        await canvas.click({ position: { x: x * box!.width / 240, y: 30 * box!.height / 60 }, timeout: 5000 })
        await expect(page.getByText(marker, { exact: true })).toBeVisible()
      }, capture = async (name: string) => {
        const before = await nativePhasePosition(page)
        expect(before.snapshot.status).toBe('play'); expect(before.snapshot.paused).toBe(false)
        await beginPhaseCapture(page, 2, { positionVoiceOnComplete: before.snapshot.id })
        const output = await endPhaseCapture(page), spectrum = harmonics(output.channels[0]!, output.sampleRate),
          ratios = spectrum.slice(1).map((value) => value / spectrum[0]!),
          metrics = await attachPhaseCapture(info, name, output, { before, spectrum, ratios, loopSeconds: .2 })
        expect(output.channels).toHaveLength(2); expect(output.channels[0]).toHaveLength(output.sampleRate * 2)
        expect(output.channels[1]).toEqual(output.channels[0])
        expect(output.completionPosition?.error).toBeUndefined()
        expect(output.completionPosition?.observation?.snapshot.status).toBe('play')
        for (const metric of metrics) {
          expect(metric.nonfinite).toBe(0); expect(metric.rms).toBeGreaterThan(.01)
          expect(Math.abs(metric.spectrum.peakHz - 440)).toBeLessThanOrEqual(2)
        }
        // The strings program has a fourth harmonic; the accidental default
        // piano does not. The independent explicitly programmed song below
        // must also reproduce all three normalized overtone measurements.
        expect(ratios[2]).toBeGreaterThan(.04); expect(ratios[2]).toBeLessThan(.12)
        return ratios
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("program.tjs","savedata/program.cjs",false,true,false);Scripts.execStorage("savedata/program.cjs");programMenu();'
          : 'Scripts.execStorage("program.tjs");programMenu();') },
        { name: 'program.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiProgramReplaySource) },
        ...Object.entries(midiProgramReplayFiles()).map(([name, bytes]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('program-menu-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。'); await openPhaseCapture(page)
      // Observe two complete periods before measuring the retained program;
      // the original first piano note is intentionally different.
      await beginPhaseCapture(page, .4)
      const initial = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'initial-instrument-transition', initial)
      expect(initial.channels[1]).toEqual(initial.channels[0]); expect(initial.channels[0]!.some((sample) => sample !== 0)).toBe(true)
      const loop = await capture('loop-retained-instrument')
      await click(38, 'program-stopped'); await evaluate(page, 'programMusic.status', 'stop')
      await beginPhaseCapture(page, .2)
      const stopped = await endPhaseCapture(page)
      await attachPhaseCapture(info, 'manual-stop-silence', stopped)
      for (const channel of stopped.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      await click(118, 'program-replayed'); await evaluate(page, 'programMusic.status', 'play')
      const replay = await capture('manual-replay-retained-instrument')
      await click(198, 'program-reference')
      const reference = await capture('explicit-program-independent-score')
      for (const observed of [loop, replay]) for (let harmonic = 0; harmonic < reference.length; harmonic++)
        expect(Math.abs(observed[harmonic]! - reference[harmonic]!), `Harmonic ${harmonic + 2}`).toBeLessThan(.005)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-program-replay-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI instrument playback or cleanup failed', { cause: failures[0] })
  })
