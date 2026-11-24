import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import {
  eriContractFiles, eriContractSource, eriContractCases, eriRgbNegative, eriRgbPositive,
  eriGrayNegative, eriGrayPositive, eriGrayRgba, eriKey1, eriPaletteGray, eriMaskedRgba,
  eriError, eriProvinceReason,
} from '../helpers/eri-fixtures.ts'
import {
  eriTruecolorCases, eriTruecolorError, eriTruecolorFiles, eriTruecolorSource, eriTrueGray, eriTrueRgb, eriTrueRgba,
} from '../helpers/eri-truecolor-fixtures.ts'
import { eriHuffmanCases, eriHuffmanFiles, eriHuffmanPaletteCases } from '../helpers/eri-huffman-fixtures.ts'

async function frame(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height, rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}
// Show opaque RGB plus the actual mask in a separate Layer, including transparent
// colors and alpha1/2, without compositing-rounding concealing those bytes.
function expectedFrame(rgba: readonly number[], width = 3) {
  return { width, height: 2 * rgba.length / (4 * width), rgba: [...rgba.map((value, at) => at % 4 === 3 ? 255 : value),
    ...rgba.filter((_value, at) => at % 4 === 3).flatMap((value) => [value, value, value, 255])] }
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: independent ERI rows, keys, masks and native failures traverse the real Worker and canvas`, async ({ page }, info) => {
    test.setTimeout(120000)
    const game = await launchWindowAttention(page, backend, binary, eriContractSource,
      Object.entries(eriContractFiles()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) }))),
      canvas = game.surface('ERI native contract').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    const loaded = async (name: string, key: string, expected: readonly number[]) => {
      await evaluate(page, `eriLoad(eriImage,"${name}",${key})`, 'ok')
      await evaluate(page, 'eriPixels(eriImage)', expected.join(','))
      await evaluate(page, 'eriShowMask()', '0')
      await expect.poll(() => frame(canvas)).toEqual(expectedFrame(expected))
      observations.push({ name, key, frame: await frame(canvas) })
    }
    try {
      for (const [name, expected] of [
        ['rgb-negative.eri', eriRgbNegative], ['rgb-positive.eri', eriRgbPositive],
        ['gray-negative.eri', eriGrayRgba(eriGrayNegative)], ['gray-positive.eri', eriGrayRgba(eriGrayPositive)],
      ] as const) {
        await loaded(name, 'clNone', expected)
        await evaluate(page, `eriLoad(eriCopy,"${name}",clNone)`, 'ok')
        await evaluate(page, '(eriImage.setMainPixel(0,0,0xabcdef),eriImage.setMaskPixel(0,0,17),0)', '0')
        await evaluate(page, 'eriPixels(eriCopy)', expected.join(','))
        await loaded(name, 'clNone', expected)
      }
      await loaded('rgb-negative.eri', 'clPalIdx+1', eriKey1)
      await evaluate(page, 'eriLoad(eriCopy,"rgb-negative.eri",clPalIdx+1)', 'ok')
      await evaluate(page, '(eriImage.setMainPixel(1,0,0),eriImage.setMaskPixel(1,0,222),0)', '0')
      await evaluate(page, 'eriPixels(eriCopy)', eriKey1.join(','))
      await loaded('rgb-negative.eri', 'clPalIdx+1', eriKey1)
      await loaded('rgb-negative.eri', 'clPalIdx+255', eriRgbNegative)
      await loaded('gray-negative.eri', 'clPalIdx+1', eriGrayRgba(eriGrayNegative))
      await loaded('masked-gray.eri', 'clNone', eriMaskedRgba(eriGrayNegative))
      await loaded('masked-palette.eri', 'clNone', eriMaskedRgba(eriPaletteGray))
      await evaluate(page, 'eriLoad(eriCopy,"masked-palette.eri",clNone)', 'ok')
      await evaluate(page, '(System.clearGraphicCache(),0)', '0')
      for (let attempt = 0; attempt < 2; attempt++) {
        await evaluate(page, 'eriLoad(eriImage,"masked-bad.eri",clNone)', eriError('ERIDecoder::DecodeImage failed.'))
        await evaluate(page, 'eriPixels(eriImage)', eriRgbNegative.join(','))
        await evaluate(page, 'eriPixels(eriCopy)', eriMaskedRgba(eriPaletteGray).join(','))
      }
      for (const entry of eriContractCases.filter((entry) => entry.mode === 'normal' && entry.error)) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await loaded('rgb-negative.eri', 'clNone', eriRgbNegative)
          await evaluate(page, '(System.clearGraphicCache(),0)', '0')
          await evaluate(page, `eriLoad(eriImage,"${entry.name}",clNone)`, eriError(entry.error!))
          const expected = entry.sizeExpected ? Array(24).fill(0) : eriRgbNegative
          await evaluate(page, 'eriPixels(eriImage)', expected.join(','))
          observations.push({ name: entry.name, attempt, error: entry.error, sizeExpected: entry.sizeExpected, retainedRgba: expected })
        }
      }
      await loaded('rgb-negative.eri', 'clNone', eriRgbNegative)
      await evaluate(page, 'eriProvince("rgb-negative.eri")', eriError(eriProvinceReason))
      await evaluate(page, 'eriPixels(eriImage)', eriRgbNegative.join(','))
      await evaluate(page, '(System.clearGraphicCache(),0)', '0')
      await loaded('rgb-positive.eri', 'clNone', eriRgbPositive)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('eri-consumer', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, observations,
      scope: 'Hand-authored ERINA v2 RL-MTF-G bytes through the real Worker, source/bytecode, private Layer cache destinations and RGB/mask canvas. Failed post-size bitmap zeroes are explicitly Web-defined.',
    }) }) } catch (error) { failures.push(error) }
    try {
      await game.stop()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'ERI browser consumer or cleanup failed', { cause: failures[0] })
  })

const colorSuites = [
  { title: 'truecolor ERI', prefix: 'tc', cases: eriTruecolorCases, files: eriTruecolorFiles, alpha: 'tc-rgba-v1-independent.eri' },
  { title: 'Huffman ERI', prefix: 'hc', cases: eriHuffmanCases, files: eriHuffmanFiles, alpha: 'hc-rgba-inline.eri' },
]
for (const suite of colorSuites) for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: ${suite.title} in visible Layers and companion masks`, async ({ page }, info) => {
    test.setTimeout(120000)
    const game = await launchWindowAttention(page, backend, binary, eriTruecolorSource,
      Object.entries(suite.files()).map(([name, bytes]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(bytes) })))
    const canvas = game.surface('ERI truecolor').locator('canvas[data-window-id]')
    const failures: unknown[] = [], observed: string[] = []
    const display = async (name: string, key: string, rgba: readonly number[]) => {
      await evaluate(page, `tcLoad(tcImage,"${name}",${key})`, 'ok')
      await evaluate(page, 'tcPixels(tcImage)', rgba.join(','))
      await evaluate(page, 'tcShowMask()', '0')
      await expect.poll(() => frame(canvas)).toEqual(expectedFrame(rgba))
      observed.push(name + ' ' + key)
    }
    try {
      for (const item of suite.cases.filter((item) => item.width === 3 && item.height === 3))
        await display(item.name, 'clNone', item.rgba)
      await display(suite.alpha, '0x0a141e', eriTrueRgba.map((v, i) => i % 4 === 3 ? (i === 3 ? 0 : 255) : v))
      const mask = eriTrueRgb.map((v, i) => i % 4 === 3 ? eriTrueGray[i >> 2]! : v)
      const name = suite.prefix + '-mask'
      await display(name + '.eri', 'clNone', mask)
      await evaluate(page, `tcLoad(tcCopy,"${name}.eri",clNone)`, 'ok')
      await evaluate(page, '(System.clearGraphicCache(),0)', '0')
      await evaluate(page, `tcLoad(tcImage,"${name}-bad.eri",clNone)`, `eri-true:<${eriTruecolorError}>`)
      await evaluate(page, 'tcPixels(tcImage)', eriTrueRgb.join(','))
      await evaluate(page, 'tcPixels(tcCopy)', mask.join(','))
      await display(name + '.eri', 'clNone', mask)
      if (suite.prefix === 'hc') {
        for (const item of eriHuffmanPaletteCases) {
          await evaluate(page, `tcLoad(tcImage,"${item.name}",clNone)`, 'ok')
          await evaluate(page, 'tcPixels(tcImage)', item.rgba.join(','))
          observed.push(item.name)
        }
        await evaluate(page, 'tcLoad(tcImage,"hp-indexed-negative.eri",clPalIdx+1)', 'ok')
        await evaluate(page, 'tcPixels(tcImage)', eriKey1.join(','))
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('eri-truecolor', { contentType: 'application/json', body: JSON.stringify({ backend, binary, codec: suite.title, observed }) })
    } catch (error) { failures.push(error) }
    try {
      await game.stop()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'ERI truecolor browser consumer or cleanup failed', { cause: failures[0] })
  })
