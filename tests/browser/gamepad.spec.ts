import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

declare global {
  interface Window {
    gamepadDevice: { pressed: number[]; connected: boolean; reads: number;
      samples: { at: number; connected: boolean; pressed: number[] }[] }
  }
}
const source = String.raw`
System.setArgument("-paddelay","0");System.setArgument("-padinterval","100");
var window=new Window();window.setInnerSize(200,100);window.visible=true;
var root=new Layer(window,null);root.setSize(200,100);root.fillRect(0,0,200,100,0xff123456);root.focusable=true;root.focus();
var padEvents=[],padRepeats=0;
window.onKeyDown=function(key,shift){
  if(key<VK_PADLEFT || key>VK_PADANY)return;
  if(shift&ssRepeat){padRepeats++;if(padRepeats==1)Debug.message("pad:repeat");return;}
  var row="D"+key+":"+System.getKeyState(key)+":"+System.getKeyState(VK_PADANY)+":"+System.getKeyState(key,false)+":"+System.getKeyState(key,false);
  padEvents.add(row);Debug.message("pad:"+row);
};
window.onKeyUp=function(key,shift){
  if(key<VK_PADLEFT || key>VK_PADANY)return;
  var row="U"+key+":"+System.getKeyState(key);padEvents.add(row);Debug.message("pad:"+row);
};
Debug.message("pad:ready");
`

async function neutral(page: Page): Promise<void> {
  const before = await page.evaluate(() => {
    window.gamepadDevice.pressed = []
    return window.gamepadDevice.reads
  })
  await expect.poll(() => page.evaluate(() => window.gamepadDevice.reads)).toBeGreaterThan(before)
}
async function press(page: Page, ...buttons: number[]): Promise<void> {
  await page.evaluate((pressed) => { window.gamepadDevice.pressed = pressed }, buttons)
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const device = window.gamepadDevice = { pressed: [] as number[], connected: true, reads: 0,
      samples: [] as { at: number; connected: boolean; pressed: number[] }[] }
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => {
      device.reads++
      if (device.samples.length < 4096)
        device.samples.push({ at: performance.now(), connected: device.connected, pressed: [...device.pressed] })
      return device.connected ? [{ index: 0, id: 'hosted-controlled-standard-pad', connected: true,
        mapping: 'standard', axes: [0, 0],
        buttons: Array.from({ length: 17 }, (_, index) => ({ pressed: device.pressed.includes(index),
          value: device.pressed.includes(index) ? 1 : 0, touched: device.pressed.includes(index) })) }] : []
    } })
  })
})
test.afterEach(async ({ page }, info) => {
  const device = await page.evaluate(() => window.gamepadDevice)
  await info.attach('gamepad-device-observation', { contentType: 'application/json', body: JSON.stringify({
    boundary: 'Injected Gamepad API snapshots; production RAF sampler, coordinator, Worker and TJS. No physical hardware claim.', device,
  }) })
  expect(device.samples.length).toBeLessThan(4096)
})

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: Gamepad API buttons and D-pad reach real TJS state and repeat events`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect(page.locator('#logs')).toContainText('pad:ready')
    await page.locator('#stage canvas').focus()
    await neutral(page)
    await press(page, 0)
    await expect(page.locator('#logs')).toContainText('pad:D448:1:1:1:0')
    await expect(page.locator('#logs')).toContainText('pad:repeat')
    await neutral(page)
    await expect(page.locator('#logs')).toContainText('pad:U448:0')
    await press(page, 15)
    await expect(page.locator('#logs')).toContainText('pad:D439:1:1:1:0')
    await neutral(page)
    await expect(page.locator('#logs')).toContainText('pad:U439:0')
    await evaluate(page, 'padEvents.join("|")', 'D448:1:1:1:0|U448:0|D439:1:1:1:0|U439:0')
    await evaluate(page, 'padRepeats>0 && !System.getKeyState(VK_PADANY)', '1')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    const before = await page.evaluate(() => window.gamepadDevice.reads)
    await page.evaluate(() => new Promise<void>((resolve) => {
      // Two fast frames can be shorter than the sampler's 50 ms interval.
      const until = performance.now() + 150
      const frame = () => {
        if (performance.now() >= until) resolve()
        else requestAnimationFrame(frame)
      }
      requestAnimationFrame(frame)
    }))
    expect(await page.evaluate(() => window.gamepadDevice.reads)).toBe(before)
    expect(errors).toEqual([])
  })

  test(`${backend}: held Gamepad input is gated across host focus, disconnection and a fresh Session`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const start = async () => {
      // The app deliberately preserves logs across Session restarts. Neither
      // readiness nor the next down/up may be satisfied by the previous run.
      await page.locator('#clear-log').click()
      await page.locator('#files').setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
      await expect(page.locator('#logs')).toContainText('pad:ready')
      await page.locator('#stage canvas').focus()
    }
    await start()
    await neutral(page)
    await press(page, 1)
    await expect(page.locator('#logs')).toContainText('pad:D449:1:1:1:0')
    await page.locator('#expression').focus()
    await expect(page.locator('#logs')).toContainText('pad:U449:0')
    await page.locator('#stage canvas').focus()
    const read = await page.evaluate(() => window.gamepadDevice.reads)
    await expect.poll(() => page.evaluate(() => window.gamepadDevice.reads)).toBeGreaterThan(read)
    expect((await page.locator('#logs').innerText()).match(/pad:D449:/g) ?? []).toHaveLength(1)
    await neutral(page)
    await press(page, 0)
    await expect(page.locator('#logs')).toContainText('pad:D448:1:1:1:0')
    await page.evaluate(() => { window.gamepadDevice.connected = false })
    await expect(page.locator('#logs')).toContainText('pad:U448:0')
    await evaluate(page, 'padEvents.join("|")', 'D449:1:1:1:0|U449:0|D448:1:1:1:0|U448:0')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await page.evaluate(() => { window.gamepadDevice.connected = true; window.gamepadDevice.pressed = [0] })
    await start()
    const freshRead = await page.evaluate(() => window.gamepadDevice.reads)
    await expect.poll(() => page.evaluate(() => window.gamepadDevice.reads)).toBeGreaterThan(freshRead)
    await evaluate(page, 'padEvents.count', '0')
    await page.locator('#stage canvas').focus()
    await neutral(page)
    await press(page, 0)
    await expect(page.locator('#logs')).toContainText('pad:D448:1:1:1:0')
    await neutral(page)
    await expect(page.locator('#logs')).toContainText('pad:U448:0')
    await evaluate(page, 'padEvents.join("|")', 'D448:1:1:1:0|U448:0')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    expect(errors).toEqual([])
  })
}
