import { expect, type Page } from '@playwright/test'
let sequence = 0

/** Asynchronous game callbacks may log after the expression's own result. */
export async function evaluate(page: Page, expression: string, result: string): Promise<void> {
  const marker = `test-result-${++sequence}:`
  await page.locator('#expression').fill(`${JSON.stringify(marker)}+string(${expression})`)
  await page.locator('#evaluate').click()
  await expect(page.getByText(marker + result, { exact: true })).toBeVisible()
}
