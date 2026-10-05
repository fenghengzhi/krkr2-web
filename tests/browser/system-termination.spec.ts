import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
function terminationMark(value){Debug.message("termination:"+value);}
function terminationArg(){terminationMark("argument");return %[];}
class TerminationWindow extends Window {
  function TerminationWindow(){super.Window();caption="Termination";setInnerSize(80,48);visible=true;}
  function onKeyDown(key,shift){
    if(key!=119 && key!=120)return;
    var method=key==119?"terminate":"exit";
    [method].save("savedata/termination-browser.txt","utf-8");
    terminationMark("before:"+method);
    if(key==120){try{System.exit(terminationArg(),terminationMark("extra"));}catch(error){terminationMark("caught");}}
    else {
      terminationMark("return:"+int(System.terminate(terminationArg(),terminationMark("extra"))===void));
      System.inform("Pending application termination");
      terminationMark("after-modal");
    }
    terminationMark("after:"+method);
  }
}
var win=new TerminationWindow();var layer=new Layer(win,null);win.add(layer);layer.setSize(80,48);layer.fillRect(0,0,80,48,0xff234567);
function terminationSaved(){var rows=[];rows.load("savedata/termination-browser.txt");return rows[0];}
`
const menuSource = String.raw`
System.exitOnWindowClose=false;
function menuMark(value){Debug.message("termination-menu:"+value);}
class TerminationMenuWindow extends Window {
  function TerminationMenuWindow(){super.Window();caption="Termination menu";setInnerSize(160,96);visible=true;}
  function onKeyDown(key,shift){
    if(key!=119)return;
    global.menuMark("popup-before");global.quitTimer.enabled=true;
    global.group.popup(0,20,30);global.menuMark("popup-after");
  }
}
var win=new TerminationMenuWindow();var root=new Layer(win,null);win.add(root);
root.setSize(160,96);root.fillRect(0,0,160,96,0xff234567);
var group=new MenuItem(win,"Pending termination menu"),item=new MenuItem(win,"Keep waiting");
win.menu.add(group);group.add(item);win.setInnerSize(160,96);
function quitTick(){quitTimer.enabled=false;menuMark("timer-before");System.terminate();menuMark("timer-after");heldTimer.enabled=true;}
function heldTick(){heldTimer.enabled=false;menuMark("pending-menu-500");}
var quitTimer=new Timer(global,"quitTick");quitTimer.enabled=false;quitTimer.interval=100;
var heldTimer=new Timer(global,"heldTick");heldTimer.enabled=false;heldTimer.interval=500;
`
for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual key callbacks distinguish posted termination from immediate exit and persist before Worker retirement`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = []
    let stop: (() => Promise<void>) | undefined
    try {
      let game = await launchWindowAttention(page, backend, binary, source, [], true)
      stop = game.stop
      for (const [method, key] of [['terminate', 'F8'], ['exit', 'F9']] as const) {
        await page.locator('#clear-log').click()
        const surface = game.surface('Termination'), canvas = surface.locator('canvas[data-window-id]')
        await expect(canvas).toHaveAttribute('width', '80'); await expect(canvas).toHaveAttribute('height', '48')
        await canvas.click({ position: { x: 16, y: 16 } })
        await expect(surface.locator('.game-text-input')).toBeFocused()
        await page.keyboard.press(key)
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        await expect(page.locator('dialog[open]')).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
        await expect(page.getByText('termination:argument', { exact: true })).toHaveCount(1)
        await expect(page.getByText('termination:extra', { exact: true })).toHaveCount(1)
        await expect(page.getByText('termination:caught', { exact: true })).toHaveCount(0)
        await expect(page.getByText('termination:after:' + method, { exact: true })).toHaveCount(method === 'terminate' ? 1 : 0)
        await expect(page.getByText('termination:after-modal', { exact: true })).toHaveCount(method === 'terminate' ? 1 : 0)
        await expect(page.getByText('termination:return:1', { exact: true })).toHaveCount(method === 'terminate' ? 1 : 0)
        await info.attach('termination-' + method, { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
        await expect(page.locator('#logs .error')).toHaveCount(0)
        game = await launchWindowAttention(page, backend, binary, source, [], true)
        stop = game.stop
        await evaluate(page, 'terminationSaved()', method)
      }
    } catch (error) { failures.push(error) }
    try { if (stop) await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Termination scenario and cleanup failed', { cause: failures[0] })
  })
  test(`${backend}/${binary ? 'bytecode' : 'source'}: timer termination retains the popup for 500ms until real Escape, while external Stop still cancels it`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      for (const ending of ['dismiss', 'stop'] as const) {
        game = await launchWindowAttention(page, backend, binary, menuSource, [], true)
        await page.locator('#clear-log').click()
        const surface = game.surface('Termination menu')
        const canvas = surface.locator('canvas[data-window-id]')
        await expect(canvas).toHaveAttribute('width', '160')
        await expect(canvas).toHaveAttribute('height', '96')
        await canvas.click({ position: { x: 16, y: 16 } })
        await expect(surface.locator('.game-text-input')).toBeFocused()
        await page.keyboard.press('F8')
        const popup = page.locator('.game-menu-popup[aria-label="Pending termination menu"]')
        await expect(popup).toBeVisible()
        await expect(page.getByText('termination-menu:timer-after', { exact: true })).toHaveCount(1)
        // This marker comes from a separate real Timer armed only after the
        // terminate call returns. Console evaluation would queue behind
        // the busy VM and cannot establish this retained-menu boundary.
        await expect(page.getByText('termination-menu:pending-menu-500', { exact: true })).toHaveCount(1)
        await expect(popup).toBeVisible()
        await expect(surface).toBeVisible()
        await expect(page.getByText('termination-menu:popup-after', { exact: true })).toHaveCount(0)
        expect(page.workers().filter((worker) => worker.url().includes('session.worker'))).toHaveLength(1)
        if (ending === 'dismiss') {
          await popup.getByRole('button', { name: 'Keep waiting', exact: true }).focus()
          await page.keyboard.press('Escape')
          await expect(page.getByText('termination-menu:popup-after', { exact: true })).toHaveCount(1)
        } else {
          // Invoke the real Stop control without an outside pointer-down that
          // would dismiss the popup first and test a different ordering.
          await page.locator('#stop').dispatchEvent('click')
        }
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        await expect(page.locator('.game-menu-overlay')).toHaveCount(0)
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
        await page.keyboard.press('Escape')
        const trace = (await page.locator('#logs p > span').allTextContents())
          .filter((line) => line.startsWith('termination-menu:')).map((line) => line.slice('termination-menu:'.length))
        expect(trace).toEqual(['popup-before', 'timer-before', 'timer-after', 'pending-menu-500',
          ...(ending === 'dismiss' ? ['popup-after'] : [])])
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await info.attach('termination-menu-' + ending, { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
        await game.stop()
        game = undefined
      }
    } catch (error) { failures.push(error) }
    try { await info.attach('termination-menu-final', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try {
      if (game && await page.locator('#stop').isEnabled()) await page.locator('#stop').dispatchEvent('click')
      if (game) await game.stop()
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Menu termination observation and cleanup failed', { cause: failures[0] })
  })
}
