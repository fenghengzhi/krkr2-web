import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { observeWindowGeometry, readWindowGeometry, expectWindowedGeometry,
  expectGeometryRect, geometryPixel, clickViewport, finishGeometry, stopGeometryPage } from '../helpers/window-geometry-browser.ts'

const source = String.raw`
System.exitOnWindowClose=false;
class GeometryWindow extends Window {
  function GeometryWindow(){super.Window();caption="Five rectangles";setSize(640,340);visible=true;}
  function onMouseDown(x,y,button,shift){Debug.message("geometry-window="+x+","+y);}
}
class GeometryLayer extends Layer {
  function GeometryLayer(window){super.Layer(window,null);type=ltOpaque;focusable=true;setSize(640,480);}
  function onMouseDown(x,y,button,shift){focus();Debug.message("geometry-layer="+x+","+y);}
}
var geoWin=new GeometryWindow(),geoRoot=new GeometryLayer(geoWin);
function paintGeometry(w,h){
  geoRoot.setSize(w,h);geoRoot.fillRect(0,0,w,h,0xffc02030);
  geoRoot.fillRect(int(w/2),0,int(w/2),int(h/2),0xff20b050);
  geoRoot.fillRect(0,int(h/2),int(w/2),int(h/2),0xff3050d0);
  geoRoot.fillRect(int(w/2),int(h/2),int(w/2),int(h/2),0xffe0c030);
}
paintGeometry(640,480);
var geometryCaptions=["Geometry Alpha","Geometry Bravo","Geometry Charlie","Geometry Delta"];
for(var i=0;i<geometryCaptions.count;i++)geoWin.menu.add(new MenuItem(geoWin,geometryCaptions[i]));
var geometryEnter=new MenuItem(geoWin,"Enter geometry fullscreen");geoWin.menu.add(geometryEnter);
geometryEnter.onClick=function(){
  geoWin.fullScreen=true;
  Debug.message("geometry-fullscreen="+[geoWin.width,geoWin.height,geoWin.innerWidth,geoWin.innerHeight,
    geoWin.zoomNumer,geoWin.zoomDenom,int(geoWin.fullScreen)].join(","));
};
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const mode = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: real chrome, wrapping menus and scrollbars separate all five Window rectangles`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await observeWindowGeometry(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const surface = page.locator('.game-window[data-window-id][aria-label="Five rectangles"]'),
      failures: unknown[] = [], records: unknown[] = []
    let stop = () => stopGeometryPage(page)
    try {
      const game = await launchWindowAttention(page, backend, binary, source, [], true)
      stop = game.stop
      const wide = await readWindowGeometry(surface)
      records.push({ phase: 'wide-menu', ...wide })
      expectWindowedGeometry(wide, false)
      expect(wide.outer.width).toBe(640)
      expect(wide.outer.height).toBe(340)
      await evaluate(page, '[geoWin.width,geoWin.height,geoWin.innerWidth,geoWin.innerHeight].join(",")',
        [640, 340, wide.body.width, wide.body.height].join(','))
      // Page fitting scales the complete outer box; it is not a script resize
      // and must not independently shrink the header, menu or render viewport.
      await page.setViewportSize({ width: 600, height: 900 })
      await expect.poll(async () => (await readWindowGeometry(surface)).scaleX).toBeLessThan(1)
      const fitted = await readWindowGeometry(surface)
      records.push({ phase: 'responsive-whole-outer', ...fitted })
      expectWindowedGeometry(fitted, false)
      expectGeometryRect(fitted.outer, wide.outer)
      expectGeometryRect(fitted.canvas, wide.canvas)
      await evaluate(page, 'geoWin.width+","+geoWin.height', '640,340')
      await page.setViewportSize({ width: 1280, height: 900 })
      await evaluate(page, '(geoWin.setSize(240,340),geoWin.innerSunken=true,geoWin.width+","+geoWin.height)', '240,340')
      const narrow = await readWindowGeometry(surface)
      records.push({ phase: 'wrapped-sunken-menu', ...narrow })
      expectWindowedGeometry(narrow, true)
      expect(narrow.menuRows).toBeGreaterThan(wide.menuRows)
      expect(narrow.menuHeight).toBeGreaterThan(wide.menuHeight)
      await evaluate(page, 'geoWin.innerWidth+","+geoWin.innerHeight',
        [narrow.body.width - 4, narrow.body.height - 4].join(','))
      expectGeometryRect(narrow.geometry.paintBox,
        { x: narrow.canvas.x, y: narrow.canvas.y, width: 640, height: 480 })
      await expect.poll(() => geometryPixel(page, surface, 24, 24)).toEqual([192, 32, 48, 255])
      await surface.locator('.game-window-scrollbox').evaluate((node) => node.scrollTo(336, 256))
      await expect.poll(() => surface.locator('.game-window-scrollbox').evaluate((node) => [node.scrollLeft, node.scrollTop])).toEqual([336, 256])
      await expect.poll(() => geometryPixel(page, surface, 24, 24)).toEqual([224, 192, 48, 255])
      await clickViewport(page, surface, 24, 24)
      await expect(page.locator('#logs')).toContainText('geometry-window=360,280')
      await expect(page.locator('#logs')).toContainText('geometry-layer=360,280')
      // A new real measurement captures the committed scroll offset. LayerPos
      // is a PaintBox displacement, not an outer/client/viewport displacement.
      await evaluate(page, '(geoWin.setLayerPos(8,12),0)', '0')
      const scrolled = await readWindowGeometry(surface)
      records.push({ phase: 'scroll-and-layer-origin', ...scrolled })
      expectWindowedGeometry(scrolled, true)
      expect(scrolled.scroll.x).toBe(336); expect(scrolled.scroll.y).toBe(256)
      expect(scrolled.scrollEvents.some((event) => event.x === 336 && event.y === 256)).toBe(true)
      expectGeometryRect(scrolled.geometry.paintBox,
        { x: scrolled.canvas.x + 8 - 336, y: scrolled.canvas.y + 12 - 256, width: 640, height: 480 })
      await clickViewport(page, surface, 24, 24)
      await expect(page.locator('#logs')).toContainText('geometry-window=352,268')
      await expect(page.locator('#logs')).toContainText('geometry-layer=352,268')
      // Explicit inner setters use the pre-scrollbar inner area, including a
      // fresh menu wrap measurement; primary resizing resets real scroll.
      await evaluate(page, '(geoWin.setInnerSize(280,180),geoWin.innerWidth+","+geoWin.innerHeight)', '280,180')
      const inner = await readWindowGeometry(surface)
      records.push({ phase: 'inner-setter', ...inner })
      expectWindowedGeometry(inner, true)
      expect(inner.scrollbox.width).toBe(280); expect(inner.scrollbox.height).toBe(180)
      await evaluate(page, '(paintGeometry(160,120),geoWin.setLayerPos(0,0),0)', '0')
      await expect.poll(() => surface.locator('.game-window-scrollbox').evaluate((node) => [node.scrollLeft, node.scrollTop])).toEqual([0, 0])
      await expect.poll(() => geometryPixel(page, surface, 24, 24)).toEqual([192, 32, 48, 255])
      await info.attach('window-geometry-scrolled-surface', { body: await surface.screenshot(), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finishGeometry(page, info, stop, records, failures)
  })

  test(`${mode}: actual fullscreen zoom fits the real viewport while public zoom and windowed geometry restore`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 1280, height: 900 })
    await observeWindowGeometry(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const surface = page.locator('.game-window[data-window-id][aria-label="Five rectangles"]'),
      failures: unknown[] = [], records: unknown[] = []
    let stop = () => stopGeometryPage(page)
    try {
      const game = await launchWindowAttention(page, backend, binary, source, [], true)
      stop = game.stop
      await evaluate(page, '(paintGeometry(160,120),geoWin.innerSunken=true,geoWin.setInnerSize(160,120),geoWin.setZoom(3,2),geoWin.zoomNumer+","+geoWin.zoomDenom)', '3,2')
      const before = await readWindowGeometry(surface)
      records.push({ phase: 'before-fullscreen', ...before })
      expectWindowedGeometry(before, true)
      await surface.getByRole('button', { name: 'Enter geometry fullscreen', exact: true }).click()
      await expect(surface).toHaveClass(/game-window-fullscreen/)
      const full = await readWindowGeometry(surface)
      records.push({ phase: 'fullscreen', ...full })
      expectGeometryRect(full.geometry.outer, { x: 0, y: 0, width: 1280, height: 900 })
      expectGeometryRect(full.geometry.client, full.geometry.outer)
      expectGeometryRect(full.geometry.inner, full.geometry.outer)
      expectGeometryRect(full.body, full.geometry.outer)
      expectGeometryRect(full.canvas, { x: 40, y: 0, width: 1200, height: 900 })
      expectGeometryRect(full.geometry.viewport, full.canvas)
      expectGeometryRect(full.geometry.paintBox, { x: 40, y: 0, width: 1200, height: 900 })
      expect(full.geometry.actualZoom.numer / full.geometry.actualZoom.denom).toBe(7.5)
      expect(full.backing).toEqual({ width: 1200, height: 900 })
      await expect(page.locator('#logs')).toContainText('geometry-fullscreen=1280,900,1280,900,3,2,1')
      await expect.poll(() => geometryPixel(page, surface, 300, 600)).toEqual([48, 80, 208, 255])
      await clickViewport(page, surface, 300, 600)
      await expect(page.locator('#logs')).toContainText('geometry-window=300,600')
      await expect(page.locator('#logs')).toContainText('geometry-layer=40,80')
      await info.attach('window-geometry-fullscreen', { body: await page.screenshot(), contentType: 'image/png' })
      await surface.getByRole('button', { name: '退出全屏', exact: true }).click()
      await expect(surface).not.toHaveClass(/game-window-fullscreen/)
      const restored = await readWindowGeometry(surface)
      records.push({ phase: 'restored', ...restored })
      expectWindowedGeometry(restored, true)
      expectGeometryRect(restored.outer, before.outer)
      expectGeometryRect(restored.scrollbox, before.scrollbox)
      expect(restored.geometry.actualZoom.numer / restored.geometry.actualZoom.denom).toBe(1.5)
      await evaluate(page, 'geoWin.innerWidth+","+geoWin.innerHeight+","+geoWin.zoomNumer+","+geoWin.zoomDenom+","+int(geoWin.innerSunken)+","+int(geoWin.fullScreen)', '160,120,3,2,1,0')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finishGeometry(page, info, stop, records, failures)
  })
}
