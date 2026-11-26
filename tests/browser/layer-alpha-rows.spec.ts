import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { layerAlphaRows, layerAlphaSource } from '../helpers/layer-alpha-rows.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'

const source = layerAlphaSource + `
rowWin.caption="Alpha rows";rowWin.borderStyle=bsNone;rowWin.innerSunken=false;
rowWin.setInnerSize(16,1);rowWin.drawDevice.preferredDrawer=Window.PassThroughDrawDevice.dtDrawDib;
rowWin.drawDevice.recreate();rowWin.visible=true;
var rowPanel;
function displayAlphaRow(){
 rowRoot.face=dfAlpha;rowRoot.fillRect(0,0,16,1,0xff000000);
 rowPanel=new Layer(rowWin,rowRoot);rowWin.add(rowPanel);rowPanel.type=ltAlpha;rowPanel.setSize(8,1);
 rowPanel.fillRect(0,0,8,1,0x7fff0000);rowPanel.opacity=129;rowPanel.visible=true;
 rowWin.update();return rowWin.drawDevice.drawer;
}`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: software Window presents stock alpha scanlines and captures their masks`, async ({ page }) => {
    const game = await launchWindowAttention(page, backend, binary, source)
    try {
      for (const { id, expected } of layerAlphaRows)
        await evaluate(page, `layerAlphaRun("${id}")`, expected)
      await evaluate(page, 'displayAlphaRow()', '1')
      const canvas = game.surface('Alpha rows').locator('canvas[data-window-id]')
      const red = [62, 62, 62, 62, 62, 62, 63, 63, 0, 0, 0, 0, 0, 0, 0, 0]
      await expect.poll(() => canvas.evaluate((node) => {
        const surface = node as HTMLCanvasElement, out = new OffscreenCanvas(surface.width, surface.height)
        const ctx = out.getContext('2d')!
        ctx.drawImage(surface, 0, 0)
        return [surface.width, surface.height, ...ctx.getImageData(0, 0, surface.width, surface.height).data]
      })).toEqual([16, 1, ...red.flatMap((r) => [r, 0, 0, 255])])
    } finally { await game.stop() }
  })
}
