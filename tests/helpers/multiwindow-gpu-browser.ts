import { expect, type Locator, type Page, type Worker } from '@playwright/test'

interface WindowGpuState {
  index: number
  gl: WebGL2RenderingContext
  canvas: OffscreenCanvas
  extension: WEBGL_lose_context | null
  lost: number
  restored: number
  programs: number
  deletedPrograms: number
  textures: number
  deletedTextures: number
  uploads: number
  draws: number
  failProgram: number
  allowRetiredRestore: boolean
  textureIds: Map<WebGLTexture, number>
}
type InstrumentedGlobal = typeof globalThis & { __windowGpuTest: WindowGpuState[] }

/** Independent test-only instrumentation: every real Window keeps its own
 * OffscreenCanvas/context record. No fault commands are added to the product. */
export async function injectWindowGpu(page: Page): Promise<void> {
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
      const records = self.__windowGpuTest = [], seen = new WeakSet();
      const get = OffscreenCanvas.prototype.getContext;
      OffscreenCanvas.prototype.getContext = function(...args) {
        const gl = get.apply(this, args);
        if (args[0] !== 'webgl2' || !gl || seen.has(gl)) return gl;
        seen.add(gl);
        const stats = { index:records.length, gl, canvas:this,
          extension:gl.getExtension('WEBGL_lose_context'), lost:0, restored:0,
          programs:0, deletedPrograms:0, textures:0, deletedTextures:0,
          uploads:0, draws:0, failProgram:0, allowRetiredRestore:false, textureIds:new Map() };
        records.push(stats);
        this.addEventListener('webglcontextlost', (event) => {
          stats.lost++; stats.textureIds.clear();
          // Permit an explicitly requested native restore even after the
          // product removed its listeners while disposing this Window.
          if (stats.allowRetiredRestore) event.preventDefault();
        });
        this.addEventListener('webglcontextrestored', () => stats.restored++);
        const program = gl.createProgram.bind(gl), deleteProgram = gl.deleteProgram.bind(gl);
        const texture = gl.createTexture.bind(gl), deleteTexture = gl.deleteTexture.bind(gl);
        const upload = gl.texImage2D.bind(gl), draw = gl.drawArrays.bind(gl);
        gl.createProgram = () => {
          stats.programs++;
          if (stats.failProgram > 0) { stats.failProgram--; return null; }
          return program();
        };
        gl.deleteProgram = (value) => { if(value)stats.deletedPrograms++; return deleteProgram(value); };
        gl.createTexture = () => {
          const value = texture();
          if(value)stats.textureIds.set(value, ++stats.textures);
          return value;
        };
        gl.deleteTexture = (value) => {
          if(value){stats.deletedTextures++;stats.textureIds.delete(value);}
          return deleteTexture(value);
        };
        gl.texImage2D = (...args) => { stats.uploads++; return upload(...args); };
        gl.drawArrays = (...args) => { stats.draws++; return draw(...args); };
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

export async function windowGpuWorker(page: Page): Promise<Worker> {
  await expect
    .poll(() => page.workers().some((worker) => worker.url().includes('/assets/session.worker-')))
    .toBe(true)
  const worker = page.workers().find((worker) => worker.url().includes('/assets/session.worker-'))!
  await expect
    .poll(() =>
      worker.evaluate(() => (globalThis as InstrumentedGlobal).__windowGpuTest?.length ?? 0),
    )
    .toBe(2)
  return worker
}

export function windowGpuContexts(worker: Worker) {
  return worker.evaluate(() =>
    (globalThis as InstrumentedGlobal).__windowGpuTest.map((state) => ({
      index: state.index,
      width: state.canvas.width,
      height: state.canvas.height,
    })),
  )
}

/** Initial attachment may render 1×1 before the VM supplies its first frame.
 * Identify the final distinctive backing dimensions, then keep the stable index. */
export async function selectWindowGpu(worker: Worker, width: number, height: number) {
  await expect
    .poll(
      async () =>
        (await windowGpuContexts(worker)).filter(
          (state) => state.width === width && state.height === height,
        ).length,
    )
    .toBe(1)
  return (await windowGpuContexts(worker)).find(
    (state) => state.width === width && state.height === height,
  )!.index
}

export function windowGpuStats(worker: Worker, index: number) {
  return worker.evaluate((index) => {
    const state = (globalThis as InstrumentedGlobal).__windowGpuTest[index]!
    return {
      index,
      width: state.canvas.width,
      height: state.canvas.height,
      lost: state.lost,
      restored: state.restored,
      programs: state.programs,
      deletedPrograms: state.deletedPrograms,
      textures: state.textures,
      deletedTextures: state.deletedTextures,
      textureIds: [...state.textureIds.values()],
      uploads: state.uploads,
      draws: state.draws,
      isLost: state.gl.isContextLost(),
      extension: !!state.extension,
    }
  }, index)
}

export async function loseWindowGpu(worker: Worker, index: number, failProgram = false) {
  const before = await windowGpuStats(worker, index)
  expect(before.extension).toBe(true)
  expect(before.isLost).toBe(false)
  await worker.evaluate(
    ({ index, failProgram }) => {
      const state = (globalThis as InstrumentedGlobal).__windowGpuTest[index]!
      if (failProgram) state.failProgram++
      state.extension!.loseContext()
    },
    { index, failProgram },
  )
  await expect.poll(async () => (await windowGpuStats(worker, index)).lost).toBe(before.lost + 1)
}

export async function restoreWindowGpu(worker: Worker, index: number) {
  const before = await windowGpuStats(worker, index)
  expect(before.isLost).toBe(true)
  await worker.evaluate((index) => {
    ;(globalThis as InstrumentedGlobal).__windowGpuTest[index]!.extension!.restoreContext()
  }, index)
  await expect
    .poll(async () => (await windowGpuStats(worker, index)).restored)
    .toBe(before.restored + 1)
}

export async function allowRetiredWindowRestore(worker: Worker, index: number) {
  await worker.evaluate((index) => {
    ;(globalThis as InstrumentedGlobal).__windowGpuTest[index]!.allowRetiredRestore = true
  }, index)
}

/** Sample the displayed canvas screenshot, not its transferred backing context. */
export async function windowCanvasSamples(page: Page, canvas: Locator): Promise<number[][]> {
  const png = await canvas.screenshot()
  return page.evaluate(
    async (url) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
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
