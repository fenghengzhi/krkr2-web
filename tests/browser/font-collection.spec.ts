import { test, expect } from '@playwright/test'
import { fontCollectionCases, fontCollectionFiles, fontCollectionFrameMismatch,
  fontCollectionGameSource, fontCollectionLists } from '../helpers/font-collection-game.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: dialogue pages use all collection families and styles and filename loading returns to face zero`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await fontCollectionFiles(), failures: unknown[] = [], observations: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      game = await launchWindowAttention(page, backend, binary, fontCollectionGameSource,
        Object.entries(fixture.files).map(([name, buffer]) => ({ name, buffer, mimeType: 'application/octet-stream' })), true)
      const canvas = game.surface('Click below to change collection face').locator('canvas[data-window-id]')
      await expect(canvas).toHaveJSProperty('width', 480); await expect(canvas).toHaveJSProperty('height', 100)
      await expect(page.getByText(`collection-list:${fontCollectionLists.all};${fontCollectionLists.horizontal};${fontCollectionLists.fixed}`, { exact: true })).toBeVisible()
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      for (const [phase, row] of fontCollectionCases.entries()) {
        if (phase) { const point = await pointerPixel(canvas, 60, 80); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`collection-face:${phase}:${row.width}:${row.face}:${Number(row.bold)}:${Number(row.file)}`, { exact: true })).toBeVisible({ timeout: 15000 })
        if (row.file) await expect(page.getByText('collection-file-charset:' + fontCollectionLists.fileCharset, { exact: true })).toBeVisible()
        let png: Buffer | undefined
        try {
          await expect.poll(async () => {
            png = await canvas.screenshot({ scale: 'css', timeout: 5000 })
            const image = readScreenshotPng(png)
            const mismatch = fontCollectionFrameMismatch(image.rgba, image.width, image.height, phase)
            if (observations.length < 96) observations.push({ phase, ...row, mismatch })
            return mismatch
          }, { timeout: 15000 }).toBeNull()
        } catch (error) {
          const pictureFailures = [error]
          if (png) try { await info.attach(`font-collection-failed-${phase}`, { body: png, contentType: 'image/png' }) }
          catch (attachmentError) { pictureFailures.push(attachmentError) }
          if (pictureFailures.length > 1) throw new AggregateError(pictureFailures, 'Font collection picture and failure attachment failed', { cause: error })
          throw error
        }
        await info.attach(`font-collection-${phase}`, { body: png!, contentType: 'image/png' })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('authored-font-collection', { body: fixture.files['dialogue.ttc'], contentType: 'font/collection' }),
      () => info.attach('font-collection-game', { contentType: 'application/json', body: JSON.stringify({
        fixture: fixture.evidence, source: fontCollectionGameSource, observations,
        scope: 'Actual Font.getList and source/bytecode Layer.drawText, real clicks, entire target panel compared with standalone authored font references. Only the TTC participates in family discovery; filename mode must use its first member.' }, null, 2) }),
      async () => info.attach('font-collection-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else {
        const modal = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
        if (await modal.count()) await modal.last().click({ timeout: 5000 })
        else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      }
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Font collection browser scene or cleanup failed', { cause: failures[0] })
  })
