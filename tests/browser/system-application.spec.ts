import { test, expect } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { observeApplication, systemApplicationSource } from '../helpers/system-application-browser.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: switching game Windows, menus and page controls does not fabricate System application events`, async ({ page }, info) => {
    test.setTimeout(90000)
    await observeApplication(page)
    const game = await launchWindowAttention(page, backend, binary, systemApplicationSource), errors: unknown[] = []
    try {
      await evaluate(page, '(applicationTrace.clear(),0)', '0')
      const count = await page.evaluate(() => window.systemApplicationEvidence.messages.length)
      for (const caption of ['Application A', 'Application B']) {
        const surface = game.surface(caption), canvas = surface.locator('canvas[data-window-id]')
        const point = await pointerPixel(canvas, 20, 20)
        await page.mouse.click(point.x, point.y)
        await surface.getByText('Application tools', { exact: true }).click()
        await page.keyboard.press('Escape')
      }
      await page.locator('#expression').focus()
      await evaluate(page, 'applicationTrace.join("|")', '')
      expect(await page.evaluate(() => window.systemApplicationEvidence.messages.length)).toBe(count)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { errors.push(error) }
    try { await info.attach('system-application-internal-focus', { body: JSON.stringify({
      scope: 'Real DOM internal focus/menu operations; no claim of OS application focus in regular Playwright',
      evidence: await page.evaluate(() => window.systemApplicationEvidence),
    }), contentType: 'application/json' }) } catch (error) { errors.push(error) }
    try { await game.stop() } catch (error) { errors.push(error) }
    if (errors.length === 1) throw errors[0]
    if (errors.length) throw new AggregateError(errors, 'System application internal-focus scenario failed', { cause: errors[0] })
  })
}
