import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { alphaTransitionCases, alphaTransitionCanvas, alphaTransitionExpected, alphaTransitionFiles,
  alphaTransitionLeafExpected, alphaTransitionSource } from '../helpers/transition-alpha.ts'

async function frame(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height, rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}
for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: live alpha and PS transition bytes reach exact RGB and mask canvas rows`, async ({ page }, info) => {
    test.setTimeout(180000)
    const game = await launchWindowAttention(page, backend, binary, alphaTransitionSource,
      Object.entries(alphaTransitionFiles()).map(([name, buffer]) => ({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(buffer) }))),
      canvas = game.surface('Alpha transition reference').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    try {
      for (const c of alphaTransitionCases) {
        if (c.kind === 'crossfade') {
          await evaluate(page, `alphaTransitionLeaf(${c.type})`, alphaTransitionLeafExpected)
          observations.push({ id: c.id + ':leaf', expected: alphaTransitionLeafExpected })
        }
        await evaluate(page, `alphaTransitionStart(${c.type},"${c.kind}",${c.time},${c.vague})`, 'started')
        for (const { tick, rgba } of c.frames) {
          await evaluate(page, `alphaTransitionSample(${tick})`, alphaTransitionExpected(rgba, tick === c.time))
          await expect.poll(() => frame(canvas)).toEqual(alphaTransitionCanvas(rgba))
          observations.push({ id: c.id, tick, expectedRaw: [...rgba], canvas: await frame(canvas) })
        }
      }
      await evaluate(page, 'alphaTransitionClose()', 'closed')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('alpha-transition-observations', { contentType: 'application/json', body: JSON.stringify({
        backend, binary, observations,
        scope: 'Real source/bytecode Worker Layers, clock-confirmed piledCopy and literal raw pixels; actual opaque RGB and mask display rows. Full-alpha composition cannot erase the zero-alpha RGB evidence.',
      }) })
    } catch (error) { failures.push(error) }
    try { await info.attach('alpha-transition-log', { contentType: 'text/plain', body: await page.locator('#logs').innerText() }) }
    catch (error) { failures.push(error) }
    try {
      await game.stop()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Alpha transition browser bytes or cleanup failed', { cause: failures[0] })
  })
}
