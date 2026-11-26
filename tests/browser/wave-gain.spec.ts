import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { waveGainCases, waveGainFiles, waveGainPublicExpected, waveGainReadback, waveGainSamples,
  waveGainSource } from '../helpers/wave-gain.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture,
  endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual Wave output preserves native integer volume stages and independent stereo attenuation`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("gain.tjs","savedata/gain.cjs",false,true,false);Scripts.execStorage("savedata/gain.cjs");'
          : 'Scripts.execStorage("gain.tjs");') },
        { name: 'gain.tjs', mimeType: 'text/plain', buffer: Buffer.from(waveGainSource) },
        ...Object.entries(waveGainFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })),
      ])
      await expect(page.getByText('wave-gain-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'waveGainPublicControls()', waveGainPublicExpected)
      await evaluate(page, 'waveGainStart()', 'play')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      for (const row of waveGainCases) {
        await evaluate(page, `waveGainSet(${row.volume},${row.volume2},${row.globalVolume},${row.pan})`, waveGainReadback(row))
        await beginPhaseCapture(page, 0.2)
        const output = await endPhaseCapture(page), expected = waveGainSamples(row)
        // This side tap copies real app mixer output. It does not replace its
        // source samples, controls, gain calculation or speaker connection.
        await attachPhaseCapture(info, `wave-gain-${row.name}`, output, { controls: row, expected })
        expect(output.channels.length).toBe(2)
        for (let index = 0; index < 2; index++) {
          const channel = output.channels[index]!
          expect(channel.length).toBeGreaterThan(0)
          expect(channel).toEqual(Array(channel.length).fill(expected[index]))
        }
      }
      await evaluate(page, 'waveGainClose()', 'closed')
      await expect.poll(() => page.locator('#sound-level').evaluate((node) => (node as HTMLMeterElement).value)).toBe(0)
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('wave-gain-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Wave attenuation browser or cleanup failed', { cause: failures[0] })
  })
