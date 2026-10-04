import { expect, test, type Locator, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var wa=new Window();wa.caption="Cursor A";wa.setInnerSize(200,100);wa.setPos(0,0);wa.visible=true;
var ra=new Layer(wa,null);ra.type=ltOpaque;ra.setSize(200,100);ra.fillRect(0,0,200,100,0xff203040);ra.cursor=crCross;
var cursorParent=new Layer(wa,ra);cursorParent.setPos(20,10);cursorParent.setSize(110,70);cursorParent.visible=true;cursorParent.cursor=crCross;
var cursorChild=new Layer(wa,cursorParent);cursorChild.setPos(3,4);cursorChild.setSize(70,40);cursorChild.fillRect(0,0,70,40,0xff6080a0);cursorChild.visible=true;cursorChild.focusable=true;cursorChild.cursor=crCross;
var cursorClicks=0;
cursorChild.onClick=function(x,y){global.cursorClicks++;Debug.message("cursor-click:"+global.cursorClicks);};
cursorChild.onKeyDown=function(key,shift,process){if(key==117)global.cursorChild.setCursorPos(10,12);};
cursorChild.focus();
var wb=new Window();wb.caption="Cursor B";wb.setInnerSize(200,100);wb.setPos(340,0);wb.visible=true;
var rb=new Layer(wb,null);rb.type=ltOpaque;rb.setSize(200,100);rb.fillRect(0,0,200,100,0xff405060);rb.cursor=crIBeam;
`

async function preserveCleanup(primary: unknown[], cleanup: () => Promise<void>) {
  try {
    await cleanup()
  } catch (error) {
    if (primary.length) throw new AggregateError([...primary, error], 'Cursor scenario and cleanup failed')
    throw error
  }
}

async function expectCursor(surface: Locator, x: number, y: number, shape = 'crosshair') {
  const marker = surface.locator('.game-virtual-cursor')
  await expect(marker).toBeVisible()
  await expect(marker).toHaveAttribute('data-cursor-shape', shape)
  await expect(marker).toHaveCSS('pointer-events', 'none')
  await expect(marker).toHaveCSS('width', '24px')
  await expect(marker).toHaveCSS('height', '24px')
  await expect(surface.locator('canvas[data-window-id]')).toHaveCSS('cursor', 'none')
  await expect.poll(() => surface.evaluate((element, point) => {
    const canvas = element.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!,
      marker = element.querySelector<HTMLElement>('.game-virtual-cursor')!
    if (!marker) return Infinity
    const image = canvas.getBoundingClientRect(), cursor = marker.getBoundingClientRect()
    // Crosshair and I-beam both have their visible hotspot at (12,12).
    return Math.max(
      Math.abs(cursor.left + 12 - image.left - image.width * point.x / 200),
      Math.abs(cursor.top + 12 - image.top - image.height * point.y / 100),
    )
  }, { x, y })).toBeLessThan(1.5)
  expect(await marker.getAttribute('data-window-id')).toBe(await surface.getAttribute('data-window-id'))
  expect(Number(await marker.getAttribute('data-cursor-revision'))).toBeGreaterThan(0)
}

async function movePhysical(page: Page, surface: Locator, x: number, y: number) {
  const canvas = surface.locator('canvas[data-window-id]')
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * x / 200, box!.y + box!.height * y / 100)
}

interface CursorGateState {
  armed: boolean
  holding: boolean
  held: number
  captured: { generation: number; sequence: number; windowId: number; revision: number; basePhysicalSequence: number }[]
  delivered: number[]
  errors: string[]
}
declare global {
  interface Window {
    layerCursorGate: {
      arm(): void
      hold(): void
      one(): void
      release(): void
      read(): CursorGateState
    }
  }
}

/** Explicit delivery fault: retain actual Session event packets byte-for-byte.
 * RPC, physical pointer messages, Worker execution and every payload stay real. */
async function installCursorGate(page: Page) {
  await page.addInitScript(() => {
    const NativeChannel = MessageChannel,
      waiting: { port: MessagePort; data: unknown }[] = [],
      captured: CursorGateState['captured'] = [],
      delivered: number[] = [], errors: string[] = []
    let eventPort: MessagePort | undefined, holding = false, armed = false, bypass = false
    const deliver = () => {
      const entry = waiting.shift()
      if (!entry) return
      bypass = true
      try {
        delivered.push((entry.data as { sequence: number }).sequence)
        entry.port.dispatchEvent(new MessageEvent('message', { data: entry.data }))
      } finally { bypass = false }
    }
    window.layerCursorGate = {
      arm() {
        if (holding || armed || waiting.length) throw new Error('Cursor event gate is already armed')
        armed = true
      },
      hold() {
        if (!eventPort || holding || armed) throw new Error('Cursor Session event port is not ready')
        holding = true
      },
      one: deliver,
      release() {
        armed = false
        holding = false
        while (waiting.length) deliver()
      },
      read: () => ({ armed, holding, held: waiting.length, captured: [...captured], delivered: [...delivered], errors: [...errors] }),
    }
    window.MessageChannel = new Proxy(NativeChannel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
          if (bypass || !event.data || typeof event.data !== 'object') return
          const message = event.data as {
            generation?: number; sequence?: number; type?: string; windowId?: number
            input?: { virtualCursor?: { revision: number; basePhysicalSequence: number } | null }
          }
          if (!Number.isSafeInteger(message.generation) || !Number.isSafeInteger(message.sequence)) return
          if (message.type === 'window-input' && !holding) eventPort = channel.port1
          if (armed && message.type === 'window-input' && message.input?.virtualCursor) {
            eventPort = channel.port1
            armed = false
            holding = true
            captured.push({
              generation: message.generation!, sequence: message.sequence!, windowId: message.windowId!,
              revision: message.input.virtualCursor.revision,
              basePhysicalSequence: message.input.virtualCursor.basePhysicalSequence,
            })
          }
          if (!holding || eventPort !== channel.port1) return
          if (waiting.length >= 256) {
            errors.push('Cursor event gate exceeded 256 retained packets')
            holding = false
            return
          }
          waiting.push({ port: channel.port1, data: event.data })
          event.stopImmediatePropagation()
        })
        return channel
      },
    })
  })
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
    test(`${variant}: Layer cursor marker projects zoom and CSS geometry, preserves hit testing and retires with its Window`, async ({ page }, info) => {
      const game = await launchWindowAttention(page, backend, binary, source),
        a = game.surface('Cursor A'), b = game.surface('Cursor B'),
        primary: unknown[] = []
      try {
        await evaluate(page, '(cursorChild.setCursorPos(10,12),0)', '0')
        await expectCursor(a, 33, 26)
        await evaluate(page, '(wa.setZoom(3,2),wa.setLayerPos(7,11),cursorChild.setCursorPos(10,12),0)', '0')
        await expectCursor(a, 60, 56)
        await evaluate(page, '(wa.setPos(90,45),0)', '0')
        await expectCursor(a, 60, 56)
        await page.addStyleTag({ content: '.game-window[aria-label="Cursor A"] { width: 29vw !important; }' })
        await page.setViewportSize({ width: 1100, height: 760 })
        await expectCursor(a, 60, 56)
        await evaluate(page, '(rb.setCursorPos(40,30),0)', '0')
        await expectCursor(b, 40, 30, 'text')
        await expectCursor(a, 60, 56)

        // Use actual game keyboard delivery to make a marker while the canvas
        // is onscreen. The marker's own DOM must not intercept its hotspot.
        const canvas = a.locator('canvas[data-window-id]')
        await canvas.scrollIntoViewIfNeeded()
        await canvas.focus()
        await expect(a.locator('.game-text-input')).toBeFocused()
        await page.keyboard.press('F6')
        await expectCursor(a, 60, 56)
        const point = await a.evaluate((element) => {
          const marker = element.querySelector<HTMLElement>('.game-virtual-cursor')!,
            rect = marker.getBoundingClientRect(), x = rect.left + 12, y = rect.top + 12,
            canvas = element.querySelector('canvas[data-window-id]')!
          return { x, y, hitsCanvas: document.elementFromPoint(x, y) === canvas }
        })
        expect(point.hitsCanvas).toBe(true)
        await page.mouse.click(point.x, point.y)
        await expect(a.locator('.game-virtual-cursor')).toHaveCount(0)
        await expect(canvas).toHaveCSS('cursor', 'crosshair')
        await expect(page.getByText('cursor-click:1', { exact: true })).toBeVisible()
        await expectCursor(b, 40, 30, 'text')
        await evaluate(page, '(cursorChild.cursor=crNone,cursorChild.setCursorPos(10,12),0)', '0')
        await expect(a.locator('.game-virtual-cursor')).toHaveCount(0)
        await expect(canvas).toHaveCSS('cursor', 'none')
        await evaluate(page, '(cursorChild.cursor=crCross,wa.mouseCursorState=2,cursorChild.setCursorPos(10,12),0)', '0')
        await expect(a.locator('.game-virtual-cursor')).toHaveCount(0)
        await evaluate(page, '(wa.mouseCursorState=0,cursorChild.setCursorPos(10,12),0)', '0')
        await expectCursor(a, 60, 56)
        await page.locator('#pause').click()
        await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
        await page.locator('#pause').click()
        await evaluate(page, '1', '1')
        await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
        await evaluate(page, '(rb.setCursorPos(40,30),0)', '0')
        await expectCursor(b, 40, 30, 'text')
        await evaluate(page, '(wb.visible=false,0)', '0')
        await expect(b.locator('.game-virtual-cursor')).toHaveCount(0)
        await evaluate(page, '(wb.visible=true,0)', '0')
        await expect(b.locator('.game-virtual-cursor')).toHaveCount(0)
        await evaluate(page, '(cursorChild.setCursorPos(10,12),0)', '0')
        await expectCursor(a, 60, 56)
        await evaluate(page, '(function(){invalidate wa;return 0;})()', '0')
        await expect(a).toHaveCount(0)
        await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
        await info.attach('cursor-host-scope', { contentType: 'application/json', body: JSON.stringify({
          scope: 'Native Layer writes to real Worker InputView and non-hit-test DOM marker; OS pointer is not warped',
          backend, binary, point,
        }) })
      } catch (error) { primary.push(error); throw error }
      finally { await preserveCleanup(primary, () => game.stop()) }
    })

    test(`${variant}: immediate physical takeover and delayed actual Worker snapshots cannot revive a cursor marker`, async ({ page }, info) => {
      await installCursorGate(page)
      const game = await launchWindowAttention(page, backend, binary, source),
        a = game.surface('Cursor A'), primary: unknown[] = []
      try {
        await evaluate(page, '(cursorChild.setCursorPos(10,12),0)', '0')
        await expectCursor(a, 33, 26)
        const initialRevision = Number(await a.locator('.game-virtual-cursor').getAttribute('data-cursor-revision'))
        await page.evaluate(() => window.layerCursorGate.hold())
        await movePhysical(page, a, 80, 40)
        await expect(a.locator('.game-virtual-cursor')).toHaveCount(0)
        await expect(a.locator('canvas')).toHaveCSS('cursor', 'crosshair')
        await expect.poll(() => page.evaluate(() => window.layerCursorGate.read().held)).toBeGreaterThan(0)
        await page.evaluate(() => window.layerCursorGate.release())

        await page.evaluate(() => window.layerCursorGate.arm())
        // This event gate also retains the console result. Submit without
        // waiting for that result until the original Session events resume.
        const completion = 'cursor-delayed-write-complete',
          expression = `(cursorChild.setCursorPos(10,12),"${completion}")`
        await expect(page.locator('#evaluate')).toBeEnabled()
        await page.locator('#expression').fill(expression)
        await expect(page.locator('#expression')).toHaveValue(expression)
        await page.locator('#evaluate').click()
        await expect.poll(() => page.evaluate(() => window.layerCursorGate.read().captured.length)).toBe(1)
        const captured = await page.evaluate(() => window.layerCursorGate.read().captured[0]!)
        expect(captured.revision).toBeGreaterThan(initialRevision)
        await expect(a.locator('.game-virtual-cursor')).toHaveCount(0)
        await movePhysical(page, a, 90, 45)
        await expect.poll(() => page.evaluate(() => window.layerCursorGate.read().held)).toBeGreaterThan(1)
        await page.evaluate(() => window.layerCursorGate.one())
        // This is the original earlier virtual InputView; all newer Worker
        // events are still held, so generic Session event ordering cannot hide
        // a missing basePhysicalSequence check in BrowserInput.
        await expect(a.locator('.game-virtual-cursor')).toHaveCount(0)
        await page.evaluate(() => window.layerCursorGate.release())
        await expect(page.getByText(completion, { exact: true })).toBeVisible()
        await evaluate(page, 'cursorChild.cursorX>=66 && cursorChild.cursorX<=68 && cursorChild.cursorY>=30 && cursorChild.cursorY<=32', '1')
        await evaluate(page, '(cursorChild.setCursorPos(10,12),0)', '0')
        await expectCursor(a, 33, 26)
        const old = await a.locator('.game-virtual-cursor').elementHandle()
        expect(old).not.toBeNull()
        await game.stop()
        await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
        expect(await old!.evaluate((element) => element.isConnected)).toBe(false)
        await old!.dispose()
        const evidence = await page.evaluate(() => window.layerCursorGate.read())
        expect(evidence.errors).toEqual([])
        expect(evidence.holding).toBe(false)
        expect(evidence.held).toBe(0)
        expect(evidence.delivered).toContain(evidence.captured[0]!.sequence)
        await info.attach('cursor-original-event-delay', { contentType: 'application/json', body: JSON.stringify(evidence) })
      } catch (error) { primary.push(error); throw error }
      finally {
        await preserveCleanup(primary, async () => {
          await page.evaluate(() => window.layerCursorGate.release())
          await game.stop()
        })
      }
    })
  }
}
