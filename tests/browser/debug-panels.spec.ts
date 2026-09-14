import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: failure logs can be reopened and a replacement game restores its own panel state`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Debug.console.visible=false;Debug.controller.visible=false;throw new Exception("hidden-failure");',
      ),
    })
    await expect(page.locator('#status')).toHaveText('运行失败')
    await expect(page.locator('#choose-files')).toBeEnabled()
    await expect(page.locator('#debug-console')).toBeHidden()
    await page.locator('#toggle-console').click()
    await expect(page.locator('#logs')).toContainText('hidden-failure')
    await expect(page.locator('#evaluate')).toBeDisabled()
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from('Debug.message("replacement-ready");'),
    })
    await expect(page.getByText('replacement-ready', { exact: true })).toBeVisible()
    await expect(page.locator('#debug-controller')).toBeVisible()
    await evaluate(page, '[Debug.console.visible,Debug.controller.visible].join("|")', '1|1')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
  })

  test(`${backend}: script and user panel visibility agree through pause, hiding, logging and restart`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Debug.console.visible=false;Debug.controller.visible=false;Debug.message("hidden-startup");',
      ),
    })
    await expect(page.locator('#status')).toHaveText('运行中')
    await expect(page.locator('#choose-files')).toBeEnabled()
    await expect(page.locator('#debug-console')).toBeHidden()
    await expect(page.locator('#debug-controller')).toBeHidden()
    for (const panel of ['console', 'controller']) {
      await expect(page.locator('#toggle-' + panel)).toHaveAttribute('aria-expanded', 'false')
      await page.locator('#toggle-' + panel).click()
      await expect(page.locator('#debug-' + panel)).toBeVisible()
    }
    await expect(page.getByText('hidden-startup', { exact: true })).toBeVisible()
    await evaluate(page, '[Debug.console.visible,Debug.controller.visible].join("|")', '1|1')
    await page.locator('#pause').click()
    await expect(page.locator('#status')).toHaveText('已暂停')
    await page.locator('#hide-console').click()
    await expect(page.locator('#debug-console')).toBeHidden()
    await expect(page.locator('#toggle-console')).toBeFocused()
    await page.locator('#toggle-controller').click()
    await expect(page.locator('#debug-controller')).toBeHidden()
    await page.locator('#toggle-controller').click()
    await expect(page.locator('#pause')).toBeEnabled()
    await page.locator('#pause').click()
    await expect(page.locator('#status')).toHaveText('运行中')
    await page.locator('#toggle-console').click()
    await evaluate(page, '[Debug.console.visible,Debug.controller.visible].join("|")', '1|1')
    await page
      .locator('#expression')
      .fill('Debug.console.visible=false,Debug.message("hidden-expression")')
    await page.locator('#evaluate').click()
    await expect(page.locator('#debug-console')).toBeHidden()
    await expect(page.locator('#toggle-console')).toBeFocused()
    await page.locator('#toggle-console').click()
    await expect(page.getByText('hidden-expression', { exact: true })).toBeVisible()
    await page.locator('#restart').click()
    await expect(page.locator('#debug-console')).toBeHidden()
    await expect(page.locator('#debug-controller')).toBeHidden()
    await expect(page.locator('#status')).toHaveText('运行中')
    await page.locator('#toggle-controller').click()
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    expect(errors).toEqual([])
  })

  test(`${backend}: hidden controls can be reopened to stop a yielding infinite startup`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        'Debug.console.visible=false;Debug.controller.visible=false;while(true){}',
      ),
    })
    await expect(page.locator('#debug-console')).toBeHidden()
    await expect(page.locator('#debug-controller')).toBeHidden()
    await page.locator('#toggle-controller').click()
    await expect(page.locator('#stop')).toBeEnabled()
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await page.locator('#toggle-console').click()
    await expect(page.locator('#debug-console')).toBeVisible()
  })
}
