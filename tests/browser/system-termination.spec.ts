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
}
