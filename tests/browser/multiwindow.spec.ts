import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const source = String.raw`
var allowA=true,allowB=true,queryTrace="",activationTrace="";
var windowClicks=[],layerClicks=[],windowKeys=[],layerKeys=[],windowText=[],releasedX=0;
class SurfaceWindow extends Window {
  var tag,color;
  function SurfaceWindow(tag,width,height,left,top,color){
    super.Window();this.tag=tag;this.color=color;caption="Surface "+tag;
    setInnerSize(width,height);setPos(left,top);visible=true;
  }
  function onResize(){
    var root=primaryLayer;
    if(root!==null){root.setSize(innerWidth,innerHeight);root.fillRect(0,0,innerWidth,innerHeight,color);}
    Debug.message("surface-resize-"+tag+"="+innerWidth+","+innerHeight);
  }
  function onCloseQuery(){
    var allow=tag=="A"?global.allowA:global.allowB;
    global.queryTrace+=tag+":"+int(allow)+"|";
    Debug.message("surface-close-query="+global.queryTrace);
    super.onCloseQuery(allow);
  }
  function onActivate(){global.activationTrace+=tag+"+|";}
  function onDeactivate(){global.activationTrace+=tag+"-|";}
  function onClick(x,y){global.windowClicks.add(tag+":"+x+","+y);}
  function onKeyDown(key,shift){
    if(key>=65 && key<=90)global.windowKeys.add(tag+":"+key);
    if(key==119)global.activationTrace="";
    if(key==88)Debug.message("surface-physical-x="+tag+":"+int(System.getKeyState(88)));
  }
  function onKeyUp(key,shift){
    if(key==119)Debug.message("surface-activation-reset");
    if(key==120)Debug.message("surface-activation-proof="+global.activationTrace);
    if(key==88)global.releasedX++;
  }
  function onKeyPress(key){global.windowText.add(tag+":"+key);}
}
class SurfaceControl extends Layer {
  var tag;
  function SurfaceControl(window,parent,tag,left,top){
    super.Layer(window,parent);this.tag=tag;setPos(left,top);setSize(32,24);
    fillRect(0,0,32,24,0xfff0e080);focusable=true;visible=true;imeMode=imOpen;
  }
  function onMouseDown(x,y,button,shift){focus();}
  function onClick(x,y){
    global.layerClicks.add(tag+":"+x+","+y);
    Debug.message("surface-layer-click="+global.layerClicks.join("|"));
  }
  function onKeyDown(key,shift,process){
    if(key>=65 && key<=90)global.layerKeys.add(tag+":"+key);
  }
}
var a=new SurfaceWindow("A",160,96,0,0,0xffcc2030);
var rootA=new Layer(a,null);rootA.type=ltOpaque;rootA.setSize(160,96);rootA.fillRect(0,0,160,96,a.color);
var controlA=new SurfaceControl(a,rootA,"A",8,4);
var b=new SurfaceWindow("B",120,80,220,0,0xff2040cc);
var rootB=new Layer(b,null);rootB.type=ltOpaque;rootB.setSize(120,80);rootB.fillRect(0,0,120,80,b.color);
var controlB=new SurfaceControl(b,rootB,"B",10,6);
function repaintB(){
  b.color=0xff20cc40;b.caption="Surface B updated";b.setInnerSize(144,88);
  rootB.setSize(144,88);rootB.fillRect(0,0,144,88,b.color);return 0;
}
function closeSecondary(){b.close();return int(isvalid b);}
function showSecondary(){b.visible=true;b.bringToFront();return int(isvalid b);}
function replaceRetiredMain(){
  var c=new SurfaceWindow("C",100,72,0,0,0xff8020cc);
  var root=new Layer(c,null);root.type=ltOpaque;root.setSize(100,72);root.fillRect(0,0,100,72,0xff8020cc);
  global.c=c;global.rootC=root;return int(global.Window.mainWindow===null);
}
Debug.message("multiwindow-surfaces-ready");
`

