import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { kagGameControls, kagGameLinkPoint } from '../helpers/kag-game-controls.ts'
import { originalIntroduction } from '../helpers/kag-intro-package.ts'
import { kagIntroStateExpression } from '../helpers/kag-intro-observation.ts'
const source = String.raw`
var window=new Window();window.setInnerSize(160,80);window.visible=true;
var root=new Layer(window,null);root.setSize(160,80);root.fillRect(0,0,160,80,0xff101010);
var text="",clicked="",keys="",touches=0,position="",hovered="",downTargets="";
class Control extends Layer {
  function Control(name,x){super.Layer(global.window,root);this.name=name;left=x;visible=true;focusable=true;imeMode=imOpen;fillRect(0,0,32,32,0xffffffff);cursor=crHandPoint;hint="button "+name;}
  function onMouseMove(x,y,shift){if(!(shift & ssLeft))hovered=name;}
  function onMouseDown(x,y,button,shift){downTargets+=hovered+"/"+name+",";focus();}
  function onMouseUp(x,y,button,shift){position=name+":"+x+","+y;}
  function onClick(x,y){clicked+=name;Debug.message("clicked="+clicked);}
  function onKeyDown(key,shift,process){keys+=key+":"+System.getKeyState(key)+",";if(key==88)Debug.message("key-state="+key+":"+System.getKeyState(key));super.onKeyDown(...);}
  function onKeyPress(key,process){text+=key;Debug.message("input-text:"+text+":layer="+name);}
  function onFocus(){Debug.message("input-focus:"+name);}
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
    // Keep Tab and typing adjacent. Only after all real key events have been
    // generated do we await their TJS receipt, before moving to the console.
    // Separate focus/text logs retain component evidence if delivery fails.
    await expect(page.getByText('input-text:Hi:layer=b', { exact: true })).toBeVisible()
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
    test(`${backend}: tapping two controls updates hover before each press and clicks each once`, async ({
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
      await page.touchscreen.tap(
        bounds.x + (bounds.width * 70) / 160,
        bounds.y + (bounds.height * 10) / 80,
      )
      await expect(page.locator('#logs')).toContainText('clicked=ab')
      await evaluate(page, '[touches,clicked,downTargets,int(window.focusedLayer===b)].join("|")', '2|ab|a/a,b/b,|1')
      await page.locator('#stop').click()
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      expect(errors).toEqual([])
    })
  for (const backend of ['asyncify', 'jspi'])
    test(`${backend}: a single touch on the original Introduction menu opens the selected chapter`, async ({ page }, info) => {
      test.setTimeout(90000)
      const observations: unknown[] = [], { read } = kagGameControls(page, observations, { firstReadTimeout: 30000 }),
        canvas = page.locator('#stage canvas[data-window-id]'), failures: unknown[] = []
      await page.goto(`/?backend=${backend}`)
      test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
      try {
        await page.locator('#files').setInputFiles({
          name: 'kag3_intro.xp3', mimeType: 'application/octet-stream', buffer: await originalIntroduction(),
        })
        await expect(page.locator('#evaluate')).toBeEnabled({ timeout: 30000 })
        const fullscreen = page.locator('.leave-fullscreen')
        if (await fullscreen.isVisible()) await fullscreen.press('Enter')
        await expect(page.locator('#stage')).not.toHaveClass(/window-fullscreen/)
        await expect.poll(async () => {
          const state = (await read(kagIntroStateExpression)).split('|')
          return [state[0], state[6], state[7]]
        }, { timeout: 30000 }).toEqual(['*syokai_start', '0', '3'])
        const point = await kagGameLinkPoint(read, 0, '*about_kirikiri')
        await canvas.scrollIntoViewIfNeeded()
        const box = await canvas.boundingBox()
        if (!box) throw new Error('Introduction menu is outside the page')
        observations.push({ tap: point, box })
        await page.touchscreen.tap(box.x + point.x * box.width / point.primaryWidth,
          box.y + point.y * box.height / point.primaryHeight)
        await expect.poll(async () => {
          const state = (await read(kagIntroStateExpression)).split('|')
          return [state[0], state[1], state[2], state[8], state[10]]
        }, { timeout: 15000 }).toEqual(['*about_kirikiri', '1', '1', '_24_4', 'l'])
        await expect(page.locator('#logs .error')).toHaveCount(0)
      } catch (error) { failures.push(error) }
      try {
        await info.attach('original-touch-selection', {
          body: JSON.stringify({ observations, logs: await page.locator('#logs').innerText() }), contentType: 'application/json',
        })
      } catch (error) { failures.push(error) }
      try {
        if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
        await expect(canvas).toHaveCount(0)
      } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Introduction touch selection or cleanup failed', { cause: failures[0] })
    })
})
