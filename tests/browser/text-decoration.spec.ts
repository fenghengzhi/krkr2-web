import { expect, test } from '@playwright/test'
import { textDecorationGameSource } from '../helpers/text-decoration.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: player clicks change complete underlined and struck-through subtitles`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], pageErrors: string[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    try {
      await page.locator('#files').setInputFiles([
        { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
          ? 'Scripts.compileStorage("subtitles.tjs","savedata/subtitles.cjs",false,true,false);Scripts.execStorage("savedata/subtitles.cjs");'
          : 'Scripts.execStorage("subtitles.tjs");') },
        { name: 'subtitles.tjs', mimeType: 'text/plain', buffer: Buffer.from(textDecorationGameSource) },
      ])
      const canvas = page.locator('#stage canvas[data-window-id]')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveJSProperty('width', 384)
      await expect(canvas).toHaveJSProperty('height', 224)
      await canvas.scrollIntoViewIfNeeded()
      for (const style of [0, 1, 2, 3, 4]) {
        await expect(page.getByText(`subtitle-decoration:${style}`, { exact: true })).toBeVisible({ timeout: 20000 })
        const reference = await page.evaluate((style) => {
          // Independent native Canvas drawing on a full output-size surface.
          // The actual game uses FontService -> per-glyph BrowserGraphics ->
          // Layer bitmap -> Worker renderer. No returned raster bounds are used.
          const width = 384, height = 224, size = 128, glyph = new OffscreenCanvas(width, height),
            ctx = glyph.getContext('2d')!, pixels = new Uint8Array(width * height * 4), metrics: unknown[] = []
          for (let at = 0; at < pixels.length; at += 4) pixels.set([16, 24, 32, 255], at)
          let x = 64
          for (const character of 'AV') {
            ctx.clearRect(0, 0, width, height)
            ctx.font = '128px serif'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = '#ffffff'
            const m = ctx.measureText(character), baseline = m.fontBoundingBoxAscent ?? size * .8,
              thickness = size / 16
            ctx.fillText(character, x, 24 + baseline)
            if (style & 1) ctx.fillRect(x, 24 + baseline + thickness, m.width, thickness)
            if (style & 2) ctx.fillRect(x, 24 + baseline - size * .3, m.width, thickness)
            const ink = ctx.getImageData(0, 0, width, height).data
            // The public drawText call requests monochrome coverage. Threshold
            // each character independently before compositing, as its API does.
            for (let at = 0; at < pixels.length; at += 4)
              if (ink[at + 3]! >= 128) pixels.set([255, 255, 255, 255], at)
            metrics.push({ character, x, width: m.width, baseline, underlineBottom: baseline + thickness * 2 })
            x += Math.round(m.width)
          }
          return { pixels: [...pixels], metrics }
        }, style)
        let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
        await expect.poll(async () => {
          const actual = captured = await canvasPixels(canvas)
          if (actual.width !== 384 || actual.height !== 224) return { dimensions: [actual.width, actual.height] }
          for (let at = 0; at < actual.rgba.length; at++)
            if (actual.rgba[at] !== reference.pixels[at]) return { at, actual: actual.rgba[at], expected: reference.pixels[at] }
          return null
        }, { timeout: 12000 }).toBeNull()
        observations.push({ style, metrics: reference.metrics, width: captured!.width, height: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        await info.attach('subtitle-style-' + style, { body: await canvas.screenshot({ scale: 'css' }), contentType: 'image/png' })
        await info.attach(`subtitle-style-${style}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
        await expect(page.locator('#logs .error')).toHaveCount(0)
        if (style < 4) {
          const box = await canvas.boundingBox()
          expect(box).not.toBeNull()
          await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height * .85)
        }
      }
      expect(pageErrors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('subtitle-decoration-observations', { body: JSON.stringify({ observations, pageErrors,
        logs: await page.locator('#logs').innerText(), source: textDecorationGameSource,
        scope: 'Actual source/bytecode Layer.drawText, five complete backing-canvas RGBA comparisons and real player clicks. Unmodified screen PNGs retain fractional CSS placement separately. System font pixels are compared to the same browser Canvas font; this is not a claim of Win32 raster equality.' }, null, 2), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Subtitle decoration game or cleanup failed', { cause: failures[0] })
  })
