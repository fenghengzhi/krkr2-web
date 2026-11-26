import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { transformWithOxc } from 'vite'
import { runFontWorker } from '../helpers/font-worker.ts'
import { highAscentFont } from '../helpers/text-decoration.ts'

// Serve actual source modules to an isolated Worker, with the production font assets.
async function runWorker<T = unknown>(page: Page, testInfo: TestInfo, body: string, data: unknown): Promise<T> {
  const files = new Set([
    'src/backends/text/browser/graphics.ts',
    'src/backends/text/browser/families.ts',
    'src/backends/text/freetype/face.ts',
    'src/backends/text/freetype/module.ts',
    'src/engine/graphics/font.ts',
    'src/engine/graphics/vertical.ts',
    'src/formats/font/vertical-data.ts',
    'src/formats/font/collection.ts',
    'src/formats/font/vertical-substitutions.ts',
    'src/engine/scheduler/control.ts',
    'src/formats/image/bmp.ts',
    'src/formats/image/selection.ts',
    'src/formats/image/read-error.ts',
  ])
  await page.route('**/__font-test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/__font-test/'.length)
    if (!files.has(path)) return route.fulfill({ status: 404 })
    const compiled = await transformWithOxc(await readFile(path, 'utf8'), path)
    await route.fulfill({ contentType: 'text/javascript', body: compiled.code })
  })
  await page.goto('/')
  const origin = new URL(page.url()).origin
  const result = await runFontWorker<T | { error: string; stack?: string; observations?: unknown }>(page, testInfo, {
    name: 'font-backend', modulePrefix: '/__font-test/', data,
    source: `
import {BrowserGraphics} from '${origin}/__font-test/src/backends/text/browser/graphics.ts';
import {loadFontKernel} from '${origin}/__font-test/src/backends/text/freetype/module.ts';
import {ExecutionControl} from '${origin}/__font-test/src/engine/scheduler/control.ts';
const font={height:20,face:'',angle:0,bold:false,italic:false,underline:false,strikeout:false};
const load=()=>loadFontKernel('${origin}/fonts/manifest.json',new ExecutionControl());
const check=(condition,message)=>{if(!condition)throw new Error(message)};
self.onmessage=async({data})=>{const observations={phase:'start'};try{${body}}catch(e){postMessage({error:String(e),stack:e.stack,observations})}};`,
  })
  // A caught script assertion is a successful Worker message, not a successful
  // scenario. Preserve its partial observations before reporting its real error.
  await testInfo.attach('font-backend-result', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  if (result !== null && typeof result === 'object' && 'error' in result && typeof result.error === 'string')
    throw new Error(result.error, { cause: result })
  return result as T
}

test('the Canvas font loader selects each collection member and releases its FontFace', async ({ page }, info) => {
  const bytes = await readFile('tests/fixtures/font-selection/collection.ttc')
  const widths = await runWorker<number[]>(page, info, `
const backend = new BrowserGraphics(), start = fonts.size, widths = [];
try {
  const collection = new Uint8Array(data);
  for (const i of [0, 1, 0]) {
    const loaded = i === 0 ? await backend.loadFont(collection) : await backend.loadFontFace(collection, i);
    try { widths.push(backend.measure('AA', { ...font, face: loaded.face }).width); }
    finally { loaded.dispose(); }
  }
  check(fonts.size === start, 'collection FontFace registration leaked');
} finally { backend.dispose(); }
postMessage(widths);`, [...bytes])
  expect(widths).toEqual([20, 28, 20])
})

