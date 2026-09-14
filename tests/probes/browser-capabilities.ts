// Run only on hosted CI, before the full browser suites. Fail once with the
// actual graphics result instead of timing out in every game's initialization.
import assert from 'node:assert/strict'
import { writeFile, mkdir } from 'node:fs/promises'
import { chromium, firefox, webkit } from '@playwright/test'
import { browserLaunchOptions } from '../helpers/browser-launch.ts'

const name = process.argv[2]
assert(name === 'chromium' || name === 'firefox' || name === 'webkit')
const browser = await { chromium, firefox, webkit }[name].launch(browserLaunchOptions)
try {
  const page = await browser.newPage()
  const graphics = await page.evaluate(async () => {
    const source = `
      try {
        const canvas = new OffscreenCanvas(2, 2);
        const gl = canvas.getContext('webgl2');
        if (!gl) throw new Error('Worker OffscreenCanvas WebGL2 context is unavailable');
        gl.clearColor(1, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const pixel = new Uint8Array(4);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
        postMessage({
          version: gl.getParameter(gl.VERSION),
          renderer: gl.getParameter(gl.RENDERER),
          pixel: Array.from(pixel),
          error: gl.getError(),
          jspi: typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function'
        });
      } catch (error) {
        postMessage({ failure: String(error) });
      }
    `
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }))
    const worker = new Worker(url)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await new Promise<{
        version?: string
        renderer?: string
        pixel?: number[]
        error?: number
        jspi?: boolean
        failure?: string
      }>((resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Worker graphics probe timed out')), 10000)
        worker.onmessage = (event) => resolve(event.data)
        worker.onerror = (event) => reject(new Error(event.message))
      })
    } finally {
      clearTimeout(timer)
      worker.terminate()
      URL.revokeObjectURL(url)
    }
  })
  const result = { browser: name, ...browserLaunchOptions, graphics }
  console.log(JSON.stringify(result, null, 2))
  await mkdir('out/ci', { recursive: true })
  await writeFile('out/ci/capabilities.json', JSON.stringify(result, null, 2) + '\n')
  assert.equal(graphics.failure, undefined, graphics.failure)
  assert.equal(graphics.error, 0)
  assert.deepEqual(graphics.pixel, [255, 0, 0, 255])
  assert.equal(graphics.jspi, true, 'Both WASM backends must be available in the CI browser')
} finally {
  await browser.close()
}
