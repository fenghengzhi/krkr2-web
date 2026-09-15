import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var flow="select", trace=[], result=-1, secondResult=-1, selectedCount=0, timerCount=0;
function mark(value){trace.add(value);Debug.message("popup-proof:"+value);}
class PopupParent extends Window {
  function PopupParent(){super.Window();caption="Popup parent";setInnerSize(180,100);setPos(0,0);visible=true;}
  function onMouseDown(){
    global.mark("before");global.clock.enabled=true;
    global.result=global.tools.popup(0,20,20);
    global.mark("return:"+global.result);
    if(global.flow=="select"){
      global.secondResult=global.more.popup(tpmReturnCmd,20,20);
      global.mark("second-return:"+int(global.secondResult>0)+":"+int(global.secondResult!=global.other.__menuId));
    }
  }
}
class PopupChild extends Window {
  function PopupChild(){super.Window();caption="Popup child";setInnerSize(140,90);setPos(230,0);visible=false;}
  function onKeyDown(key,shift){if(key==65)global.mark("child-key:"+global.result);}
  function onCloseQuery(){global.mark("child-close");super.onCloseQuery(true);}
}
var parent=new PopupParent(),root=new Layer(parent,null);
root.type=ltOpaque;root.setSize(180,100);root.fillRect(0,0,180,100,0xff204060);
var child=new PopupChild(),childLayer=new Layer(child,null);
childLayer.type=ltOpaque;childLayer.setSize(140,90);childLayer.fillRect(0,0,140,90,0xff805020);
var tools=new MenuItem(parent,"First popup"),item=new MenuItem(parent,"Select first");
parent.menu.add(tools);tools.add(item);
item.onClick=function(){global.selectedCount++;global.mark("click:"+global.result+":"+global.secondResult);};
var more=new MenuItem(parent,"Second popup"),other=new MenuItem(parent,"Select second");
parent.menu.add(more);more.add(other);
other.onClick=function(){global.mark("unexpected-second-click");};
function tick(){
  clock.enabled=false;timerCount++;mark("timer:"+result);
  if(flow=="window"){
    mark("child-before");child.showModal();mark("child-return:"+result);
  }
}
var clock=new Timer(global,"tick");clock.interval=100;
mark("ready");
`

async function launch(page: Page, backend: string, binary: boolean, flow = 'select') {
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
          ? 'Scripts.compileStorage("popup-proof.tjs","savedata/popup-proof.cjs",false,true,false);Scripts.execStorage("savedata/popup-proof.cjs");'
          : 'Scripts.execStorage("popup-proof.tjs");',
      ),
    },
    {
      name: 'popup-proof.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + `\nflow="${flow}";`),
    },
  ])
  await expect(page.getByText('popup-proof:ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  const parent = page.locator('.game-window[aria-label="Popup parent"]'),
    child = page.locator('.game-window[aria-label="Popup child"]'),
    popup = page.locator('.game-menu-popup')
  await expect(parent).toBeVisible()
  await expect(child).toBeHidden()
  return {
    parent,
    child,
    popup,
    async open() {
      await parent.locator('canvas[data-window-id]').click({ position: { x: 90, y: 50 } })
      await expect(page.getByText('popup-proof:before', { exact: true })).toBeVisible()
      await expect(page.getByText('popup-proof:timer:-1', { exact: true })).toBeVisible()
    },
    async stop() {
      // The app's stop command must also work while the game owns a popup.
      await page.locator('#stop').dispatchEvent('click')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('.game-menu-overlay')).toHaveCount(0)
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
      expect(errors).toEqual([])
    },
  }
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    test(`${backend}/${binary ? 'bytecode' : 'source'}: popup pumps Timer and dispatches its selection after return inside the next popup`, async ({
      page,
    }) => {
      const game = await launch(page, backend, binary)
      try {
        await game.open()
        await expect(game.popup).toHaveAttribute('aria-label', 'First popup')
        await expect(page.getByText(/^popup-proof:return:/)).toHaveCount(0)
        await game.popup.getByRole('button', { name: 'Select first', exact: true }).click()
        await expect(page.getByText('popup-proof:return:1', { exact: true })).toBeVisible()
        await expect(game.popup).toHaveAttribute('aria-label', 'Second popup')
        // This is a callback in the busy VM; console evaluate would queue
        // behind the suspended original input and cannot prove this boundary.
        await expect(page.getByText('popup-proof:click:1:-1', { exact: true })).toBeVisible()
        await game.popup.getByRole('button', { name: 'Select second', exact: true }).click()
        await expect(game.popup).toHaveCount(0)
        await expect(page.getByText('popup-proof:second-return:1:1', { exact: true })).toBeVisible()
        await evaluate(
          page,
          'trace.join("|")+":"+selectedCount+":"+timerCount',
          'ready|before|timer:-1|return:1|click:1:-1|second-return:1:1:1:1',
        )
      } finally {
        await game.stop()
      }
    })

    test(`${backend}/${binary ? 'bytecode' : 'source'}: a Timer opens a Window above its popup without unwinding the child`, async ({
      page,
    }) => {
      const game = await launch(page, backend, binary, 'window')
      try {
        await game.open()
        await expect(game.child).toBeVisible()
        await expect(game.parent).toHaveAttribute('data-blocked', 'true')
        await expect(game.popup).toHaveCount(0)
        await expect(page.getByText(/^popup-proof:return:/)).toHaveCount(0)
        await game.child.locator('canvas[data-window-id]').focus()
        await page.keyboard.press('a')
        await expect(page.getByText('popup-proof:child-key:-1', { exact: true })).toBeVisible()
        await game.child.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
        await expect(game.child).toBeHidden()
        await expect(game.parent).toHaveAttribute('data-blocked', 'false')
        await expect(page.getByText('popup-proof:return:0', { exact: true })).toBeVisible()
        await evaluate(
          page,
          'trace.join("|")+":"+selectedCount',
          'ready|before|timer:-1|child-before|child-key:-1|child-close|child-return:-1|return:0:0',
        )
      } finally {
        await game.stop()
      }
    })
  }
  test(`${backend}: Stop releases a popup entered by a suspended input callback`, async ({
    page,
  }) => {
    const game = await launch(page, backend, false)
    await game.open()
    await expect(game.popup).toHaveAttribute('aria-label', 'First popup')
    await expect(page.getByText(/^popup-proof:return:/)).toHaveCount(0)
    await game.stop()
  })
}
