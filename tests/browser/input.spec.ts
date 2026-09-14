import { test, expect, type Page } from '@playwright/test'
async function evaluate(page: Page, source: string, value: string) {
  await page.locator('#expression').fill(source)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs p span').last()).toHaveText(value)
}
const source = String.raw`
var window=new Window();window.setInnerSize(160,80);window.visible=true;
var root=new Layer(window,null);root.setSize(160,80);root.fillRect(0,0,160,80,0xff101010);
var text="",clicked="",keys="",touches=0,position="";
class Control extends Layer {
  function Control(name,x){super.Layer(global.window,root);this.name=name;left=x;visible=true;focusable=true;imeMode=imOpen;fillRect(0,0,32,32,0xffffffff);cursor=crHandPoint;hint="button "+name;}
  function onMouseDown(x,y,button,shift){focus();}
  function onMouseUp(x,y,button,shift){position=name+":"+x+","+y;}
  function onClick(x,y){clicked+=name;Debug.message("clicked="+clicked);}
  function onKeyDown(key,shift,process){keys+=key+":"+System.getKeyState(key)+",";if(key==88)Debug.message("key-state="+key+":"+System.getKeyState(key));super.onKeyDown(...);}
  function onKeyPress(key,process){text+=key;}
  function onTouchDown(x,y,cx,cy,id){touches++;}
}
var a=new Control("a",0),b=new Control("b",60);
Debug.message("input-ready");
`
for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: browser pointer capture, focus, keys and committed text reach TJS`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page
      .locator('#files')
      .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
    await expect(page.locator('#logs')).toContainText('input-ready')
    await expect(page.locator('#evaluate')).toBeEnabled()
    const canvas = page.locator('canvas'),
      bounds = (await canvas.boundingBox())!
    await page.mouse.move(
      bounds.x + (bounds.width * 10) / 160,
      bounds.y + (bounds.height * 10) / 80,
    )
    await expect(canvas).toHaveCSS('cursor', 'pointer')
    await expect(canvas).toHaveAttribute('title', 'button a')
    await page.mouse.down()
    await page.mouse.move(
      bounds.x + (bounds.width * 70) / 160,
      bounds.y + (bounds.height * 10) / 80,
    )
    await page.mouse.up()
    await evaluate(page, 'position.indexOf("a:")==0 && clicked==""', '1')
    await canvas.click({ position: { x: (bounds.width * 10) / 160, y: (bounds.height * 10) / 80 } })
    await expect(page.locator('#logs')).toContainText('clicked=a')
    await page.keyboard.press('Tab')
    await page.keyboard.type('Hi')
    await evaluate(page, 'window.focusedLayer===b && text=="Hi"', '1')
    await canvas.focus()
    await page.keyboard.down('Control')
    await page.keyboard.down('x')
    await expect(page.locator('#logs')).toContainText('key-state=88:1')
    await page.keyboard.up('x')
    await page.keyboard.up('Control')
    await evaluate(page, 'keys.indexOf("88:1")>=0 && !System.getKeyState(VK_CONTROL)', '1')
    await canvas.focus()
    await page.locator('.game-text-input').evaluate((element) => {
      const input = element as HTMLTextAreaElement
      input.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
      input.value = '中文'
      input.dispatchEvent(
        new InputEvent('input', {
          data: '中文',
          inputType: 'insertCompositionText',
          isComposing: true,
          bubbles: true,
        }),
      )
      input.dispatchEvent(new CompositionEvent('compositionend', { data: '中文', bubbles: true }))
      input.value = '中文'
      input.dispatchEvent(
        new InputEvent('input', {
          data: '中文',
          inputType: 'insertFromComposition',
          bubbles: true,
        }),
      )
    })
    await evaluate(page, 'text', 'Hi中文')
    await page.locator('#stop').click()
    await expect(page.locator('.game-text-input')).toHaveCount(0)
    expect(errors).toEqual([])
  })
test.describe('touch input', () => {
  test.use({ hasTouch: true })
  for (const backend of ['asyncify', 'jspi'])
    test(`${backend}: a touch tap reaches raw touch and legacy mouse handlers once`, async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`/?backend=${backend}`)
      test.skip(
        backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
        'JSPI unavailable',
      )
      await page
        .locator('#files')
        .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
      await expect(page.locator('#logs')).toContainText('input-ready')
      const bounds = (await page.locator('canvas').boundingBox())!
      await page.touchscreen.tap(
        bounds.x + (bounds.width * 10) / 160,
        bounds.y + (bounds.height * 10) / 80,
      )
      await expect(page.locator('#logs')).toContainText('clicked=a')
      await evaluate(page, 'touches==1 && clicked=="a" && window.focusedLayer===a', '1')
      await page.locator('#stop').click()
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      expect(errors).toEqual([])
    })
})
