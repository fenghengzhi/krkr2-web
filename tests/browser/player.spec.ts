import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { prepareSystemPage, stopSystemPage } from '../helpers/web-system-core.ts'

for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: real TJS scene, input, pause, stop and fresh restart`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    const capabilities = await page.evaluate(() => ({
      jspi: 'Suspending' in WebAssembly && 'promising' in WebAssembly,
      webgl: !!new OffscreenCanvas(1, 1).getContext('webgl2'),
    }))
    test.skip(
      !capabilities.webgl,
      'OffscreenCanvas WebGL2 is unavailable in this browser environment',
    )
    test.skip(backend === 'jspi' && !capabilities.jspi, 'JSPI is not implemented by this browser')
    await page.getByRole('button', { name: '运行示例' }).click()
    await expect(page.locator('#logs')).toContainText('会话就绪')
    await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
    await expect(page.locator('#runtime-info')).toContainText('3 个资源')
    const canvas = page.locator('canvas')
    const before = await canvas.screenshot()
    await canvas.click({ position: { x: 120, y: 120 } })
    await expect(page.locator('#logs')).toContainText('点击 1')
    const after = await canvas.screenshot()
    expect(before.equals(after)).toBe(false)
    await page.locator('#expression').fill('6 * 7')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('42')
    await page.locator('#pause').click()
    await expect(page.locator('#status')).toHaveText('已暂停')
    await canvas.click()
    await page.locator('#pause').click()
    await canvas.click()
    await expect(page.locator('#logs')).toContainText('点击 2')
    await page.locator('#restart').click()
    await expect(page.locator('#status')).toHaveText('运行中')
    await expect(page.locator('#evaluate')).toBeEnabled()
    await page.locator('#expression').fill('clicks')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('0')
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: game-written files survive reload and backup import`, async ({ page }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI is unavailable',
    )
    const script =
      'var count=0; if(Storages.isExistentStorage("savedata/counter.txt")) count=int([].load("savedata/counter.txt")[0]); count++; [string(count)].save("savedata/counter.txt","z"); Debug.message("persistent-count="+count);'
    const file = { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(script) }
    await page.locator('#files').setInputFiles(file)
    await expect(page.locator('#logs')).toContainText('persistent-count=1')
    await expect(page.locator('#save-status')).toContainText('1 个存档文件，已保存')
    const downloaded = page.waitForEvent('download')
    await page.locator('#export-saves').click()
    const download = await downloaded
    const backup = await readFile((await download.path())!)
    expect(JSON.parse(backup.toString()).files[0].path).toBe('savedata/counter.txt')
    await page.reload()
    await page.locator('#files').setInputFiles(file)
    await expect(page.locator('#logs')).toContainText('persistent-count=2')
    await expect(page.locator('#evaluate')).toBeEnabled()
    await page.locator('#pause').click()
    await page
      .locator('#save-file')
      .setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup })
    await expect(page.locator('#logs')).toContainText('存档已导入')
    await page.locator('#pause').click()
    await page.locator('#expression').fill('[].load("savedata/counter.txt")[0]')
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs p span').last()).toHaveText('1')
  })

test('a missing startup script reports a useful error and allows recovery', async ({ page }) => {
  await page.goto('/')
  await page.locator('#files').setInputFiles({
    name: 'readme.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('not a game'),
  })
  await expect(page.locator('#logs')).toContainText('ストレージ startup.tjs が見つかりません')
  await expect(page.locator('#choose-files')).toBeEnabled()
})

test('stop cancels a running TJS loop without freezing the page', async ({ page }) => {
  await page.goto('/?backend=asyncify')
  await page.locator('#files').setInputFiles({
    name: 'startup.tjs',
    mimeType: 'text/plain',
    buffer: Buffer.from('while(true) {}'),
  })
  await expect(page.locator('#status')).toHaveText('运行中')
  await page.locator('#stop').click()
  await expect(page.locator('#stop')).toBeDisabled()
  await expect(page.locator('#choose-files')).toBeEnabled()
  await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
})

