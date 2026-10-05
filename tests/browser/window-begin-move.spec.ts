import { test, expect, type Locator, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

type MoveObservation = { dropped: number; entries: Record<string, unknown>[] }
declare global { interface Window { beginMoveObservation?: MoveObservation } }

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const observation = window.beginMoveObservation = { dropped: 0, entries: [] } as MoveObservation
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'gotpointercapture',
      'lostpointercapture', 'focus', 'blur', 'scroll']) {
      window.addEventListener(type, (event) => {
        if (observation.entries.length >= 256) { observation.dropped++; return }
        const target = event.target instanceof Element ? event.target : undefined,
          pointer = event instanceof PointerEvent ? event : undefined,
          stage = document.querySelector('.game-desktop'),
          moving = document.querySelector<HTMLElement>('.game-window-dragging')
        observation.entries.push({
          sequence: observation.entries.length, time: performance.now(), type,
          trusted: event.isTrusted, target: target ? `${target.tagName}.${target.className}` : String(event.target),
          pointerId: pointer?.pointerId, buttons: pointer?.buttons,
          x: pointer?.clientX, y: pointer?.clientY, scrollX, scrollY,
          stageScroll: stage ? [stage.scrollLeft, stage.scrollTop] : undefined,
          moving: moving?.dataset.windowId,
          position: moving ? [moving.style.getPropertyValue('--game-window-left'),
            moving.style.getPropertyValue('--game-window-top')] : undefined,
        })
      }, { capture: true, passive: true })
    }
  })
})
test.afterEach(async ({ page }, info) => {
  await info.attach('begin-move-dom-observation', {
    body: JSON.stringify(await page.evaluate(() => window.beginMoveObservation ?? null), null, 2),
    contentType: 'application/json',
  })
})

function source(sole: boolean): string {
  return String.raw`
System.exitOnWindowClose=false;
var moveCalls=0,moveReturns=0,moveWaiting=false,moveMode="normal",moveTicks=0;
var moveMouseUps=0,moveClicks=0,moveKeyUps=0,moveLayerDowns=0;
function moveTick(){
  global.moveTicks++;
  if(global.moveTicks==1)
    Debug.message("begin-move:pending:"+global.moveCalls+":"+global.moveReturns+":"+int(global.moveWaiting));
  if(global.moveTicks<60 || global.moveMode=="normal")return;
  global.moveClock.enabled=false;
  if(global.moveMode=="hide"){
    global.moveTarget.visible=false;
    Debug.message("begin-move:hidden");
  }else if(global.moveMode=="invalidate"){
    invalidate global.moveTarget;
    Debug.message("begin-move:invalidated");
  }
}
var moveClock=new Timer(global,"moveTick");moveClock.interval=50;moveClock.enabled=false;
class MoveWindow extends Window {
  function MoveWindow(){
    super.Window();caption="Begin move target";borderStyle=bsNone;
    setInnerSize(240,160);setPos(60,40);visible=true;
  }
  function onMouseDown(x,y,button,shift){
    global.moveCalls++;global.moveWaiting=true;global.moveTicks=0;
    Debug.message("begin-move:enter:"+global.moveCalls);
    global.moveClock.enabled=true;
    try {
      beginMove();
      global.moveReturns++;
      Debug.message("begin-move:return:"+global.moveCalls+":"+left+","+top);
    }catch(error){Debug.message("begin-move:error:"+global.moveCalls+":"+error.message);}
    global.moveClock.enabled=false;global.moveWaiting=false;
  }
  function onMouseUp(x,y,button,shift){global.moveMouseUps++;Debug.message("begin-move:unexpected-up");}
  function onClick(x,y){global.moveClicks++;Debug.message("begin-move:unexpected-click");}
  function onKeyUp(key,shift){global.moveKeyUps++;Debug.message("begin-move:unexpected-key-up:"+key);}
}
${sole ? '' : String.raw`
var moveBack=new Window();moveBack.caption="Begin move back";moveBack.borderStyle=bsNone;
moveBack.setInnerSize(240,160);moveBack.setPos(360,40);moveBack.visible=true;
var moveBackRoot=new Layer(moveBack,null);moveBackRoot.setSize(240,160);moveBackRoot.setImageSize(240,160);
moveBackRoot.fillRect(0,0,240,160,0xff325675);
`}
var moveTarget=new MoveWindow();
var moveRoot=new Layer(moveTarget,null);moveRoot.setSize(240,160);moveRoot.setImageSize(240,160);
moveRoot.fillRect(0,0,240,160,0xff91572d);
moveRoot.onMouseDown=function(x,y,button,shift){
  global.moveLayerDowns++;Debug.message("begin-move:layer-down:"+global.moveLayerDowns+":"+int(global.moveWaiting));
};
moveRoot.onMouseUp=function(x,y,button,shift){global.moveMouseUps++;Debug.message("begin-move:unexpected-layer-up");};
moveRoot.onClick=function(x,y){global.moveClicks++;Debug.message("begin-move:unexpected-layer-click");};
`
}

