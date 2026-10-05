import { test, expect, type Page, type TestInfo, type Worker } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { injectWindowGpu, windowGpuWorker, windowGpuStats, selectWindowOutput,
  loseWindowGpu, restoreWindowGpu, windowCanvasSamples } from '../helpers/multiwindow-gpu-browser.ts'

// Explicit fixture colors are also the independent screenshot oracle.
const colors = [
  [208, 32, 48, 255], [32, 80, 208, 255], [32, 176, 80, 255],
  [192, 96, 32, 255], [144, 48, 192, 255], [32, 176, 192, 255],
  [192, 64, 144, 255], [112, 128, 48, 255], [64, 104, 152, 255],
]
const source = String.raw`
System.exitOnWindowClose=false;
var manyWindows=[],manyRoots=[],manyClicks=[],manyKeys=[];
var manyColors=[0xffd02030,0xff2050d0,0xff20b050,0xffc06020,0xff9030c0,
  0xff20b0c0,0xffc04090,0xff708030,0xff406898];
class ManySurface extends Window {
  var slot;
  function ManySurface(slot){
    super.Window();this.slot=slot;caption="Many GPU "+slot;
    setInnerSize(128+slot*4,72+slot*2);
    var cell=slot==8?3:slot;
    setPos((cell%4)*190,int(cell/4)*150);visible=true;
  }
  function onCloseQuery(canClose){
    if(slot==3){var self=this;invalidate self;}
    else super.onCloseQuery(canClose);
  }
}
class ManyRoot extends Layer {
  var slot;
  function ManyRoot(window,slot){
    super.Layer(window,null);this.slot=slot;type=ltOpaque;focusable=true;
    setSize(128+slot*4,72+slot*2);fillRect(0,0,width,height,global.manyColors[slot]);
  }
  function onMouseDown(x,y,button,shift){focus();}
  function onClick(x,y){
    global.manyClicks[slot]++;Debug.message("many-click="+slot+":"+global.manyClicks[slot]);
  }
  function onKeyDown(key,shift,process){
    if(key==65){global.manyKeys[slot]++;Debug.message("many-key="+slot+":"+global.manyKeys[slot]);}
  }
}
function createMany(slot){
  manyClicks[slot]=0;manyKeys[slot]=0;
  manyWindows[slot]=new ManySurface(slot);
  manyRoots[slot]=new ManyRoot(manyWindows[slot],slot);
  return manyWindows[slot].__windowId;
}
for(var i=0;i<8;i++)createMany(i);
Debug.message("many-gpu-ready=8");
`
const surface = (page: Page, slot: number) =>
  page.locator(`.game-window[data-window-id][aria-label="Many GPU ${slot}"]`)
