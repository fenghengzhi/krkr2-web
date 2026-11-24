import { expect, test, type Locator } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { launchWindowAttention } from '../helpers/web-window-attention.ts'
import { jpegContractFiles, jpegContractSource, jpegError, jpegErrorCodes, jpegFixture, jpegFrame, jpegRgba } from '../helpers/jpeg-contract.ts'
import { decodeSelectedJpeg } from '../../src/formats/image/jpeg.ts'
import type { ImageJpegDecoder, ImageJpegPrecision } from '../../src/engine/ports/image-jpeg.ts'

async function frame(canvas: Locator) {
  return canvas.evaluate((element) => {
    const source = element as HTMLCanvasElement, output = new OffscreenCanvas(source.width, source.height),
      context = output.getContext('2d', { willReadFrequently: true })!
    context.drawImage(source, 0, 0)
    return { width: source.width, height: source.height, rgba: [...context.getImageData(0, 0, source.width, source.height).data] }
  })
}

const precisionSource = String.raw`
System.exitOnWindowClose=false;
var jpegStartupArgument=System.getArgument("-jpegdec");
var jpegPrecisionWindow=new Window();jpegPrecisionWindow.caption="JPEG startup precision";
jpegPrecisionWindow.setInnerSize(17,19);jpegPrecisionWindow.visible=true;
var jpegPrecisionImage=new Layer(jpegPrecisionWindow,null);jpegPrecisionWindow.add(jpegPrecisionImage);
jpegPrecisionImage.type=ltOpaque;jpegPrecisionImage.setSize(17,19);
function jpegPrecisionLoad(){
  System.clearGraphicCache();jpegPrecisionImage.loadImages("precision.jpg");
  jpegPrecisionImage.update();jpegPrecisionWindow.update();
  var bytes=[];for(var y=0;y<19;y++)for(var x=0;x<17;x++){
    var c=jpegPrecisionImage.getMainPixel(x,y);bytes.add((c>>16)&255);bytes.add((c>>8)&255);
    bytes.add(c&255);bytes.add(jpegPrecisionImage.getMaskPixel(x,y));
  }return bytes.join(",");
}
`

/** A direct real-kernel control checks startup routing, not independent JPEG
 * pixel fidelity. The separate fixed IJG C comparison is the pixel oracle. */
