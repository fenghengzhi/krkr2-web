import { createHash } from 'node:crypto'
import type { Page, TestInfo } from '@playwright/test'
import { runFontWorker } from './font-worker.ts'

interface Raster {
  width: number
  height: number
  pixels: number[]
  metrics: unknown[]
  font: string
  normalizedFont: string
  contextLanguage: string | null
}

/** Independent Canvas references in the same kind of execution context as
 * the game rasterizer. This does not import or invoke BrowserGraphics. */
const workerSource = String.raw`
self.onmessage=({data})=>{
 try {
  const variants=[];
  for(const font of ['128px serif','128px serif,sans-serif']) {
   const width=384,height=224,size=128,canvas=new OffscreenCanvas(width,height),
    ctx=canvas.getContext('2d'),pixels=new Uint8Array(width*height*4),metrics=[];
   for(let at=0;at<pixels.length;at+=4)pixels.set([16,24,32,255],at);
   let x=64;
   for(const character of 'AV') {
    ctx.clearRect(0,0,width,height);ctx.font=font;ctx.textBaseline='alphabetic';ctx.fillStyle='#ffffff';
    const m=ctx.measureText(character),baseline=m.fontBoundingBoxAscent??size*.8,thickness=size/16;
    ctx.fillText(character,x,24+baseline);
    if(data.style&1)ctx.fillRect(x,24+baseline+thickness,m.width,thickness);
    if(data.style&2)ctx.fillRect(x,24+baseline-size*.3,m.width,thickness);
    const ink=ctx.getImageData(0,0,width,height).data;
    for(let at=0;at<pixels.length;at+=4)if(ink[at+3]>=128)pixels.set([255,255,255,255],at);
    metrics.push({character,x,width:m.width,baseline,underlineBottom:baseline+thickness*2,
     fontBoundingBoxAscent:m.fontBoundingBoxAscent??null,fontBoundingBoxDescent:m.fontBoundingBoxDescent??null,
     actualBoundingBoxLeft:m.actualBoundingBoxLeft,actualBoundingBoxRight:m.actualBoundingBoxRight,
     actualBoundingBoxAscent:m.actualBoundingBoxAscent,actualBoundingBoxDescent:m.actualBoundingBoxDescent});
    x+=Math.round(m.width);
   }
   variants.push({width,height,pixels:Array.from(pixels),metrics,font,normalizedFont:ctx.font,contextLanguage:ctx.lang??null});
  }
  self.postMessage({variants,language:navigator.language,languages:Array.from(navigator.languages)});
 }catch(error){self.postMessage({error:String(error),stack:error&&error.stack});}
};
`

function rasterSummary(pixels: readonly number[], width: number, height: number) {
  let left = width, top = height, right = 0, bottom = 0, ink = 0
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const at = (y * width + x) * 4
    if (pixels[at] === 16 && pixels[at + 1] === 24 && pixels[at + 2] === 32 && pixels[at + 3] === 255) continue
    ink++; left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x + 1); bottom = Math.max(bottom, y + 1)
  }
  return { width, height, bytes: pixels.length, sha256: createHash('sha256').update(Buffer.from(pixels)).digest('hex'),
    inkPixels: ink, inkBounds: ink ? { left, top, right, bottom } : null }
}
function difference(actual: readonly number[], reference: readonly number[]) {
  if (actual.length !== reference.length) return { actualBytes: actual.length, referenceBytes: reference.length }
  for (let at = 0; at < actual.length; at++)
    if (actual[at] !== reference[at]) return { at, actual: actual[at], reference: reference[at] }
  return null
}

/** Failure-only observations. Caller retains its original assertion failure. */
export async function observeTextDecorationFailure(page: Page, info: TestInfo, frame: {
  style: number
  actual: { width: number; height: number; rgba: number[]; bounds: unknown; devicePixelRatio: number }
  reference: { pixels: number[]; metrics: unknown[] }
  difference: unknown
}) {
  const errors: unknown[] = [], { pixels, ...referenceMetadata } = frame.reference,
    observation: Record<string, unknown> = { style: frame.style, firstFailure: frame.difference,
      actual: { ...rasterSummary(frame.actual.rgba, frame.actual.width, frame.actual.height),
        bounds: frame.actual.bounds, devicePixelRatio: frame.actual.devicePixelRatio },
      pageReference: { ...referenceMetadata, ...rasterSummary(pixels, 384, 224) },
      workerReferences: [], scope: 'Passive failure evidence only; the original page-reference byte comparison remains authoritative for this test.' }
  // Keep both original arrays even if creating the independent Worker fails.
  for (const [name, bytes] of [['subtitle-failed-backing-rgba', frame.actual.rgba], ['subtitle-failed-page-reference-rgba', pixels]] as const)
    try { await info.attach(name, { body: Buffer.from(bytes), contentType: 'application/octet-stream' }) }
    catch (error) { errors.push(error) }
  try {
    const result = await runFontWorker<{ variants?: Raster[]; language?: string; languages?: string[]; error?: string }>(page, info, {
      name: 'subtitle-font-context', source: workerSource, data: { style: frame.style }, modulePrefix: '/src/backends/text/',
    })
    if (result.error || result.variants?.length !== 2) throw new Error(result.error ?? 'Incomplete independent font context report')
    observation.workerEnvironment = { language: result.language, languages: result.languages }
    const variants: unknown[] = []
    observation.workerReferences = variants
    for (const [index, raster] of result.variants.entries()) {
      if (raster.width !== 384 || raster.height !== 224 || raster.pixels.length !== 384 * 224 * 4)
        throw new Error('Invalid independent font context raster')
      const { pixels: bytes, ...metadata } = raster
      variants.push({ ...metadata, ...rasterSummary(bytes, raster.width, raster.height),
        firstDifferenceFromActual: difference(frame.actual.rgba, bytes),
        firstDifferenceFromPageReference: difference(pixels, bytes) })
      try { await info.attach('subtitle-failed-worker-reference-' + index + '-rgba', {
        body: Buffer.from(bytes), contentType: 'application/octet-stream',
      }) } catch (error) { errors.push(error) }
    }
  } catch (error) { errors.push(error) }
  observation.errors = errors.map((error) => error instanceof Error ? { name: error.name, message: error.message } : String(error))
  try { await info.attach('subtitle-failed-font-contexts', { body: JSON.stringify(observation, null, 2), contentType: 'application/json' }) }
  catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Subtitle font context evidence failed', { cause: errors[0] })
}
