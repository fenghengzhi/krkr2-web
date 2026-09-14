// Compare actual browser glyph bytes with TextMetrics; no game-side assumptions.
import { build } from 'vite'
import { chromium, firefox, webkit } from '@playwright/test'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile, writeFile } from 'node:fs/promises'
const directory = 'out/verification/font-geometry/browser-inspect'
await build({
  configFile: false,
  logLevel: 'silent',
  build: {
    outDir: directory,
    emptyOutDir: true,
    minify: false,
    lib: {
      entry: 'src/backends/text/browser/graphics.ts',
      formats: ['es'],
      fileName: () => 'backend.js',
    },
  },
})
const source = await readFile(directory + '/backend.js'),
  server = createServer((req, res) => {
    if (req.url === '/backend.js')
      res.writeHead(200, { 'Content-Type': 'application/javascript' }).end(source)
    else
      res
        .writeHead(200, { 'Content-Type': 'text/html' })
        .end('<!doctype html><title>Glyph probe</title>')
  })
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const address = server.address()
if (!address || typeof address === 'string') throw new Error('No address')
const base = `http://127.0.0.1:${address.port}`
const results = []
try {
  for (const name of ['chromium', 'firefox', 'webkit'] as const) {
    const browser = await { chromium, firefox, webkit }[name].launch()
    try {
      const page = await browser.newPage()
      await page.goto(base)
      const result = await page.evaluate(
        async ({ base, bytes }) => {
          const code = `
import {BrowserGraphics} from '${base}/backend.js';
function box(data,width,height){let l=width,t=height,r=0,b=0;const alpha=new Set();for(let y=0;y<height;y++)for(let x=0;x<width;x++){const a=data[(y*width+x)*4+3];alpha.add(a);if(a){l=Math.min(l,x);t=Math.min(t,y);r=Math.max(r,x+1);b=Math.max(b,y+1);}}return {bounds:[l,t,r,b],alpha:[...alpha].sort((a,b)=>a-b)}}
self.onmessage=async({data:bytes})=>{try{
 const graphics=new BrowserGraphics(),loaded=await graphics.loadFont(new Uint8Array(bytes)),font={height:20,face:loaded.face,angle:0,bold:false,italic:false,underline:false,strikeout:false};
 const c=new OffscreenCanvas(32,32),ctx=c.getContext('2d');ctx.font='20px "'+loaded.face+'"';
 const outputs=[];for(const ch of ['A','V',' ']){
  ctx.clearRect(0,0,32,32);const m=ctx.measureText(ch);ctx.fillText(ch,1,17);
  const direct=box(ctx.getImageData(0,0,32,32).data,32,32),raster=graphics.text(ch,20,0xffffff,font,{antialiased:true,shadowLevel:0,shadowWidth:0,shadowX:0,shadowY:0,shadowColor:0});
  outputs.push({ch,metrics:{width:m.width,left:m.actualBoundingBoxLeft,right:m.actualBoundingBoxRight,ascent:m.actualBoundingBoxAscent,descent:m.actualBoundingBoxDescent,fontAscent:m.fontBoundingBoxAscent},direct,raster:{width:raster.width,height:raster.height,left:raster.left,top:raster.top,...box(raster.data,raster.width,raster.height)},bounds:graphics.measureGlyph(ch,font)});
 }loaded.dispose();postMessage(outputs);
}catch(e){postMessage({error:String(e)})}};
`
          const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
            worker = new Worker(url, { type: 'module' })
          try {
            return await new Promise((resolve, reject) => {
              worker.onmessage = (e) => resolve(e.data)
              worker.onerror = (e) => reject(new Error(e.message))
              worker.postMessage(bytes)
            })
          } finally {
            worker.terminate()
            URL.revokeObjectURL(url)
          }
        },
        { base, bytes: [...(await readFile('tests/fixtures/font/narrow.ttf'))] },
      )
      results.push({ browser: name, result })
      console.log(name, JSON.stringify(result))
    } finally {
      await browser.close()
    }
  }
} finally {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
}
await writeFile(
  'out/verification/font-geometry/browser-glyphs.json',
  JSON.stringify(results, null, 2) + '\n',
)
