import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { scrollPhaseFiles, scrollPhasePixels, scrollPhaseSource } from '../helpers/scroll-phase.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: the real game canvas commits the 29-pixel scroll boundary without fractional rounding`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], readings: unknown[] = []
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      game = await launchWindowAttention(page, backend, binary, scrollPhaseSource,
        Object.entries(scrollPhaseFiles()).map(([name, bytes]) => ({ name, mimeType: 'image/bmp', buffer: Buffer.from(bytes) })), true)
      const canvas = game.surface('scroll-phase').locator('canvas[data-window-id]')
      for (const from of [0, 1, 2, 3]) {
        await evaluate(page, `scrollPhaseStart(${from})`, '0')
        for (const tick of [0, 28, 29, 30, 100] as const) {
          await evaluate(page, `scrollPhaseAt(${tick})`, tick === 100 ? '1' : '0')
          let actual: { width: number; height: number; pixels: number[] } | undefined
          try {
            // Frame delivery and console replies use different ports. Keep
            // the script clock frozen and wait for these exact backing bytes,
            // not for CSS dimensions or a later transition time.
            await expect.poll(async () => actual = await canvas.evaluate((node) => {
              const source = node as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
                context = output.getContext('2d', { willReadFrequently: true })!
              context.drawImage(source, 0, 0)
              return { width: source.width, height: source.height, pixels: [...context.getImageData(0, 0, source.width, source.height).data] }
            }), { message: `${from}/${tick}: every real renderer channel` }).toEqual({
              width: 100, height: 100, pixels: scrollPhasePixels(from, tick),
            })
          } finally { readings.push({ from, tick, actual }) }
        }
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('integer-scroll-frames', { body: JSON.stringify({ readings }), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try {
      const modal = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
      if (await modal.count()) await modal.last().press('Enter', { timeout: 5000 })
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      if (game) await game.waitForStopped(); else await expect(page.locator('#status')).toHaveText('待机')
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Integer scroll browser or cleanup failed', { cause: failures[0] })
  })
