import { expect, test } from '@playwright/test'
import { mouseClickOriginExpected, mouseDoubleOriginExpected, mouseClickOriginSource } from '../helpers/mouse-click-origin.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

interface ClickOriginEvent { type: string; x: number; y: number; button: number; detail: number; trusted: boolean }
declare global { interface Window { clickOriginEvents: ClickOriginEvent[] } }

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: dragging a choice keeps its original Click position and the current release`, async ({ page }, info) => {
    test.setTimeout(90000)
    const failures: unknown[] = [], observations: unknown[] = [],
      game = await launchWindowAttention(page, backend, binary, mouseClickOriginSource),
      canvas = game.surface('Drag choice').locator('canvas[data-window-id]')
    let pressed = false
    let captured: Awaited<ReturnType<typeof canvasPixels>> | undefined
    try {
      await expect(canvas).toHaveJSProperty('width', 320)
      await expect(canvas).toHaveJSProperty('height', 180)
      await canvas.scrollIntoViewIfNeeded()
      await canvas.evaluate((node) => {
        const target = node as HTMLCanvasElement
        window.clickOriginEvents = []
        for (const type of ['mousedown', 'mouseup'] as const)
          target.addEventListener(type, (event) => {
            const rect = target.getBoundingClientRect()
            if (window.clickOriginEvents.length < 16) window.clickOriginEvents.push({ type,
              x: (event.clientX - rect.left) * 320 / rect.width,
              y: (event.clientY - rect.top) * 180 / rect.height,
              button: event.button, detail: event.detail, trusted: event.isTrusted })
          })
      })
      let round = 0
      for (const [index, downX, upX, selected, double] of [
        [0, 40, 240, 'left', false], [1, 240, 40, 'right', false],
        [0, 40, 240, 'left', true], [1, 240, 40, 'right', true],
      ] as const) {
        const down = await pointerPixel(canvas, downX, 30)
        if (double) {
          // Both press samples are identical. This isolates the fixed Form's
          // saved point from the unproven order of VCL's second down event.
          await page.mouse.click(down.x, down.y, { clickCount: 1 }); round++
        }
        const count = double ? 2 : 1, trace = (double ? mouseDoubleOriginExpected : mouseClickOriginExpected)[index]
        await page.mouse.move(down.x, down.y); await page.mouse.down({ clickCount: count }); pressed = true
        const up = await pointerPixel(canvas, upX, 90)
        await page.mouse.move(up.x, up.y); await page.mouse.up({ clickCount: count }); pressed = false
        await expect(page.getByText(`drag-choice:${++round}:${selected}:${trace}`, { exact: true }))
          .toBeVisible({ timeout: 20000 })
        await expect.poll(async () => {
          const image = captured = await canvasPixels(canvas)
          if (image.width !== 320 || image.height !== 180) return { dimensions: [image.width, image.height] }
          if (image.bounds.width !== 320 || image.bounds.height !== 180) return { cssDimensions: [image.bounds.width, image.bounds.height] }
          for (let y = 0; y < 180; y++) for (let x = 0; x < 320; x++) {
            const color = y < 140 ? x < 160 ? [32, 64, 96, 255] : [96, 64, 32, 255]
              : selected === 'left' ? [32, 112, 64, 255] : [112, 64, 32, 255], at = (y * 320 + x) * 4
            for (let c = 0; c < 4; c++) if (image.rgba[at + c] !== color[c])
              return { x, y, channel: c, actual: image.rgba[at + c], expected: color[c] }
          }
          return null
        }).toBeNull()
        observations.push({ selected, double, down: [downX, 30], up: [upX, 90], trace,
          width: captured!.width, height: captured!.height, bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        const label = `drag-selected-${double ? 'double-' : ''}${selected}`
        await info.attach(label, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach(label + '-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
      }
      const events = await page.evaluate(() => window.clickOriginEvents)
      expect(events.map((event) => [event.type, Math.trunc(event.x), Math.trunc(event.y), event.button, event.detail, event.trusted]))
        .toEqual([
          ['mousedown', 40, 30, 0, 1, true], ['mouseup', 240, 90, 0, 1, true],
          ['mousedown', 240, 30, 0, 1, true], ['mouseup', 40, 90, 0, 1, true],
          ['mousedown', 40, 30, 0, 1, true], ['mouseup', 40, 30, 0, 1, true],
          ['mousedown', 40, 30, 0, 2, true], ['mouseup', 240, 90, 0, 2, true],
          ['mousedown', 240, 30, 0, 1, true], ['mouseup', 240, 30, 0, 1, true],
          ['mousedown', 240, 30, 0, 2, true], ['mouseup', 40, 90, 0, 2, true],
        ])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length && captured) for (const attach of [
      () => info.attach('drag-choice-last-captured-rgba', { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' }),
      async () => info.attach('drag-choice-failed-screen', { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    try {
      await info.attach('mouse-click-origin', { contentType: 'application/json', body: JSON.stringify({
        observations, events: await page.evaluate(() => window.clickOriginEvents),
        source: mouseClickOriginSource, logs: await page.locator('#logs').innerText(),
        lastCanvas: captured && { width: captured.width, height: captured.height, bounds: captured.bounds, devicePixelRatio: captured.devicePixelRatio },
        scope: 'Trusted left-button down/move/up, with explicit browser click counts, inside the same game canvas. Click and equal-press DoubleClick use the saved point while MouseUp keeps release; both actions and every backing pixel stay strict. Screen PNGs retain fractional CSS placement. VCL double-event timing and different-press positions remain unverified and retain the previous Web behavior.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { if (pressed) await page.mouse.up() } catch (error) { failures.push(error) }
    try { await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Drag choice or cleanup failed', { cause: failures[0] })
  })