type PaletteFailureWindow = typeof window & {
  __paletteStartupFailure?: {
    attempts: number
    injected: boolean
    canvas?: HTMLCanvasElement
    probes: HTMLElement[]
    requestedSize?: number[]
    restore(): void
  }
}

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: synchronous palette failure releases startup hosts and permits a real Worker restart`, async ({
    page,
  }, info) => {
    const setup = await prepareSystemPage(page, backend)
    await page.evaluate(() => {
      const prototype = CanvasRenderingContext2D.prototype,
        original = Object.getOwnPropertyDescriptor(prototype, 'getImageData')!,
        state: NonNullable<PaletteFailureWindow['__paletteStartupFailure']> = {
          attempts: 0,
          injected: false,
          probes: [],
          restore() {
            Object.defineProperty(prototype, 'getImageData', original)
          },
        }
      ;(window as PaletteFailureWindow).__paletteStartupFailure = state
      Object.defineProperty(prototype, 'getImageData', {
        ...original,
        value: new Proxy(original.value, {
          apply(target, receiver: CanvasRenderingContext2D, args: unknown[]) {
            const probes = Array.from(document.querySelectorAll<HTMLElement>('span')).filter(
              (element) =>
                element.style.visibility === 'hidden' &&
                element.style.pointerEvents === 'none' &&
                element.style.transitionProperty === 'none' &&
                element.style.animationName === 'none',
            )
            if (
              receiver.canvas.width === 1 &&
              receiver.canvas.height === 1 &&
              args[0] === 0 &&
              args[1] === 0 &&
              args[2] === 1 &&
              args[3] === 1 &&
              probes.length === 1
            ) {
              state.attempts++
              if (!state.injected) {
                state.injected = true
                state.canvas = receiver.canvas
                state.probes = probes
                state.requestedSize = [receiver.canvas.width, receiver.canvas.height]
                // Deliberate API fault injection, not a replay or simulation of
                // the WebKit resource failure. Every other read remains native.
                throw new DOMException('palette-startup-readback-failure', 'InvalidStateError')
              }
            }
            return Reflect.apply(target, receiver, args)
          },
        }),
      })
    })
    try {
      await page.locator('#files').setInputFiles({
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(
          'var recoveryWindow=new Window();recoveryWindow.setInnerSize(80,40);recoveryWindow.visible=true;var recoveryLayer=new Layer(recoveryWindow,null);recoveryLayer.setSize(80,40);recoveryLayer.fillRect(0,0,80,40,0xff193d57);Debug.message("palette-startup-real-worker-ready");',
        ),
      })
      await expect(
        page.getByText('palette-startup-readback-failure', { exact: true }),
      ).toBeVisible()
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect(page.locator('#load-url')).toBeEnabled()
      await expect(page.locator('#restart')).toBeEnabled()
      await expect(page.locator('#evaluate')).toBeDisabled()
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(page.locator('#stage')).not.toHaveClass(/game-desktop/)
      await expect(page.locator('#stage canvas')).toHaveCount(0)
      await expect(page.locator('.game-pad, .game-window, .game-text-input')).toHaveCount(0)
      await expect(
        page.getByText('palette-startup-real-worker-ready', { exact: true }),
      ).toHaveCount(0)
      expect(setup.workers).toHaveLength(0)
      const failed = await page.evaluate(() => {
        const state = (window as PaletteFailureWindow).__paletteStartupFailure!
        return {
          attempts: state.attempts,
          injected: state.injected,
          requestedSize: state.requestedSize,
          releasedSize: [state.canvas?.width, state.canvas?.height],
          probesConnected: state.probes.map((probe) => probe.isConnected),
        }
      })
      await info.attach('injected-palette-startup-failure-cleanup', {
        contentType: 'application/json',
        body: JSON.stringify({ backend, failed, sessionWorkers: setup.workers.length }, null, 2),
      })
      expect(failed).toEqual({
        attempts: 1,
        injected: true,
        requestedSize: [1, 1],
        releasedSize: [0, 0],
        probesConnected: [false],
      })
      await page.evaluate(() => {
        ;(window as PaletteFailureWindow).__paletteStartupFailure!.restore()
      })
      // User-selected restart runs the same retained file through unmodified
      // browser APIs, the shipped Worker, and the real requested native VM.
      await page.locator('#restart').click()
      await expect(
        page.getByText('palette-startup-real-worker-ready', { exact: true }),
      ).toBeVisible()
      await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
      await expect(page.locator('#evaluate')).toBeEnabled()
      expect(setup.workers).toHaveLength(1)
      await page.locator('#expression').fill('recoveryLayer.getMainPixel(0,0)')
      await page.locator('#evaluate').click()
      await expect(page.locator('#logs p span').last()).toHaveText(String(0x193d57))
      await stopSystemPage(page, setup.errors)
      await expect.poll(() => setup.workers.every((worker) => worker.closed)).toBe(true)
      await expect(
        page.getByText('palette-startup-readback-failure', { exact: true }),
      ).toBeVisible()
    } finally {
      const finalFailure = await page.evaluate(() => {
        const state = (window as PaletteFailureWindow).__paletteStartupFailure
        state?.restore()
        return state
          ? {
              attempts: state.attempts,
              injected: state.injected,
              requestedSize: state.requestedSize,
              releasedSize: [state.canvas?.width, state.canvas?.height],
              probesConnected: state.probes.map((probe) => probe.isConnected),
            }
          : null
      })
      await info.attach('palette-startup-recovery-final-observation', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            backend,
            injectedBoundary: finalFailure,
            workers: setup.workers.map(({ url, closed }) => ({ url, closed })),
            errors: setup.errors,
            logs: await page.locator('#logs').innerText(),
          },
          null,
          2,
        ),
      })
    }
  })
