import { expect, test } from '@playwright/test'
import { aiffGame, aiffReference } from '../helpers/cdda-aiff.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { attachPhaseCapture, beginPhaseCapture, closePhaseCapture, endPhaseCapture,
  observeNativePhaseMixer, openPhaseCapture, phaseMetrics } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: select AIFF and AIFF-C disc tracks through game buttons and hear each stereo phrase`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const { files, record } = aiffReference(), canvas = page.locator('#stage canvas[data-window-id]')
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#files').setInputFiles({ name: 'data.xp3', mimeType: 'application/octet-stream',
        buffer: xp3Fixture(aiffGame(binary, files)).bytes })
      await expect(page.getByText('cd-select-ready', { exact: true })).toBeVisible()
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      for (const track of [2, 3, 4, 1]) {
        const point = await pointerPixel(canvas, (track - 1) * 80 + 38, 32)
        await page.mouse.click(point.x, point.y)
        const late = track % 2 === 0
        await expect(page.getByText(`cd-choice:${track}:play:${late ? 1000 : 2000}:${track < 3 ? 24 : 16}`,
          { exact: true })).toBeVisible()
        if (track === 2) await openPhaseCapture(page)
        await beginPhaseCapture(page, .45)
        const recording = await endPhaseCapture(page), metrics = phaseMetrics(recording)
        await attachPhaseCapture(info, 'disc-track-' + track, recording)
        observations.push({ track, metrics })
        expect(metrics).toHaveLength(2)
        for (const [c, hz] of (late ? [660, 990] : [330, 550]).entries()) {
          const channel = metrics[c]!
          expect(channel.nonfinite).toBe(0)
          expect(Math.abs(channel.spectrum.peakHz - hz)).toBeLessThanOrEqual(3)
          expect(channel.audibleSeconds).toBeGreaterThan(.32)
        }
      }
      await info.attach('disc-track-menu', { body: await canvas.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('disc-track-observations', { body: JSON.stringify({ record, observations, errors,
        logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try { await closePhaseCapture(page) } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((w) => w.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'CD track selection or cleanup failed', { cause: failures[0] })
  })
