import { expect, test, type Locator, type Page, type TestInfo } from '@playwright/test'
import { cursorDib, cursorFile } from '../helpers/cursor-fixtures.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const custom = cursorFile([{ width: 32, height: 32, hotspot: [4, 5], payload: cursorDib({
  width: 32, height: 32, depth: 24,
  xorRows: Array.from({ length: 32 }, () => Array.from({ length: 32 }, () => [255, 0, 255]).flat()),
}) }])
const source = String.raw`
System.exitOnWindowClose=false;
var menuWindow=new Window();menuWindow.caption="Menu cursor A";menuWindow.setPos(0,0);
var menuRoot=new Layer(menuWindow,null);menuWindow.add(menuRoot);menuRoot.type=ltOpaque;
menuRoot.setSize(240,140);menuRoot.fillRect(0,0,240,140,0xff123456);menuRoot.cursor=crCross;
var cursorTools=new MenuItem(menuWindow,"Cursor tools"),cursorNested=new MenuItem(menuWindow,"Nested tools"),cursorLeaf=new MenuItem(menuWindow,"Menu leaf");
menuWindow.menu.add(cursorTools);cursorTools.add(cursorNested);cursorNested.add(cursorLeaf);
cursorLeaf.onClick=function(){Debug.message("menu-force-leaf");};
menuWindow.setInnerSize(240,140);menuWindow.visible=true;
var controlWindow=new Window();controlWindow.caption="Menu cursor B";controlWindow.setPos(360,0);
var controlRoot=new Layer(controlWindow,null);controlWindow.add(controlRoot);controlRoot.type=ltOpaque;
controlRoot.setSize(160,100);controlRoot.fillRect(0,0,160,100,0xff654321);
controlWindow.setInnerSize(160,100);controlWindow.visible=true;controlWindow.mouseCursorState=mcsHidden;
var menuMutation=0,menuPopupRound=0;
var menuTimer=new Timer();menuTimer.enabled=false;menuTimer.interval=25;
menuTimer.onTimer=function(){
  global.menuTimer.enabled=false;
  if(global.menuMutation==1){global.menuWindow.mouseCursorState=mcsHidden;global.menuRoot.cursor=crIBeam;}
  if(global.menuMutation==2){global.menuWindow.mouseCursorState=mcsVisible;global.menuRoot.cursor="menu.cur";global.menuRoot.setCursorPos(100,80);}
  if(global.menuMutation==3){global.menuWindow.mouseCursorState=mcsHidden;global.menuRoot.cursor="menu.cur";global.menuRoot.setCursorPos(100,80);}
  Debug.message("menu-force-mutation:"+global.menuMutation+":"+global.menuWindow.mouseCursorState);
};
function mutateMenuCursor(mode){global.menuMutation=mode;global.menuTimer.enabled=true;}
menuWindow.onKeyDown=function(key,shift){
  if(key==117)global.menuRoot.setCursorPos(100,80);
  if(key==120){
    global.menuWindow.hideMouseCursor();
    Debug.message("menu-force-popup-before:"+global.menuWindow.mouseCursorState);
    global.menuPopupRound++;
    global.mutateMenuCursor(global.menuPopupRound==1?3:2);
    global.cursorTools.popup(0,20,20);
    Debug.message("menu-force-popup-return:"+global.menuPopupRound+":"+global.menuWindow.mouseCursorState);
  }
};
`

