import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  injectWindowGpu,
  windowGpuWorker,
  windowGpuContexts,
  selectWindowGpu,
  windowGpuStats,
  loseWindowGpu,
  restoreWindowGpu,
  allowRetiredWindowRestore,
  windowCanvasSamples,
} from '../helpers/multiwindow-gpu-browser.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var a=new Window();a.caption="GPU A";a.setInnerSize(160,96);a.setPos(0,0);a.visible=true;
var rootA=new Layer(a,null),leftA=new Layer(a,rootA),groupA=new Layer(a,rootA),childA=new Layer(a,groupA);
rootA.type=ltOpaque;rootA.setSize(160,96);rootA.fillRect(0,0,160,96,0xff000000);
leftA.setSize(80,96);leftA.visible=true;leftA.opacity=128;leftA.fillRect(0,0,80,96,0xffff0000);
groupA.setSize(80,96);groupA.left=80;groupA.visible=true;groupA.opacity=128;groupA.fillRect(0,0,80,96,0xff0000ff);
childA.setSize(40,96);childA.left=40;childA.visible=true;childA.fillRect(0,0,40,96,0xff00ff00);
var b=new Window();b.caption="GPU B";b.setInnerSize(120,80);b.setPos(220,0);b.visible=true;
var rootB=new Layer(b,null),leftB=new Layer(b,rootB),middleB=new Layer(b,rootB),rightB=new Layer(b,rootB);
rootB.type=ltOpaque;rootB.setSize(120,80);rootB.fillRect(0,0,120,80,0xff102030);
leftB.setSize(60,80);leftB.visible=true;leftB.fillRect(0,0,60,80,0xff2040cc);
middleB.setSize(30,80);middleB.left=60;middleB.visible=true;middleB.fillRect(0,0,30,80,0xff40c020);
rightB.setSize(30,80);rightB.left=90;rightB.visible=true;rightB.fillRect(0,0,30,80,0xffcc8040);
function resizeB(){
  b.setInnerSize(144,88);rootB.setSize(144,88);rootB.fillRect(0,0,144,88,0xff102030);
  leftB.setSize(72,88);leftB.fillRect(0,0,72,88,0xff40cc80);
  middleB.setSize(36,88);middleB.left=72;middleB.fillRect(0,0,36,88,0xff8020cc);
  rightB.setSize(36,88);rightB.left=108;rightB.fillRect(0,0,36,88,0xffcc2040);
  return b.innerWidth+","+b.innerHeight;
}
Debug.message("multiwindow-gpu-ready");
`
const colorsA = [
    [128, 0, 0, 255],
    [0, 0, 128, 255],
    [0, 128, 0, 255],
  ],
  colorsB = [
    [32, 64, 204, 255],
    [64, 192, 32, 255],
    [204, 128, 64, 255],
  ],
  resizedB = [
    [64, 204, 128, 255],
    [128, 32, 204, 255],
    [204, 32, 64, 255],
  ]

async function launch(page: Page, backend: string, binary: boolean) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await injectWindowGpu(page)
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("gpu-windows.tjs","savedata/gpu-windows.cjs",false,true,false);Scripts.execStorage("savedata/gpu-windows.cjs");'
          : 'Scripts.execStorage("gpu-windows.tjs");',
      ),
    },
    { name: 'gpu-windows.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
  ])
  await expect(page.getByText('multiwindow-gpu-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#status')).toHaveText('运行中')
  await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
  const a = page.locator('.game-window[data-window-id][aria-label="GPU A"]'),
    b = page.locator('.game-window[data-window-id][aria-label="GPU B"]'),
    canvasA = a.locator('canvas[data-window-id]'),
    canvasB = b.locator('canvas[data-window-id]')
  await expect(a).toBeVisible()
  await expect(b).toBeVisible()
  await expect(canvasA).toHaveJSProperty('width', 160)
  await expect(canvasA).toHaveJSProperty('height', 96)
  await expect(canvasB).toHaveJSProperty('width', 120)
  await expect(canvasB).toHaveJSProperty('height', 80)
  await expect.poll(() => windowCanvasSamples(page, canvasA)).toEqual(colorsA)
  await expect.poll(() => windowCanvasSamples(page, canvasB)).toEqual(colorsB)
  const worker = await windowGpuWorker(page),
    gpuA = await selectWindowGpu(worker, 160, 96),
    gpuB = await selectWindowGpu(worker, 120, 80)
  expect(gpuA).not.toBe(gpuB)
  const beforeA = await windowGpuStats(worker, gpuA),
    beforeB = await windowGpuStats(worker, gpuB)
  expect(beforeA.programs).toBeGreaterThan(0)
  expect(beforeB.programs).toBeGreaterThan(0)
  expect(beforeA.textureIds.length).toBeGreaterThan(0)
  expect(beforeB.textureIds.length).toBeGreaterThan(0)
  return {
    worker,
    a,
    b,
    canvasA,
    canvasB,
    gpuA,
    gpuB,
    beforeA,
    beforeB,
    async stop() {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect.poll(() => page.workers().includes(worker)).toBe(false)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      expect(errors).toEqual([])
    },
  }
}

function retainedResources(
  actual: Awaited<ReturnType<typeof windowGpuStats>>,
  baseline: typeof actual,
) {
  expect(actual.programs).toBe(baseline.programs)
  expect(actual.deletedPrograms).toBe(baseline.deletedPrograms)
  expect(actual.uploads).toBe(baseline.uploads)
  expect(actual.textureIds).toEqual(baseline.textureIds)
  expect(actual.deletedTextures).toBe(baseline.deletedTextures)
  expect(actual.isLost).toBe(false)
}

async function attachStats(testInfo: TestInfo, name: string, value: unknown) {
  await testInfo.attach(name, {
    body: Buffer.from(JSON.stringify(value, null, 2)),
    contentType: 'application/json',
  })
}

for (const backend of ['asyncify', 'jspi'])
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: two real GPU contexts recover independently and only the last recovery resumes the session`, async ({
      page,
    }, testInfo) => {
      const f = await launch(page, backend, binary)
      try {
        await attachStats(testInfo, 'initial-context-resources', { a: f.beforeA, b: f.beforeB })
        await loseWindowGpu(f.worker, f.gpuA)
        await expect(page.locator('#status')).toHaveText('等待画面恢复')
        await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'lost')
        await expect(page.locator('#evaluate')).toBeDisabled()
        await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
        retainedResources(await windowGpuStats(f.worker, f.gpuB), f.beforeB)
        await loseWindowGpu(f.worker, f.gpuB)
        await restoreWindowGpu(f.worker, f.gpuA)
        await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
        const restoredA = await windowGpuStats(f.worker, f.gpuA)
        expect(restoredA.programs).toBe(f.beforeA.programs + 1)
        expect(restoredA.uploads).toBeGreaterThan(f.beforeA.uploads)
        expect(restoredA.width).toBe(160)
        expect(restoredA.height).toBe(96)
        await expect(page.locator('#status')).toHaveText('等待画面恢复')
        await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'lost')
        await expect(page.locator('#evaluate')).toBeDisabled()
        expect((await windowGpuStats(f.worker, f.gpuB)).isLost).toBe(true)
        await restoreWindowGpu(f.worker, f.gpuB)
        await expect(page.locator('#status')).toHaveText('运行中')
        await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
        await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
        await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
        retainedResources(await windowGpuStats(f.worker, f.gpuA), restoredA)
        const restoredB = await windowGpuStats(f.worker, f.gpuB)
        expect(restoredB.programs).toBe(f.beforeB.programs + 1)
        expect(restoredB.uploads).toBeGreaterThan(f.beforeB.uploads)
        expect(restoredB.width).toBe(120)
        expect(restoredB.height).toBe(80)
        await evaluate(page, 'resizeB()', '144,88')
        await expect(f.canvasB).toHaveJSProperty('width', 144)
        await expect(f.canvasB).toHaveJSProperty('height', 88)
        await expect(f.canvasA).toHaveJSProperty('width', 160)
        await expect(f.canvasA).toHaveJSProperty('height', 96)
        await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(resizedB)
        await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
        retainedResources(await windowGpuStats(f.worker, f.gpuA), restoredA)
        expect((await windowGpuContexts(f.worker)).length).toBe(2)
        await attachStats(testInfo, 'independent-recovered-contexts', {
          a: await windowGpuStats(f.worker, f.gpuA),
          b: await windowGpuStats(f.worker, f.gpuB),
        })
        await testInfo.attach('recovered-A-composition', {
          body: await f.canvasA.screenshot(),
          contentType: 'image/png',
        })
        await testInfo.attach('recovered-B-resized-composition', {
          body: await f.canvasB.screenshot(),
          contentType: 'image/png',
        })
      } finally {
        await f.stop()
      }
    })

    test(`${mode}: retrying one failed GPU program preserves the healthy Window's textures and image`, async ({
      page,
    }, testInfo) => {
      const f = await launch(page, backend, binary)
      try {
        await loseWindowGpu(f.worker, f.gpuA, true)
        await expect(page.locator('#status')).toHaveText('等待画面恢复')
        await restoreWindowGpu(f.worker, f.gpuA)
        await expect(page.locator('#status')).toHaveText('画面恢复失败')
        await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'failed')
        await expect(page.locator('#evaluate')).toBeDisabled()
        await expect(page.locator('#retry-graphics')).toBeVisible()
        const failedPhaseB = await windowGpuStats(f.worker, f.gpuB)
        // A's unpresented frame keeps presentation pending. Observe B using its
        // retained textures during that failure, rather than only an old image.
        await expect
          .poll(async () => (await windowGpuStats(f.worker, f.gpuB)).draws)
          .toBeGreaterThan(failedPhaseB.draws)
        await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
        retainedResources(await windowGpuStats(f.worker, f.gpuB), f.beforeB)
        const failedA = await windowGpuStats(f.worker, f.gpuA)
        expect(failedA.programs).toBe(f.beforeA.programs + 1)
        expect(failedA.textureIds).toEqual([])
        await attachStats(testInfo, 'A-failed-with-B-retained', {
          a: failedA,
          b: await windowGpuStats(f.worker, f.gpuB),
        })
        await page.locator('#retry-graphics').click()
        await expect(page.locator('#status')).toHaveText('运行中')
        await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
        await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
        await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
        const retriedA = await windowGpuStats(f.worker, f.gpuA)
        expect(retriedA.programs).toBe(f.beforeA.programs + 2)
        expect(retriedA.uploads).toBeGreaterThan(f.beforeA.uploads)
        retainedResources(await windowGpuStats(f.worker, f.gpuB), f.beforeB)
        await evaluate(page, '(global.Window.mainWindow===a)+","+(isvalid b)', '1,1')
        await attachStats(testInfo, 'A-retried-with-B-retained', {
          a: retriedA,
          b: await windowGpuStats(f.worker, f.gpuB),
        })
      } finally {
        await f.stop()
      }
    })

    test(`${mode}: a native restore arriving after Window disposal cannot rebuild its retired GPU or disturb its survivor`, async ({
      page,
    }, testInfo) => {
      const f = await launch(page, backend, binary)
      try {
        const oldWindowId = await f.a.getAttribute('data-window-id')
        await allowRetiredWindowRestore(f.worker, f.gpuA)
        await evaluate(page, '(a.close(),int(isvalid a))', '0')
        await expect(f.a).toHaveCount(0)
        await expect(f.b).toBeVisible()
        await expect(page.locator('#status')).toHaveText('运行中')
        await expect
          .poll(async () => (await windowGpuStats(f.worker, f.gpuA)).lost)
          .toBe(f.beforeA.lost + 1)
        const closedA = await windowGpuStats(f.worker, f.gpuA)
        expect(closedA.isLost).toBe(true)
        expect(closedA.programs).toBe(f.beforeA.programs)
        expect(closedA.deletedPrograms).toBe(f.beforeA.deletedPrograms + 1)
        expect(closedA.textureIds).toEqual([])
        retainedResources(await windowGpuStats(f.worker, f.gpuB), f.beforeB)
        // The test listener permits a real extension-driven restoration on the
        // retired context; the product's own listeners have already been removed.
        await restoreWindowGpu(f.worker, f.gpuA)
        await evaluate(page, 'resizeB()', '144,88')
        await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(resizedB)
        await evaluate(page, '(global.Window.mainWindow===null)+","+(isvalid b)', '1,1')
        const lateA = await windowGpuStats(f.worker, f.gpuA),
          survivingB = await windowGpuStats(f.worker, f.gpuB)
        expect(lateA.restored).toBe(closedA.restored + 1)
        expect(lateA.isLost).toBe(false)
        expect(lateA.programs).toBe(closedA.programs)
        expect(lateA.uploads).toBe(closedA.uploads)
        expect(lateA.draws).toBe(closedA.draws)
        expect(lateA.textureIds).toEqual([])
        expect(survivingB.programs).toBe(f.beforeB.programs)
        expect(survivingB.textureIds).toEqual(f.beforeB.textureIds)
        expect(survivingB.uploads).toBeGreaterThan(f.beforeB.uploads)
        expect(survivingB.draws).toBeGreaterThan(f.beforeB.draws)
        expect((await windowGpuContexts(f.worker)).length).toBe(2)
        await expect(page.locator(`.game-window[data-window-id="${oldWindowId}"]`)).toHaveCount(0)
        await expect(page.locator('canvas[data-window-id]')).toHaveCount(1)
        await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
        await attachStats(testInfo, 'late-native-restore-after-retirement', {
          closedA,
          lateA,
          survivingB,
        })
        await testInfo.attach('survivor-after-late-restore', {
          body: await f.canvasB.screenshot(),
          contentType: 'image/png',
        })
      } finally {
        await f.stop()
      }
    })
  }