async function launch(page: Page, backend: string, binary: boolean, exitOnClose?: boolean) {
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
          ? 'Scripts.compileStorage("browser-multiwindow.tjs","savedata/browser-multiwindow.cjs",false,true,false);Scripts.execStorage("savedata/browser-multiwindow.cjs");'
          : 'Scripts.execStorage("browser-multiwindow.tjs");',
      ),
    },
    {
      name: 'browser-multiwindow.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        (exitOnClose === undefined ? '' : `System.exitOnWindowClose=${exitOnClose};\n`) + source,
      ),
    },
  ])
  await expect(page.getByText('multiwindow-surfaces-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  const a = page.locator('.game-window[data-window-id][aria-label="Surface A"]'),
    initialB = page.locator('.game-window[data-window-id][aria-label="Surface B"]')
  await expect(a).toBeVisible()
  await expect(initialB).toBeVisible()
  const aId = await a.getAttribute('data-window-id'),
    bId = await initialB.getAttribute('data-window-id')
  expect(aId).toMatch(/^[1-9]\d*$/)
  expect(bId).toMatch(/^[1-9]\d*$/)
  expect(aId).not.toBe(bId)
  // Stable IDs continue to locate the same surface after caption changes.
  const b = page.locator(`.game-window[data-window-id="${bId}"]`),
    canvasA = a.locator('canvas[data-window-id]'),
    canvasB = b.locator('canvas[data-window-id]')
  await expect(canvasA).toHaveAttribute('data-window-id', aId!)
  await expect(canvasB).toHaveAttribute('data-window-id', bId!)
  await expect(canvasA).toHaveJSProperty('width', 160)
  await expect(canvasA).toHaveJSProperty('height', 96)
  await expect(canvasB).toHaveJSProperty('width', 120)
  await expect(canvasB).toHaveJSProperty('height', 80)
  await expect(page.locator('.game-text-input')).toHaveCount(2)
  const assertStopped = async () => {
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
    await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    await expect(page.locator('.game-text-input')).toHaveCount(0)
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    await expect(page.locator('#logs')).not.toContainText('Session client is disposed')
    expect(errors).toEqual([])
  }
  return {
    a,
    b,
    canvasA,
    canvasB,
    aId,
    bId,
    assertStopped,
    async stop() {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await assertStopped()
    },
  }
}

/** Read a screenshot of the presented surface, never a second rendering context
 * on the transferred game canvas. Pure-color interiors avoid CSS edge rounding. */
async function samples(page: Page, canvas: Locator): Promise<number[][]> {
  const png = await canvas.screenshot()
  return page.evaluate(
    async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const values = [0.55, 0.75, 0.9].map((x) => [
        ...context.getImageData(Math.floor(bitmap.width * x), Math.floor(bitmap.height * 0.7), 1, 1)
          .data,
      ])
      bitmap.close()
      return values
    },
    'data:image/png;base64,' + png.toString('base64'),
  )
}

async function color(page: Page, canvas: Locator, rgba: number[]) {
  await expect.poll(() => samples(page, canvas)).toEqual([rgba, rgba, rgba])
}

async function capture(testInfo: TestInfo, label: string, canvas: Locator) {
  await testInfo.attach(label, { body: await canvas.screenshot(), contentType: 'image/png' })
}

