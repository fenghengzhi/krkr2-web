import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { clickViewport, expectGeometryRect, finishGeometry, geometryPixel, observeWindowGeometry,
  readWindowGeometry, stopGeometryPage } from '../helpers/window-geometry-browser.ts'

const scene = `
class ChapterWindow extends Window {
  function ChapterWindow(){super.Window();caption="Fullscreen chapter";setInnerSize(320,240);}
}
class ChapterLayer extends Layer {
  function ChapterLayer(w){
    super.Layer(w,null);type=ltOpaque;holdAlpha=false;setSize(320,240);
    fillRect(0,0,320,240,0xff284050);
    fillRect(48,82,40,16,0xffe8a040);
    visible=true;
  }
  function onMouseDown(x,y,button,shift){
    if(x>=48 && x<88 && y>=82 && y<98){
      [x+","+y].save(System.dataPath+"selected.txt");Debug.message("chapter-choice:"+x+","+y);
    }
  }
}
var storyWindow=new ChapterWindow(),storyLayer=new ChapterLayer(storyWindow);
storyWindow.add(storyLayer);storyWindow.setZoom(5,4);storyWindow.visible=true;
var storyFull=new MenuItem(storyWindow,"Play fullscreen");storyWindow.menu.add(storyFull);
storyFull.onClick=function(){global.storyWindow.fullScreen=true;};
Debug.message("chapter-fit:"+System.getArgument("-fszoom"));
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a game's fullscreen option preserves the visible chapter choice and its saved coordinates`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.setViewportSize({ width: 960, height: 540 })
    await observeWindowGeometry(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    await page.locator('#project-mode').selectOption('auto')
    const failures: unknown[] = [], evidence: unknown[] = []
    let stop = () => stopGeometryPage(page)
    try {
      const files = [{ name: 'Chapter.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('Game launcher name') },
        { name: 'Chapter.cf', mimeType: 'text/plain', buffer: Buffer.from('fsres=nochange\r\nfszoom=outer\r\n') }]
      const game = await launchWindowAttention(page, backend, binary, scene, files, true)
      stop = game.stop
      const surface = game.surface('Fullscreen chapter')
      await expect(page.getByText('chapter-fit:outer', { exact: true })).toBeVisible()
      await surface.getByRole('button', { name: 'Play fullscreen', exact: true }).click()
      await expect(surface).toHaveClass(/game-window-fullscreen/)
      await expect(surface.locator('canvas[data-window-id]')).toHaveJSProperty('height', 540)
      const full = await readWindowGeometry(surface)
      evidence.push(full)
      expectGeometryRect(full.canvas, { x: 0, y: 0, width: 960, height: 540 })
      expectGeometryRect(full.geometry.paintBox, { x: 0, y: -90, width: 960, height: 720 })
      expect(full.geometry.scroll.maxY).toBe(0)
      await expect.poll(() => geometryPixel(page, surface, 180, 180)).toEqual([232, 160, 64, 255])
      await clickViewport(page, surface, 180, 180)
      await expect(page.getByText('chapter-choice:60,90', { exact: true })).toBeVisible()
      await surface.getByRole('button', { name: '退出全屏', exact: true }).click()
      await expect(surface).not.toHaveClass(/game-window-fullscreen/)
      const restored = await readWindowGeometry(surface)
      expect(restored.geometry.actualZoom.numer / restored.geometry.actualZoom.denom).toBe(1.25)
      await evaluate(page, '[].load(System.dataPath+"selected.txt")[0]', '60,90')
      await evaluate(page, '(System.setArgument("-fszoom","no"),System.getArgument("-fszoom"))', 'no')
      await surface.getByRole('button', { name: 'Play fullscreen', exact: true }).click()
      await expect(surface).toHaveClass(/game-window-fullscreen/)
      await expect(surface.locator('canvas[data-window-id]')).toHaveJSProperty('height', 240)
      const unscaled = await readWindowGeometry(surface)
      evidence.push(unscaled)
      expectGeometryRect(unscaled.canvas, { x: 320, y: 150, width: 320, height: 240 })
      expectGeometryRect(unscaled.geometry.paintBox, unscaled.canvas)
      await expect.poll(() => geometryPixel(page, surface, 60, 90)).toEqual([232, 160, 64, 255])
      await clickViewport(page, surface, 60, 90)
      await expect(page.getByText('chapter-choice:60,90', { exact: true })).toHaveCount(2)
      await surface.getByRole('button', { name: '退出全屏', exact: true }).click()
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await finishGeometry(page, info, stop, evidence, failures)
  })
