import { test, expect } from '../helpers/native-activity-browser.ts'
import type { Page } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { observeApplication, systemApplicationSource } from '../helpers/system-application-browser.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: trusted application focus dispatches System callbacks and disabled transitions replace pending input`, async ({ native, baseURL }, info) => {
    test.setTimeout(90000)
    const { page } = native, errors: unknown[] = []
    let other: Page | undefined, game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    await observeApplication(page)
    try {
      await page.goto(`${baseURL}/?backend=${backend}`)
      await page.locator('#pause-background').uncheck()
      game = await launchWindowAttention(page, backend, binary, systemApplicationSource, [], true)
      await page.bringToFront()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      await evaluate(page, '(applicationTrace.clear(),0)', '0')
      other = await page.context().newPage()
      await other.setContent('<button>Other application</button>')
      await other.bringToFront(); await other.getByRole('button').click()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await expect(page.getByText('system-application:deactivate', { exact: true })).toBeVisible()
      await page.bringToFront()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      await expect(page.getByText('system-application:deactivate|activate', { exact: true })).toBeVisible()
      await evaluate(page, '(applicationTrace.clear(),System.eventDisabled=true,0)', '0')
      const before = await page.evaluate(() => window.systemApplicationEvidence.messages.length)
      await other.bringToFront(); await other.getByRole('button').click()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await page.bringToFront()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      await expect.poll(() => page.evaluate(() => window.systemApplicationEvidence.messages.length)).toBe(before + 2)
      await evaluate(page, 'applicationTrace.join("|")', '')
      await evaluate(page, '(System.eventDisabled=false,0)', '0')
      await expect(page.getByText('system-application:activate', { exact: true })).toBeVisible()
      await evaluate(page, 'applicationTrace.join("|")', 'activate')
      const proof = await page.evaluate(() => window.systemApplicationEvidence)
      expect(proof.events.some((event) => event.type === 'blur' && event.windowTarget && event.trusted && !event.focused)).toBe(true)
      expect(proof.events.some((event) => event.type === 'focus' && event.windowTarget && event.trusted && event.focused)).toBe(true)
      expect(proof.messages.slice(before).map((value) => value.active)).toEqual([false, true])
      expect(proof.dropped).toBe(0)
      await game.stop()
      const stopped = await page.evaluate(() => window.systemApplicationEvidence.messages.length)
      await other.bringToFront(); await other.getByRole('button').click()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await page.bringToFront()
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
      expect(await page.evaluate(() => window.systemApplicationEvidence.messages.length)).toBe(stopped)
    } catch (error) { errors.push(error) }
    if (other) { try { await other.close(); await page.bringToFront() } catch (error) { errors.push(error) } }
    try { await info.attach('system-application-native-focus', { body: JSON.stringify({
      scope: 'Owned Chromium noDefaults; actual trusted tab focus/visibility, no dispatched focus events',
      evidence: await page.evaluate(() => window.systemApplicationEvidence), logs: await page.locator('#logs').innerText(),
      unverified: 'External OS application focus for Firefox/WebKit is not established by this Chromium scenario',
    }), contentType: 'application/json' }) } catch (error) { errors.push(error) }
    try { if (game && await page.locator('#stop').isEnabled()) await game.stop() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'Trusted System application scenario failed', { cause: errors[0] })
  })
}
