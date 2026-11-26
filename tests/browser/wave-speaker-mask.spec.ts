import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { waveMaskCases, waveMaskFiles, waveMaskSource } from '../helpers/wave-speaker-mask.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture, nativePhasePosition } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: surround music buttons keep center dialogue balanced, distinguish back speakers and omit the LFE plane`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page); await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Surround music$/ }) }).locator('canvas[data-window-id]'),
      click = async (x: number) => { const point = await pointerPixel(canvas, x, 30); await page.mouse.click(point.x, point.y) },
      silence = async (label: string) => {
        await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
        await beginPhaseCapture(page, .1); const output = await endPhaseCapture(page)
        await attachPhaseCapture(info, label, output)
        expect(output.channels).toHaveLength(2)
        for (const channel of output.channels) {
          expect(channel).toHaveLength(Math.ceil(output.sampleRate * .1))
          expect(channel).toEqual(Array(channel.length).fill(0))
        }
      }
    let capturing = false
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("mask-music.tjs","savedata/mask-music.cjs",false,true,false);Scripts.execStorage("savedata/mask-music.cjs");maskMenu();'
          : 'Scripts.execStorage("mask-music.tjs");maskMenu();') },
        { name: 'mask-music.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveMaskSource) },
        ...Object.entries(waveMaskFiles()).map(([name, bytes]) => ({ name, mimeType: name.endsWith('.wav') ? 'audio/wav' : 'text/plain', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('mask-menu-ready', { exact: true })).toBeVisible(); await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      for (const [index, entry] of waveMaskCases.entries()) {
        await click(38)
        await expect(page.getByText(`mask-selected:${index}:${entry.name}`, { exact: true })).toBeVisible()
        await evaluate(page, 'maskMusic.channels+"|"+maskMusic.status', `${entry.row.length}|play`)
        if (!capturing) { await openPhaseCapture(page); capturing = true }
        const capture = async (label: string) => {
          const before = (await nativePhasePosition(page)).snapshot
          expect(before.status).toBe('play'); expect(before.channels).toBe(entry.row.length)
          await beginPhaseCapture(page, .25, { positionVoiceOnComplete: before.id })
          const output = await endPhaseCapture(page), metrics = await attachPhaseCapture(info, label, output,
            { mask: entry.mask, namedInput: entry.name, stereoAmplitude: entry.stereo }), after = output.completionPosition?.observation?.snapshot
          expect(output.completionPosition?.error).toBeUndefined(); expect(after).toBeDefined()
          expect(after!.id).toBe(before.id); expect(after!.status).toBe('play')
          expect(output.channels).toHaveLength(2)
          for (const channel of [0, 1]) {
            const samples = output.channels[channel]!, amplitude = Math.fround(entry.stereo[channel]!)
            expect(samples).toHaveLength(Math.ceil(output.sampleRate * .25))
            let peak = 0
            for (let frame = 0; frame < samples.length; frame++) {
              const value = samples[frame]!
              if (!Number.isFinite(value) || Math.abs(value) > amplitude || (amplitude === 0 && value !== 0))
                throw new Error(`${label}: speaker ${channel}, frame ${frame}: ${value}, amplitude ${amplitude}`)
              peak = Math.max(peak, Math.abs(value))
            }
            expect(peak).toBe(amplitude)
            if (amplitude) expect(Math.abs(metrics[channel]!.spectrum.peakHz - 1000)).toBeLessThanOrEqual(2)
          }
          if (entry.stereo[0] === entry.stereo[1]) expect(output.channels[0]).toEqual(output.channels[1])
          observations.push({ label, before, after, metrics })
        }
        if (entry.stereo[0] === 0 && entry.stereo[1] === 0) await silence(entry.name)
        else await capture(entry.name)
        if (index === 0) {
          await click(118); await expect(page.getByText('mask-paused:1', { exact: true })).toBeVisible()
          await silence('paused-center')
          await click(118); await expect(page.getByText('mask-paused:0', { exact: true })).toBeVisible()
          await click(198); await expect(page.getByText('mask-seek:0', { exact: true })).toBeVisible()
          await capture('center-through-distant-SLI-phrase')
          await evaluate(page, 'maskLabels>0 && maskMusic.samplePosition>=8184 && maskMusic.samplePosition<8200', '1')
        }
      }
      await info.attach('surround-music-menu', { body: await canvas.screenshot(), contentType: 'image/png' })
      await evaluate(page, '(maskMusic.stop(),maskMusic.status)', 'stop'); await silence('stopped-music')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-mask-observations', { body: JSON.stringify({ observations, errors,
      logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { if (capturing) await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Declared Wave speakers or cleanup failed', { cause: failures[0] })
  })
