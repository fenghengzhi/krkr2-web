import { test, expect, type Page } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  injectGpu,
  gpuWorker,
  gpuStats,
  loseGpu,
  restoreGpu,
  canvasSamples,
} from '../helpers/gpu-browser.ts'
import { readFile, mkdir } from 'node:fs/promises'

const source = String.raw`
var window=new Window();window.visible=true;window.setInnerSize(8,4);
var root=new Layer(window,null),left=new Layer(window,root),group=new Layer(window,root),child=new Layer(window,group);
root.setSize(8,4);root.fillRect(0,0,8,4,0xff000000);
left.setSize(4,4);left.visible=true;left.opacity=128;left.fillRect(0,0,4,4,0xffff0000);
group.setSize(4,4);group.left=4;group.visible=true;group.opacity=128;group.fillRect(0,0,4,4,0xff0000ff);
child.setSize(2,4);child.left=2;child.visible=true;child.fillRect(0,0,2,4,0xff00ff00);
var clicks=0;left.onClick=function(){clicks++;Debug.message("gpu-click="+clicks);};
["checkpoint"].save("savedata/checkpoint.txt","utf-8");Debug.message("gpu-ready");
`
const colors = [
  [128, 0, 0, 255],
  [0, 0, 128, 255],
  [0, 128, 0, 255],
]
async function load(page: Page, backend: string) {
  await injectGpu(page)
  await page.goto(`/?backend=${backend}`)
  await page
    .locator('#files')
    .setInputFiles({ name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) })
  await expect(page.locator('#logs')).toContainText('gpu-ready')
  const worker = await gpuWorker(page)
  await expect(page.locator('#choose-files')).toBeEnabled()
  return worker
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: a context lost during construction resumes the pending original startup`, async ({
    page,
  }, testInfo) => {
    const startup =
      String.raw`
