import { expect, test } from '@playwright/test'
import { mouseButtonChoiceSource, mouseButtonSteps, mouseButtonTrace } from '../helpers/mouse-button-choice.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

interface ButtonInput { type: string; button: number; detail: number; trusted: boolean; x: number; y: number }
declare global { interface Window { buttonChoiceInputs: ButtonInput[] } }

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: right menu and middle history do not activate a left-button choice`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, mouseButtonChoiceSource),
      canvas = game.surface('Button choices').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    let pressed: 'left' | 'right' | 'middle' | undefined
    try {
      await expect(canvas).toHaveJSProperty('width', 240)
      await expect(canvas).toHaveJSProperty('height', 160)
      await canvas.scrollIntoViewIfNeeded()
      await canvas.evaluate((element) => {
        window.buttonChoiceInputs = []
        for (const type of ['mousedown', 'mouseup'] as const) element.addEventListener(type, (raw) => {
          const event = raw as MouseEvent, rect = element.getBoundingClientRect()
          if (window.buttonChoiceInputs.length < 32) window.buttonChoiceInputs.push({ type,
            button: event.button, detail: event.detail, trusted: event.isTrusted,
            x: Math.trunc((event.clientX - rect.left) * 240 / rect.width),
            y: Math.trunc((event.clientY - rect.top) * 160 / rect.height) })
        })
      })
      for (const [index, step] of mouseButtonSteps.entries()) {
        const button = (['left', 'right', 'middle'] as const)[step.button],
          detail = index === 1 || index === 3 || index === 5 ? 2 : 1,
          point = await pointerPixel(canvas, step.x, 40)
        await page.mouse.move(point.x, point.y)
        await page.mouse.down({ button, clickCount: detail }); pressed = button
        await page.mouse.up({ button, clickCount: detail }); pressed = undefined
        const trace = mouseButtonTrace(step.button, step.kind, step.x)
        await expect(page.getByText(`button-choice:${index + 1}:${step.state}|${trace}`, { exact: true }))
          .toBeVisible({ timeout: 15000 })
        let screenshot: Buffer | undefined
        await expect.poll(async () => {
          screenshot = await canvas.screenshot({ scale: 'css' })
          const actual = readScreenshotPng(screenshot)
          if (actual.width !== 240 || actual.height !== 160) return { width: actual.width, height: actual.height }
          for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) {
            const expected = y < 120 ? [48, 64, 80, 255] : step.color, at = (y * 240 + x) * 4
            for (let c = 0; c < 4; c++) if (actual.rgba[at + c] !== expected[c])
              return { x, y, channel: c, actual: actual.rgba[at + c], expected: expected[c] }
          }
          return null
        }).toBeNull()
        observations.push({ index, button, detail, state: step.state, trace })
        await info.attach(`button-choice-${index + 1}`, { body: screenshot!, contentType: 'image/png' })
      }
      expect(await page.evaluate(() => window.buttonChoiceInputs)).toEqual(mouseButtonSteps.flatMap((step, index) => {
        const detail = index === 1 || index === 3 || index === 5 ? 2 : 1, button = [0, 2, 1][step.button]!
        return ['mousedown', 'mouseup'].map((type) => ({ type, button, detail, trusted: true, x: step.x, y: 40 }))
      }))
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('mouse-button-choice', { contentType: 'application/json', body: JSON.stringify({
        source: mouseButtonChoiceSource, observations, inputs: await page.evaluate(() => window.buttonChoiceInputs),
        logs: await page.locator('#logs').innerText(),
        scope: 'Trusted primary/secondary/auxiliary down/up with explicit click counts. Native VCL only synthesizes Click/DoubleClick for the primary button. Existing primary double-click ordering is retained; action-owner hit notifications are forbidden and fractional true hit arbitration is exercised.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { if (pressed) await page.mouse.up({ button: pressed }) } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Mouse choices or cleanup failed', { cause: failures[0] })
  })
