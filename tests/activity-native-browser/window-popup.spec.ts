import { test, expect } from '../helpers/native-activity-browser.ts'
import type { Page } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { popupSource, observePopupDom, reset, sequence, focusGame } from '../helpers/window-popup-fixture.ts'

// The regular Playwright pages force focus/visibility. Keep the original real
// blur, false hasFocus(), one-notice and restoration assertions in a browser
// connection that explicitly omits those overrides; do not synthesize events.
for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: trusted application blur notifies popups once and real restoration preserves Window input`, async ({ native, baseURL }, info) => {
    test.setTimeout(90000)
    const { page } = native, failures: unknown[] = []
    let other: Page | undefined, game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    await observePopupDom(page)
    try {
      await page.goto(`${baseURL}/?backend=${backend}`)
      await page.locator('#pause-background').uncheck()
      game = await launchWindowAttention(page, backend, binary, popupSource, [], true)
      const main = game.surface('Popup main')
      await reset(page, 'application-blur')
      await page.bringToFront()
      await focusGame(page, main)
      const blurBefore = await page.evaluate(() => window.popupDomEvidence!.events.filter((event) => event.type === 'blur').length)
      other = await page.context().newPage()
      await other.setContent('<button type="button">Other application surface</button>')
      await other.bringToFront()
      await other.getByRole('button', { name: 'Other application surface', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.popupDomEvidence!.events.filter((event) => event.type === 'blur').length))
        .toBeGreaterThan(blurBefore)
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      const events = await page.evaluate(() => window.popupDomEvidence!.events)
      expect(events.filter((event) => event.type === 'blur').slice(blurBefore)
        .every((event) => event.trusted === true && event.target === 'window')).toBe(true)
      await sequence(page, 'application-blur', 'hide:new|action:old')
      await page.bringToFront()
      await focusGame(page, main)
      await page.keyboard.press('F8')
      await sequence(page, 'application-blur', 'hide:new|action:old|key:main:119')
      await expect(game.surface('Popup old')).toBeVisible()
      await expect(game.surface('Popup new')).toBeVisible()
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (other) {
      try { await other.close(); await page.bringToFront() } catch (error) { failures.push(error) }
    }
    try {
      const evidence = await page.evaluate(() => window.popupDomEvidence)
      await info.attach('window-popup-trusted-deactivation', { body: JSON.stringify({
        scope: 'Owned Chromium connected with noDefaults; actual tab activation, no dispatched focus/blur/visibility events',
        sourceScenario: 'tests/browser/window-popup.spec.ts: application-blur subsection before batch 093',
        evidence, logs: await page.locator('#logs').innerText(),
      }, null, 2), contentType: 'application/json' })
      expect(evidence?.dropped).toBe(0)
    } catch (error) { failures.push(error) }
    try { await game?.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Native popup scenario and cleanup failed', { cause: failures[0] })
  })
}
