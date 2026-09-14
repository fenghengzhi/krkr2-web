import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { transformWithOxc } from 'vite'

// Serve actual source modules to an isolated Worker, with the production font assets.
async function runWorker(page: Page, body: string, data: unknown) {
  const files = new Set([
    'src/backends/text/browser/graphics.ts',
    'src/backends/text/browser/families.ts',
    'src/backends/text/freetype/face.ts',
    'src/backends/text/freetype/module.ts',
    'src/engine/graphics/font.ts',
    'src/engine/graphics/vertical.ts',
    'src/formats/font/vertical-data.ts',
    'src/formats/font/vertical-substitutions.ts',
    'src/engine/scheduler/control.ts',
    'src/formats/image/bmp.ts',
  ])
  await page.route('**/__font-test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/__font-test/'.length)
    if (!files.has(path)) return route.fulfill({ status: 404 })
    const compiled = await transformWithOxc(await readFile(path, 'utf8'), path)
    await route.fulfill({ contentType: 'text/javascript', body: compiled.code })
  })
  await page.goto('/')
  return await page.evaluate(
    async ({ body, data }) => {
      const code = `
import {BrowserGraphics} from '${location.origin}/__font-test/src/backends/text/browser/graphics.ts';
import {loadFontKernel} from '${location.origin}/__font-test/src/backends/text/freetype/module.ts';
import {ExecutionControl} from '${location.origin}/__font-test/src/engine/scheduler/control.ts';
const font={height:20,face:'',angle:0,bold:false,italic:false,underline:false,strikeout:false};
const load=()=>loadFontKernel('${location.origin}/fonts/manifest.json',new ExecutionControl());
const check=(condition,message)=>{if(!condition)throw new Error(message)};
self.onmessage=async({data})=>{try{${body}}catch(e){postMessage({error:String(e),stack:e.stack})}};`
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
        worker = new Worker(url, { type: 'module' })
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Font Worker timed out')), 12000)
          worker.onmessage = (e) => {
            clearTimeout(timer)
            resolve(e.data)
          }
          worker.onerror = (e) => {
            clearTimeout(timer)
            reject(new Error(e.message))
          }
          worker.postMessage(data)
        })
      } finally {
        worker.terminate()
        URL.revokeObjectURL(url)
      }
    },
    { body, data },
  )
}
test('Worker file glyphs match native coverage and missing glyphs use browser fallback only where allowed', async ({
  page,
}) => {
  const reference = JSON.parse(await readFile('tests/fixtures/font-geometry/freetype.json', 'utf8'))
  const result = await runWorker(
    page,
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
}) => {
  const result = await runWorker(
    page,
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
