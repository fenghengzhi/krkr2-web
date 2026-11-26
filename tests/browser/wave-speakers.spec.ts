import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveSpeakerCases, waveSpeakerFiles, waveSpeakerSource } from '../helpers/wave-speakers.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real game buttons preserve six-channel Wave speaker routing with and without a declared mask`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Speaker routing$/ }) }).locator('canvas[data-window-id]')
    const click = async (x: number) => {
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: x * box!.width / 160, y: 30 * box!.height / 60 }, timeout: 5000 })
    }
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("speakers.tjs","savedata/speakers.cjs",false,true,false);Scripts.execStorage("savedata/speakers.cjs");speakerMenu();'
          : 'Scripts.execStorage("speakers.tjs");speakerMenu();') },
        { name: 'speakers.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveSpeakerSource) },
        ...Object.entries(waveSpeakerFiles()).map(([name, bytes]) => ({ name, mimeType: 'audio/wav', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('speaker-buttons-ready', { exact: true })).toBeVisible()
      await expect(canvas).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      let selection = 0, capturing = false
      for (const row of waveSpeakerCases) {
        let reference: number[][] | undefined
        for (const layout of ['legacy', 'masked']) {
          const name = `${row.name}-${layout}.wav`
          await click(38)
          await expect(page.getByText(`speaker-selection:${selection++}:${name}`, { exact: true })).toBeVisible()
          await evaluate(page, 'speakerSound.channels+":"+speakerSound.status', '6:play')
          if (!capturing) { await openPhaseCapture(page); capturing = true }
          await beginPhaseCapture(page, 0.2)
          const output = await endPhaseCapture(page), expected = row.stereo.map((value) => Math.fround(value))
          await attachPhaseCapture(info, `wave-speakers-${row.name}-${layout}`, output, { expected, layout })
          expect(output.channels).toHaveLength(2)
          for (let channel = 0; channel < 2; channel++) {
            const samples = output.channels[channel]!
            expect(samples.length).toBeGreaterThan(0)
            expect(samples).toEqual(Array(samples.length).fill(expected[channel]))
          }
          if (reference) expect(output.channels).toEqual(reference)
          else reference = output.channels
        }
        if (row.name === 'front-left') {
          await click(122)
          await expect(page.getByText('speaker-pause:1', { exact: true })).toBeVisible()
          await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
          await beginPhaseCapture(page, 0.2)
          const paused = await endPhaseCapture(page)
          expect(paused.channels).toHaveLength(2)
          for (const samples of paused.channels) expect(samples).toEqual(Array(samples.length).fill(0))
          await click(122)
          await expect(page.getByText('speaker-pause:0', { exact: true })).toBeVisible()
          await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBeGreaterThan(0)
        }
      }
      await evaluate(page, '(speakerSound.stop(),speakerSound.status)', 'stop')
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-speakers-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave speaker routing browser or cleanup failed', { cause: failures[0] })
  })
