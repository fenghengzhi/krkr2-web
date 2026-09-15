import { test, expect, type Locator, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const source = String.raw`
var modalParentInputs=0,modalParentKeys=0,modalReturned=0,modalQueries=0,modalKeys=0,modalTrace=[];
class ModalParent extends Window {
  function ModalParent(){
    super.Window();caption="Modal parent";setInnerSize(160,96);setPos(0,0);visible=true;
  }
  function onMouseDown(x,y,button,shift){
    global.modalParentInputs++;
    if(global.modalParentInputs==1){
      global.modalTrace.add("enter");Debug.message("modal-parent-enter");
      global.modalChild.showModal();
      global.modalReturned++;
      global.modalTrace.add("return");
      Debug.message("modal-parent-return:"+global.modalParentInputs+":"+global.modalQueries+":"+global.modalKeys);
    }else{
      global.modalTrace.add("reuse:"+global.modalParentInputs);
      Debug.message("modal-parent-reused:"+global.modalParentInputs+":"+global.modalParentKeys);
    }
  }
  function onKeyDown(key,shift){if(key==80)global.modalParentKeys++;}
}
class ModalChild extends Window {
  function ModalChild(){
    super.Window();caption="Modal child";setInnerSize(140,90);setPos(220,0);visible=false;
  }
  function onKeyDown(key,shift){
    if(key!=65)return;
    global.modalKeys++;
    global.modalTrace.add("key:"+global.modalKeys);
    Debug.message("modal-child-proof:"+global.modalKeys+":"+global.modalParentInputs+":"+global.modalParentKeys+":"+global.modalReturned+":"+global.modalQueries);
  }
  function onCloseQuery(){
    global.modalQueries++;
    var allow=global.modalQueries>=2;
    global.modalTrace.add("query:"+global.modalQueries+":"+int(allow));
    Debug.message("modal-close-query:"+global.modalQueries+":"+int(allow));
    super.onCloseQuery(allow);
  }
}
var modalParent=new ModalParent();
var modalParentLayer=new Layer(modalParent,null);
modalParentLayer.type=ltOpaque;modalParentLayer.setSize(160,96);modalParentLayer.fillRect(0,0,160,96,0xff305070);
var modalChild=new ModalChild();
var modalChildLayer=new Layer(modalChild,null);
modalChildLayer.type=ltOpaque;modalChildLayer.setSize(140,90);modalChildLayer.fillRect(0,0,140,90,0xff807030);
Debug.message("window-modal-ready");
`

async function launch(page: Page, backend: string, binary: boolean) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("browser-window-modal.tjs","savedata/browser-window-modal.cjs",false,true,false);Scripts.execStorage("savedata/browser-window-modal.cjs");'
          : 'Scripts.execStorage("browser-window-modal.tjs");',
      ),
    },
    {
      name: 'browser-window-modal.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source),
    },
  ])
  await expect(page.getByText('window-modal-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  const parent = page.locator('.game-window[data-window-id][aria-label="Modal parent"]'),
    child = page.locator('.game-window[data-window-id][aria-label="Modal child"]'),
    parentCanvas = parent.locator('canvas[data-window-id]'),
    childCanvas = child.locator('canvas[data-window-id]'),
    closeChild = child.getByRole('button', { name: '关闭游戏窗口', exact: true })
  await expect(parent).toBeVisible()
  await expect(child).toBeHidden()
  await expect(parentCanvas).toHaveJSProperty('width', 160)
  await expect(childCanvas).toHaveJSProperty('width', 140)
  await expect(page.locator('.game-text-input')).toHaveCount(2)
  const expectPending = async () => {
    await expect(child).toBeVisible()
    await expect(child).toHaveAttribute('data-blocked', 'false')
    await expect(parent).toHaveAttribute('data-blocked', 'true')
    await expect(parent).toHaveJSProperty('inert', true)
    await expect(parent).toHaveAttribute('aria-disabled', 'true')
    await expect(parent.locator('.game-window-close')).toBeDisabled()
    await expect(page.getByText(/^modal-parent-return:/)).toHaveCount(0)
  }
  return {
    errors,
    parent,
    child,
    parentCanvas,
    childCanvas,
    closeChild,
    expectPending,
    async open() {
      await parentCanvas.click({ position: { x: 80, y: 48 } })
      await expect(page.getByText('modal-parent-enter', { exact: true })).toBeVisible()
      await expectPending()
    },
    async stop() {
      await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
      await expect(page.locator('#logs')).not.toContainText('Session client is disposed')
      expect(errors).toEqual([])
    },
  }
}

async function clickBlockedCanvas(page: Page, canvas: Locator) {
  // An inert canvas correctly fails locator.click's actionability checks. Use
  // real pointer input at its current visible position to prove it is ignored.
  // In particular, canvas.focus alone does not scroll the page in WebKit.
  await canvas.scrollIntoViewIfNeeded()
  await expect(canvas).toBeInViewport({ ratio: 1 })
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2)
  await canvas.focus()
  await expect(canvas).not.toBeFocused()
  await page.keyboard.press('p')
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true])
    test(`${backend}/${binary ? 'bytecode' : 'source'}: showModal pumps child input and vetoed close queries while its caller remains blocked`, async ({
      page,
    }) => {
      const game = await launch(page, backend, binary)
      await game.open()
      await clickBlockedCanvas(page, game.parentCanvas)
      await game.childCanvas.focus()
      await page.keyboard.press('a')
      // The proof runs inside the same VM while the parent callback is still
      // suspended; a separate evaluate RPC would wait behind that callback.
      await expect(page.getByText('modal-child-proof:1:1:0:0:0', { exact: true })).toBeVisible()
      await game.closeChild.click()
      await expect(page.getByText('modal-close-query:1:0', { exact: true })).toBeVisible()
      await game.expectPending()

      await clickBlockedCanvas(page, game.parentCanvas)
      await game.childCanvas.focus()
      await page.keyboard.press('a')
      await expect(page.getByText('modal-child-proof:2:1:0:0:1', { exact: true })).toBeVisible()
      await game.closeChild.click()
      await expect(page.getByText('modal-close-query:2:1', { exact: true })).toBeVisible()
      await expect(page.getByText('modal-parent-return:1:2:2', { exact: true })).toBeVisible()
      await expect(game.child).toBeHidden()
      await expect(game.parent).toHaveAttribute('data-blocked', 'false')
      await expect(game.parent).toHaveJSProperty('inert', false)
      await expect(game.parent).toHaveAttribute('aria-disabled', 'false')
      await expect(game.parent.locator('.game-window-close')).toBeEnabled()
      await expect(game.parent).toHaveAttribute('data-active', 'true')
      await expect
        .poll(() => game.parent.evaluate((element) => element.contains(document.activeElement)))
        .toBe(true)
      await page.keyboard.press('p')
      await game.parentCanvas.click({ position: { x: 80, y: 48 } })
      await expect(page.getByText('modal-parent-reused:2:1', { exact: true })).toBeVisible()
      await evaluate(
        page,
        'global.modalTrace.join("|")+":"+global.modalReturned+":"+int(isvalid global.modalChild)+":"+int(global.modalChild.visible)',
        'enter|key:1|query:1:0|key:2|query:2:1|return|reuse:2:1:1:0',
      )
      expect(game.errors).toEqual([])
      await game.stop()
    })

  test(`${backend}: Stop cancels a waiting showModal and releases both Window surfaces`, async ({
    page,
  }) => {
    const game = await launch(page, backend, false)
    await game.open()
    await game.childCanvas.focus()
    await page.keyboard.press('a')
    await expect(page.getByText('modal-child-proof:1:1:0:0:0', { exact: true })).toBeVisible()
    await game.expectPending()
    await game.stop()
  })
}
