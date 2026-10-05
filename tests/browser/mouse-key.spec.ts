import { expect, test, type Locator, type Page } from '@playwright/test'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

declare global {
  interface Window {
    mouseKeyEvidence: {
      pointer: { x: number; y: number } | null
      pressed: number[]
      reads: number
      inputs: { windowId: number; revision: number; x: number; y: number }[]
    }
  }
}
const source = String.raw`
System.exitOnWindowClose=false;
var win=new Window();win.caption="Mouse keys";win.setInnerSize(200,100);win.visible=true;
var root=new Layer(win,null);root.setSize(200,100);root.fillRect(0,0,200,100,0xff203040);root.cursor=crCross;
var button=new Layer(win,root);button.setSize(200,100);button.fillRect(0,0,200,100,0xff405060);button.visible=true;button.focusable=true;button.focus();
var sequence=[],keyEvents=[],clicks=0;
win.onMouseDown=function(x,y,b,shift){sequence.add("down"+b);};
win.onMouseUp=function(x,y,b,shift){sequence.add("up"+b);Debug.message("mouse-key:sequence:"+sequence.join(","));};
win.onClick=function(x,y){sequence.add("click");};
button.onClick=function(x,y){clicks++;Debug.message("mouse-key:button:"+clicks);};
win.onKeyDown=function(key,shift){keyEvents.add("D"+key);if(key==119)Debug.message("mouse-key:keys:"+keyEvents.join(","));};
win.onKeyUp=function(key,shift){keyEvents.add("U"+key);};
win.onKeyPress=function(key){Debug.message("mouse-key:text:"+(key=="\r"?"13":key=="\x1b"?"27":key==" "?"32":"other"));};
win.useMouseKey=true;
`

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const evidence = window.mouseKeyEvidence = { pointer: null as { x: number; y: number } | null,
      pressed: [] as number[], reads: 0, inputs: [] as { windowId: number; revision: number; x: number; y: number }[] }
    window.addEventListener('mousemove', (event) => {
      evidence.pointer = { x: event.clientX, y: event.clientY }
    }, { capture: true, passive: true })
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => {
      evidence.reads++
      return [{ index: 0, id: 'hosted-mouse-key-pad', connected: true, mapping: 'standard', axes: [0, 0],
        buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: evidence.pressed.includes(index),
          value: evidence.pressed.includes(index) ? 1 : 0, touched: false })) }]
    } })
    const Channel = MessageChannel
    window.MessageChannel = new Proxy(Channel, {
      construct(target, args, newTarget) {
        const channel = Reflect.construct(target, args, newTarget) as MessageChannel
        channel.port1.addEventListener('message', (event: MessageEvent<unknown>) => {
          const data = event.data as { type?: string; windowId?: number;
            input?: { virtualCursor?: { revision: number; x: number; y: number } } } | null
          if (data?.type === 'window-input' && data.windowId && data.input?.virtualCursor && evidence.inputs.length < 2048)
            evidence.inputs.push({ windowId: data.windowId, ...data.input.virtualCursor })
        })
        return channel
      },
    })
  })
})
test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => window.mouseKeyEvidence)
  await info.attach('mouse-key-observation', { contentType: 'application/json', body: JSON.stringify({
    boundary: 'Real DOM keyboard and pointer, actual Session/VM, controlled Gamepad API snapshots; no OS pointer movement or physical gamepad claim.',
    evidence,
  }) })
  expect(evidence.inputs.length).toBeLessThan(2048)
})