async function clickLogical(canvas: Locator, x: number, y: number) {
  await canvas.scrollIntoViewIfNeeded()
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  const size = await canvas.evaluate((element) => {
    const canvas = element as HTMLCanvasElement
    return { width: canvas.width, height: canvas.height }
  })
  // Legacy MouseEvent client coordinates can quantize to integer viewport
  // pixels. A fractional canvas top made logical y=15.5 arrive as y=14.8125
  // in hosted Chromium. Choose an integer viewport point inside the intended
  // logical pixel instead of accepting a neighboring pixel in the oracle.
  const offset = (origin: number, extent: number, logicalSize: number, value: number) => {
    const scale = extent / logicalSize,
      first = Math.ceil(origin + Math.floor(value) * scale),
      last = Math.ceil(origin + (Math.floor(value) + 1) * scale) - 1
    expect(
      last,
      'the target logical pixel has a representable viewport point',
    ).toBeGreaterThanOrEqual(first)
    return Math.max(first, Math.min(last, Math.round(origin + value * scale))) - origin
  }
  await canvas.click({
    position: {
      x: offset(bounds!.x, bounds!.width, size.width, x),
      y: offset(bounds!.y, bounds!.height, size.height, y),
    },
  })
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: two Window primary layers present independent pixels, captions and backing sizes`, async ({
      page,
    }, testInfo) => {
      const { a, b, canvasA, canvasB, stop } = await launch(page, backend, binary, false)
      try {
        await evaluate(
          page,
          '(a.primaryLayer===rootA)+","+(b.primaryLayer===rootB)+","+(rootA!==rootB)+","+(global.Window.mainWindow===a)',
          '1,1,1,1',
        )
        await expect(a.locator('.game-window-title')).toHaveText('Surface A')
        await expect(b.locator('.game-window-title')).toHaveText('Surface B')
        await color(page, canvasA, [204, 32, 48, 255])
        await color(page, canvasB, [32, 64, 204, 255])
        await capture(testInfo, 'independent-window-A-red', canvasA)
        await capture(testInfo, 'independent-window-B-blue', canvasB)
        await evaluate(page, 'repaintB()', '0')
        await expect(b).toHaveAttribute('aria-label', 'Surface B updated')
        await expect(b.locator('.game-window-title')).toHaveText('Surface B updated')
        await expect(canvasB).toHaveJSProperty('width', 144)
        await expect(canvasB).toHaveJSProperty('height', 88)
        await expect(canvasA).toHaveJSProperty('width', 160)
        await expect(canvasA).toHaveJSProperty('height', 96)
        await expect(a.locator('.game-window-title')).toHaveText('Surface A')
        await color(page, canvasB, [32, 204, 64, 255])
        await color(page, canvasA, [204, 32, 48, 255])
        await capture(testInfo, 'independent-window-B-repainted-green', canvasB)
      } finally {
        await stop()
      }
    })

    test(`${mode}: real canvas and title input stays with its Window and leaving the game releases physical keys`, async ({
      page,
    }) => {
      const { a, b, canvasA, canvasB, stop } = await launch(page, backend, binary, false)
      try {
        await clickLogical(canvasB, 20.5, 15.5)
        await expect(page.getByText('surface-layer-click=B:10,9', { exact: true })).toBeVisible()
        await clickLogical(canvasA, 20.5, 15.5)
        await expect(
          page.getByText('surface-layer-click=B:10,9|A:12,11', { exact: true }),
        ).toBeVisible()
        // Reset inside a real key callback. Console focus would insert its own
        // deactivate into the activation order being checked here.
        await page.keyboard.press('F8')
        await expect(page.getByText('surface-activation-reset', { exact: true })).toBeVisible()
        await b.locator('.game-window-title').click()
        await expect(b).toHaveAttribute('data-active', 'true')
        await expect(a).toHaveAttribute('data-active', 'false')
        await b.locator('.game-window-title').click()
        await page.keyboard.press('b')
        await page.keyboard.press('F9')
        await expect(
          page.getByText('surface-activation-proof=A-|B+|', { exact: true }),
        ).toBeVisible()
        await a.locator('.game-window-title').click()
        await expect(a).toHaveAttribute('data-active', 'true')
        await page.keyboard.press('a')
        await page.keyboard.down('x')
        await expect(page.getByText('surface-physical-x=A:1', { exact: true })).toBeVisible()
        // The browser-level release clears System.getKeyState even though the
        // old game textarea no longer receives the keyUp script callback.
        await page.locator('#expression').focus()
        await expect(page.locator('#expression')).toBeFocused()
        await evaluate(page, 'int(System.getKeyState(88))', '1')
        await page.keyboard.up('x')
        await evaluate(page, 'int(System.getKeyState(88))+","+releasedX', '0,0')
        await evaluate(
          page,
          'windowKeys.join("|")+";"+layerKeys.join("|")',
          'B:66|A:65|A:88;B:66|A:65|A:88',
        )
        await evaluate(
          page,
          'windowClicks.join("|")+";"+layerClicks.join("|")+";"+(a.focusedLayer===controlA)+","+(b.focusedLayer===controlB)',
          'B:20,15|A:20,15;B:10,9|A:12,11;1,1',
        )
        await evaluate(
          page,
          '(a.setZoom(2,1),a.setLayerPos(3,4),b.setZoom(3,2),b.setLayerPos(5,7),0)',
          '0',
        )
        await clickLogical(canvasA, 27.5, 19.5)
        await expect(
          page.getByText('surface-layer-click=B:10,9|A:12,11|A:4,3', { exact: true }),
        ).toBeVisible()
        await clickLogical(canvasB, 37.5, 27.5)
        await expect(
          page.getByText('surface-layer-click=B:10,9|A:12,11|A:4,3|B:11,7', { exact: true }),
        ).toBeVisible()
        await expect(b).toHaveAttribute('data-active', 'true')
        await expect(a).toHaveAttribute('data-active', 'false')
        // B's later physical position and distinct zoom/offset must not replace
        // A's last observed position when reading either primary or child Layer.
        await evaluate(
          page,
          'rootA.cursorX+","+rootA.cursorY+";"+controlA.cursorX+","+controlA.cursorY+";"+rootB.cursorX+","+rootB.cursorY+";"+controlB.cursorX+","+controlB.cursorY',
          '12,7;4,3;21,13;11,7',
        )
      } finally {
        await stop()
      }
    })

    test(`${mode}: dragging and resizing one Window preserves the other and hidden surfaces can resume input`, async ({
      page,
    }) => {
      const { a, b, canvasA, canvasB, stop } = await launch(page, backend, binary, false)
      try {
        const aEpoch = await a.getAttribute('data-surface-epoch'),
          bEpoch = await b.getAttribute('data-surface-epoch')
        await evaluate(page, '(b.setMinSize(100,60),b.setMaxSize(200,150),0)', '0')
        const grip = b.locator('.game-window-resize')
        await expect(grip).toBeVisible()
        await grip.scrollIntoViewIfNeeded()
        const gripBox = await grip.boundingBox(),
          canvasBox = await canvasB.boundingBox()
        expect(gripBox).not.toBeNull()
        expect(canvasBox).not.toBeNull()
        const x = gripBox!.x + gripBox!.width / 2,
          y = gripBox!.y + gripBox!.height / 2,
          width = Math.round(120 + (24 * 120) / canvasBox!.width),
          height = Math.round(80 + (16 * 80) / canvasBox!.height)
        await page.mouse.move(x, y)
        await page.mouse.down()
        // Moving focus between controls in this Window must not be mistaken
        // for the browser page losing focus while its resize grip owns capture.
        await b.locator('.game-window-close').focus()
        await expect(b).toHaveClass(/game-window-dragging/)
        await page.mouse.move(x + 24, y + 16, { steps: 3 })
        await page.mouse.up()
        await expect(b).not.toHaveClass(/game-window-dragging/)
        await expect(canvasB).toHaveJSProperty('width', width)
        await expect(canvasB).toHaveJSProperty('height', height)
        await expect(
          page.getByText(`surface-resize-B=${width},${height}`, { exact: true }),
        ).toBeVisible()
        await a.locator('.game-window-title').scrollIntoViewIfNeeded()
        const title = await a.locator('.game-window-title').boundingBox()
        expect(title).not.toBeNull()
        const titleX = title!.x + 12,
          titleY = title!.y + title!.height / 2
        await page.mouse.move(titleX, titleY)
        await page.mouse.down()
        await page.mouse.move(titleX + 16, titleY + 22, { steps: 3 })
        await page.mouse.up()
        await expect(a).not.toHaveClass(/game-window-dragging/)
        await evaluate(
          page,
          'a.left+","+a.top+","+a.innerWidth+","+a.innerHeight+";"+b.left+","+b.top+","+b.innerWidth+","+b.innerHeight',
          `16,22,160,96;220,0,${width},${height}`,
        )
        await expect(canvasA).toHaveJSProperty('width', 160)
        await expect(canvasA).toHaveJSProperty('height', 96)
        await evaluate(page, '(a.visible=false,0)', '0')
        await expect(a).toBeHidden()
        await expect(a).toHaveCount(1)
        await clickLogical(canvasB, 20.5, 15.5)
        await expect(page.getByText('surface-layer-click=B:10,9', { exact: true })).toBeVisible()
        await evaluate(page, '(a.visible=true,a.bringToFront(),0)', '0')
        await expect(a).toBeVisible()
        await expect(a).toHaveAttribute('data-active', 'true')
        await expect(a).toHaveAttribute('data-surface-epoch', aEpoch!)
        await expect(b).toHaveAttribute('data-surface-epoch', bEpoch!)
        await clickLogical(canvasA, 20.5, 15.5)
        await expect(
          page.getByText('surface-layer-click=B:10,9|A:12,11', { exact: true }),
        ).toBeVisible()
        await color(page, canvasA, [204, 32, 48, 255])
        await color(page, canvasB, [32, 64, 204, 255])
      } finally {
        await stop()
      }
    })

    test(`${mode}: a secondary user close queries once and hides, while script close retires its surface`, async ({
      page,
    }) => {
      const { a, b, canvasA, canvasB, bId, stop } = await launch(page, backend, binary, false)
      try {
        const bEpoch = await b.getAttribute('data-surface-epoch'),
          oldClose = await b.locator('.game-window-close').elementHandle()
        expect(oldClose).not.toBeNull()
        await evaluate(page, '(allowB=false,0)', '0')
        await b.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
        await expect(page.getByText('surface-close-query=B:0|', { exact: true })).toBeVisible()
        await expect(b).toBeVisible()
        await evaluate(page, '(isvalid b)+","+b.visible+","+queryTrace', '1,1,B:0|')
        await evaluate(page, '(allowB=true,0)', '0')
        await b.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
        await expect(b).toBeHidden()
        await expect(b).toHaveCount(1)
        await evaluate(page, '(isvalid b)+","+b.visible+","+queryTrace', '1,0,B:0|B:1|')
        await clickLogical(canvasA, 20.5, 15.5)
        await expect(page.getByText('surface-layer-click=A:12,11', { exact: true })).toBeVisible()
        await evaluate(page, 'showSecondary()', '1')
        await expect(b).toBeVisible()
        await expect(b).toHaveAttribute('data-window-id', bId!)
        await expect(b).toHaveAttribute('data-surface-epoch', bEpoch!)
        await clickLogical(canvasB, 20.5, 15.5)
        await expect(
          page.getByText('surface-layer-click=A:12,11|B:10,9', { exact: true }),
        ).toBeVisible()
        await evaluate(page, 'closeSecondary()', '0')
        await expect(b).toHaveCount(0)
        await expect(page.locator('.game-text-input')).toHaveCount(1)
        expect(await oldClose!.evaluate((node) => node.isConnected)).toBe(false)
        await oldClose!.evaluate((node) =>
          node.dispatchEvent(new MouseEvent('click', { bubbles: true })),
        )
        await evaluate(
          page,
          'queryTrace+";"+(isvalid a)+","+(global.Window.mainWindow===a)',
          'B:0|B:1|B:1|;1,1',
        )
        await expect(a).toBeVisible()
        await color(page, canvasA, [204, 32, 48, 255])
      } finally {
        await stop()
      }
    })

    test(`${mode}: the default main-window user close honors a rejected query then stops every surface`, async ({
      page,
    }) => {
      // Omit any assignment: this case proves the native default is true.
      const { a, b, canvasB, assertStopped, stop } = await launch(page, backend, binary)
      try {
        await evaluate(page, 'int(System.exitOnWindowClose)', '1')
        await evaluate(page, '(allowA=false,0)', '0')
        await a.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
        await expect(page.getByText('surface-close-query=A:0|', { exact: true })).toBeVisible()
        await expect(a).toBeVisible()
        await expect(b).toBeVisible()
        await clickLogical(canvasB, 20.5, 15.5)
        await expect(page.getByText('surface-layer-click=B:10,9', { exact: true })).toBeVisible()
        await evaluate(page, '(allowA=true,0)', '0')
        await a.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
        await expect(page.getByText('surface-close-query=A:0|A:1|', { exact: true })).toBeVisible()
        await assertStopped()
      } finally {
        await stop()
      }
    })

    test(`${mode}: disabling main-close exit preserves another Window and retired DOM cannot target its replacement`, async ({
      page,
    }, testInfo) => {
      const { a, b, canvasA, canvasB, aId, stop } = await launch(page, backend, binary, false)
      try {
        const oldCanvas = await canvasA.elementHandle(),
          oldInput = await a.locator('.game-text-input').elementHandle(),
          oldClose = await a.locator('.game-window-close').elementHandle()
        expect(oldCanvas).not.toBeNull()
        expect(oldInput).not.toBeNull()
        expect(oldClose).not.toBeNull()
        await a.getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
        await expect(a).toHaveCount(0)
        await expect(b).toBeVisible()
        await expect(page.locator('.game-text-input')).toHaveCount(1)
        await evaluate(
          page,
          '(isvalid a)+","+(isvalid b)+","+(global.Window.mainWindow===null)+","+int(System.exitOnWindowClose)',
          '0,1,1,0',
        )
        await evaluate(page, 'replaceRetiredMain()', '1')
        const c = page.locator('.game-window[data-window-id][aria-label="Surface C"]'),
          canvasC = c.locator('canvas[data-window-id]')
        await expect(c).toBeVisible()
        await expect(c).toHaveAttribute('data-active', 'true')
        expect(await c.getAttribute('data-window-id')).not.toBe(aId)
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(2)
        await color(page, canvasC, [128, 32, 204, 255])
        for (const old of [oldCanvas!, oldInput!, oldClose!])
          expect(await old.evaluate((node) => node.isConnected)).toBe(false)
        await oldCanvas!.evaluate((node) => {
          node.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, buttons: 1 }))
          node.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
          node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z', keyCode: 90 }))
        })
        await oldInput!.evaluate((node) => {
          node.dispatchEvent(new FocusEvent('focus'))
          node.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'z', keyCode: 90 }))
          ;(node as HTMLTextAreaElement).value = 'z'
          node.dispatchEvent(
            new InputEvent('input', { bubbles: true, inputType: 'insertText', data: 'z' }),
          )
        })
        await oldClose!.evaluate((node) =>
          node.dispatchEvent(new MouseEvent('click', { bubbles: true })),
        )
        // A real callback on B is the positive queue barrier after stale events.
        // No old event may be rerouted to B, C, or a new surface for A.
        await clickLogical(canvasB, 20.5, 15.5)
        await expect(page.getByText('surface-layer-click=B:10,9', { exact: true })).toBeVisible()
        await evaluate(
          page,
          'windowClicks.join("|")+";"+layerClicks.join("|")+";"+windowKeys.count+","+layerKeys.count+","+windowText.count+","+int(System.getKeyState(90))+";"+queryTrace+";"+(isvalid c)',
          'B:20,15;B:10,9;0,0,0,0;A:1|;1',
        )
        await evaluate(page, 'repaintB()', '0')
        await color(page, canvasB, [32, 204, 64, 255])
        await color(page, canvasC, [128, 32, 204, 255])
        await expect(page.locator(`.game-window[data-window-id="${aId}"]`)).toHaveCount(0)
        await expect(page.locator('.game-text-input')).toHaveCount(2)
        await capture(testInfo, 'surviving-window-B-after-main-retired', canvasB)
        await capture(testInfo, 'new-window-C-without-main-promotion', canvasC)
      } finally {
        await stop()
      }
    })
  }
}