async function precisionControls(bytes: Uint8Array) {
  // Do not require generated native assets during Playwright collection/list.
  const { createHeadlessImageJpegProvider } = await import('../helpers/image-jpeg.ts')
  const provider = createHeadlessImageJpegProvider(), failures: unknown[] = [],
    controls = new Map<ImageJpegPrecision, { width: number; height: number; rgba: number[] }>()
  let decoder: ImageJpegDecoder | undefined
  try {
    for (const precision of ['low', 'normal', 'high'] as const) {
      decoder = await provider.open(bytes, 'normal', precision)
      const work = decodeSelectedJpeg(bytes, 'normal', decoder)
      let result = work.next()
      while (!result.done) result = work.next()
      expect([result.value.width, result.value.height]).toEqual([17, 19])
      controls.set(precision, { width: result.value.width, height: result.value.height, rgba: [...result.value.data] })
      decoder.close(); decoder = undefined
    }
    // Do not assume a chosen pixel changes between precisions: require the
    // independently encoded, nonconstant fixture to distinguish whole planes.
    for (const [first, second] of [['low', 'normal'], ['low', 'high'], ['normal', 'high']] as const)
      expect(controls.get(first)!.rgba).not.toEqual(controls.get(second)!.rgba)
  } catch (error) { failures.push(error) }
  try { decoder?.close() } catch (error) { failures.push(error) }
  try { provider.dispose() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'JPEG startup controls or cleanup failed', { cause: failures[0] })
  return controls
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: public JPEG startup precision reaches the Worker and stays fixed after script argument changes`, async ({ page }, info) => {
    test.setTimeout(180000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const bytes = jpegFixture('y420-normal'), controls = await precisionControls(bytes),
      observations: unknown[] = [], failures: unknown[] = []
    let game: Awaited<ReturnType<typeof launchWindowAttention>> | undefined
    try {
      for (const [query, argument, precision] of [
        [undefined, 'void', 'normal'], ['low', 'low', 'low'], ['normal', 'normal', 'normal'],
        ['high', 'high', 'high'], ['unsupported', 'normal', 'normal'],
      ] as const) {
        if (query !== undefined) await page.goto(`/?backend=${backend}&jpegdec=${query}`)
        game = await launchWindowAttention(page, backend, binary, precisionSource,
          [{ name: 'precision.jpg', mimeType: 'image/jpeg', buffer: bytes }], true)
        const canvas = game.surface('JPEG startup precision').locator('canvas[data-window-id]'),
          expected = controls.get(precision)!, firstMutation = precision === 'low' ? 'high' : 'low',
          secondMutation = precision === 'high' ? 'normal' : 'high'
        await evaluate(page, 'jpegStartupArgument===void ? "void" : jpegStartupArgument', argument)
        await evaluate(page, 'System.getArgument("-jpegdec")===void ? "void" : System.getArgument("-jpegdec")', argument)
        // Change the public argument before even the first decoder is opened.
        await evaluate(page, `(System.setArgument("-jpegdec","${firstMutation}"),System.getArgument("-jpegdec"))`, firstMutation)
        await evaluate(page, 'jpegPrecisionLoad()', expected.rgba.join(','))
        await expect.poll(() => frame(canvas)).toEqual(expected)
        const first = await frame(canvas)
        await evaluate(page, `(System.setArgument("-jpegdec","${secondMutation}"),System.getArgument("-jpegdec"))`, secondMutation)
        // jpegPrecisionLoad clears the actual processed cache before reading.
        await evaluate(page, 'jpegPrecisionLoad()', expected.rgba.join(','))
        await expect.poll(() => frame(canvas)).toEqual(expected)
        observations.push({ query: query ?? null, argument, precision, firstMutation, secondMutation,
          first, afterClearAndReload: await frame(canvas) })
        await expect(page.locator('#logs .error')).toHaveCount(0)
        await game.stop(); game = undefined
        await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      }
    } catch (error) { failures.push(error) }
    try { await info.attach('jpeg-startup-precision', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, controls: Object.fromEntries(controls), observations,
      scope: 'Real App URL -> PlayerOptions -> SessionClient initialize -> Worker startup argument; same-kernel whole-plane controls prove precision routing only. Fixed IJG C comparisons independently validate codec pixels. Every script mutation precedes a cache-cleared real decode.',
    }) }) } catch (error) { failures.push(error) }
    try {
      if (game) await game.stop()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'JPEG startup observation or cleanup failed', { cause: failures[0] })
  })

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: native JPEG main, grayscale mask, numeric errors and source EOF reach actual Layer and canvas`, async ({ page }, info) => {
    test.setTimeout(90000)
    const codes = jpegErrorCodes(), files = jpegContractFiles(),
      game = await launchWindowAttention(page, backend, binary, jpegContractSource,
        Object.entries(files).map(([name, buffer]) => ({ name, mimeType: 'image/jpeg', buffer }))),
      canvas = game.surface('JPEG native contract').locator('canvas[data-window-id]'),
      observations: unknown[] = [], failures: unknown[] = []
    const loaded = async (name: string, value: number, alpha = 255, key = 'clNone') => {
      await evaluate(page, `jpegLoad(jpegImage,"${name}",${key})`, 'ok')
      await evaluate(page, 'jpegPixels(jpegImage)', jpegRgba(value, alpha).join(','))
      await evaluate(page, 'jpegShowMask()', '0')
      await expect.poll(() => frame(canvas)).toEqual(jpegFrame(value, alpha))
      observations.push({ name, key, frame: await frame(canvas) })
    }
    try {
      for (const [name, value, alpha] of [
        ['gray0.jpg', 0, 255], ['gray64.jpg', 64, 255], ['gray255.jpg', 255, 255],
        ['mask0.jpg', 255, 0], ['mask64.jpg', 255, 64], ['mask255.jpg', 64, 255],
      ] as const) {
        await loaded(name, value, alpha)
        await evaluate(page, `jpegLoad(jpegCopy,"${name}",clNone)`, 'ok')
        await evaluate(page, '(jpegImage.setMainPixel(0,0,0xabcdef),jpegImage.setMaskPixel(0,0,19),0)', '0')
        await evaluate(page, 'jpegPixels(jpegCopy)', jpegRgba(value, alpha).join(','))
        await loaded(name, value, alpha)
      }
      await loaded('gray64.jpg', 64, 0, '0x404040')
      await loaded('gray64.jpg', 64)
      for (const [name, code] of [['no-soi.jpg', codes.NO_SOI!], ['empty.jpg', codes.INPUT_EMPTY!]] as const) {
        for (let attempt = 0; attempt < 2; attempt++) {
          await evaluate(page, `jpegLoad(jpegImage,"${name}",clNone)`, jpegError(code))
          await evaluate(page, 'jpegPixels(jpegImage)', jpegRgba(64).join(','))
        }
        observations.push({ name, expectedNativeHolder: jpegError(code) })
      }
      await evaluate(page, 'jpegLoad(jpegImage,"unsupported-mask.jpg",clNone)', jpegError(codes.CONVERSION_NOTIMPL!))
      await evaluate(page, 'jpegPixels(jpegImage)', jpegRgba(255).join(','))
      await loaded('gray64-eof.jpg', 64)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await info.attach('jpeg-native-consumer', { contentType: 'application/json', body: JSON.stringify({
      backend, binary, observations, codes,
      scope: 'Independent fixed IJG6b constant DC inputs, real native JPEG Worker decoding and Layer/cache consumers; opaque RGB above a separate display of actual mask bytes. Missing EOI uses complete entropy, not guessed partial pixels.',
    }) }) } catch (error) { failures.push(error) }
    try {
      await game.stop()
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'JPEG browser consumer or cleanup failed', { cause: failures[0] })
  })
