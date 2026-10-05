import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

type PopupDomEvidence = { dropped: number; events: Record<string, unknown>[] }
declare global { interface Window { popupDomEvidence?: PopupDomEvidence } }

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const evidence: PopupDomEvidence = { dropped: 0, events: [] }
    window.popupDomEvidence = evidence
    const record = (event: Event) => {
      if (evidence.events.length >= 512) { evidence.dropped++; return }
      const target = event.target instanceof Element ? event.target : null,
        pointer = event instanceof MouseEvent ? event : null,
        key = event instanceof KeyboardEvent ? event : null
      evidence.events.push({ type: event.type, at: performance.now(), trusted: event.isTrusted,
        target: target ? `${target.tagName}.${target.className}` : event.target === window ? 'window' : 'document',
        windowId: target?.closest('[data-window-id]')?.getAttribute('data-window-id'),
        button: pointer?.button, x: pointer?.clientX, y: pointer?.clientY,
        key: key?.key, altKey: key?.altKey, focused: document.hasFocus(), visibility: document.visibilityState })
    }
    for (const type of ['pointerdown', 'pointerup', 'keydown', 'keyup'])
      window.addEventListener(type, record, { capture: true, passive: true })
    // Only the browser Window losing focus counts as an application blur.
    window.addEventListener('blur', (event) => { if (event.target === window) record(event) }, true)
    window.addEventListener('focus', (event) => { if (event.target === window) record(event) }, true)
    document.addEventListener('visibilitychange', record)
  })
})

const source = String.raw`
System.exitOnWindowClose=false;
var popupTrace=[],popupPhase="setup",popupMode="stay";
function popupNote(value){global.popupTrace.add(value);Debug.message("popup:"+global.popupPhase+":"+global.popupTrace.join("|"));}
class PopupWindow extends Window {
  var tag;
  function PopupWindow(tag,x,y){super.Window();this.tag=tag;caption="Popup "+tag;setInnerSize(150,85);setPos(x,y);visible=true;}
  function onMouseDown(x,y,button,shift){popupNote("down:"+tag+":"+button);}
  function onKeyDown(key,shift){popupNote("key:"+tag+":"+key);}
  function onPopupHide(){
    popupNote("hide:"+tag);
    if(tag=="new" && global.popupMode=="mutate-old"){
      global.popupOld.focusable=true;global.popupOld.stayOnTop=false;
    }
    if(tag=="new" && global.popupMode=="hide-old")global.popupOld.visible=false;
    if(global.popupMode=="hide")visible=false;
  }
}
function popupImage(window,color){var layer=new Layer(window,null);layer.setSize(150,85);layer.fillRect(0,0,150,85,color);return layer;}
var popupMain=new PopupWindow("main",0,0),popupMainImage=popupImage(popupMain,0xff355575);
var popupOld=new Window();popupOld.caption="Popup old";popupOld.setInnerSize(150,85);popupOld.setPos(190,0);
popupOld.focusable=false;popupOld.stayOnTop=true;popupOld.visible=true;
var popupOldImage=popupImage(popupOld,0xff735535);
popupOld.action=function(event){
  if(event.type!="onPopupHide")return;
  var pairs=[];pairs.assign(event);
  if(event.target!==global.popupOld || pairs.count!=4)throw "bad onPopupHide action payload";
  popupNote("action:old");
  if(global.popupMode=="hide")global.popupOld.visible=false;
};
var popupNew=new PopupWindow("new",380,0),popupNewImage=popupImage(popupNew,0xff557535);
popupNew.focusable=false;popupNew.stayOnTop=true;
var popupRegular=new PopupWindow("regular",0,145),popupRegularImage=popupImage(popupRegular,0xff454545);
popupRegular.stayOnTop=true;
var popupNonTop=new PopupWindow("non-top",190,145),popupNonTopImage=popupImage(popupNonTop,0xff555555);
popupNonTop.focusable=false;
var popupHidden=new PopupWindow("hidden",380,145),popupHiddenImage=popupImage(popupHidden,0xff656565);
popupHidden.focusable=false;popupHidden.stayOnTop=true;popupHidden.visible=false;
function popupReset(phase,mode="stay"){
  global.popupMain.useMouseKey=false;global.popupNonTop.trapKey=false;
  global.popupOld.focusable=false;global.popupOld.stayOnTop=true;global.popupOld.visible=true;
  global.popupNew.focusable=false;global.popupNew.stayOnTop=true;global.popupNew.visible=true;
  global.popupHidden.visible=false;global.popupTrace.clear();global.popupPhase=phase;global.popupMode=mode;
  return 1;
}
var popupMenu=new MenuItem(popupMain,"Popup test"),popupMenuItem=new MenuItem(popupMain,"F10 action");
popupMain.menu.add(popupMenu);popupMenu.add(popupMenuItem);popupMenuItem.shortcut="F10";
popupMenuItem.onClick=function(){popupNote("menu:main");};
`

