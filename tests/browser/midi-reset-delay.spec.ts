import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { midiResetDelayFiles, midiResetDelaySource } from '../helpers/midi-reset-delay.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real looping MIDI waits for module initialization before each audible phrase`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^MIDI module initialization$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number) => {
        const box = await canvas.boundingBox(); expect(box).not.toBeNull()
        await canvas.click({ position: { x: x * box!.width / 240, y: 30 * box!.height / 60 }, timeout: 5000 })
      }, capture = async (name: string, wait: number) => {
        await beginPhaseCapture(page, 2)
        const output = await endPhaseCapture(page), gaps: { start: number; length: number }[] = [], samples = output.channels[0]!
        expect(output.channels).toHaveLength(2); expect(samples.length).toBeGreaterThan(0)
        expect(output.channels[1]).toEqual(samples)
        let start = -1
        for (let frame = 0; frame <= samples.length; frame++) {
          if (frame < samples.length && samples[frame] === 0) { if (start < 0) start = frame }
          else if (start >= 0) {
            const length = frame - start
            // Ignore only truncated capture edges and individual oscillator
            // zero crossings. Every complete module-wait interval is retained.
            if (start > 0 && frame < samples.length && length >= output.sampleRate / 100) gaps.push({ start, length })
            start = -1
          }
        }
        const metrics = await attachPhaseCapture(info, name, output, { wait, gaps, scoreSeconds: 0.2 })
        expect(gaps.length).toBeGreaterThanOrEqual(8)
        for (const gap of gaps) {
          // Source/output rate conversion places a boundary on one adjacent
          // output frame; the note's exact attack-zero can add one more.
          expect(gap.length, JSON.stringify(gap)).toBeGreaterThanOrEqual(Math.floor(wait * output.sampleRate) - 1)
          expect(gap.length, JSON.stringify(gap)).toBeLessThanOrEqual(Math.ceil(wait * output.sampleRate) + 2)
        }
        for (let index = 1; index < gaps.length; index++)
          expect(Math.abs(gaps[index]!.start - gaps[index - 1]!.start - output.sampleRate / 5)).toBeLessThanOrEqual(2)
        for (const metric of metrics) {
          expect(metric.nonfinite).toBe(0); expect(metric.rms).toBeGreaterThan(0.01)
          expect(Math.abs(metric.spectrum.peakHz - 440)).toBeLessThanOrEqual(2)
        }
      }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("reset.tjs","savedata/reset.cjs",false,true,false);Scripts.execStorage("savedata/reset.cjs");resetMenu();'
          : 'Scripts.execStorage("reset.tjs");resetMenu();') },
        { name: 'reset.tjs', mimeType: 'text/plain', buffer: Buffer.from(midiResetDelaySource) },
        ...Object.entries(midiResetDelayFiles()).map(([name, bytes]) => ({ name, mimeType: 'audio/midi', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('reset-menu-ready', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      await capture('one-native-reset-per-loop', .05)
      await click(38); await expect(page.getByText('reset-selected:1', { exact: true })).toBeVisible()
      await capture('two-serial-resets-per-loop', .1)
      await click(118); await expect(page.getByText('reset-stopped', { exact: true })).toBeVisible()
      await evaluate(page, 'resetMusic.status', 'stop')
      await beginPhaseCapture(page, .2)
      const stopped = await endPhaseCapture(page)
      for (const channel of stopped.channels) expect(channel).toEqual(Array(channel.length).fill(0))
      await click(198); await expect(page.getByText('reset-restarted', { exact: true })).toBeVisible()
      await capture('manual-restart-keeps-module-waits', .1)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('midi-reset-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'MIDI initialization playback or cleanup failed', { cause: failures[0] })
  })
