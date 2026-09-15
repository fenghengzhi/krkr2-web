import { expect, type Page } from '@playwright/test'
let sequence = 0

/** Asynchronous game callbacks may log after the expression's own result. */
export async function evaluate(page: Page, expression: string, result: string): Promise<void> {
  const marker = `test-result-${++sequence}:`
  const source = `${JSON.stringify(marker)}+string(${expression})`
  // A running state can arrive before startup has finished creating/focusing
  // its Windows. Wait for the console's own readiness before editing it.
  await expect(page.locator('#evaluate')).toBeEnabled()
  await page.locator('#expression').fill(source)
  await expect(page.locator('#expression')).toHaveValue(source)
  await page.locator('#evaluate').click()
  await expect(page.getByText(marker + result, { exact: true })).toBeVisible()
}
