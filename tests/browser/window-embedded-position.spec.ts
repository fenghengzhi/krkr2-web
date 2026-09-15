import { test, expect, type Locator, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var clicks=[],menuCount=0,b=null,rootB=null,controlB=null;
class PositionWindow extends Window {
  function PositionWindow(tag,left,top){
    super.Window();caption="Position "+tag;setInnerSize(160,96);setPos(left,top);visible=true;
  }
}
class PositionControl extends Layer {
  var tag;
  function PositionControl(window,parent,tag){
    super.Layer(window,parent);this.tag=tag;setPos(8,4);setSize(32,24);
    fillRect(0,0,32,24,0xfff0d060);visible=true;
  }
  function onClick(x,y){
    global.clicks.add(tag+":"+x+","+y);
    Debug.message("position-click="+global.clicks.join("|"));
  }
}
var a=new PositionWindow("A",-320,-180);
var rootA=new Layer(a,null);rootA.type=ltOpaque;rootA.setSize(160,96);rootA.fillRect(0,0,160,96,0xff204060);
var controlA=new PositionControl(a,rootA,"A");
var tools=new MenuItem(a,"Position tools"),count=new MenuItem(a,"Count position");
a.menu.add(tools);tools.add(count);
count.onClick=function(){global.menuCount++;Debug.message("position-menu="+global.menuCount);};
var fullscreen=new MenuItem(a,"Position fullscreen");a.menu.add(fullscreen);
fullscreen.onClick=function(){global.a.fullScreen=true;};
function addSecondary(){
  global.b=new PositionWindow("B",240,40);
  global.rootB=new Layer(global.b,null);global.rootB.type=ltOpaque;
  global.rootB.setSize(160,96);global.rootB.fillRect(0,0,160,96,0xff604020);
  global.controlB=new PositionControl(global.b,global.rootB,"B");
  return global.b.left+","+global.b.top;
}
Debug.message("embedded-position-ready");
`

async function stagePosition(surface: Locator) {
  return surface.evaluate((element) => {
    const stage = element.closest<HTMLElement>('#stage')!,
      bounds = element.getBoundingClientRect(),
      parent = stage.getBoundingClientRect()
    // Account for scrolling without changing it. Comparing rendered geometry
    // catches a relative element that still inherits native left/top offsets.
    return {
      left: Math.round(bounds.left - parent.left + stage.scrollLeft - stage.clientLeft),
      top: Math.round(bounds.top - parent.top + stage.scrollTop - stage.clientTop),
    }
  })
}

async function clickControl(page: Page, surface: Locator, expected: string) {
  const canvas = surface.locator('canvas[data-window-id]')
  await canvas.scrollIntoViewIfNeeded()
  const bounds = await canvas.boundingBox()
  expect(bounds).not.toBeNull()
  // The backing size is 160×96. Legacy MouseEvent client coordinates can
  // quantize to integers, so select a representable viewport point inside the
  // intended logical pixel even when the canvas origin has a fractional part.
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
      x: offset(bounds!.x, bounds!.width, 160, 20.5),
      y: offset(bounds!.y, bounds!.height, 96, 15.5),
    },
  })
  await expect(page.getByText(`position-click=${expected}`, { exact: true })).toBeVisible()
}

async function selectMenu(page: Page, surface: Locator, count: number) {
  await surface.getByText('Position tools', { exact: true }).click()
  await surface.getByRole('button', { name: 'Count position', exact: true }).click()
  await expect(page.getByText(`position-menu=${count}`, { exact: true })).toBeVisible()
}

for (const backend of ['asyncify', 'jspi'])
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: an embedded Window keeps native positions without displacing input or menus, while floating windows use their positions`, async ({
      page,
    }) => {
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
              ? 'Scripts.compileStorage("embedded-position.tjs","savedata/embedded-position.cjs",false,true,false);Scripts.execStorage("savedata/embedded-position.cjs");'
              : 'Scripts.execStorage("embedded-position.tjs");',
          ),
        },
        { name: 'embedded-position.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
      ])
      const stage = page.locator('#stage'),
        a = page.locator('.game-window[data-window-id][aria-label="Position A"]'),
        b = page.locator('.game-window[data-window-id][aria-label="Position B"]')
      try {
        await expect(page.getByText('embedded-position-ready', { exact: true })).toBeVisible()
        await expect(page.locator('#evaluate')).toBeEnabled()
        await expect(a.locator('canvas')).toHaveJSProperty('width', 160)
        await expect(a.locator('canvas')).toHaveJSProperty('height', 96)
        await expect(a).toHaveClass(/game-window-embedded/)
        await expect.poll(() => stagePosition(a)).toEqual({ left: 0, top: 0 })
        await evaluate(page, 'a.left+","+a.top', '-320,-180')
        await clickControl(page, a, 'A:12,11')
        await selectMenu(page, a, 1)

        await evaluate(page, '(a.setPos(240,130),a.left+","+a.top)', '240,130')
        await expect.poll(() => stagePosition(a)).toEqual({ left: 0, top: 0 })
        await clickControl(page, a, 'A:12,11|A:12,11')

        await evaluate(page, '(a.setPos(-640,-360),a.left+","+a.top)', '-640,-360')
        await a.getByRole('button', { name: 'Position fullscreen', exact: true }).click()
        await expect(a).toHaveClass(/game-window-fullscreen/)
        await expect(stage).toHaveClass(/game-desktop-fullscreen/)
        await a.getByRole('button', { name: '退出全屏', exact: true }).click()
        await expect(a).not.toHaveClass(/game-window-fullscreen/)
        await expect(stage).not.toHaveClass(/game-desktop-fullscreen/)
        await expect.poll(() => stagePosition(a)).toEqual({ left: 0, top: 0 })
        await evaluate(page, 'a.left+","+a.top+","+int(a.fullScreen)', '-640,-360,0')
        await clickControl(page, a, 'A:12,11|A:12,11|A:12,11')
        await selectMenu(page, a, 2)

        // Create only one extra small surface within this same game fixture.
        // The primary must now honor its stored position as well as the second.
        await evaluate(page, '(a.setPos(20,24),addSecondary())', '240,40')
        await expect(b.locator('canvas')).toHaveJSProperty('width', 160)
        await expect(b.locator('canvas')).toHaveJSProperty('height', 96)
        await expect(a).not.toHaveClass(/game-window-embedded/)
        await expect(b).not.toHaveClass(/game-window-embedded/)
        await expect.poll(() => stagePosition(a)).toEqual({ left: 20, top: 24 })
        await expect.poll(() => stagePosition(b)).toEqual({ left: 240, top: 40 })
        await clickControl(page, b, 'A:12,11|A:12,11|A:12,11|B:12,11')
        await evaluate(page, '(b.setPos(260,52),b.left+","+b.top)', '260,52')
        await expect.poll(() => stagePosition(b)).toEqual({ left: 260, top: 52 })
        await expect.poll(() => stagePosition(a)).toEqual({ left: 20, top: 24 })

        await evaluate(page, '(b.close(),int(isvalid b)+","+a.left+","+a.top)', '0,20,24')
        await expect(b).toHaveCount(0)
        await expect(a).toHaveClass(/game-window-embedded/)
        await expect.poll(() => stagePosition(a)).toEqual({ left: 0, top: 0 })
        await clickControl(page, a, 'A:12,11|A:12,11|A:12,11|B:12,11|A:12,11')
        await selectMenu(page, a, 3)
      } finally {
        const leave = a.getByRole('button', { name: '退出全屏', exact: true })
        if (await leave.isVisible()) await leave.click()
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
        expect(errors).toEqual([])
      }
    })
  }
