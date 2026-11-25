import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { decimalGameSource } from '../helpers/decimal-reals.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: saved decimal coordinates place a visible layer at the original pixel`, async ({ page }) => {
    const game = await launchWindowAttention(page, backend, binary, decimalGameSource)
    try {
      const canvas = game.surface('Decimal layout').locator('canvas[data-window-id]')
      for (const name of ['converted', 'literal', 'restored']) {
        await evaluate(page, `decimalPosition(Scripts.evalStorage(System.dataPath+"${name}.tjs"))`, '64,7')
        await expect.poll(() => canvas.evaluate((element) => {
          const source = element as HTMLCanvasElement
          const dest = new OffscreenCanvas(source.width, source.height), ctx = dest.getContext('2d')!
          ctx.drawImage(source, 0, 0)
          const data = ctx.getImageData(0, 0, source.width, source.height).data, colored: number[] = []
          for (let i = 0; i < data.length; i += 4) {
            if (data[i] === 224 && data[i + 1] === 176 && data[i + 2] === 64 && data[i + 3] === 255) colored.push(i / 4)
            else if (data[i] !== 16 || data[i + 1] !== 32 || data[i + 2] !== 48 || data[i + 3] !== 255) return []
          }
          return [source.width, source.height, ...colored]
        })).toEqual([80, 12, 624, 625, 626, 704, 705, 706])
      }
    } finally { await game.stop() }
  })