async function box(surface: Locator) {
  const rectangle = await surface.boundingBox()
  expect(rectangle).not.toBeNull()
  return rectangle!
}

async function begin(page: Page, surface: Locator, call: number, returns: number) {
  const canvas = surface.locator('canvas[data-window-id]')
  await canvas.scrollIntoViewIfNeeded()
  // Console interaction can scroll the page between moves. Keep the baseline
  // in the same viewport coordinate system as the following pointer gesture.
  const initial = await box(surface), rectangle = await box(canvas),
    point = { x: rectangle.x + 36, y: rectangle.y + 32 }
  await page.mouse.move(point.x, point.y)
  await page.mouse.down()
  await expect(page.getByText(`begin-move:enter:${call}`, { exact: true })).toBeVisible()
  await expect(surface).toHaveClass(/game-window-dragging/)
  // This Timer runs in the same VM's modal pump while the down callback is
  // suspended. An evaluate RPC would queue behind that callback instead.
  await expect(page.getByText(`begin-move:pending:${call}:${returns}:1`, { exact: true })).toBeVisible()
  await expect(page.getByText(new RegExp(`^begin-move:return:${call}:`))).toHaveCount(0)
  return { ...point, initial }
}

async function noCompletionInput(page: Page) {
  await evaluate(page, 'global.moveMouseUps+":"+global.moveClicks+":"+global.moveKeyUps', '0:0:0')
  await expect(page.locator('#logs')).not.toContainText('begin-move:unexpected-')
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: beginMove with the left button up returns without changing embedded placement`, async ({ page }) => {
    const game = await launchWindowAttention(page, backend, binary, source(true)),
      target = game.surface('Begin move target')
    try {
      await expect(target).toHaveClass(/game-window-embedded/)
      // The real console click completes before its expression enters TJS, so
      // the observed left button is up. The old host would wait indefinitely.
      await evaluate(page, `(function(){
        global.moveTarget.beginMove();
        return global.moveTarget.left+","+global.moveTarget.top;
      })()`.replace(/\s*\n\s*/g, ' '), '60,40')
      await expect(target).toHaveClass(/game-window-embedded/)
      await expect(target).not.toHaveClass(/game-window-dragging/)
      await expect(page.locator('.game-window-flow-space')).toHaveCount(0)
      await evaluate(page, `(function(){
        global.moveTarget.visible=false;
        global.moveTarget.beginMove();
        global.moveTarget.visible=true;
        return global.moveTarget.left+","+global.moveTarget.top;
      })()`.replace(/\s*\n\s*/g, ' '), '60,40')
      await expect(target).toBeVisible()
      await expect(target).toHaveClass(/game-window-embedded/)
      await expect(page.locator('.game-window-dragging,.game-window-flow-space')).toHaveCount(0)
    } finally { await game.stop() }
  })

  test(`${backend}/${binary ? 'bytecode' : 'source'}: borderless beginMove suspends its real mouse callback through commit, Escape, hide and invalidation`, async ({ page }, info) => {
    test.setTimeout(120000)
    const game = await launchWindowAttention(page, backend, binary, source(false)),
      target = game.surface('Begin move target')
    try {
      await expect(target).not.toHaveClass(/game-window-embedded/)
      const first = await begin(page, target, 1, 0), initial = first.initial
      await page.mouse.move(first.x + 70, first.y + 35, { steps: 5 })
      await expect.poll(async () => Math.round((await box(target)).x - initial.x)).toBe(70)
      await expect.poll(async () => Math.round((await box(target)).y - initial.y)).toBe(35)
      await expect(page.getByText(/^begin-move:return:1:/)).toHaveCount(0)
      await page.mouse.up()
      await expect(page.getByText('begin-move:return:1:130,75', { exact: true })).toBeVisible()
      await expect(target).not.toHaveClass(/game-window-dragging/)
      // The manager's original down callback follows the resumed Window call;
      // a page move must not fake controller.release or synthesize its mouseup.
      await expect(page.getByText('begin-move:layer-down:1:0', { exact: true })).toBeVisible()
      await noCompletionInput(page)
      await info.attach('begin-move-borderless-committed', { body: await page.screenshot(), contentType: 'image/png' })

      const second = await begin(page, target, 2, 1), committed = second.initial
      await page.mouse.move(second.x + 45, second.y + 20, { steps: 3 })
      await expect.poll(async () => Math.round((await box(target)).x - committed.x)).toBe(45)
      await page.keyboard.press('Escape')
      await expect(page.getByText('begin-move:return:2:130,75', { exact: true })).toBeVisible()
      await expect(target).not.toHaveClass(/game-window-dragging/)
      await page.mouse.up()
      await expect.poll(async () => Math.round((await box(target)).x - committed.x)).toBe(0)
      await expect.poll(async () => Math.round((await box(target)).y - committed.y)).toBe(0)
      await expect(page.getByText('begin-move:layer-down:2:0', { exact: true })).toBeVisible()
      await noCompletionInput(page)

      await evaluate(page, '(global.moveMode="hide",0)', '0')
      const third = await begin(page, target, 3, 2)
      await page.mouse.move(third.x + 20, third.y + 10)
      await expect(page.getByText('begin-move:hidden', { exact: true })).toBeVisible()
      await expect(target).toBeHidden()
      await expect(target).not.toHaveClass(/game-window-dragging/)
      await expect(page.getByText('begin-move:return:3:130,75', { exact: true })).toBeVisible()
      await page.mouse.up()
      await evaluate(page, '(global.moveTarget.visible=true,global.moveMode="invalidate",0)', '0')
      await expect(target).toBeVisible()
      await begin(page, target, 4, 3)
      await expect(page.getByText('begin-move:invalidated', { exact: true })).toBeVisible()
      await expect(target).toHaveCount(0)
      await expect(page.locator('.game-window-dragging')).toHaveCount(0)
      await page.mouse.up()
      await expect(page.locator('#logs')).not.toContainText('begin-move:unexpected-')
    } finally {
      await page.mouse.up()
      await game.stop()
    }
  })

  test(`${backend}/${binary ? 'bytecode' : 'source'}: sole responsive beginMove preserves CSS size, rolls back Escape, keeps committed placement and cancels on Stop`, async ({ page }, info) => {
    test.setTimeout(90000)
    const game = await launchWindowAttention(page, backend, binary, source(true)),
      target = game.surface('Begin move target'), canvas = target.locator('canvas[data-window-id]')
    try {
      await expect(target).toHaveClass(/game-window-embedded/)
      await canvas.scrollIntoViewIfNeeded()
      const originalCanvas = await box(canvas), first = await begin(page, target, 1, 0),
        original = first.initial
      await expect(target).not.toHaveClass(/game-window-embedded/)
      expect(Math.abs((await box(canvas)).width - originalCanvas.width)).toBeLessThan(1.5)
      expect(Math.abs((await box(canvas)).height - originalCanvas.height)).toBeLessThan(1.5)
      await page.mouse.move(first.x + 35, first.y + 25)
      await expect.poll(async () => Math.round((await box(target)).x - original.x)).toBe(35)
      await page.keyboard.press('Escape')
      await expect(page.getByText('begin-move:return:1:60,40', { exact: true })).toBeVisible()
      await page.mouse.up()
      await expect(target).toHaveClass(/game-window-embedded/)
      expect(Math.abs((await box(canvas)).width - originalCanvas.width)).toBeLessThan(1.5)
      await expect(page.locator('.game-window-flow-space')).toHaveCount(0)
      await noCompletionInput(page)

      const second = await begin(page, target, 2, 1), restored = second.initial
      await page.mouse.move(second.x + 55, second.y + 30, { steps: 4 })
      await page.mouse.up()
      await expect(page.getByText(/^begin-move:return:2:/)).toBeVisible()
      await expect(target).not.toHaveClass(/game-window-embedded|game-window-dragging/)
      await expect(page.locator('.game-window-flow-space')).toHaveCount(1)
      await expect.poll(async () => Math.round((await box(target)).x - restored.x)).toBe(55)
      await expect.poll(async () => Math.round((await box(target)).y - restored.y)).toBe(30)
      expect(Math.abs((await box(canvas)).width - originalCanvas.width)).toBeLessThan(1.5)
      const placement = await target.evaluate((element) => {
        const style = getComputedStyle(element)
        return `${Number.parseFloat(style.getPropertyValue('--game-window-left'))},${Number.parseFloat(style.getPropertyValue('--game-window-top'))}`
      })
      await evaluate(page, 'global.moveTarget.left+","+global.moveTarget.top', placement)
      await noCompletionInput(page)
      await info.attach('begin-move-sole-committed', { body: await page.screenshot(), contentType: 'image/png' })

      await begin(page, target, 3, 2)
      // Invoke the real App Stop handler without generating the pointerup that
      // would first commit the native-style move loop. This is an explicit DOM
      // control activation; all drag pointer/keyboard events above are real.
      await page.locator('#stop').evaluate((element) => (element as HTMLButtonElement).click())
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window')).toHaveCount(0)
      await expect(page.locator('.game-window-dragging')).toHaveCount(0)
      await expect(page.locator('.game-window-flow-space')).toHaveCount(0)
      await expect(page.getByText(/^begin-move:return:3:/)).toHaveCount(0)
      await page.mouse.up()
    } finally {
      await page.mouse.up()
      await game.stop()
    }
  })
}
