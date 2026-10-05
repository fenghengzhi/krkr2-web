import { expect, type Locator, type Page, type Worker } from '@playwright/test'

interface GpuRecord {
  canvas: OffscreenCanvas
  gl: WebGL2RenderingContext
  extension: WEBGL_lose_context | null
  lost: number
  restored: number
  programs: number
  deletedPrograms: number
  uploads: number
  draws: number
  failProgram: number
}
interface OutputRecord {
  canvas: OffscreenCanvas
  kind: 'bitmaprenderer' | '2d'
  commits: number
  clears: number
}
interface SharedGpuEvidence {
  gpu: GpuRecord[]
  outputs: OutputRecord[]
  bitmaps: { created: number; transferred: number; closed: number }
}
type InstrumentedGlobal = typeof globalThis & { __windowGpuTest: SharedGpuEvidence }

/** Observe real contexts and bitmap ownership. Only canvases which request
 * bitmaprenderer are Window outputs; font measurement/raster 2D canvases are
 * unrelated. The optional fault takes the production adapter's real 2D path. */
export async function injectWindowGpu(page: Page, force2D = false): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(input: string | URL, options?: WorkerOptions) {
        const url = new URL(input, location.href)
        if (url.pathname.includes('/assets/session.worker-'))
          url.searchParams.set('multiwindow-gpu-test', crypto.randomUUID())
        super(url, options)
      }
    }
  })
  await page.route('**/assets/session.worker-*.js*', async (route) => {
    const response = await route.fetch()
    const instrumentation = `(() => {
      const evidence = self.__windowGpuTest = { gpu:[], outputs:[],
        bitmaps:{created:0,transferred:0,closed:0} };
      const seen = new WeakSet(), outputCanvases = new WeakSet(), owned = new WeakMap();
      const transfer = OffscreenCanvas.prototype.transferToImageBitmap;
      OffscreenCanvas.prototype.transferToImageBitmap = function(...args) {
        const bitmap = transfer.apply(this,args);
        owned.set(bitmap,true); evidence.bitmaps.created++; return bitmap;
      };
      const close = ImageBitmap.prototype.close;
      ImageBitmap.prototype.close = function(...args) {
        const result = close.apply(this,args);
        if(owned.get(this)){owned.set(this,false);evidence.bitmaps.closed++;}
        return result;
      };
      const get = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function(...args) {
        if(args[0] === 'bitmaprenderer') outputCanvases.add(this);
        if(${force2D} && args[0] === 'bitmaprenderer') return null;
        const context = get.apply(this,args);
        if(!context || seen.has(context)) return context;
        seen.add(context);
        if(args[0] === 'webgl2') {
          const gl=context, stats={canvas:this,gl,extension:gl.getExtension('WEBGL_lose_context'),
            lost:0,restored:0,programs:0,deletedPrograms:0,uploads:0,draws:0,failProgram:0};
          evidence.gpu.push(stats);
          this.addEventListener('webglcontextlost',()=>stats.lost++);
          this.addEventListener('webglcontextrestored',()=>stats.restored++);
          const program=gl.createProgram.bind(gl), remove=gl.deleteProgram.bind(gl);
          const upload=gl.texImage2D.bind(gl),draw=gl.drawArrays.bind(gl);
          gl.createProgram=()=>{stats.programs++;if(stats.failProgram>0){stats.failProgram--;return null;}return program();};
          gl.deleteProgram=(value)=>{if(value)stats.deletedPrograms++;return remove(value);};
          gl.texImage2D=(...args)=>{stats.uploads++;return upload(...args);};
          gl.drawArrays=(...args)=>{stats.draws++;return draw(...args);};
        } else if(outputCanvases.has(this) && (args[0] === 'bitmaprenderer' || args[0] === '2d')) {
          const stats={canvas:this,kind:args[0],commits:0,clears:0};evidence.outputs.push(stats);
          if(args[0] === 'bitmaprenderer') {
            const present=context.transferFromImageBitmap.bind(context);
            context.transferFromImageBitmap=(bitmap)=>{
              const result=present(bitmap);
              if(bitmap){stats.commits++;if(owned.get(bitmap)){owned.set(bitmap,false);evidence.bitmaps.transferred++;}}
              else stats.clears++;
              return result;
            };
          } else {
            const draw=context.drawImage.bind(context),clear=context.clearRect.bind(context);
            context.drawImage=(...args)=>{const result=draw(...args);stats.commits++;return result;};
            context.clearRect=(...args)=>{const result=clear(...args);stats.clears++;return result;};
          }
        }
        return context;
      };
    })();`
    await route.fulfill({ response, headers: { ...response.headers(), 'cache-control': 'no-store' },
      body: instrumentation + '\n' + (await response.text()) })
  })
}

