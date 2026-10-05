import { expect, type Locator, type Page } from '@playwright/test'

type PopupDomEvidence = { dropped: number; events: Record<string, unknown>[] }
declare global { interface Window { popupDomEvidence?: PopupDomEvidence } }

export async function observePopupDom(page: Page) {
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
}

export const popupSource = String.raw`
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

export async function reset(page: Page, phase: string, mode = 'stay', extra = '') {
  // A console mousedown posts its own popup events. Their delivery may follow
  // evaluate(), so resetting inside that evaluation is not a delivery barrier.
  // Submit preparation through the real console's Enter path, without adding
  // another application-deactivation gesture to the scenario being measured.
  const marker = `popup-reset:${phase}:`,
    source = `${JSON.stringify(marker)}+string((function(){popupReset(${JSON.stringify(phase)},${JSON.stringify(mode)});${extra}return 1;})())`,
    expression = page.locator('#expression')
  await expect(page.locator('#evaluate')).toBeEnabled()
  await expression.fill(source)
  await expect(expression).toHaveValue(source)
  await expression.press('Enter')
  await expect(page.getByText(marker + '1', { exact: true })).toBeVisible()
}
export async function sequence(page: Page, phase: string, values: string) {
  const lines = page.locator('#logs p span').filter({ hasText: new RegExp(`^popup:${phase}:`) })
  await expect(lines.last()).toHaveText(`popup:${phase}:${values}`)
}
export async function point(locator: Locator) {
  await locator.scrollIntoViewIfNeeded()
  const box = await locator.boundingBox()
  expect(box).not.toBeNull()
  return { x: box!.x + Math.min(30, box!.width / 2), y: box!.y + Math.min(25, box!.height / 2) }
}
export async function focusGame(page: Page, surface: Locator) {
  const canvas = surface.locator('canvas[data-window-id]'), position = await point(canvas)
  await page.mouse.move(position.x, position.y)
  await canvas.focus()
  await expect(surface.locator('.game-text-input')).toBeFocused()
  await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true)
}
