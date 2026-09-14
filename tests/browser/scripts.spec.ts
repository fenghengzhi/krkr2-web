import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'
import { scriptsFixture, reentrantScriptsFixture } from '../helpers/scripts-fixture.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: native Scripts execution, compilation and reflection reach browser saves`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?backend=' + backend)
    await page.locator('#script-debug').check()
    await page.locator('#files').setInputFiles(
      Object.entries(scriptsFixture).map(([name, source]) => ({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(source),
      })),
    )
    await expect(page.getByText('native-scripts-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'scope.value', '9')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#export-saves').click(),
    ])
    const backup = JSON.parse(await readFile((await download.path())!, 'utf8'))
    const output = backup.files.find(
      (file: { path: string }) => file.path === 'savedata/native.cjs',
    )
    expect(Buffer.from(output.base64, 'base64').subarray(0, 4).toString()).toBe('TJS2')
    await page.locator('#stop').click()
    await page.locator('#files').setInputFiles(
      Object.entries(reentrantScriptsFixture).map(([name, source]) => ({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(source),
      })),
    )
    await expect(page.getByText('reentrant-scripts-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'outerResult', '84')
    await page.locator('#stop').click()
    expect(errors).toEqual([])
  })