test('missing proportional Mincho uses an available named serif while requested faces keep priority', async ({ page }, info) => {
  const result = await runWorker<{
    localFaces: { name: string; available: boolean; error?: string }[]
    selected: string
    measurements: { height: number; bold: boolean; text: string; expected: number; actual: number }[]
    rasterCompared: boolean
    rasterDiscrimination: unknown
    requestedWidths: number[]
  }>(page, info, `
const backend=new BrowserGraphics(), owned=[], localFaces=[], candidates=[];
const ref=new OffscreenCanvas(1,1).getContext('2d');
observations.localFaces=localFaces;observations.measurements=[];
try {
 observations.phase='resolve-local-faces';
 // local() actually resolves a font; FontFaceSet.check alone can return true
 // when a missing family merely falls back. Keep all availability outcomes.
 for(const name of ['MS PMincho','Times New Roman','Liberation Serif','Times']){
  const alias='krkr-serifs-'+localFaces.length, face=new FontFace(alias,'local('+JSON.stringify(name)+')');
  try {await face.load();self.fonts.add(face);owned.push(face);candidates.push({name,alias});localFaces.push({name,available:true});}
  catch(error){localFaces.push({name,available:false,error:String(error)});}
 }
 check(candidates.length>0,'No requested or named serif font resolved: '+JSON.stringify(localFaces));
 const chosen=candidates[0], measurements=observations.measurements;
 observations.selected=chosen;observations.phase='measure-named-serif';
 for(const height of [24,40])for(const bold of [false,true])for(const text of ['AVATAR WAVE','ii WW 0123456789','Cafe Omega']){
  ref.font=height+'px '+JSON.stringify(chosen.alias);
  let expected=0;
  for(let i=0;i<text.length;i++){
   const m=ref.measureText(text[i]),box=m.fontBoundingBoxAscent+m.fontBoundingBoxDescent;
   expected+=Math.round(m.width)+(bold?Math.floor((Number.isFinite(box)&&box>0?Math.round(box):height)/50)+1:0);
  }
  const actual=backend.measure(text,{...font,face:'MS PMincho',height,bold}).width;
  measurements.push({height,bold,text,expected,actual});
  check(actual===expected,'Named serif advance '+JSON.stringify({chosen,localFaces,height,bold,text,expected,actual}));
 }
 // Rasterization must use the same selected family as measurement. The
 // independent local face alias refers to the actual host font, not a bitmap
 // made by the application or a game-specific width table.
 observations.phase='raster-named-serif';
 const actual=backend.text('AVATAR WAVE',24,0xffffff,{...font,face:'MS PMincho',height:24});
 observations.raster={actual:{...actual,data:[...actual.data]}};
 observations.phase='raster-local-reference';
 const expected=backend.text('AVATAR WAVE',24,0xffffff,{...font,face:chosen.alias,height:24});
 observations.raster.expected={...expected,data:[...expected.data]};
 // The ordinary CSS family and a local() FontFace alias can resolve through
 // different platform paths despite identical rounded advances. Observe the
 // actual first/second-word glyphs as well as the original string, without
 // replacing the strict raster assertions below or changing font selection.
 observations.phase='observe-named-serif-raster';
 observations.rasterDiscrimination={scope:'Passive single-family Canvas versus backend stack/local alias, common text origin',complete:false,cases:[]};
 try {
  const w=320,h=96,ox=16,oy=32;
  const place=(image)=>{
   const bytes=new Uint8Array(w*h*4),x=ox+(image.left??0),y=oy+(image.top??0);
   if(x<0||y<0||x+image.width>w||y+image.height>h)throw new Error('Font observation exceeds fixed canvas');
   for(let row=0;row<image.height;row++)bytes.set(image.data.subarray(row*image.width*4,(row+1)*image.width*4),((y+row)*w+x)*4);
   return bytes;
  };
  const summarize=async(bytes)=>{
   let x0=w,y0=h,x1=-1,y1=-1;
   for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(bytes[(y*w+x)*4+3]){x0=Math.min(x0,x);y0=Math.min(y0,y);x1=Math.max(x1,x);y1=Math.max(y1,y);}
   const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
   return {canvas:[w,h],origin:[ox,oy],ink:x1<0?null:{left:x0-ox,top:y0-oy,width:x1-x0+1,height:y1-y0+1},
    rgbaSha256:[...hash].map(v=>v.toString(16).padStart(2,'0')).join('')};
  };
  const families=[...['MS PMincho','Times New Roman','Liberation Serif','Times','serif'].map(name=>({kind:'ordinary-family',name})),
   ...candidates.map(face=>({kind:'loaded-local-alias',name:face.alias,localName:face.name}))];
  for(const text of ['A','W','AVATAR WAVE']){
   const a=text==='AVATAR WAVE'?actual:backend.text(text,24,0xffffff,{...font,face:'MS PMincho',height:24}),
    b=text==='AVATAR WAVE'?expected:backend.text(text,24,0xffffff,{...font,face:chosen.alias,height:24}),aa=place(a),bb=place(b),
    entry={text,actual:{raster:[a.left,a.top,a.width,a.height],...await summarize(aa)},
     reference:{raster:[b.left,b.top,b.width,b.height],...await summarize(bb)},families:[]};
   observations.rasterDiscrimination.cases.push(entry);
   for(const face of families){
    const canvas=new OffscreenCanvas(w,h),ctx=canvas.getContext('2d'),requestedFont='24px '+(face.name==='serif'?'serif':JSON.stringify(face.name));
    ctx.font=requestedFont;const m=ctx.measureText(text),baseline=m.fontBoundingBoxAscent??24*.8;
    const metrics={};for(const key of ['width','actualBoundingBoxLeft','actualBoundingBoxRight','actualBoundingBoxAscent','actualBoundingBoxDescent',
     'fontBoundingBoxAscent','fontBoundingBoxDescent','emHeightAscent','emHeightDescent','hangingBaseline','alphabeticBaseline','ideographicBaseline'])
     if(typeof m[key]==='number')metrics[key]=m[key];
    if(ox-m.actualBoundingBoxLeft<1||ox+m.actualBoundingBoxRight>=w-1||oy+baseline-m.actualBoundingBoxAscent<1||oy+baseline+m.actualBoundingBoxDescent>=h-1)
     throw new Error('Single-family font observation exceeds fixed canvas');
    ctx.fillStyle='#ffffff';ctx.textBaseline='alphabetic';ctx.fillText(text,ox,oy+baseline);
    const pixels=new Uint8Array(ctx.getImageData(0,0,w,h).data.buffer),state={};
    for(const key of ['fontKerning','fontStretch','fontVariantCaps','textRendering','letterSpacing','wordSpacing','direction'])if(key in ctx)state[key]=ctx[key];
    entry.families.push({...face,requestedFont,resolvedFont:ctx.font,metrics,baseline,state,...await summarize(pixels),
     matchesActual:pixels.every((v,i)=>v===aa[i]),matchesReference:pixels.every((v,i)=>v===bb[i])});
   }
  }
  observations.rasterDiscrimination.complete=true;
 }catch(error){observations.rasterDiscrimination.error=String(error);}
 observations.phase='compare-named-serif-raster';
 check(JSON.stringify([actual.width,actual.height,actual.left,actual.top])===JSON.stringify([expected.width,expected.height,expected.left,expected.top]),'Named serif raster bounds');
 check(actual.data.length===expected.data.length&&actual.data.every((v,i)=>v===expected.data[i]),'Named serif raster bytes');
 // Authored font fixtures have 500/900-unit A advances, at 1000 units/em.
 // Loading an actual requested face must take precedence over every fallback.
 observations.phase='requested-face-priority';
 for(const [name,bytes] of [['MS PMincho',data.narrow],['Game Face',data.wide]]){
  const face=new FontFace(name,new Uint8Array(bytes));await face.load();self.fonts.add(face);owned.push(face);
 }
 const requestedWidths=['MS PMincho','MS PMincho,Game Face','Game Face,MS PMincho'].map(face=>backend.measure('A',{...font,face}).width);
 observations.requestedWidths=requestedWidths;
 check(JSON.stringify(requestedWidths)==='[10,10,18]','Requested face priority '+JSON.stringify(requestedWidths));
 postMessage({localFaces,selected:chosen.name,measurements,rasterCompared:true,rasterDiscrimination:observations.rasterDiscrimination,requestedWidths});
} finally {for(const face of owned)self.fonts.delete(face);backend.dispose();}
`, { narrow: [...await readFile('tests/fixtures/font/narrow.ttf')], wide: [...await readFile('tests/fixtures/font/wide.ttf')] })
  await info.attach('system-serif-selection', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  expect(result.localFaces).toHaveLength(4)
  expect(result.localFaces.some((face) => face.available && face.name === result.selected)).toBe(true)
  expect(result.measurements).toHaveLength(12)
  expect(result.measurements.every((row) => row.actual === row.expected)).toBe(true)
  expect(result.rasterCompared).toBe(true)
  expect(result.requestedWidths).toEqual([10, 10, 18])
})

test('system glyph decorations retain every pixel beyond the em box, including rotation and shadows', async ({ page }, info) => {
  const result = await runWorker<{ cases: number; formerlyClipped: number }>(page, info, `
const backend=new BrowserGraphics(), face=new FontFace('krkr-decoration',new Uint8Array(data));
await face.load();self.fonts.add(face);
let cases=0,formerlyClipped=0;
try {
 for(const size of [24,96])for(const angle of [0,450,900,2700])for(const style of [0,1,2,3])for(const shadow of [false,true]){
  const spec={...font,face:'krkr-decoration',height:size,angle,underline:!!(style&1),strikeout:!!(style&2)},
   options={antialiased:true,shadowLevel:shadow?255:0,shadowWidth:shadow?2:0,shadowX:shadow?3:0,shadowY:shadow?4:0,shadowColor:0x224466};
  // Independent, generously sized canvas: no allocation/bounds formula from
  // BrowserGraphics. Translate the complete returned bitmap into this domain.
  const canvas=new OffscreenCanvas(512,512),ctx=canvas.getContext('2d');
  ctx.font=size+'px "krkr-decoration",sans-serif';
  const metrics=ctx.measureText('AV'),baseline=metrics.fontBoundingBoxAscent,thickness=Math.max(1,size/16);
  check(baseline>=size,'Authored high ascent must expose decoration outside the em box');
  ctx.translate(256,256);ctx.rotate(-angle*Math.PI/1800);ctx.fillStyle='#ffffff';
  if(shadow){ctx.shadowColor='#224466';ctx.shadowBlur=2;ctx.shadowOffsetX=3;ctx.shadowOffsetY=4;}
  ctx.fillText('AV',0,baseline);
  if(style&1)ctx.fillRect(0,baseline+thickness,metrics.width,thickness);
  if(style&2)ctx.fillRect(0,baseline-size*.3,metrics.width,thickness);
  const expected=ctx.getImageData(0,0,512,512).data,actual=backend.text('AV',size,0xffffff,spec,options),
   placed=new Uint8Array(expected.length),x0=256+actual.left,y0=256+actual.top;
  check(x0>=0&&y0>=0&&x0+actual.width<=512&&y0+actual.height<=512,'Reference canvas contains complete raster');
  for(let y=0;y<actual.height;y++)placed.set(actual.data.subarray(y*actual.width*4,(y+1)*actual.width*4),((y0+y)*512+x0)*4);
  observations.case={size,angle,style,shadow,bounds:[actual.left,actual.top,actual.width,actual.height],baseline};
  let mismatch=-1;for(let i=0;i<expected.length;i++)if(expected[i]!==placed[i]){mismatch=i;break;}
  if(mismatch!==-1)observations.mismatch={index:mismatch,expected:expected[mismatch],actual:placed[mismatch]};
  check(mismatch===-1,'Complete decorated raster '+JSON.stringify(observations.case));
  if(angle===0&&!shadow&&(style&1)){
   const oldBottom=Math.ceil(Math.max(size,baseline+metrics.actualBoundingBoxDescent)+1);
   for(let y=256+oldBottom;y<512;y++)for(let x=0;x<512;x++)if(expected[(y*512+x)*4+3])formerlyClipped++;
  }
  cases++;
 }
}finally{self.fonts.delete(face);backend.dispose();}
postMessage({cases,formerlyClipped});
`, [...highAscentFont(await readFile('tests/fixtures/font/narrow.ttf'))])
  expect(result.cases).toBe(64)
  expect(result.formerlyClipped).toBeGreaterThan(0)
})

test('system bold measures dialogue and places glyphs using distinct regular-face advances', async ({ page }, info) => {
  const result = await runWorker(page, info, `
const backend=new BrowserGraphics(), ref=new OffscreenCanvas(1,1).getContext('2d');
let cases=0, distinct=false;
try {
 for(const height of [24,40,96]){
  const spec={...font,face:'serif',height,bold:true};ref.font=height+'px serif';
  for(const text of ['Introduction to Kirikiri and','Exit','Wi Wi','A'+String.fromCharCode(0)+'B']){
   let width=0,pen=0;
   for(let i=0;i<text.length && text.charCodeAt(i);i++){
    const m=ref.measureText(text[i]), regular=Math.round(m.width), box=m.fontBoundingBoxAscent+m.fontBoundingBoxDescent;
    width+=regular+Math.floor((Number.isFinite(box)&&box>0?Math.round(box):height)/50)+1;
    pen+=regular+Math.floor(regular/50)+1;
   }
   const got=backend.measure(text,spec);
   check(got.width===width && got.drawAdvance===pen,'system advances '+[height,text,width,got.width,pen,got.drawAdvance]);
   distinct ||= width!==pen;
   cases++;
  }
  check(backend.measureGlyph('i',spec).advance===Math.round(ref.measureText('i').width),'glyph bounds use regular advance');
 }
} finally {backend.dispose();}
postMessage({cases,distinct});
`, {})
  expect(result).toEqual({ cases: 12, distinct: true })
})

test('Worker file glyphs match native coverage and missing glyphs use browser fallback only where allowed', async ({
  page,
}, testInfo) => {
  const reference = JSON.parse(await readFile('tests/fixtures/font-geometry/freetype.json', 'utf8'))
  const result = await runWorker(
    page,
    testInfo,
    `
const backend=new BrowserGraphics(load),loaded=await backend.loadFont(new Uint8Array(data.bytes)),spec={...font,face:loaded.face};
for(const row of data.cases){
 const f={...spec,height:row.height,bold:!!(row.flags&1),italic:!!(row.flags&2),underline:!!(row.flags&4),strikeout:!!(row.flags&8)},ch=String.fromCharCode(row.code),g=backend.glyph(ch,f,!(row.flags&16)),m=backend.measureGlyph(ch,f);
 check(JSON.stringify([m.left,m.top,m.right,m.bottom,m.advance])===JSON.stringify(row.metrics),'metrics '+JSON.stringify(row));
 check(JSON.stringify([g.width,g.height,g.left,g.top,g.advance])===JSON.stringify(row.glyph),'glyph dimensions');
 check(g.coverage.every((v,i)=>v===row.coverage[i])&&g.coverage.length===row.coverage.length,'glyph pixels '+[row.height,row.flags,row.code]);
}
const missing=backend.glyph('Z',spec,true),fallback=backend.text('Z',20,0xffffff,{...font,face:'sans-serif'},{antialiased:true,shadowLevel:0,shadowWidth:0,shadowX:0,shadowY:0,shadowColor:0});
check(missing.coverage.some(v=>v>0),'missing character has visible fallback');
check(missing.coverage.every((v,i)=>v===fallback.data[i*4+3]),'fallback alpha');
check(missing.advance===Math.round(backend.measure('Z',{...font,face:'sans-serif'}).width),'fallback advance');
check(backend.measure('Z',spec).width===20,'measurement keeps primary missing-character width');
for(const code of [9,32,0x85,0xa0,0x2003,0x3000,0xd800,0xfdd0,0xffff])check(!backend.glyph(String.fromCharCode(code),spec,true).coverage.some(v=>v),'blank fallback '+code);
loaded.dispose();backend.dispose();postMessage({cases:data.cases.length,fallback:true});
`,
    {
      bytes: [...(await readFile('tests/fixtures/font-geometry/outlines.ttf'))],
      cases: reference.cases,
    },
  )
  expect(result).toEqual({ cases: 512, fallback: true })
})

test('font backend retries failed loads, isolates families and releases pending or live kernels once', async ({
  page,
}, testInfo) => {
  const result = await runWorker(
    page,
    testInfo,
    `
const kernel=await load();let closes=0,done=0,attempts=0;
const close=kernel.module._krfont_close,finish=kernel.module._krfont_done;
kernel.module._krfont_close=(...args)=>{closes++;return close(...args)};
kernel.module._krfont_done=(...args)=>{done++;return finish(...args)};
const backend=new BrowserGraphics(async()=>{if(++attempts===1)throw new Error('transient');return kernel});
try{await backend.loadFont(new Uint8Array(data.narrow));throw new Error('failure swallowed')}catch(e){check(e.message==='transient','initial rejection')}
const a=await backend.loadFont(new Uint8Array(data.narrow)),b=await backend.loadFont(new Uint8Array(data.wide));
check(a.face!==b.face,'unique font identities');
check(backend.measure('A',{...font,face:a.face}).width===10,'narrow');
check(backend.measure('A',{...font,face:b.face}).width===18,'wide');
a.dispose();a.dispose();backend.dispose();b.dispose();await Promise.resolve();
check(closes===2&&done===1&&attempts===2,'release count '+[closes,done,attempts]);
let resolve;const lateKernel=await load(),lateFinish=lateKernel.module._krfont_done;let lateDone=0;
lateKernel.module._krfont_done=(...args)=>{lateDone++;return lateFinish(...args)};
const late=new BrowserGraphics(()=>new Promise(r=>resolve=r)),pending=late.loadFont(new Uint8Array(data.narrow));
const rejected=pending.then(()=>{throw new Error('late load accepted')},e=>check(e.message.includes('disposed'),'late rejection'));
late.dispose();late.dispose();resolve(lateKernel);await rejected;await Promise.resolve();
check(lateDone===1,'late kernel release');
// Standalone Canvas backend owns registrations too, including cancellation during FontFace.load.
const original=FontFace.prototype.load,gate=new Promise(r=>resolve=r);
FontFace.prototype.load=async function(){await gate;return original.call(this)};
const browserBackend=new BrowserGraphics(),cancelled=browserBackend.loadFont(new Uint8Array(data.narrow)),count=fonts.size;
const browserRejected=cancelled.then(()=>{throw new Error('cancelled browser font accepted')},e=>check(e.message.includes('disposed'),'browser rejection'));
browserBackend.dispose();resolve();await browserRejected;FontFace.prototype.load=original;
check(fonts.size===count,'late browser registration');
const live=new BrowserGraphics(),registration=await live.loadFont(new Uint8Array(data.narrow));
check(fonts.size===count+1,'browser registration');live.dispose();registration.dispose();
check(fonts.size===count,'browser release');postMessage({released:closes,done,lateDone,browserReleased:true});
`,
    {
      narrow: [...(await readFile('tests/fixtures/font/narrow.ttf'))],
      wide: [...(await readFile('tests/fixtures/font/wide.ttf'))],
    },
  )
  expect(result).toEqual({ released: 2, done: 1, lateDone: 1, browserReleased: true })
})
