import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { sessionTransitionChecks, sessionTransitionFiles } from '../helpers/session-transition-options.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: Layer transition options, callbacks and recovery through the Worker`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const errors: string[] = [], failures: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      await page.locator('#files').setInputFiles(Object.entries(sessionTransitionFiles(binary)).map(([name, data]) => ({
        name, mimeType: typeof data === 'string' ? 'text/plain' : 'application/octet-stream',
        buffer: typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data),
      })))
      await expect(page.getByText('transition-options-ready', { exact: true })).toBeVisible()
      for (let start = 0; start < sessionTransitionChecks.length; start += 4) {
        const group = sessionTransitionChecks.slice(start, start + 4)
        await evaluate(page, `[${group.map((check) => check.call).join(',')}].join(" / ")`,
          group.map((check) => check.expected).join(' / '))
      }
      await evaluate(page, '(transitionOptionClose(),int(!isvalid transitionWindow))', '1')
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('transition-options-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Worker transition options and cleanup failed', { cause: failures[0] })
  })
}
