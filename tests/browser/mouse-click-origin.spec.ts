import { expect, test } from '@playwright/test'
import { mouseClickOriginExpected, mouseClickOriginSource } from '../helpers/mouse-click-origin.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { pointerPixel } from '../helpers/pointer-pixel.ts'
import { canvasPixels } from '../helpers/canvas-pixels.ts'

interface ClickOriginEvent { type: string; x: number; y: number; button: number; trusted: boolean }
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
              button: event.button, trusted: event.isTrusted })
          })
      })
      for (const [index, downX, upX, selected] of [[0, 40, 240, 'left'], [1, 240, 40, 'right']] as const) {
        const down = await pointerPixel(canvas, downX, 30)
        await page.mouse.move(down.x, down.y); await page.mouse.down(); pressed = true
        const up = await pointerPixel(canvas, upX, 90)
        await page.mouse.move(up.x, up.y); await page.mouse.up(); pressed = false
        await expect(page.getByText(`drag-choice:${index + 1}:${selected}:${mouseClickOriginExpected[index]}`, { exact: true }))
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
        observations.push({ selected, down: [downX, 30], up: [upX, 90], trace: mouseClickOriginExpected[index],
          width: captured!.width, height: captured!.height, bounds: captured!.bounds, devicePixelRatio: captured!.devicePixelRatio })
        await info.attach(`drag-selected-${selected}`, { body: await canvas.screenshot({ scale: 'css', timeout: 5000 }), contentType: 'image/png' })
        await info.attach(`drag-selected-${selected}-rgba`, { body: Buffer.from(captured!.rgba), contentType: 'application/octet-stream' })
      }
      const events = await page.evaluate(() => window.clickOriginEvents)
      expect(events.map((event) => [event.type, Math.trunc(event.x), Math.trunc(event.y), event.button, event.trusted]))
        .toEqual([
          ['mousedown', 40, 30, 0, true], ['mouseup', 240, 90, 0, true],
          ['mousedown', 240, 30, 0, true], ['mouseup', 40, 90, 0, true],
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
        scope: 'Trusted left-button down/move/up inside the same game canvas. Original Form Click uses the down point while MouseUp uses release; both actions and every backing-canvas pixel are checked. Unmodified screen PNGs retain fractional CSS placement separately. Double-click timing and outside-client click cancellation are unchanged.' }, null, 2) })
    } catch (error) { failures.push(error) }
    try { if (pressed) await page.mouse.up(); await game.stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Drag choice or cleanup failed', { cause: failures[0] })
  })