if(typeof global.gpuStartupRuns=="undefined")global.gpuStartupRuns=0;
global.gpuStartupRuns++;
var gpuWindowReturns=0,gpuStartupEvents=0;
var gpuStartupTrigger=new AsyncTrigger(function(){global.gpuStartupEvents++;Debug.message("gpu-startup-event="+global.gpuStartupEvents);},"");
gpuStartupTrigger.trigger();Debug.message("gpu-startup-begin="+global.gpuStartupRuns);
` +
      source.replace(
        'var window=new Window();',
        'var window=new Window();gpuWindowReturns++;Debug.message("gpu-window-returned");',
      )
    // Window construction waits for its own surface. The real getContext fault
    // must hold the original constructor before subsequent Layer allocations;
    // no post-constructor resource read or held surface request is needed.
    await injectGpu(page, false, true)
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(startup),
    })
    await expect(page.locator('#status')).toHaveText('等待画面恢复')
    const worker = await gpuWorker(page)
    await expect.poll(async () => (await gpuStats(worker)).lost).toBe(1)
    const suspended = await gpuStats(worker)
    expect(suspended.isLost).toBe(true)
    expect(suspended.restored).toBe(0)
    await expect(page.locator('#status')).toHaveText('等待画面恢复')
    await expect(page.locator('#evaluate')).toBeDisabled()
    await expect(page.locator('#logs')).toContainText('gpu-startup-begin=1')
    await expect(page.locator('#logs')).not.toContainText('gpu-window-returned')
    await expect(page.locator('#logs')).not.toContainText('gpu-ready')
    await expect(page.locator('#logs')).not.toContainText('gpu-startup-event=')
    await testInfo.attach('constructor-suspended-with-context-lost', {
      body: JSON.stringify(suspended),
      contentType: 'application/json',
    })
    await restoreGpu(worker)
    await expect(page.locator('#logs')).toContainText('gpu-window-returned')
    await expect(page.locator('#logs')).toContainText('gpu-ready')
    await expect(page.locator('#logs')).toContainText('gpu-startup-event=1')
    await expect(page.locator('#status')).toHaveText('运行中')
    expect(await gpuWorker(page)).toBe(worker)
    await expect(page.locator('#logs p').filter({ hasText: 'gpu-startup-begin=' })).toHaveCount(1)
    await expect(page.locator('#logs p').filter({ hasText: 'gpu-window-returned' })).toHaveCount(1)
    await expect(page.locator('#logs p').filter({ hasText: 'gpu-ready' })).toHaveCount(1)
    expect(await canvasSamples(page)).toEqual(colors)
    await evaluate(
      page,
      '[gpuStartupRuns,gpuWindowReturns,gpuStartupEvents,clicks].join(",")',
      '1,1,1,0',
    )
    await page.locator('#stop').click()
  })

  test(`${backend}: choosing to stay paused during context loss survives automatic restoration`, async ({
    page,
  }) => {
    const worker = await load(page, backend)
    await expect(page.locator('#status')).toHaveText('运行中')
    await loseGpu(worker)
    await expect(page.locator('#pause')).toHaveText('保持暂停')
    await page.locator('#pause').click()
    await restoreGpu(worker)
    await expect(page.locator('#status')).toHaveText('已暂停')
    expect(await canvasSamples(page)).toEqual(colors)
    await page.locator('#pause').click()
    await evaluate(page, 'clicks', '0')
    await page.locator('#stop').click()
  })

  test(`${backend}: stopping a lost context closes its Worker and a new session owns fresh graphics`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const worker = await load(page, backend)
    await expect(page.locator('#status')).toHaveText('运行中')
    await loseGpu(worker)
    await expect(page.locator('#status')).toHaveText('等待画面恢复')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    await expect.poll(() => page.workers().includes(worker)).toBe(false)
    await page.locator('#restart').click()
    await expect(page.locator('#status')).toHaveText('运行中')
    expect(await gpuWorker(page)).not.toBe(worker)
    expect(await canvasSamples(page)).toEqual(colors)
    await evaluate(page, 'clicks', '0')
    expect(errors).toEqual([])
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await page.locator('#stop').click()
  })

  test(`${backend}: repeated native context restoration reuploads unchanged CPU images and preserves input`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const worker = await load(page, backend)
    await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
    expect(await canvasSamples(page)).toEqual(colors)
    for (let i = 0; i < 2; i++) {
      const before = await gpuStats(worker)
      await loseGpu(worker)
      await expect(page.locator('#status')).toHaveText('等待画面恢复')
      await expect(page.locator('#evaluate')).toBeDisabled()
      await restoreGpu(worker)
      await expect(page.locator('#status')).toHaveText('运行中')
      expect(await canvasSamples(page)).toEqual(colors)
      expect((await gpuStats(worker)).uploads).toBeGreaterThan(before.uploads)
      expect((await gpuStats(worker)).programs).toBe(before.programs + 1)
    }
    await evaluate(page, 'clicks', '0')
    await page.locator('canvas').click({ position: { x: 1, y: 1 } })
    await expect(page.locator('#logs')).toContainText('gpu-click=1')
    await evaluate(page, 'left.getMainPixel(0,0)', '16711680')
    expect(errors).toEqual([])
    await page.locator('#stop').click()
  })

  test(`${backend}: loss inside texture upload suspends startup output and retries the same frame`, async ({
    page,
  }) => {
    await injectGpu(page, true)
    await page.goto(`/?backend=${backend}`)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source),
    })
    // The render timer can upload at any VM yield, before startup's final log.
    // Restore the fault before waiting for script completion or enabled controls.
    await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'lost')
    await expect(page.locator('#status')).toHaveText('等待画面恢复')
    const worker = await gpuWorker(page)
    await expect.poll(async () => (await gpuStats(worker)).lost).toBe(1)
    const before = await gpuStats(worker)
    expect(before.uploads).toBeGreaterThan(0)
    await restoreGpu(worker)
    await expect(page.locator('#logs')).toContainText('gpu-ready')
    await expect(page.locator('#choose-files')).toBeEnabled()
    await expect(page.locator('#status')).toHaveText('运行中')
    expect(await canvasSamples(page)).toEqual(colors)
    const after = await gpuStats(worker)
    expect(after.uploads).toBeGreaterThan(before.uploads)
    expect(after.programs).toBe(before.programs + 1)
    await evaluate(page, 'clicks', '0')
    await page.locator('#stop').click()
  })

  for (const failure of ['program', 'texture'] as const)
    test(`${backend}: ${failure} reconstruction failure retains saves and user pause until explicit retry`, async ({
      page,
    }, testInfo) => {
      const worker = await load(page, backend)
      await expect(page.locator('#status')).toHaveText('运行中')
      await page.locator('#pause').click()
      await loseGpu(worker, failure)
      await restoreGpu(worker)
      await expect(page.locator('#status')).toHaveText('画面恢复失败')
      await expect(page.locator('#retry-graphics')).toBeVisible()
      if (failure === 'program' && backend === 'asyncify') {
        await page.setViewportSize({ width: 375, height: 800 })
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        )
        await mkdir('out/verification/graphics', { recursive: true })
        await page
          .locator('.stage-panel')
          .screenshot({ path: `out/verification/graphics/retry-${testInfo.project.name}.png` })
      }
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.locator('#export-saves').click(),
      ])
      expect(JSON.parse(await readFile((await download.path())!, 'utf8')).files[0].path).toBe(
        'savedata/checkpoint.txt',
      )
      await page.locator('#retry-graphics').click()
      await expect(page.locator('#stage')).toHaveAttribute('data-graphics', 'ready')
      await expect(page.locator('#status')).toHaveText('已暂停')
      expect(await canvasSamples(page)).toEqual(colors)
      await page.locator('#pause').click()
      await evaluate(page, 'clicks', '0')
      await page.locator('#stop').click()
    })
}