const canvas = (page: Page, slot: number) => surface(page, slot).locator('canvas[data-window-id]')
async function assertPixels(page: Page, slots: number[]) {
  for (const slot of slots) {
    const target = canvas(page, slot)
    await target.scrollIntoViewIfNeeded()
    await expect(target).toHaveJSProperty('width', 128 + slot * 4)
    await expect(target).toHaveJSProperty('height', 72 + slot * 2)
    await expect.poll(() => windowCanvasSamples(page, target)).toEqual([colors[slot], colors[slot], colors[slot]])
  }
}
async function inputs(page: Page, slot: number, expected: number) {
  await canvas(page, slot).click({ position: { x: 12, y: 12 } })
  await expect(page.getByText(`many-click=${slot}:${expected}`, { exact: true })).toBeVisible()
  await page.keyboard.press('a')
  await expect(page.getByText(`many-key=${slot}:${expected}`, { exact: true })).toBeVisible()
}
async function ready(page: Page, starts = 1) {
  await expect(page.getByText('many-gpu-ready=8', { exact: true })).toHaveCount(starts)
  await expect(page.getByText('many-gpu-ready=8', { exact: true }).last()).toBeVisible()
  await expect(page.locator('#status')).toHaveText('运行中')
  await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
  await expect(page.locator('.game-window[data-window-id]')).toHaveCount(8)
  await expect(page.locator('.game-text-input')).toHaveCount(8)
  const ids = await page.locator('.game-window[data-window-id]').evaluateAll((elements) =>
    elements.map((element) => element.getAttribute('data-window-id')))
  expect(new Set(ids).size).toBe(8)
  const worker = await windowGpuWorker(page), stats = await windowGpuStats(worker)
  expect(stats.contexts).toBe(1)
  expect(stats.outputs).toHaveLength(8)
  expect(stats.lost).toBe(0)
  expect(stats.bitmaps.outstanding).toBe(0)
  return worker
}
async function launch(page: Page, backend: string, binary: boolean, force2D: boolean) {
  await injectWindowGpu(page, force2D)
  await page.setViewportSize({ width: 1280, height: 960 })
  await page.goto(`/?backend=${backend}`)
  await page.locator('#files').setInputFiles([
    { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
      ? 'Scripts.compileStorage("many-windows.tjs","savedata/many-windows.cjs",false,true,false);Scripts.execStorage("savedata/many-windows.cjs");'
      : 'Scripts.execStorage("many-windows.tjs");') },
    { name: 'many-windows.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
  ])
  return ready(page)
}
async function stop(page: Page, worker?: Worker) {
  if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
  await expect(page.locator('#status')).toHaveText('待机')
  await expect(page.locator('.game-window[data-window-id],canvas[data-window-id],.game-text-input')).toHaveCount(0)
  if (worker) await expect.poll(() => page.workers().includes(worker)).toBe(false)
  await expect.poll(() => page.workers().filter((entry) => entry.url().includes('/assets/session.worker-')).length).toBe(0)
  await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
  await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
}
async function finish(page: Page, info: TestInfo, worker: Worker | undefined,
  records: unknown[], errors: string[], failures: unknown[]) {
  try {
    if (worker && page.workers().includes(worker)) records.push({ phase: 'finally', stats: await windowGpuStats(worker) })
    await info.attach('many-window-gpu-ownership', { contentType: 'application/json',
      body: JSON.stringify({ records, pageErrors: errors, logs: await page.locator('#logs').innerText() }, null, 2) })
  } catch (error) { failures.push(error) }
  try { await stop(page, worker) } catch (error) { failures.push(error) }
  try { expect(errors).toEqual([]) } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Many Window scenario and cleanup failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  const mode = `${backend}/${binary ? 'bytecode' : 'source'}`
  test(`${mode}: eight real Windows keep independent pixels and input through retirement and shared GPU recovery`, async ({ page }, info) => {
    test.setTimeout(150000)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const errors: string[] = [], failures: unknown[] = [], records: unknown[] = []
    let worker: Worker | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      worker = await launch(page, backend, binary, false)
      const initial = await windowGpuStats(worker)
      records.push({ phase: 'eight-live', stats: initial })
      await assertPixels(page, [0, 1, 2, 3, 4, 5, 6, 7])
      for (let slot = 0; slot < 8; slot++) await inputs(page, slot, 1)
      await evaluate(page, 'manyClicks.join(",")+"|"+manyKeys.join(",")', '1,1,1,1,1,1,1,1|1,1,1,1,1,1,1,1')
      const retiredOutput = await selectWindowOutput(worker, 140, 78)
      await surface(page, 3).getByRole('button', { name: '关闭游戏窗口', exact: true }).click()
      await expect(surface(page, 3)).toHaveCount(0)
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(7)
      await evaluate(page, 'int(isvalid manyWindows[3])+","+int(isvalid manyRoots[3])', '0,0')
      const retired = await windowGpuStats(worker)
      expect(retired.contexts).toBe(1)
      expect(retired.lost).toBe(initial.lost)
      expect(retired.programs).toBe(initial.programs)
      expect(retired.deletedPrograms).toBe(initial.deletedPrograms)
      await assertPixels(page, [0, 1, 2, 4, 5, 6, 7])
      await evaluate(page, 'int(createMany(8)>manyWindows[7].__windowId)', '1')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(8)
      const active = [0, 1, 2, 4, 5, 6, 7, 8]
      await assertPixels(page, active)
      await inputs(page, 8, 1)
      const beforeLoss = await windowGpuStats(worker), outputIds = [] as number[]
      for (const slot of active) outputIds.push(await selectWindowOutput(worker, 128 + slot * 4, 72 + slot * 2))
      await loseWindowGpu(worker)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'lost')
      await expect(page.locator('#evaluate')).toBeDisabled()
      await assertPixels(page, active)
      const lost = await windowGpuStats(worker)
      records.push({ phase: 'shared-loss', stats: lost })
      await restoreWindowGpu(worker)
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
      await assertPixels(page, active)
      const restored = await windowGpuStats(worker)
      expect(restored.contexts).toBe(1)
      expect(restored.outputs).toHaveLength(9)
      expect(restored.programs).toBe(beforeLoss.programs + 1)
      expect(restored.uploads).toBeGreaterThan(beforeLoss.uploads)
      for (const id of outputIds) expect(restored.outputs[id]!.commits).toBeGreaterThan(lost.outputs[id]!.commits)
      expect(restored.outputs[retiredOutput]!.commits).toBe(retired.outputs[retiredOutput]!.commits)
      expect(restored.bitmaps.outstanding).toBe(0)
      for (const slot of active) await inputs(page, slot, 2)
      await evaluate(page, 'manyClicks.join(",")+"|"+manyKeys.join(",")', '2,2,2,1,2,2,2,2,2|2,2,2,1,2,2,2,2,2')
      records.push({ phase: 'restored-eight-live-one-retired', stats: restored })
      await info.attach('eight-independent-recovered-windows', { body: await page.locator('#stage').screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(page, info, worker, records, errors, failures)
  })

  test(`${mode}: eight 2D fallback outputs release a lost shared GPU on Stop and restart with fresh ownership`, async ({ page }, info) => {
    test.setTimeout(150000)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const errors: string[] = [], failures: unknown[] = [], records: unknown[] = []
    let worker: Worker | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    try {
      worker = await launch(page, backend, binary, true)
      await assertPixels(page, [0, 1, 2, 3, 4, 5, 6, 7])
      const before = await windowGpuStats(worker)
      expect(before.outputs.map((output) => output.kind)).toEqual(Array(8).fill('2d'))
      expect(before.bitmaps.created).toBeGreaterThan(0)
      expect(before.bitmaps.closed).toBe(before.bitmaps.created)
      expect(before.bitmaps.transferred).toBe(0)
      expect(before.bitmaps.outstanding).toBe(0)
      await loseWindowGpu(worker)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'lost')
      const oldWorker = worker
      records.push({ phase: 'fallback-lost-before-stop', stats: await windowGpuStats(worker) })
      await stop(page, oldWorker)
      await page.locator('#restart').click()
      worker = await ready(page, 2)
      expect(worker).not.toBe(oldWorker)
      const fresh = await windowGpuStats(worker)
      expect(fresh.outputs.map((output) => output.kind)).toEqual(Array(8).fill('2d'))
      expect(fresh.lost).toBe(0)
      expect(fresh.restored).toBe(0)
      expect(fresh.bitmaps.outstanding).toBe(0)
      await assertPixels(page, [0, 1, 2, 3, 4, 5, 6, 7])
      await evaluate(page, 'manyClicks.join(",")+"|"+manyKeys.join(",")', '0,0,0,0,0,0,0,0|0,0,0,0,0,0,0,0')
      await inputs(page, 7, 1)
      records.push({ phase: 'fresh-fallback-restart', stats: await windowGpuStats(worker) })
      await info.attach('eight-fallback-windows-after-restart', { body: await page.locator('#stage').screenshot(), contentType: 'image/png' })
    } catch (error) { failures.push(error) }
    await finish(page, info, worker, records, errors, failures)
  })
}
