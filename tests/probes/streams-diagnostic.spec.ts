// Opt-in isolation of the production Blob/CompressionStream path without TJS or WebGL.
import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { createHash } from 'node:crypto'

test('worker compression and decompression complete repeatedly', async ({ page }, info) => {
  const paths = ['src/formats/binary/writer.ts', 'src/backends/files/blob-source.ts']
  const sources = await Promise.all(paths.map((path) => readFile(path, 'utf8')))
  await info.attach('production-sources', {
    contentType: 'application/json',
    body: JSON.stringify(
      Object.fromEntries(
        paths.map((path, i) => [path, createHash('sha256').update(sources[i]!).digest('hex')]),
      ),
    ),
  })
  const source = stripTypeScriptTypes(
    'const MAX_RESOURCE_BYTES=64*1024*1024;\n' +
      sources
        .map((text) => text.replace(/^import .*\n/gm, '').replace(/\bexport /g, ''))
        .join('\n'),
    { mode: 'transform' },
  )
  await page.goto('/')
  const result = await page.evaluate(async (source) => {
    const code =
      source +
      `
      (async()=>{
        const input=new Uint8Array([0,200,100,50,0,0,0,255,128,0,0,255,0,255,255,0,0,73]);
        for(let i=0;i<500;i++){
          postMessage({iteration:i,stage:'deflate'});
          const compressed=await deflateImage(input);
          postMessage({iteration:i,stage:'inflate'});
          const output=await inflateImage(compressed,input.length);
          if(output.some((byte,i)=>byte!==input[i]))throw new Error('Round trip differs');
        }
        postMessage({stage:'done'});
      })().catch(error=>postMessage({error:String(error)}));
    `
    const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' })),
      worker = new Worker(url)
    let latest: unknown
    return new Promise((resolve) => {
      const finish = (result: unknown) => {
        clearTimeout(timer)
        worker.terminate()
        URL.revokeObjectURL(url)
        resolve(result)
      }
      const timer = setTimeout(() => finish({ timeout: true, latest }), 12_000)
      worker.onmessage = ({ data }) => {
        latest = data
        if (data.stage === 'done' || data.error) finish(data)
      }
      worker.onerror = (event) => finish({ error: event.message })
    })
  }, source)
  expect(result).toEqual({ stage: 'done' })
})
