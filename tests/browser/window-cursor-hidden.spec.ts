import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var hiddenWindow=new Window();hiddenWindow.caption="Screen cursor";
hiddenWindow.setInnerSize(220,140);hiddenWindow.setPos(20,30);hiddenWindow.visible=true;
var hiddenRoot=new Layer(hiddenWindow,null);hiddenWindow.add(hiddenRoot);
hiddenRoot.type=ltOpaque;hiddenRoot.setSize(440,280);hiddenRoot.fillRect(0,0,440,280,0xff406080);hiddenRoot.cursor=crCross;
var hiddenControl=new Window();hiddenControl.caption="Screen control";
hiddenControl.setInnerSize(100,80);hiddenControl.setPos(450,20);hiddenControl.visible=true;
var hiddenControlRoot=new Layer(hiddenControl,null);hiddenControl.add(hiddenControlRoot);
hiddenControlRoot.type=ltOpaque;hiddenControlRoot.setSize(100,80);hiddenControlRoot.fillRect(0,0,100,80,0xff806040);
var hiddenObservations=0;
function hiddenKey(key,shift) {
  if(key==72)global.hiddenWindow.hideMouseCursor();
  if(key==86)global.hiddenWindow.mouseCursorState=mcsVisible;
  if(key==75)global.hiddenWindow.mouseCursorState=mcsHidden;
  if(key==80)global.hiddenRoot.setCursorPos(100,100);
  if(key==77)global.hiddenWindow.setPos(global.hiddenWindow.left+40,global.hiddenWindow.top+20);
  if(key==71)Debug.message("screen-cursor-observe="+(++global.hiddenObservations)+","+global.hiddenWindow.mouseCursorState);
}
hiddenWindow.onKeyDown=hiddenKey;hiddenControl.onKeyDown=hiddenKey;
`

interface MouseObservation {
  type: string
  clientX: number
  clientY: number
  screenX: number
  screenY: number
  buttons: number
  trusted: boolean
}
interface ObservedWindow { screenCursorObservations: MouseObservation[] }
async function observe(page: Page) {
  await page.addInitScript(() => {
    const observed = window as unknown as ObservedWindow
    observed.screenCursorObservations = []
    for (const type of ['mousemove','mousedown','mouseup','wheel'] as const) {
      window.addEventListener(type, (event) => {
        observed.screenCursorObservations.push({ type, clientX: event.clientX, clientY: event.clientY,
          screenX: event.screenX, screenY: event.screenY, buttons: event.buttons, trusted: event.isTrusted })
        if (observed.screenCursorObservations.length > 256) observed.screenCursorObservations.shift()
      }, true)
    }
  })
}
const observations = (page: Page) => page.evaluate(() => (window as unknown as ObservedWindow).screenCursorObservations)
async function state(page: Page) {
  const values = (text: string) => [...text.matchAll(/screen-cursor-observe=\d+,([012])/g)].map((match) => Number(match[1])),
    before = values(await page.locator('#logs').innerText()).length
  // Reading through the game keyboard preserves the real pointer position.
  // A console click would itself introduce an unrelated screen observation.
  await page.keyboard.press('KeyG')
  await expect.poll(async () => values(await page.locator('#logs').innerText()).length).toBe(before + 1)
  return values(await page.locator('#logs').innerText()).at(-1)!
}
async function finish(page: Page, info: TestInfo, stop: () => Promise<void>, failures: unknown[]) {
  try {
    await info.attach('screen-pointer-observations', { body: Buffer.from(JSON.stringify(await observations(page), null, 2)), contentType: 'application/json' })
    await info.attach('screen-cursor-logs', { body: Buffer.from(await page.locator('#logs').innerText()), contentType: 'text/plain' })
  } catch (error) { failures.push(error) }
  try { await stop() } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Screen cursor scenario or cleanup failed')
}

for (const backend of ['asyncify','jspi']) for (const binary of [false,true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: real same-screen buttons and wheel take over virtual cursor without restoring temp-hidden state`, async ({ page }, info) => {
    test.setTimeout(90000)
    await observe(page)
    const game = await launchWindowAttention(page, backend, binary, source), surface = game.surface('Screen cursor'),
      canvas = surface.locator('canvas[data-window-id]'), failures: unknown[] = []
    try {
      await canvas.click({ position: { x: 120, y: 80 } })
      await expect(surface.locator('.game-text-input')).toBeFocused()
      const box = (await canvas.boundingBox())!, point = { x: box.x + 120, y: box.y + 80 }
      await page.mouse.move(point.x, point.y)
      const baseline = (await observations(page)).filter((x) => x.type === 'mousemove' && x.trusted).at(-1)!
      expect(baseline).toBeDefined()
      await page.keyboard.press('KeyH'); expect(await state(page)).toBe(1)
      await expect(canvas).toHaveCSS('cursor', 'none')
      await page.mouse.down(); await page.mouse.up(); expect(await state(page)).toBe(1)
      await page.mouse.wheel(0, 40); expect(await state(page)).toBe(1)
      await page.mouse.move(point.x, point.y); expect(await state(page)).toBe(1)
      const same = (await observations(page)).filter((x) => x.type === 'mousemove' && x.trusted).at(-1)!
      expect([same.screenX,same.screenY]).toEqual([baseline.screenX,baseline.screenY])

      await page.keyboard.press('KeyP'); expect(await state(page)).toBe(0)
      await expect(surface.locator('.game-virtual-cursor')).toHaveCount(1)
      await page.keyboard.press('KeyH'); expect(await state(page)).toBe(1)
      await page.mouse.down(); await page.mouse.up(); expect(await state(page)).toBe(1)
      await page.keyboard.press('KeyV'); expect(await state(page)).toBe(0)
      await expect(surface.locator('.game-virtual-cursor')).toHaveCount(0)

      await page.keyboard.press('KeyH'); expect(await state(page)).toBe(1)
      await page.mouse.move(point.x + 2, point.y); expect(await state(page)).toBe(0)
      const moved = (await observations(page)).filter((x) => x.type === 'mousemove' && x.trusted).at(-1)!
      expect([moved.screenX,moved.screenY]).not.toEqual([baseline.screenX,baseline.screenY])
      await page.keyboard.press('KeyK'); expect(await state(page)).toBe(2)
      await page.mouse.move(point.x + 4, point.y)
      await page.keyboard.press('KeyP'); expect(await state(page)).toBe(2)
      await expect(surface.locator('.game-virtual-cursor')).toHaveCount(0)
      await expect(canvas).toHaveCSS('cursor', 'none')
    } catch (error) { failures.push(error) }
    finally { await finish(page, info, game.stop, failures) }
  })
  test(`${variant}: moving the Window and scrolling keep screen baseline; independent DOM coordinates isolate its restore condition`, async ({ page }, info) => {
    test.setTimeout(90000)
    await observe(page)
    const game = await launchWindowAttention(page, backend, binary, source), surface = game.surface('Screen cursor'),
      canvas = surface.locator('canvas[data-window-id]'), failures: unknown[] = []
    try {
      await canvas.click({ position: { x: 120, y: 80 } })
      await expect(surface.locator('.game-text-input')).toBeFocused()
      const before = (await canvas.boundingBox())!, point = { x: before.x + 120, y: before.y + 80 }
      await page.mouse.move(point.x, point.y)
      const baseline = (await observations(page)).filter((x) => x.type === 'mousemove' && x.trusted).at(-1)!
      expect(baseline).toBeDefined()
      await page.keyboard.press('KeyH'); expect(await state(page)).toBe(1)
      await page.keyboard.press('KeyM')
      await expect.poll(async () => { const next = (await canvas.boundingBox())!; return [Math.round(next.x-before.x),Math.round(next.y-before.y)] }).toEqual([40,20])
      await page.mouse.move(point.x, point.y); expect(await state(page)).toBe(1)
      const stationary = (await observations(page)).filter((x) => x.type === 'mousemove' && x.trusted).at(-1)!
      expect([stationary.screenX,stationary.screenY]).toEqual([baseline.screenX,baseline.screenY])
      await surface.locator('.game-window-scrollbox').evaluate((node) => node.scrollTo(30,40))
      await expect.poll(() => surface.locator('.game-window-scrollbox').evaluate((node) => [node.scrollLeft,node.scrollTop])).toEqual([30,40])
      await page.mouse.move(point.x, point.y); expect(await state(page)).toBe(1)

      // Explicit untrusted DOM negative controls, separate from the real browser
      // mouse above: client-only delta must fail to restore; screen-only must work.
      const control = { clientX: point.x + 10, clientY: point.y + 9, screenX: baseline.screenX, screenY: baseline.screenY }
      await canvas.evaluate((node, coordinates) => node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...coordinates })), control)
      expect(await state(page)).toBe(1)
      await canvas.evaluate((node, coordinates) => node.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, ...coordinates, screenX: coordinates.screenX + 1 })), control)
      expect(await state(page)).toBe(0)
      const controls = (await observations(page)).filter((x) => x.type === 'mousemove' && !x.trusted).slice(-2)
      expect(controls).toHaveLength(2)
      expect(controls.map((x) => [x.clientX,x.clientY])).toEqual([[control.clientX,control.clientY],[control.clientX,control.clientY]])
      expect(controls.map((x) => x.screenX)).toEqual([baseline.screenX,baseline.screenX+1])
    } catch (error) { failures.push(error) }
    finally { await finish(page, info, game.stop, failures) }
  })
}
