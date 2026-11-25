import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { postedKagSource } from '../helpers/window-post-input.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: original KAG padKeyMap posts a real mouse-key click into its Layer tree`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], errors: string[] = [],
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      expect(createHash('sha256').update(original).digest('hex'))
        .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      await info.attach('posted-kag-observer', { body: postedKagSource, contentType: 'text/plain' })
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'posted-observer.tjs', mimeType: 'text/plain', buffer: Buffer.from(postedKagSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("posted-observer.tjs","savedata/posted-observer.cjs",false,true,false);Scripts.execStorage("savedata/posted-observer.cjs");'
          : 'Scripts.execStorage("posted-observer.tjs");') },
      ])
      await expect(page.getByText('posted-kag-observer-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      await expect(page.locator('#evaluate')).toBeEnabled()
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      // Only game-owned configuration and the test's button are added. In
      // particular MainWindow.action/onKeyDown and Window.postInputEvent are
      // never replaced or invoked directly by this harness.
      await evaluate(page, '(preparePostedKag(),[kag.padKeyMap[VK_F8],kag.useMouseKey,postedKagCount].join(","))', '13,1,0')
      const surface = page.locator('.game-window[data-window-id]'), canvas = surface.locator('canvas[data-window-id]')
      await expect(surface).toHaveCount(1)
      await canvas.scrollIntoViewIfNeeded()
      const size = await canvas.evaluate((el) => ({ width: (el as HTMLCanvasElement).width, height: (el as HTMLCanvasElement).height })),
        box = await canvas.boundingBox()
      expect(box).not.toBeNull()
      expect(size.width).toBeGreaterThan(0); expect(size.height).toBeGreaterThan(0)
      // KAG's original logical primary is 640x480; use the actual displayed
      // canvas projection. Merely move/focus, so only F8's posted path can click.
      await page.mouse.move(box!.x + box!.width * 36 / 640, box!.y + box!.height * 32 / 480)
      await canvas.focus()
      await expect(surface.locator('.game-text-input')).toBeFocused()
      await page.keyboard.press('F8')
      await expect(page.getByText('posted-kag-click:1', { exact: true })).toBeVisible()
      let screenshot: Buffer | undefined
      await expect.poll(async () => {
        screenshot = await canvas.screenshot()
        const image = readScreenshotPng(screenshot), at = (Math.floor(image.height * 32 / 480) * image.width + Math.floor(image.width * 36 / 640)) * 4
        return [...image.rgba.subarray(at, at + 4)]
      }).toEqual([200, 60, 20, 255])
      await info.attach('posted-kag-real-click', { body: screenshot!, contentType: 'image/png' })
      await evaluate(page, '[postedKagCount,System.getKeyState(VK_RETURN),System.getKeyState(VK_LBUTTON)].join(",")', '1,0,0')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('posted-kag-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Original KAG posted input or cleanup failed', { cause: failures[0] })
  })