export async function windowGpuWorker(page: Page): Promise<Worker> {
  await expect.poll(() => page.workers().some((worker) => worker.url().includes('/assets/session.worker-'))).toBe(true)
  const worker = page.workers().find((worker) => worker.url().includes('/assets/session.worker-'))!
  await expect.poll(() => worker.evaluate(() =>
    (globalThis as InstrumentedGlobal).__windowGpuTest?.gpu.length ?? 0)).toBe(1)
  return worker
}
export function windowGpuStats(worker: Worker) {
  return worker.evaluate(() => {
    const evidence = (globalThis as InstrumentedGlobal).__windowGpuTest,
      state = evidence.gpu[0]!, bitmaps = { ...evidence.bitmaps }
    return {
      contexts: evidence.gpu.length, lost: state.lost, restored: state.restored,
      programs: state.programs, deletedPrograms: state.deletedPrograms,
      uploads: state.uploads, draws: state.draws,
      isLost: state.gl.isContextLost(), extension: !!state.extension,
      bitmaps: { ...bitmaps, outstanding: bitmaps.created - bitmaps.transferred - bitmaps.closed },
      outputs: evidence.outputs.map((output, index) => ({ index, kind: output.kind,
        width: output.canvas.width, height: output.canvas.height,
        commits: output.commits, clears: output.clears })),
    }
  })
}
export async function selectWindowOutput(worker: Worker, width: number, height: number) {
  await expect.poll(async () => (await windowGpuStats(worker)).outputs.filter(
    (output) => output.width === width && output.height === height).length).toBe(1)
  return (await windowGpuStats(worker)).outputs.find(
    (output) => output.width === width && output.height === height)!.index
}
export async function loseWindowGpu(worker: Worker, failProgram = false) {
  const before = await windowGpuStats(worker)
  expect(before.contexts).toBe(1)
  expect(before.extension).toBe(true)
  expect(before.isLost).toBe(false)
  await worker.evaluate((failProgram) => {
    const state = (globalThis as InstrumentedGlobal).__windowGpuTest.gpu[0]!
    if (failProgram) state.failProgram++
    state.extension!.loseContext()
  }, failProgram)
  await expect.poll(async () => (await windowGpuStats(worker)).lost).toBe(before.lost + 1)
}
export async function restoreWindowGpu(worker: Worker) {
  const before = await windowGpuStats(worker)
  expect(before.isLost).toBe(true)
  await worker.evaluate(() =>
    (globalThis as InstrumentedGlobal).__windowGpuTest.gpu[0]!.extension!.restoreContext())
  await expect.poll(async () => (await windowGpuStats(worker)).restored).toBe(before.restored + 1)
}

/** Read the presented screenshot rather than requesting a new game context. */
export async function windowCanvasSamples(page: Page, canvas: Locator): Promise<number[][]> {
  const png = await canvas.screenshot()
  return page.evaluate(async (url) => {
    const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
      context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
    try {
      context.drawImage(bitmap, 0, 0)
      return [0.25, 0.625, 0.875].map((x) => [...context.getImageData(
        Math.floor(x * bitmap.width), Math.floor(bitmap.height / 2), 1, 1).data])
    } finally { bitmap.close() }
  }, 'data:image/png;base64,' + png.toString('base64'))
}
