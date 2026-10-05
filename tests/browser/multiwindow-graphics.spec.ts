import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { injectWindowGpu, windowGpuWorker, selectWindowOutput, windowGpuStats,
  loseWindowGpu, restoreWindowGpu, windowCanvasSamples } from '../helpers/multiwindow-gpu-browser.ts'

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
  test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
  await page.locator('#files').setInputFiles([
    { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
      ? 'Scripts.compileStorage("gpu-windows.tjs","savedata/gpu-windows.cjs",false,true,false);Scripts.execStorage("savedata/gpu-windows.cjs");'
      : 'Scripts.execStorage("gpu-windows.tjs");') },
    { name: 'gpu-windows.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
  ])
  await expect(page.getByText('multiwindow-gpu-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#status')).toHaveText('运行中')
  await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
  const a = page.locator('.game-window[data-window-id][aria-label="GPU A"]'),
    b = page.locator('.game-window[data-window-id][aria-label="GPU B"]'),
    canvasA = a.locator('canvas[data-window-id]'), canvasB = b.locator('canvas[data-window-id]')
  await expect(a).toBeVisible(); await expect(b).toBeVisible()
  await expect.poll(() => windowCanvasSamples(page, canvasA)).toEqual(colorsA)
  await expect.poll(() => windowCanvasSamples(page, canvasB)).toEqual(colorsB)
  const worker = await windowGpuWorker(page),
    outputA = await selectWindowOutput(worker, 160, 96),
    outputB = await selectWindowOutput(worker, 120, 80), before = await windowGpuStats(worker)
  expect(outputA).not.toBe(outputB)
  expect(before.contexts).toBe(1)
  expect(before.outputs).toHaveLength(2)
  expect(before.programs).toBeGreaterThan(0)
  expect(before.outputs[outputA]!.commits).toBeGreaterThan(0)
  expect(before.outputs[outputB]!.commits).toBeGreaterThan(0)
  expect(before.bitmaps.outstanding).toBe(0)
  return { worker, a, b, canvasA, canvasB, outputA, outputB, before,
    async stop() {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window[data-window-id],.game-text-input')).toHaveCount(0)
      await expect.poll(() => page.workers().includes(worker)).toBe(false)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      expect(errors).toEqual([])
    },
  }
}
async function attachStats(info: TestInfo, name: string, value: unknown) {
  await info.attach(name, { body: JSON.stringify(value, null, 2), contentType: 'application/json' })
}
async function finish(f: Awaited<ReturnType<typeof launch>>, info: TestInfo, failures: unknown[]) {
  try { await attachStats(info, 'shared-window-graphics', await windowGpuStats(f.worker)) }
  catch (error) { failures.push(error) }
  try { await f.stop() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Graphics scenario and cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const mode = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: shared GPU restoration replays both independent Window outputs before resuming`, async ({ page }, info) => {
    const f = await launch(page, backend, binary), failures: unknown[] = []
    try {
      await loseWindowGpu(f.worker)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'lost')
      await expect(page.locator('#evaluate')).toBeDisabled()
      await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
      await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
      const lost = await windowGpuStats(f.worker)
      await restoreWindowGpu(f.worker)
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
      await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
      await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
      const restored = await windowGpuStats(f.worker)
      expect(restored.contexts).toBe(1)
      expect(restored.programs).toBe(f.before.programs + 1)
      expect(restored.uploads).toBeGreaterThan(f.before.uploads)
      for (const output of [f.outputA, f.outputB])
        expect(restored.outputs[output]!.commits).toBeGreaterThan(lost.outputs[output]!.commits)
      expect(restored.bitmaps.outstanding).toBe(0)
      await evaluate(page, 'resizeB()', '144,88')
      await expect(f.canvasB).toHaveJSProperty('width', 144)
      await expect(f.canvasB).toHaveJSProperty('height', 88)
      await expect(f.canvasA).toHaveJSProperty('width', 160)
      await expect(f.canvasA).toHaveJSProperty('height', 96)
      await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(resizedB)
      await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
      await info.attach('recovered-A-composition', { body: await f.canvasA.screenshot(), contentType: 'image/png' })
      await info.attach('recovered-B-resized-composition', { body: await f.canvasB.screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(f, info, failures)
  })

  test(`${mode}: failed shared GPU reconstruction retains both Window bitmaps until explicit retry`, async ({ page }, info) => {
    const f = await launch(page, backend, binary), failures: unknown[] = []
    try {
      await loseWindowGpu(f.worker, true)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await restoreWindowGpu(f.worker)
      await expect(page.locator('#status')).toHaveText('画面恢复失败')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'failed')
      await expect(page.locator('#evaluate')).toBeDisabled()
      await expect(page.locator('#retry-graphics')).toBeVisible()
      await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
      await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
      const failed = await windowGpuStats(f.worker)
      expect(failed.programs).toBe(f.before.programs + 1)
      expect(failed.contexts).toBe(1)
      expect(failed.bitmaps.outstanding).toBe(0)
      await attachStats(info, 'failed-shared-program-retained-outputs', failed)
      await page.locator('#retry-graphics').click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
      await expect.poll(() => windowCanvasSamples(page, f.canvasA)).toEqual(colorsA)
      await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(colorsB)
      const retried = await windowGpuStats(f.worker)
      expect(retried.programs).toBe(f.before.programs + 2)
      expect(retried.uploads).toBeGreaterThan(f.before.uploads)
      for (const output of [f.outputA, f.outputB])
        expect(retried.outputs[output]!.commits).toBeGreaterThan(failed.outputs[output]!.commits)
      expect(retried.bitmaps.outstanding).toBe(0)
      await evaluate(page, '(global.Window.mainWindow===a)+","+(isvalid b)', '1,1')
    } catch (error) { failures.push(error) }
    await finish(f, info, failures)
  })

  test(`${mode}: a retired Window output cannot revive when its surviving shared GPU restores`, async ({ page }, info) => {
    const f = await launch(page, backend, binary), failures: unknown[] = []
    try {
      const oldWindowId = await f.a.getAttribute('data-window-id')
      await evaluate(page, '(a.close(),int(isvalid a))', '0')
      await expect(f.a).toHaveCount(0)
      await expect(f.b).toBeVisible()
      await expect(page.locator('#status')).toHaveText('运行中')
      const closed = await windowGpuStats(f.worker)
      expect(closed.contexts).toBe(1)
      expect(closed.isLost).toBe(false)
      expect(closed.lost).toBe(f.before.lost)
      expect(closed.programs).toBe(f.before.programs)
      expect(closed.deletedPrograms).toBe(f.before.deletedPrograms)
      await loseWindowGpu(f.worker)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await restoreWindowGpu(f.worker)
      await expect(page.locator('#status')).toHaveText('运行中')
      await evaluate(page, 'resizeB()', '144,88')
      await expect.poll(() => windowCanvasSamples(page, f.canvasB)).toEqual(resizedB)
      await evaluate(page, '(global.Window.mainWindow===null)+","+(isvalid b)', '1,1')
      const after = await windowGpuStats(f.worker)
      expect(after.contexts).toBe(1)
      expect(after.outputs).toHaveLength(2)
      expect(after.outputs[f.outputA]!.commits).toBe(closed.outputs[f.outputA]!.commits)
      expect(after.outputs[f.outputB]!.commits).toBeGreaterThan(closed.outputs[f.outputB]!.commits)
      expect(after.programs).toBe(closed.programs + 1)
      expect(after.bitmaps.outstanding).toBe(0)
      await expect(page.locator(`.game-window[data-window-id="${oldWindowId}"]`)).toHaveCount(0)
      await expect(page.locator('canvas[data-window-id]')).toHaveCount(1)
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
      await attachStats(info, 'retired-output-after-shared-restore', { closed, after })
      await info.attach('survivor-after-shared-restore', { body: await f.canvasB.screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(f, info, failures)
  })
}
