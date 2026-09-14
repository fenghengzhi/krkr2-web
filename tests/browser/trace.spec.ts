import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: startup debug switch exposes native traces and survives restart`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?backend=' + backend)
    const startup = {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        [
          'function frame(){return Scripts.getTraceString();}',
          'var captured=frame();',
          'Debug.message("trace-game-ready");',
        ].join('\n'),
      ),
    }
    await page.locator('#files').setInputFiles(startup)
    await expect(page.getByText('trace-game-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'captured', '')
    await page.locator('#script-debug').check()
    await evaluate(page, 'Scripts.getTraceString()', '')
    await page.locator('#clear-log').click()
    await page.locator('#restart').click()
    await expect(page.getByText('trace-game-ready', { exact: true })).toBeVisible()
    await evaluate(
      page,
      'captured',
      'startup.tjs(1)[(function) frame] <-- startup.tjs(2)[(top level script) global]',
    )
    await evaluate(page, 'System.getArgument("-debug")', 'yes')
    await evaluate(page, 'Scripts.getTraceString(1).indexOf("krkr2-web/")', '-1')
    await page.locator('#script-debug').uncheck()
    await page.locator('#clear-log').click()
    await page.locator('#restart').click()
    await expect(page.getByText('trace-game-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'captured', '')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    expect(errors).toEqual([])
  })
}