async function focusAt(page: Page, surface: Locator, x = 70, y = 40) {
  const canvas = surface.locator('canvas[data-window-id]')
  await canvas.scrollIntoViewIfNeeded()
  const box = await canvas.boundingBox()
  expect(box).not.toBeNull()
  await page.mouse.move(box!.x + box!.width * x / 200, box!.y + box!.height * y / 100)
  await canvas.focus()
  await expect(surface.locator('.game-text-input')).toBeFocused()
  return canvas
}
async function hotspot(surface: Locator): Promise<{ x: number; y: number }> {
  return surface.locator('.game-virtual-cursor').evaluate((marker) => {
    const rect = marker.getBoundingClientRect()
    return { x: rect.left + 12, y: rect.top + 12 }
  })
}
async function neutral(page: Page): Promise<void> {
  const before = await page.evaluate(() => { window.mouseKeyEvidence.pressed = []; return window.mouseKeyEvidence.reads })
  await expect.poll(() => page.evaluate(() => window.mouseKeyEvidence.reads)).toBeGreaterThan(before)
}
async function animationInterval(page: Page, duration = 175): Promise<void> {
  await page.evaluate((duration) => new Promise<void>((resolve) => {
    const until = performance.now() + duration
    const tick = () => performance.now() >= until ? resolve() : requestAnimationFrame(tick)
    requestAnimationFrame(tick)
  }), duration)
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: mouse keys move the visible cursor in CSS pixels and click through the actual Layer input path`, async ({ page }, info) => {
    const game = await launchWindowAttention(page, backend, binary, source), surface = game.surface('Mouse keys')
    try {
      // Non-unit CSS size makes an implementation that moves one logical Layer
      // pixel instead of one screen/CSS pixel fail the independent geometry check.
      await page.addStyleTag({ content: '.game-window[aria-label="Mouse keys"] canvas[data-window-id]{width:360px!important;height:180px!important;}' })
      const canvas = await focusAt(page, surface),
        actual = await page.evaluate(() => window.mouseKeyEvidence.pointer!)
      await page.keyboard.press('ArrowRight')
      const marker = surface.locator('.game-virtual-cursor')
      await expect(marker).toBeVisible()
      await expect(marker).toHaveAttribute('data-cursor-shape', 'crosshair')
      await expect(marker).toHaveCSS('pointer-events', 'none')
      const point = await hotspot(surface)
      expect(Math.abs(point.x - actual.x - 1)).toBeLessThanOrEqual(0.6)
      expect(Math.abs(point.y - actual.y)).toBeLessThanOrEqual(0.6)
      await expect(canvas).toHaveCSS('cursor', 'none')
      await page.keyboard.press('Enter')
      await expect(page.locator('#logs')).toContainText('mouse-key:sequence:down0,click,up0')
      await expect(page.locator('#logs')).toContainText('mouse-key:button:1')
      await page.keyboard.press('Escape')
      await expect(page.locator('#logs')).toContainText('mouse-key:sequence:down0,click,up0,down1,up1')
      await page.keyboard.press('F8')
      await expect(page.locator('#logs')).toContainText('mouse-key:keys:U39,D119')
      await expect(page.locator('#logs')).not.toContainText('mouse-key:text:13')
      await expect(page.locator('#logs')).not.toContainText('mouse-key:text:27')
      await info.attach('mouse-key-visible-cursor', { body: await surface.screenshot(), contentType: 'image/png' })
      // The real pointer immediately takes authority back. Keyboard emulation
      // remains enabled and starts from this new position on its next input.
      await focusAt(page, surface, 110, 45)
      await expect(marker).toHaveCount(0)
      await animationInterval(page)
      const next = await page.evaluate(() => window.mouseKeyEvidence.pointer!)
      await page.keyboard.press('ArrowLeft')
      await expect(marker).toBeVisible()
      expect(Math.abs((await hotspot(surface)).x - next.x + 1)).toBeLessThanOrEqual(0.6)
      await page.locator('#pause').click()
      await expect(marker).toHaveCount(0)
      await page.locator('#pause').click()
      await animationInterval(page)
      await expect(marker).toHaveCount(0)
    } finally { await game.stop() }
    await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
  })

  test(`${variant}: admitted Gamepad input drives mouse keys and loses its timer and marker at focus/Stop boundaries`, async ({ page }) => {
    const game = await launchWindowAttention(page, backend, binary, source), surface = game.surface('Mouse keys')
    try {
      const canvas = await focusAt(page, surface)
      await neutral(page)
      const actual = await page.evaluate(() => window.mouseKeyEvidence.pointer!)
      await page.evaluate(() => { window.mouseKeyEvidence.pressed = [15] })
      const marker = surface.locator('.game-virtual-cursor')
      await expect(marker).toBeVisible()
      await expect.poll(async () => (await hotspot(surface)).x - actual.x).toBeGreaterThan(5)
      await neutral(page)
      await page.evaluate(() => { window.mouseKeyEvidence.pressed = [0] })
      await animationInterval(page, 75)
      await neutral(page)
      await expect(page.locator('#logs')).toContainText('mouse-key:sequence:down0,click,up0')
      await expect(page.locator('#logs')).toContainText('mouse-key:button:1')
      await page.locator('#expression').focus()
      await expect(surface).toHaveAttribute('data-active', 'false')
      const count = await page.evaluate(() => window.mouseKeyEvidence.inputs.length)
      await page.evaluate(() => { window.mouseKeyEvidence.pressed = [15] })
      await animationInterval(page)
      expect(await page.evaluate(() => window.mouseKeyEvidence.inputs.length)).toBe(count)
      await canvas.focus()
      await expect(surface.locator('.game-text-input')).toBeFocused()
      await expect(surface).toHaveAttribute('data-active', 'true')
      await animationInterval(page)
      expect(await page.evaluate(() => window.mouseKeyEvidence.inputs.length)).toBe(count)
      await neutral(page)
      await page.evaluate(() => { window.mouseKeyEvidence.pressed = [15] })
      await expect.poll(() => page.evaluate(() => window.mouseKeyEvidence.inputs.length)).toBeGreaterThan(count)
      await neutral(page)
    } finally { await game.stop() }
    const stopped = await page.evaluate(() => ({ count: window.mouseKeyEvidence.inputs.length, reads: window.mouseKeyEvidence.reads }))
    await animationInterval(page)
    expect(await page.evaluate(() => ({ count: window.mouseKeyEvidence.inputs.length, reads: window.mouseKeyEvidence.reads }))).toEqual(stopped)
    await expect(page.locator('.game-virtual-cursor')).toHaveCount(0)
  })
}
