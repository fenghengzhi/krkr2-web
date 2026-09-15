import { expect, type Page, type Worker } from '@playwright/test'

interface GpuState {
  gl: WebGL2RenderingContext
  extension: WEBGL_lose_context | null
  canvas: OffscreenCanvas
  lost: number
  restored: number
  programs: number
  uploads: number
  draws: number
  failProgram: number
  failTexture: number
  loseOnUpload: boolean
  startupGateReads: number
  startupGateReturns: number
  releaseStartupGate?: () => void
}
type InstrumentedGlobal = typeof globalThis & { __gpuTest: GpuState }

/** Test-only Worker instrumentation; production has no GPU fault command. */
export async function injectGpu(
  page: Page,
  loseOnUpload = false,
  loseAtCreation = false,
  startupGate?: string,
): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(input: string | URL, options?: WorkerOptions) {
        const url = new URL(input, location.href)
        if (url.pathname.includes('/assets/session.worker-'))
          url.searchParams.set('gpu-test', crypto.randomUUID())
        super(url, options)
      }
    }
  })
  await page.route('**/assets/session.worker-*.js*', async (route) => {
    const response = await route.fetch()
    const instrumentation = `(() => {
      const stats = self.__gpuTest = { lost:0, restored:0, programs:0, uploads:0, draws:0,
        failProgram:0, failTexture:0, loseOnUpload:${loseOnUpload}, startupGateReads:0, startupGateReturns:0 };
      const startupGate = ${JSON.stringify(startupGate ?? null)};
      if (startupGate !== null) {
        let heldRequest, heldOnce = false;
        const post = MessagePort.prototype.postMessage;
        MessagePort.prototype.postMessage = function(message, ...transfer) {
          if (!heldOnce && message?.type === 'request' &&
              [message.generation, message.windowId, message.surfaceEpoch].every(value => Number.isSafeInteger(value) && value > 0)) {
            heldOnce = true;
            heldRequest = () => post.call(this, message, ...transfer);
            return;
          }
          return post.call(this, message, ...transfer);
        };
        const read = Blob.prototype.arrayBuffer;
        Blob.prototype.arrayBuffer = async function() {
          const bytes = await read.call(this);
          if (heldRequest && new TextDecoder().decode(bytes) === startupGate) {
            stats.startupGateReads++;
            const pending = new Promise(resolve => { stats.releaseStartupGate = resolve; });
            const request = heldRequest;
            heldRequest = undefined;
            request();
            await pending;
            stats.startupGateReturns++;
          }
          return bytes;
        };
      }
      const get = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function(...args) {
        const gl = get.apply(this,args);
        if (args[0] !== 'webgl2' || !gl || stats.gl) return gl;
        stats.gl = gl; stats.canvas = this; stats.extension = gl.getExtension('WEBGL_lose_context');
        this.addEventListener('webglcontextlost', () => stats.lost++);
        this.addEventListener('webglcontextrestored', () => stats.restored++);
        const program = gl.createProgram.bind(gl), texture = gl.createTexture.bind(gl);
        const upload = gl.texImage2D.bind(gl), draw = gl.drawArrays.bind(gl);
        gl.createProgram = () => { stats.programs++; if(stats.failProgram>0){stats.failProgram--;return null;} return program(); };
        gl.createTexture = () => { if(stats.failTexture>0){stats.failTexture--;return null;} return texture(); };
        gl.texImage2D = (...args) => { stats.uploads++; if(stats.loseOnUpload){stats.loseOnUpload=false;stats.extension.loseContext();} return upload(...args); };
        gl.drawArrays = (...args) => { stats.draws++; return draw(...args); };
        if (${loseAtCreation}) stats.extension.loseContext();
        return gl;
      };
    })();`
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'cache-control': 'no-store' },
      body: instrumentation + '\n' + (await response.text()),
    })
  })
}
export async function gpuWorker(page: Page): Promise<Worker> {
  await expect
    .poll(() => page.workers().some((worker) => worker.url().includes('/assets/session.worker-')))
    .toBe(true)
  const worker = page.workers().find((worker) => worker.url().includes('/assets/session.worker-'))!
  await expect
    .poll(() => worker.evaluate(() => !!(globalThis as InstrumentedGlobal).__gpuTest?.gl))
    .toBe(true)
  return worker
}
export function gpuStats(worker: Worker) {
  return worker.evaluate(() => {
    const {
      gl,
      extension,
      lost,
      restored,
      programs,
      uploads,
      draws,
      startupGateReads,
      startupGateReturns,
    } = (globalThis as InstrumentedGlobal).__gpuTest
    return {
      lost,
      restored,
      programs,
      uploads,
      draws,
      startupGateReads,
      startupGateReturns,
      isLost: gl.isContextLost(),
      extension: !!extension,
    }
  })
}
/** Complete the real startup read while the GPU is still lost, outside the VM queue. */
export async function releaseGpuStartupGate(worker: Worker): Promise<void> {
  await worker.evaluate(async () => {
    const state = (globalThis as InstrumentedGlobal).__gpuTest
    if (!state.releaseStartupGate || state.startupGateReads !== 1)
      throw new Error('The pending startup read was not reached')
    state.releaseStartupGate()
    state.releaseStartupGate = undefined
    // Drain I/O continuations and a Worker task turn. A broken pause checkpoint
    // can now advance startup; the test checks its output before restoring GPU.
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
  })
  await expect.poll(async () => (await gpuStats(worker)).startupGateReturns).toBe(1)
}
export async function loseGpu(worker: Worker, failure?: 'program' | 'texture') {
  const before = await gpuStats(worker)
  expect(before.extension).toBe(true)
  await worker.evaluate((failure) => {
    const state = (globalThis as InstrumentedGlobal).__gpuTest
    if (failure === 'program') state.failProgram = 1
    if (failure === 'texture') state.failTexture = 1
    state.extension!.loseContext()
  }, failure)
  await expect.poll(async () => (await gpuStats(worker)).lost).toBe(before.lost + 1)
}
export async function restoreGpu(worker: Worker) {
  const before = await gpuStats(worker)
  await worker.evaluate(() =>
    (globalThis as InstrumentedGlobal).__gpuTest.extension!.restoreContext(),
  )
  await expect.poll(async () => (await gpuStats(worker)).restored).toBe(before.restored + 1)
}
export async function canvasSamples(page: Page): Promise<number[][]> {
  const png = await page.locator('canvas').screenshot()
  return page.evaluate(
    async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob())
      const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const colors = [0.25, 0.625, 0.875].map((x) => [
        ...context.getImageData(Math.floor(x * bitmap.width), Math.floor(bitmap.height / 2), 1, 1)
          .data,
      ])
      bitmap.close()
      return colors
    },
    'data:image/png;base64,' + png.toString('base64'),
  )
}
