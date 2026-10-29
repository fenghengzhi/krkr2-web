import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { paletteFiles, paletteRgba, packedKeyRgba, paletteGray } from '../helpers/png-palette-contract.ts'

const source = String.raw`
System.exitOnWindowClose=false;
System.assignMessage("TVPPNGLoadError","palette-png:%1");
var paletteWindow=new Window();paletteWindow.caption="PNG palette contract";paletteWindow.setInnerSize(4,6);paletteWindow.visible=true;
var paletteRoot=new Layer(paletteWindow,null);paletteWindow.add(paletteRoot);paletteRoot.type=ltOpaque;
paletteRoot.setSize(4,6);paletteRoot.fillRect(0,0,4,6,0xff000000);
var paletteImage=new Layer(paletteWindow,paletteRoot);paletteImage.type=ltOpaque;paletteImage.setSize(4,3);paletteImage.visible=true;
var paletteMask=new Layer(paletteWindow,paletteRoot);paletteMask.type=ltOpaque;paletteMask.setSize(4,3);paletteMask.top=3;paletteMask.visible=true;
var paletteCopy=new Layer(paletteWindow,paletteRoot);paletteCopy.setSize(4,3);paletteCopy.visible=false;
function paletteLoad(target,name,key){try{target.loadImages(name,key);return "ok";}catch(error){return error.message;}}
function paletteBytes(target){
  var bytes=[];for(var y=0;y<3;y++)for(var x=0;x<4;x++){
    var c=target.getMainPixel(x,y);bytes.add((c>>16)&255);bytes.add((c>>8)&255);bytes.add(c&255);bytes.add(target.getMaskPixel(x,y));
  }return bytes.join(",");
}
function paletteShowMask(){
  for(var y=0;y<3;y++)for(var x=0;x<4;x++){
    var a=global.paletteImage.getMaskPixel(x,y);global.paletteMask.setMainPixel(x,y,a*0x010101);
  }return 0;
}
`

async function frame(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height, rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}
// Opaque display of the real loaded RGB above a separate real Layer displaying
// its actual mask bytes. This makes all48 bytes visible without compositing
// quantization hiding transparent RGB or the partial-alpha values.
function expectedFrame(rgba: readonly number[]) {
  return { width: 4, height: 6, rgba: [...rgba.map((value, index) => index % 4 === 3 ? 255 : value),
    ...rgba.filter((_value, index) => index % 4 === 3).flatMap((alpha) => [alpha, alpha, alpha, 255])] }
}
const opaqueRgba = paletteRgba.map((value, index) => index % 4 === 3 ? 255 : value)
const maskRgba = (values: readonly number[]) => values.flatMap((alpha, index) =>
  index % 4 === 0 ? [17, 34, 51, alpha] : [200, 100, 50, alpha])

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: palette PNG keys, native mask stride and failure rows reach real Worker Layers and canvas`, async ({ page }, info) => {
    test.setTimeout(120000)
    const game = await launchWindowAttention(page, backend, binary, source,
      Object.entries(paletteFiles()).map(([name, buffer]) => ({ name, mimeType: 'application/octet-stream', buffer }))),
      canvas = game.surface('PNG palette contract').locator('canvas[data-window-id]'),
      failures: unknown[] = [], observations: unknown[] = []
    const loaded = async (name: string, key: string, expected: readonly number[]) => {
      await evaluate(page, `paletteLoad(paletteImage,"${name}",${key})`, 'ok')
      await evaluate(page, 'paletteBytes(paletteImage)', expected.join(','))
      await evaluate(page, 'paletteShowMask()', '0')
      await expect.poll(() => frame(canvas)).toEqual(expectedFrame(expected))
      observations.push({ name, key, frame: await frame(canvas) })
    }
    try {
      for (const name of ['alpha.png', 'alpha-adam7.png'])
        for (const key of ['clNone', 'clPalIdx+0', 'clPalIdx+1', 'clPalIdx+255'])
          await loaded(name, key, paletteRgba)
      await evaluate(page, 'paletteLoad(paletteCopy,"alpha.png",clPalIdx+1)', 'ok')
      await evaluate(page, '(paletteImage.setMainPixel(1,0,0xabcdef),paletteImage.setMaskPixel(1,0,222),0)', '0')
      await evaluate(page, 'paletteBytes(paletteCopy)', paletteRgba.join(','))
      await loaded('alpha.png', 'clPalIdx+1', paletteRgba)
      for (const name of ['opaque.png', 'opaque-adam7.png'])
        for (const key of ['clNone', 'clPalIdx+0', 'clPalIdx+1', 'clPalIdx+255'])
          await loaded(name, key, key === 'clNone' ? opaqueRgba : packedKeyRgba)
      await evaluate(page, 'paletteLoad(paletteCopy,"opaque.png",clPalIdx+255)', 'ok')
      await evaluate(page, '(paletteImage.setMainPixel(0,0,0),paletteImage.setMaskPixel(0,0,255),0)', '0')
      await evaluate(page, 'paletteBytes(paletteCopy)', packedKeyRgba.join(','))
      await loaded('opaque.png', 'clPalIdx+255', packedKeyRgba)
      await loaded('masked.bmp', 'clNone', maskRgba(paletteGray))
      await evaluate(page, 'paletteLoad(paletteCopy,"masked.bmp",clNone)', 'ok')
      await evaluate(page, '(System.clearGraphicCache(),0)', '0')
      for (let attempt = 0; attempt < 2; attempt++) {
        await evaluate(page, 'paletteLoad(paletteImage,"masked-bad.bmp",clNone)', 'palette-png:IDAT: CRC error')
        await evaluate(page, 'paletteBytes(paletteImage)', maskRgba([...paletteGray.slice(0, 8), 255, 255, 255, 255]).join(','))
        await evaluate(page, 'paletteBytes(paletteCopy)', maskRgba(paletteGray).join(','))
      }
      for (const [name, expected, phase] of [
        ['alpha-bad-row.png', paletteRgba, 'IDAT'], ['opaque-bad-row.png', packedKeyRgba, 'IDAT'],
        ['alpha-tail.png', paletteRgba, 'IEND'], ['alpha-adam7-tail.png', Array(48).fill(0), 'IEND'],
      ] as const) {
        await evaluate(page, `paletteLoad(paletteImage,"${name}",clPalIdx+1)`, `palette-png:${phase}: CRC error`)
        await evaluate(page, 'paletteBytes(paletteImage)', expected.join(','))
        observations.push({ name, phase, expectedRetainedBytes: [...expected] })
      }
      await loaded('alpha-adam7.png', 'clPalIdx+255', paletteRgba)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('png-palette-consumer', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, observations,
      scope: 'Real PNG bytes through selected loader, TJS/bytecode, private Layer destinations and RGB/mask canvas; packed row tail is explicitly Web zero, never native uninitialized memory.',
    }) }) } catch (error) { failures.push(error) }
    try {
      await game.stop()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'PNG palette browser consumer or cleanup failed', { cause: failures[0] })
  })
