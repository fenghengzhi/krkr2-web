import { test, expect } from '@playwright/test'
import { layerDefaultFontCases, layerDefaultFontSource, layerDefaultFontFrameMismatch } from '../helpers/layer-default-font.ts'
import { launchWindowAttention, expectAttentionAnchor } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: default dialogue text and input hint use the original 12-pixel font before explicit game resizing`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, layerDefaultFontSource + '\ndefaultFontMenu();'),
      surface = game.surface('Default dialogue font'), canvas = surface.locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      for (const row of layerDefaultFontCases) await evaluate(page, `layerDefaultFontObserve(${JSON.stringify(row.id)})`, row.expected)
      for (const [phase, height] of [-12, 12, 24].entries()) {
        if (phase) { const point = await pointerPixel(canvas, 160, 120); await page.mouse.click(point.x, point.y) }
        await expect(page.getByText(`default-font-phase:${phase}:${height}:${Math.abs(height)}`, { exact: true })).toBeVisible()
        await evaluate(page, 'defaultFontText.font.face+"|"+defaultFontText.font.height', `ＭＳ Ｐゴシック|${height}`)
        const input = surface.locator('.game-text-input')
        await expect(input).toHaveCSS('font-size', `${Math.abs(height)}px`)
        expect(await input.evaluate((element) => element.style.fontFamily.replace(/^["']|["']$/g, ''))).toBe('ＭＳ Ｐゴシック')
        await expectAttentionAnchor(surface, 8 / 320, 36 / 144)
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.bounds.width !== 320 || image.bounds.height !== 144) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          return layerDefaultFontFrameMismatch(Uint8Array.from(image.rgba), image.width, image.height, phase)
        }).toBeNull()
        await info.attach(`default-font-${phase}`, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach(`default-font-${phase}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
        observations.push({ phase, height, width: captured!.width, canvasHeight: captured!.height,
          bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio,
          input: await input.evaluate((element) => ({ family: element.style.fontFamily, size: element.style.fontSize })) })
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length && captured) for (const attach of [
      () => info.attach('default-font-last-captured-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' }),
      async () => info.attach('default-font-failed-screen', { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    try { await info.attach('default-font-observations', { body: JSON.stringify({ source: layerDefaultFontSource, observations,
      lastCanvas: captured && { width: captured.width, height: captured.height, bounds: captured.bounds, devicePixelRatio: captured.devicePixelRatio },
      scope: 'Actual Layer font properties, complete backing-canvas text panels and sampled DOM input font. Unmodified screen PNGs retain fractional CSS placement separately. The reference explicitly selects the same face and absolute height. Browser system substitution and CSS IME hints do not assert Win32 glyph/IME equivalence.',
      logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Default dialogue font or cleanup failed', { cause: failures[0] })
  })
