import { test, expect } from '../helpers/native-activity-browser.ts'
import type { Page } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { observeApplication } from '../helpers/system-application-browser.ts'
import { maintenanceSource, observeMaintenance } from '../helpers/system-maintenance-browser.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: trusted application deactivation compacts before its callback and is independent of disabled input`, async ({ native, baseURL }, info) => {
    test.setTimeout(90000)
    const { page } = native, failures: unknown[] = []
    let other: Page | undefined, game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    await observeApplication(page); await observeMaintenance(page)
    await page.goto(`${baseURL}/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      await page.locator('#pause-background').uncheck()
      game = await launchWindowAttention(page, backend, binary, maintenanceSource, [], true)
      await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      const before = await page.evaluate(() => window.maintenanceProof.entries.length)
      other = await page.context().newPage(); await other.setContent('<button>Owned other page</button>')
      await other.bringToFront(); await other.getByRole('button').click()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await expect.poll(() => page.evaluate((before) => window.maintenanceProof.entries.slice(before).some((entry) => entry.kind === 'debug' && entry.text === 'maintenance:deactivate'), before)).toBe(true)
      const first = await page.evaluate((before) => window.maintenanceProof.entries.slice(before), before),
        compact = first.find((entry) => entry.kind === 'compact' && entry.level === 10),
        callback = first.find((entry) => entry.kind === 'debug' && entry.text === 'maintenance:deactivate')
      expect(compact).toBeDefined(); expect(callback).toBeDefined(); expect(compact!.sequence).toBeLessThan(callback!.sequence)
      await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      await evaluate(page, '(System.eventDisabled=true,0)', '0')
      const disabled = await page.evaluate(() => window.maintenanceProof.entries.length)
      await other.bringToFront(); await other.getByRole('button').click()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await expect.poll(() => page.evaluate((after) => window.maintenanceProof.entries.slice(after).some((entry) => entry.kind === 'compact' && entry.level === 10), disabled)).toBe(true)
      expect(await page.evaluate((after) => window.maintenanceProof.entries.slice(after).some((entry) => entry.kind === 'debug'), disabled)).toBe(false)
      await page.bringToFront(); await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      await evaluate(page, '(System.eventDisabled=false,fakeCompacts)', '0')
      const proof = await page.evaluate(() => window.maintenanceProof), activity = await page.evaluate(() => window.systemApplicationEvidence)
      expect(proof.entries.some((entry) => entry.level === 15)).toBe(false)
      expect(proof.dropped).toBe(0)
      expect(activity.events.some((event) => event.type === 'blur' && event.trusted && event.windowTarget && !event.focused)).toBe(true)
      await info.attach('trusted-automatic-compact', { body: JSON.stringify({ proof, activity,
        scope: 'Owned Chromium noDefaults trusted tab focus; Firefox/WebKit OS deactivation and OS minimization remain unverified' }), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try { if (other) { await other.close(); await page.bringToFront() } } catch (error) { failures.push(error) }
    try { if (game) await game.stop(); await page.evaluate(() => window.closeMaintenanceProof()) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Trusted automatic compact or cleanup failed', { cause: failures[0] })
  })
}