async function open(summary: Locator) {
  await summary.focus()
  await summary.press('Enter')
  await expect(summary.locator('..')).toHaveAttribute('open', '')
}
async function close(page: Page, summary: Locator) {
  await summary.focus()
  await page.keyboard.press('Escape')
  await expect(summary.locator('..')).not.toHaveAttribute('open', '')
}
async function finish(page: Page, info: TestInfo, stop: () => Promise<void>, failures: unknown[]) {
  try { await info.attach('menu-cursor-logs', { body: Buffer.from(await page.locator('#logs').innerText()), contentType: 'text/plain' }) }
  catch (error) { failures.push(error) }
  // A popup or fullscreen game covers the page by design. Dispatch the
  // existing Stop control so cleanup cannot replace the primary assertion
  // with a blocked pointer click against the fullscreen canvas.
  try {
    if (await page.locator('.game-menu-overlay, .game-window-fullscreen').count())
      await page.locator('#stop').dispatchEvent('click')
    await stop()
  } catch (error) { failures.push(error) }
  if (failures.length) throw new AggregateError(failures, 'Menu cursor scenario or cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify','jspi']) for (const binary of [false,true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: nested page menus override cursor presentation while retaining live logic and virtual identity`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source,
      [{ name: 'menu.cur', mimeType: 'application/octet-stream', buffer: custom }]),
      a = game.surface('Menu cursor A'), b = game.surface('Menu cursor B'),
      canvas = a.locator('canvas[data-window-id]'), other = b.locator('canvas[data-window-id]'),
      tools = a.locator('summary').filter({ hasText: /^Cursor tools$/ }),
      nested = a.locator('summary').filter({ hasText: /^Nested tools$/ }), failures: unknown[] = []
    try {
      await canvas.focus(); await page.keyboard.press('F6')
      const marker = a.locator('.game-virtual-cursor')
      await expect(marker).toBeVisible()
      const revision = await marker.getAttribute('data-cursor-revision')
      // Keyboard activation introduces no physical cursor takeover.
      await open(tools)
      await expect(canvas).toHaveCSS('cursor', 'default')
      await expect(marker).toHaveCount(0)
      await expect(other).toHaveCSS('cursor', 'none')
      await open(nested)
      await nested.press('Enter')
      await expect(nested.locator('..')).not.toHaveAttribute('open', '')
      await expect(tools.locator('..')).toHaveAttribute('open', '')
      await expect(canvas).toHaveCSS('cursor', 'default')
      await close(page, tools)
      await expect(marker).toBeVisible()
      await expect(marker).toHaveAttribute('data-cursor-revision', revision!)

      await open(tools)
      await evaluate(page, '(mutateMenuCursor(1),0)', '0')
      await expect(page.locator('#logs')).toContainText('menu-force-mutation:1:2')
      await expect(canvas).toHaveCSS('cursor', 'default')
      await evaluate(page, 'menuWindow.mouseCursorState+","+menuRoot.cursor', '2,-4')
      await close(page, tools)
      await expect(canvas).toHaveCSS('cursor', 'none')

      await open(tools)
      await evaluate(page, '(mutateMenuCursor(2),0)', '0')
      await expect(page.locator('#logs')).toContainText('menu-force-mutation:2:0')
      await expect(canvas).toHaveCSS('cursor', 'default')
      await expect(a.locator('.game-custom-cursor')).toHaveCount(0)
      await close(page, tools)
      const customMarker = a.locator('.game-custom-cursor')
      await expect(customMarker).toBeVisible()
      await expect(customMarker).toHaveClass(/game-virtual-cursor/)
      await expect.poll(() => customMarker.evaluate((node) => [...(node as HTMLCanvasElement).getContext('2d')!.getImageData(16,16,1,1).data]))
        .toEqual([255,0,255,255])
      await expect(other).toHaveCSS('cursor', 'none')

      await open(tools)
      await evaluate(page, '(menuWindow.mouseCursorState=mcsHidden,menuWindow.visible=false,0)', '0')
      await expect(a).toBeHidden()
      await evaluate(page, '(menuWindow.visible=true,0)', '0')
      await expect(a).toBeVisible()
      await expect(tools.locator('..')).not.toHaveAttribute('open', '')
      await expect(canvas).toHaveCSS('cursor', 'none')
    } catch (error) { failures.push(error) }
    finally { await finish(page, info, game.stop, failures) }
  })

  test(`${variant}: blocking popup forces default cursor through Timer mutations and restores latest state on cancel or Stop`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source,
      [{ name: 'menu.cur', mimeType: 'application/octet-stream', buffer: custom }]),
      a = game.surface('Menu cursor A'), b = game.surface('Menu cursor B'), canvas = a.locator('canvas[data-window-id]'),
      popup = page.locator('.game-menu-popup'), failures: unknown[] = []
    try {
      await canvas.focus(); await page.keyboard.press('F9')
      await expect(popup).toBeVisible()
      await expect(page.locator('#logs')).toContainText('menu-force-popup-before:1')
      await expect(page.locator('#logs')).toContainText('menu-force-mutation:3:2')
      await expect(canvas).toHaveCSS('cursor', 'default')
      await expect(a.locator('.game-custom-cursor')).toHaveCount(0)
      await expect(b.locator('canvas[data-window-id]')).toHaveCSS('cursor', 'none')
      await page.keyboard.press('Escape')
      await expect(popup).toHaveCount(0)
      await expect(page.locator('#logs')).toContainText('menu-force-popup-return:1:2')
      await expect(canvas).toHaveCSS('cursor', 'none')

      await evaluate(page, '(menuWindow.fullScreen=true,0)', '0')
      await expect(a).toHaveClass(/game-window-fullscreen/)
      await canvas.focus(); await page.keyboard.press('F9')
      await expect(popup).toBeVisible()
      await expect(page.locator('#logs')).toContainText('menu-force-mutation:2:0')
      await expect(canvas).toHaveCSS('cursor', 'default')
      await expect(a.locator('.game-custom-cursor')).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(page.locator('#logs')).toContainText('menu-force-popup-return:2:0')
      await expect(a.locator('.game-custom-cursor')).toBeVisible()
      await expect(a.locator('.game-custom-cursor')).toHaveClass(/game-virtual-cursor/)

      await canvas.focus(); await page.keyboard.press('F9')
      await expect(popup).toBeVisible()
      await expect(canvas).toHaveCSS('cursor', 'default')
      await page.locator('#stop').dispatchEvent('click')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-menu-overlay, .game-virtual-cursor, .game-custom-cursor')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    finally { await finish(page, info, game.stop, failures) }
  })
}