async function reset(page: Page, phase: string, mode = 'stay', extra = '') {
  // Console clicks themselves deactivate the game. Reset after that real
  // notification, then make the next gesture without another console click.
  await evaluate(page, `(function(){popupReset(${JSON.stringify(phase)},${JSON.stringify(mode)});${extra}return 1;})()`, '1')
}
async function sequence(page: Page, phase: string, values: string) {
  const lines = page.locator('#logs p span').filter({ hasText: new RegExp(`^popup:${phase}:`) })
  await expect(lines.last()).toHaveText(`popup:${phase}:${values}`)
}
async function point(locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + Math.min(30, box!.width / 2), y: box!.y + Math.min(25, box!.height / 2) }
}
async function focusGame(page: Page, surface: Locator) {
  const canvas = surface.locator('canvas[data-window-id]'), position = await point(canvas)
  await page.mouse.move(position.x, position.y)
  await canvas.focus()
  await expect(surface.locator('.game-text-input')).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
}
async function finish(page: Page, info: TestInfo, stop: () => Promise<void>, failures: unknown[]) {
  try { await page.keyboard.up('Alt'); await page.mouse.up(); await page.mouse.up({ button: 'right' }); await stop() }
  catch (error) { failures.push(error) }
  try {
    const evidence = await page.evaluate(() => window.popupDomEvidence)
    await info.attach('window-popup-input', { body: JSON.stringify({ scope: 'Real browser pointer/key/focus events; no physical hardware claim', evidence,
      logs: await page.locator('#logs').innerText() }, null, 2), contentType: 'application/json' })
    expect(evidence?.dropped).toBe(0)
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Popup scenario and cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${variant}: popup notifications use real inside/outside and chrome downs, registration order and script-owned visibility`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source), failures: unknown[] = [],
      main = game.surface('Popup main'), old = game.surface('Popup old'), newer = game.surface('Popup new')
    try {
      await reset(page, 'inside')
      const inside = await point(newer.locator('canvas[data-window-id]'))
      await page.mouse.click(inside.x, inside.y)
      await sequence(page, 'inside', 'down:new:0')
      await expect(old).toBeVisible(); await expect(newer).toBeVisible()

      for (const button of ['left', 'right'] as const) {
        await reset(page, `outside-${button}`)
        const outside = await point(main.locator('canvas[data-window-id]'))
        await page.mouse.click(outside.x, outside.y, { button })
        await sequence(page, `outside-${button}`, `hide:new|action:old|down:main:${button === 'left' ? 0 : 1}`)
        // No engine or host auto-hide: both callbacks deliberately keep them.
        await expect(old).toBeVisible(); await expect(newer).toBeVisible()
      }

      await reset(page, 'captured-targets', 'mutate-old')
      const mainPoint = await point(main.locator('canvas[data-window-id]'))
      await page.mouse.click(mainPoint.x, mainPoint.y)
      await sequence(page, 'captured-targets', 'hide:new|action:old|down:main:0')
      await expect(old).toHaveAttribute('data-focusable', 'true')

      await reset(page, 'delivery-visible', 'hide-old')
      const visiblePoint = await point(main.locator('canvas[data-window-id]'))
      await page.mouse.click(visiblePoint.x, visiblePoint.y)
      await sequence(page, 'delivery-visible', 'hide:new|down:main:0')
      await expect(old).toBeHidden(); await expect(newer).toBeVisible()

      for (const button of ['left', 'right'] as const) {
        await reset(page, `chrome-${button}`)
        const title = await point(main.locator('.game-window-title'))
        await page.mouse.click(title.x, title.y, { button })
        await sequence(page, `chrome-${button}`, 'hide:new|action:old')
        if (button === 'right') await page.keyboard.press('Escape')
      }

      await reset(page, 'mouse-key', 'stay', 'popupMain.useMouseKey=true;')
      await focusGame(page, main)
      await page.keyboard.press('Enter')
      await sequence(page, 'mouse-key', 'hide:new|action:old|down:main:0')

      await reset(page, 'script-hides', 'hide')
      const hidePoint = await point(main.locator('canvas[data-window-id]'))
      await page.mouse.click(hidePoint.x, hidePoint.y)
      await sequence(page, 'script-hides', 'hide:new|action:old|down:main:0')
      await expect(old).toBeHidden(); await expect(newer).toBeHidden()
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await info.attach('window-popup-script-hidden', { body: await page.screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(page, info, game.stop, failures)
  })

  test(`${variant}: system keys precede trapped or menu-consumed input, while real application blur broadcasts once`, async ({ page, context }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    // Keep the VM available while observing the real browser's blur/hidden
    // events; this controls the app preference, not document focus/visibility.
    await page.locator('#pause-background').uncheck()
    const game = await launchWindowAttention(page, backend, binary, source, [], true), failures: unknown[] = [],
      main = game.surface('Popup main')
    let other: Page | undefined
    try {
      await reset(page, 'posted', 'stay', 'popupMain.postInputEvent("onKeyDown",%[key:121,shift:0]);')
      await sequence(page, 'posted', 'key:main:121')

      await reset(page, 'alt-trap', 'stay', 'popupNonTop.trapKey=true;')
      await focusGame(page, main)
      // Native trapKey=true resets its system-key admission gate. A real
      // ordinary key arms it and must itself leave both popups untouched.
      await page.keyboard.press('a')
      await sequence(page, 'alt-trap', 'key:non-top:65')
      await page.keyboard.down('Alt')
      try { await sequence(page, 'alt-trap', 'key:non-top:65|hide:new|action:old|key:non-top:18') }
      finally { await page.keyboard.up('Alt') }

      await reset(page, 'menu-f10')
      await focusGame(page, main)
      await page.keyboard.press('F10')
      await sequence(page, 'menu-f10', 'hide:new|action:old|menu:main')

      await reset(page, 'host-control')
      await focusGame(page, main)
      await page.locator('#expression').click()
      await sequence(page, 'host-control', 'hide:new|action:old')
      // Return without mousedown, then use an ordinary real key as the FIFO
      // barrier after any duplicate blur notification could have been queued.
      await focusGame(page, main)
      await page.keyboard.press('F8')
      await sequence(page, 'host-control', 'hide:new|action:old|key:main:119')

      await reset(page, 'application-blur')
      await focusGame(page, main)
      const blurBefore = await page.evaluate(() => window.popupDomEvidence!.events.filter((event) => event.type === 'blur').length)
      other = await context.newPage()
      await other.setContent('<button type="button">Other application surface</button>')
      await other.bringToFront()
      await other.getByRole('button', { name: 'Other application surface', exact: true }).click()
      await expect.poll(() => page.evaluate(() => window.popupDomEvidence!.events.filter((event) => event.type === 'blur').length))
        .toBeGreaterThan(blurBefore)
      await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(false)
      await sequence(page, 'application-blur', 'hide:new|action:old')
      await page.bringToFront()
      await focusGame(page, main)
      await page.keyboard.press('F8')
      await sequence(page, 'application-blur', 'hide:new|action:old|key:main:119')
      await expect(game.surface('Popup old')).toBeVisible()
      await expect(game.surface('Popup new')).toBeVisible()
      await other.close(); other = undefined
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await info.attach('window-popup-focus-restored', { body: await page.screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    if (other) {
      try { await other.close(); await page.bringToFront() } catch (error) { failures.push(error) }
    }
    await finish(page, info, game.stop, failures)
  })
}
