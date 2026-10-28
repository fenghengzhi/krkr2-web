import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { exceptionContextInitial, exceptionContextAnonymous, exceptionContextBound,
  exceptionContextRecovered, systemExceptionContextSource } from '../helpers/system-exception-context.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: real Worker exception callbacks preserve native receiver context and remain usable`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, systemExceptionContextSource), failures: unknown[] = []
    try {
      await evaluate(page, 'exceptionContextSnapshot()', exceptionContextInitial)
      const canvas = game.surface('Exception context').locator('canvas[data-window-id]')
      for (const [bound, expected] of [[0, exceptionContextAnonymous], [1, exceptionContextBound], [0, exceptionContextRecovered]] as const) {
        await evaluate(page, `armExceptionContext(${bound})`, '1')
        await canvas.click({ position: { x: 8, y: 8 } })
        await evaluate(page, 'exceptionContextSnapshot()', expected)
        await evaluate(page, 'int(System.eventDisabled)', '0')
      }
      await expect(page.locator('.game-system-dialog')).toHaveCount(0)
      await expect(page.locator('#status')).toHaveText('运行中')
    } catch (error) { failures.push(error) }
    try { await info.attach('exception-context-worker-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Worker exception context or cleanup failed', { cause: failures[0] })
  })
}
