import { readFileSync } from 'node:fs'
import { test, expect, observeVideoFrames } from '../helpers/video-presentation-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { geometryPixel, stopGeometryPage } from '../helpers/window-geometry-browser.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: layer video geometry moves decoded pixels and visibility without changing its overlay rectangle`,
    async ({ page }, info) => {
      test.setTimeout(90000)
      const failures: unknown[] = [], readings: unknown[] = []
      await observeVideoFrames(page)
      await page.goto(`/?backend=${backend}`)
      test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
      let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
      try {
        game = await launchWindowAttention(page, backend, binary, `
var videoWindow=new Window();videoWindow.caption="layer-geometry";videoWindow.setInnerSize(160,100);videoWindow.visible=true;
var videoRoot=new Layer(videoWindow,null);videoRoot.setSize(160,100);videoRoot.fillRect(0,0,160,100,0xff000000);
var a=new Layer(videoWindow,videoRoot),b=new Layer(videoWindow,videoRoot);
a.visible=b.visible=true;b.left=80;
var layerMovie=new VideoOverlay(videoWindow);layerMovie.setBounds(3,4,48,32);layerMovie.mode=vomLayer;
layerMovie.layer1=a;layerMovie.layer2=b;layerMovie.open("colors.mp4");layerMovie.pause();layerMovie.frame=6;
`, [{ name: 'colors.mp4', mimeType: 'video/mp4',
          buffer: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)) }], true)
        const surface = game.surface('layer-geometry')
        const green = async (x: number, y: number) => {
          const pixels = await geometryPixel(page, surface, x, y)
          readings.push({ x, y, pixels })
          expect(pixels[0]).toBeLessThan(30); expect(pixels[1]).toBeGreaterThan(220)
          expect(pixels[2]).toBeLessThan(30); expect(pixels[3]).toBe(255)
        }
        const black = async (x: number, y: number) => {
          const pixels = await geometryPixel(page, surface, x, y)
          readings.push({ x, y, pixels }); expect(pixels).toEqual([0, 0, 0, 255])
        }
        await green(8, 8); await green(88, 8)
        await evaluate(page, '(function(){layerMovie.setPos(20,30);return [a.left,a.top,b.left,b.top,layerMovie.left,layerMovie.top].join(",");})()', '20,30,20,30,3,4')
        await black(8, 8); await black(88, 8); await green(28, 38)
        await evaluate(page, '(function(){layerMovie.setSize(1,1);layerMovie.setBounds(0,0,1,1);return [a.width,a.height,b.width,b.height,a.left,a.top,layerMovie.width,layerMovie.height].join(",");})()', '64,48,64,48,20,30,48,32')
        await green(70, 70)
        await evaluate(page, '(function(){layerMovie.visible=false;return [a.visible,b.visible,layerMovie.visible].join(",");})()', '0,0,0')
        await black(28, 38)
        await evaluate(page, '(function(){layerMovie.visible=true;return [a.visible,b.visible].join(",");})()', '1,1')
        await green(28, 38)
        await evaluate(page, '(function(){layerMovie.close();layerMovie.visible=false;return [a.visible,b.visible,layerMovie.visible].join(",");})()', '1,1,0')
        await green(28, 38)
        await expect(page.locator('#logs .error')).toHaveCount(0)
      } catch (error) { failures.push(error) }
      try { await info.attach('video-layer-geometry', { contentType: 'application/json', body: JSON.stringify({
        readings, logs: await page.locator('#logs').innerText(),
      }) }) } catch (error) { failures.push(error) }
      try {
        if (game) await game.stop()
        else await stopGeometryPage(page)
        await expect(page.locator('video,.video-plane')).toHaveCount(0)
      } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Decoded layer geometry and cleanup failed', { cause: failures[0] })
    })
}
