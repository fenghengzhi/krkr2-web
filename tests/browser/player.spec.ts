import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: real TJS scene, input, pause, stop and fresh restart`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    const capabilities = await page.evaluate(() => ({
      jspi: 'Suspending' in WebAssembly && 'promising' in WebAssembly,
      webgl: !!new OffscreenCanvas(1, 1).getContext('webgl2'),
    }))
    test.skip(
      !capabilities.webgl,
      'OffscreenCanvas WebGL2 is unavailable in this browser environment',
    )
    test.skip(backend === 'jspi' && !capabilities.jspi, 'JSPI is not implemented by this browser')
    await page.getByRole('button', { name: '运行示例' }).click()
    await expect(page.locator('#logs')).toContainText('会话就绪')
    await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
    await expect(page.locator('#runtime-info')).toContainText('3 个资源')
    const canvas = page.locator('canvas')
    const before = await canvas.screenshot()
    await canvas.click({ position: { x: 120, y: 120 } })
    await expect(page.locator('#logs')).toContainText('点击 1')
    const after = await canvas.screenshot()
    expect(before.equals(after)).toBe(false)
    await page.locator('#expression').fill('6 * 7')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('42')
    await page.locator('#pause').click()
    await expect(page.locator('#status')).toHaveText('已暂停')
    await canvas.click()
    await page.locator('#pause').click()
    await canvas.click()
    await expect(page.locator('#logs')).toContainText('点击 2')
    await page.locator('#restart').click()
    await expect(page.locator('#status')).toHaveText('运行中')
    await expect(page.locator('#evaluate')).toBeEnabled()
    await page.locator('#expression').fill('clicks')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('0')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: game-written files survive reload and backup import`, async ({ page }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI is unavailable',
    )
    const script =
      'var count=0; if(Storages.isExistentStorage("savedata/counter.txt")) count=int([].load("savedata/counter.txt")[0]); count++; [string(count)].save("savedata/counter.txt","z"); Debug.message("persistent-count="+count);'
    const file = { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(script) }
    await page.locator('#files').setInputFiles(file)
    await expect(page.locator('#logs')).toContainText('persistent-count=1')
    await expect(page.locator('#save-status')).toContainText('1 个存档文件，已保存')
    const downloaded = page.waitForEvent('download')
    await page.locator('#export-saves').click()
    const download = await downloaded
    const backup = await readFile((await download.path())!)
    expect(JSON.parse(backup.toString()).files[0].path).toBe('savedata/counter.txt')
    await page.reload()
    await page.locator('#files').setInputFiles(file)
    await expect(page.locator('#logs')).toContainText('persistent-count=2')
    await expect(page.locator('#evaluate')).toBeEnabled()
    await page.locator('#pause').click()
    await page
      .locator('#save-file')
      .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup })
    await expect(page.locator('#logs')).toContainText('存档已导入')
    await page.locator('#pause').click()
    await page.locator('#expression').fill('[].load("savedata/counter.txt")[0]')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('1')
  })

test('a missing startup script reports a useful error and allows recovery', async ({ page }) => {
  await page.goto('/')
  await page.locator('#files').setInputFiles({
    name: 'readme.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a game'),
  })
  await expect(page.locator('#logs')).toContainText('Resource not found: startup.tjs')
  await expect(page.locator('#choose-files')).toBeEnabled()
})

test('stop cancels a running TJS loop without freezing the page', async ({ page }) => {
  await page.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles({
    name: 'startup.tjs',
    mimeType: 'text/plain',
    buffer: Buffer.from('while(true) {}'),
  })
  await expect(page.locator('#status')).toHaveText('运行中')
  await page.locator('#stop').click()
  await expect(page.locator('#stop')).toBeDisabled()
  await expect(page.locator('#choose-files')).toBeEnabled()
  await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
})
