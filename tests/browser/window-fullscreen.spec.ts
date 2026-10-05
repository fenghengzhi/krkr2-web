import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var guarded=new Window();guarded.caption="Fullscreen contract";guarded.setInnerSize(160,96);
guarded.setPos(20,24);guarded.visible=true;
var guardedImage=new Layer(guarded,null);guardedImage.setSize(160,96);
guardedImage.fillRect(0,0,160,96,0xff315779);
// Native Window invalidates explicitly registered objects. A global Layer
// reference alone is not registration in the Window's managed-object list.
guarded.add(guardedImage);
var secondary=null,secondaryImage=null,guardErrors=[];
var enter=new MenuItem(guarded,"Enter fullscreen and check");guarded.menu.add(enter);
var child=new MenuItem(guarded,"Ordinary child");guarded.menu.add(child);
guarded.setInnerSize(160,96);
function guardedGeometry(){
  return [guarded.width,guarded.height,guarded.innerWidth,guarded.innerHeight,
    guarded.left,guarded.top,guarded.minWidth,guarded.minHeight,guarded.maxWidth,
    guarded.maxHeight,guarded.borderStyle,int(guarded.innerSunken),int(guarded.visible),
    int(guarded.menu.visible)].join(",");
}
function fullscreenCheck(){
  global.guardErrors.clear();guarded.fullScreen=true;var before=guardedGeometry();
  var operations=["guarded.width=260;","guarded.innerHeight=120;","guarded.setSize(280,140);",
    "guarded.setInnerSize(270,130);","guarded.setPos(300,320);","guarded.setMinSize(12,13);",
    "guarded.setMaxSize(500,400);","guarded.borderStyle=bsNone;","guarded.innerSunken=true;",
    "guarded.visible=false;","guarded.menu.visible=false;"];
  for(var i=0;i<operations.count;i++){
    try{Scripts.exec(operations[i]);throw "fullscreen operation was accepted: "+operations[i];}
    catch(error){
      if(typeof error!="Object" || error.message===void)throw error;
      global.guardErrors.add(string(error.message));
    }
    if(before!=guardedGeometry())throw "rejected fullscreen operation changed window state";
  }
  guarded.caption="Fullscreen permitted caption";
  child.visible=false;child.visible=true;
  if(guarded.caption!="Fullscreen permitted caption" || !child.visible)
    throw "unrestricted fullscreen setter failed";
  Debug.message("fullscreen-guards="+global.guardErrors.count+":"+int(guarded.fullScreen));
}
enter.onClick=fullscreenCheck;
function createFullscreenSecondary(){
  global.secondary=new Window();secondary.caption="Fullscreen secondary";
  secondary.setInnerSize(144,88);secondary.setPos(200,24);secondary.visible=true;
  global.secondaryImage=new Layer(secondary,null);secondaryImage.setSize(144,88);
  secondaryImage.fillRect(0,0,144,88,0xff795731);secondary.fullScreen=true;
  return int(secondary.fullScreen);
}
`

async function finish(page: Page, info: TestInfo, stop: () => Promise<void>, failures: unknown[]) {
  try {
    await info.attach('fullscreen-window-state', { contentType: 'application/json', body: JSON.stringify({
      logs: await page.locator('#logs').innerText(),
      windows: await page.locator('.game-window[data-window-id]').evaluateAll((elements) => elements.map((element) => ({
        windowId: element.getAttribute('data-window-id'), caption: element.getAttribute('aria-label'),
        classes: element.className, hidden: (element as HTMLElement).hidden,
        width: element.querySelector('canvas')?.width, height: element.querySelector('canvas')?.height,
      }))),
    }, null, 2) })
  } catch (error) { failures.push(error) }
  try {
    const exits = page.getByRole('button', { name: '退出全屏', exact: true })
    if (await exits.count()) await exits.first().click()
  } catch (error) { failures.push(error) }
  try { await stop() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Fullscreen scenario and cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: fullscreen rejects script geometry and root-menu writes, while a real exit restores writable geometry`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.setViewportSize({ width: 1280, height: 900 })
    const game = await launchWindowAttention(page, backend, binary, source), failures: unknown[] = []
    try {
      await game.surface('Fullscreen contract').getByRole('button', { name: 'Enter fullscreen and check', exact: true }).click()
      const surface = game.surface('Fullscreen permitted caption')
      await expect(surface).toHaveClass(/game-window-fullscreen/)
      await expect(page.locator('#logs')).toContainText('fullscreen-guards=11:1')
      // Fullscreen fits the requested 160:96 inner aspect into the actual
      // 1280x900 desktop. Its rendered backing is the 1280x768 viewport.
      await expect(surface.locator('canvas')).toHaveJSProperty('width', 1280)
      await expect(surface.locator('canvas')).toHaveJSProperty('height', 768)
      await expect(surface.getByRole('button', { name: 'Ordinary child', exact: true })).toBeVisible()
      await info.attach('fullscreen-rejected-script-writes', { body: await page.screenshot(), contentType: 'image/png' })
      await surface.getByRole('button', { name: '退出全屏', exact: true }).click()
      await expect(surface).not.toHaveClass(/game-window-fullscreen/)
      await evaluate(page, '(function(){guarded.innerSunken=true;guarded.menu.visible=false;guarded.setInnerSize(180,108);guarded.setPos(32,36);return guarded.innerWidth+","+guarded.innerHeight+","+guarded.left+","+guarded.top+","+int(guarded.innerSunken)+","+int(guarded.menu.visible)+","+int(guarded.fullScreen);})()', '180,108,32,36,1,0,0')
      await expect(surface.locator('canvas')).toHaveJSProperty('width', 180)
      await expect(surface.locator('canvas')).toHaveJSProperty('height', 108)
      await expect(surface.getByRole('button', { name: 'Ordinary child', exact: true })).toBeHidden()
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })

  test(`${variant}: real close hides a fullscreen secondary Window without invalidating it, and retires the main Window`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source), failures: unknown[] = []
    try {
      await evaluate(page, 'createFullscreenSecondary()', '1')
      const secondary = game.surface('Fullscreen secondary')
      await expect(secondary).toHaveClass(/game-window-fullscreen/)
      await secondary.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
      await expect(secondary).toBeHidden()
      await expect(page.locator('#stage')).not.toHaveClass(/game-desktop-fullscreen/)
      await evaluate(page, 'int(isvalid secondary)+","+int(secondary.visible)+","+int(isvalid secondaryImage)+","+int(isvalid guarded)', '1,0,1,1')
      await evaluate(page, '(function(){secondary.fullScreen=false;secondary.visible=true;return int(secondary.visible);})()', '1')
      await expect(secondary).toBeVisible()
      await expect(secondary.locator('canvas')).toHaveJSProperty('width', 144)
      await expect(secondary.locator('canvas')).toHaveJSProperty('height', 88)
      await evaluate(page, '(function(){invalidate secondary;guarded.fullScreen=true;return int(guarded.fullScreen);})()', '1')
      const main = game.surface('Fullscreen contract')
      await expect(main).toHaveClass(/game-window-fullscreen/)
      await main.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
      await expect(main).toHaveCount(0)
      await expect(page.locator('#stage')).not.toHaveClass(/game-desktop-fullscreen/)
      await evaluate(page, 'int(isvalid guarded)+","+int(isvalid guardedImage)', '0,0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })
}
