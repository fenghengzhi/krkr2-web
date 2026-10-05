import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { stopGeometryPage } from '../helpers/window-geometry-browser.ts'

const source = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPInvalidMethodInFullScreen","window-method-live:%%:%1");
System.assignMessage("TVPInvalidPropertyInFullScreen","window-property-live:%%:%1");
var controls=new Window();controls.caption="Method controls";controls.setPos(10,10);controls.visible=true;
var controlsRoot=new Layer(controls,null);controls.add(controlsRoot);controlsRoot.setSize(180,96);
controlsRoot.fillRect(0,0,180,96,0xff315779);
var moveArmed=false,methodFailures="",methodPreserved=false;
class MethodTarget extends Window {
 function MethodTarget(){super.Window();caption="Method target";setPos(320,40);setInnerSize(160,96);visible=true;}
 function onMouseDown(x,y,button,shift){
  if(!global.moveArmed)return;
  global.moveArmed=false;Debug.message("window-method:move-before");
  beginMove();Debug.message("window-method:move-after:"+left+","+top);
 }
}
var target=new MethodTarget(),targetRoot=new Layer(target,null);target.add(targetRoot);
targetRoot.setSize(160,96);targetRoot.fillRect(0,0,160,96,0xffa75c31);
function fullscreenFailures(){
 var errors=[],before=[target.visible,target.width,target.height,target.left,target.top].join(",");
 try{target.beginMove();errors.add("NO_MOVE_ERROR");}catch(error){errors.add(error.message);}
 try{target.showModal();errors.add("NO_MODAL_ERROR");}catch(error){errors.add(error.message);}
 try{target.width=target.width+1;errors.add("NO_PROPERTY_ERROR");}catch(error){errors.add(error.message);}
 global.methodPreserved=before==[target.visible,target.width,target.height,target.left,target.top].join(",");
 global.methodFailures=errors.join("|");
 Debug.message("window-method:rejected:"+methodFailures+":"+int(methodPreserved));
}
var check=new MenuItem(controls,"Check fullscreen methods"),modal=new MenuItem(controls,"Open windowed modal");
controls.menu.add(check);controls.menu.add(modal);controls.setInnerSize(180,96);
check.onClick=function(){global.target.fullScreen=true;global.fullscreenFailures();};
modal.onClick=function(){global.target.visible=false;global.target.showModal();global.Debug.message("window-method:modal-after");};
function armMove(){target.visible=true;global.moveArmed=true;return target.left+","+target.top;}
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: actual fullscreen method errors precede host interactions and normal modal/move behavior recovers`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const failures: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      game = await launchWindowAttention(page, backend, binary, source, [], true)
      const controls = game.surface('Method controls'), target = game.surface('Method target')
      await controls.getByRole('button', { name: 'Check fullscreen methods', exact: true }).click()
      await expect(target).toHaveClass(/game-window-fullscreen/)
      await expect(page.getByText('window-method:rejected:window-method-live:%%:%1|window-method-live:%%:%1|window-property-live:%%:%1:1', { exact: true })).toBeAttached()
      await expect(target).toHaveAttribute('data-blocked', 'false')
      await expect(controls).toHaveAttribute('data-blocked', 'false')
      await expect(page.locator('.game-window-dragging')).toHaveCount(0)
      await expect(page.locator('#logs .error')).toHaveCount(0)
      await target.getByRole('button', { name: '退出全屏', exact: true }).click()
      await expect(target).not.toHaveClass(/game-window-fullscreen/)
      await evaluate(page, 'int(methodPreserved)+","+int(target.fullScreen)', '1,0')

      // The same live Window now enters the real modal path. Its native close
      // query and host close control unwind the suspended menu callback.
      await controls.getByRole('button', { name: 'Open windowed modal', exact: true }).click()
      await expect(target).toBeVisible()
      await expect(controls).toHaveAttribute('data-blocked', 'true')
      await expect(target).toHaveAttribute('data-blocked', 'false')
      await expect(page.getByText('window-method:modal-after', { exact: true })).toHaveCount(0)
      await target.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
      await expect(page.getByText('window-method:modal-after', { exact: true })).toHaveCount(1)
      await expect(target).not.toBeVisible()
      await expect(controls).toHaveAttribute('data-blocked', 'false')

      // A held, real pointer gesture reaches the ordinary beginMove request;
      // no synthetic reply or test-only move API is used by this browser case.
      await evaluate(page, 'armMove()', '320,40')
      const canvas = target.locator('canvas[data-window-id]')
      await expect(canvas).toHaveAttribute('width', '160')
      await expect(canvas).toHaveAttribute('height', '96')
      await canvas.scrollIntoViewIfNeeded()
      const before = await target.boundingBox(), rectangle = await canvas.boundingBox()
      expect(before).not.toBeNull(); expect(rectangle).not.toBeNull()
      const point = { x: rectangle!.x + 36, y: rectangle!.y + 32 }
      await page.mouse.move(point.x, point.y); await page.mouse.down()
      await expect(target).toHaveClass(/game-window-dragging/)
      await expect(page.getByText('window-method:move-before', { exact: true })).toHaveCount(1)
      await expect(page.getByText(/^window-method:move-after:/)).toHaveCount(0)
      await page.mouse.move(point.x + 30, point.y + 20, { steps: 4 })
      await expect.poll(async () => Math.round((await target.boundingBox())!.x - before!.x)).toBe(30)
      await expect.poll(async () => Math.round((await target.boundingBox())!.y - before!.y)).toBe(20)
      await page.mouse.up()
      await expect(page.getByText('window-method:move-after:350,60', { exact: true })).toHaveCount(1)
      await expect(target).not.toHaveClass(/game-window-dragging/)
      await evaluate(page, 'target.left+","+target.top+","+int(target.fullScreen)', '350,60,0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('fullscreen-methods-and-recovery', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }) }
    catch (error) { failures.push(error) }
    try { await page.mouse.up() } catch (error) { failures.push(error) }
    try {
      const exit = page.getByRole('button', { name: '退出全屏', exact: true })
      if (await exit.count()) await exit.first().click()
    } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop(); else await stopGeometryPage(page)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Window method messages or cleanup failed', { cause: failures[0] })
  })
}
