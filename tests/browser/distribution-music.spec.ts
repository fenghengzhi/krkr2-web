import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { musicDistribution } from '../helpers/deflated-distribution.ts'
import { httpServer } from '../helpers/http-server.ts'
import { xp3AudioRegions } from '../helpers/xp3-segment-fixtures.ts'
import { observeNativePhaseMixer, openPhaseCapture, closePhaseCapture, beginPhaseCapture, endPhaseCapture, attachPhaseCapture } from '../helpers/web-phase-vocoder.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a remote ZIP release plays its patched game and seeks its large deflated BGM`, async ({ page }, info) => {
    test.setTimeout(150000)
    await observeNativePhaseMixer(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await musicDistribution(binary)
    const server = await httpServer({ '/story.zip': { bytes: fixture.bytes, etag: '"release-v1"' } })
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#remote-url').fill(server.url + '/story.zip')
      await page.locator('#load-url').click()
      await expect(page.getByText('distribution-ready:updated', { exact: true })).toBeVisible({ timeout: 45000 })
      await evaluate(page, 'Storages.getPlacedPath("chapter.tjs")', 'game://./Release/patch.xp3>chapter.tjs')
      if (await page.locator('#sound-toggle').textContent() === '开启声音') await page.locator('#sound-toggle').click()
      await expect(page.locator('#sound-status')).toHaveText('声音已开启。')
      await openPhaseCapture(page)
      for (const region of [xp3AudioRegions[0], xp3AudioRegions[2], xp3AudioRegions[1]]) {
        await evaluate(page, `(playFrom(${region.startSample}),music.status)`, 'play')
        await expect(page.getByText('release-label:' + region.id, { exact: true })).toBeVisible({ timeout: 15000 })
        await beginPhaseCapture(page, 0.5)
        const output = await endPhaseCapture(page)
        const metrics = await attachPhaseCapture(info, 'distribution-' + region.id, output, { region, crc: fixture.crc })
        expect(metrics).toHaveLength(2)
        for (const channel of metrics) {
          expect(channel.nonfinite).toBe(0); expect(channel.spectrum.count).toBe(8192)
          expect(Math.abs(channel.spectrum.peakHz - region.frequency)).toBeLessThanOrEqual(1)
          expect(Math.abs(channel.rms - region.amplitude / 32768 / Math.SQRT2)).toBeLessThan(0.02)
        }
      }
      expect(fixture.wave.size).toBeGreaterThan(64 * 1024 * 1024)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } finally {
      try { await closePhaseCapture(page) } finally {
        try { if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter') }
        finally { await server.close() }
      }
    }
    await expect(page.locator('#status')).toHaveText('待机')
    await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
  })
}
