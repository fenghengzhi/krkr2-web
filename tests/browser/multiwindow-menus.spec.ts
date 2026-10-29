import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { installWorkerRpcObservation, observeWorkerRpc, type WorkerRpcObservation } from '../helpers/worker-rpc-observation.ts'

const source = String.raw`
System.exitOnWindowClose=false;
var countA=0,countB=0,popupsA=0,popupsB=0;
var a=new Window();a.caption="Menu window A";a.setInnerSize(180,100);a.setPos(0,0);a.visible=true;
var rootA=new Layer(a,null);rootA.setSize(180,100);rootA.fillRect(0,0,180,100,0xff402020);
var toolsA=new MenuItem(a,"Tools A"),itemA=new MenuItem(a,"Count A");
a.menu.add(toolsA);toolsA.add(itemA);itemA.shortcut="Shift+F6";
itemA.onClick=function(){global.countA++;global.itemA.checked=true;Debug.message("menu-A="+global.countA);};
var openA=new MenuItem(a,"Popup A");a.menu.add(openA);
openA.onClick=function(){global.toolsA.popup(0,20,20);global.popupsA++;Debug.message("popup-A-closed="+global.popupsA);};
var b=new Window();b.caption="Menu window B";b.setInnerSize(180,100);b.setPos(220,0);b.visible=true;
var rootB=new Layer(b,null);rootB.setSize(180,100);rootB.fillRect(0,0,180,100,0xff204020);
var toolsB=new MenuItem(b,"Tools B"),itemB=new MenuItem(b,"Count B");
b.menu.add(toolsB);toolsB.add(itemB);itemB.shortcut="Shift+F6";
itemB.onClick=function(){global.countB++;global.itemB.checked=true;Debug.message("menu-B="+global.countB);};
var openB=new MenuItem(b,"Popup B");b.menu.add(openB);
openB.onClick=function(){global.toolsB.popup(0,20,20);global.popupsB++;Debug.message("popup-B-closed="+global.popupsB);};
var crossPopup=new MenuItem(a,"Open B from A");toolsA.add(crossPopup);crossPopup.shortcut="Shift+F7";
crossPopup.onClick=function(){global.toolsB.popup(0,20,20);Debug.message("inactive-popup-B-closed");};
Debug.message("multiwindow-menus-ready");
`

async function launch(page: Page, backend: string, binary: boolean, info: TestInfo) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await installWorkerRpcObservation(page)
  await page.addInitScript(() => {
    const listeners = new Set<unknown>(),
      menuRequests: string[] = [],
      add = window.addEventListener,
      remove = window.removeEventListener,
      post = Worker.prototype.postMessage
    let beforeStop: WorkerRpcObservation | undefined
    // Read synchronously on the actual Stop activation. An extra awaited
    // page.evaluate before clicking could let the very pending reply under
    // investigation settle before the original Stop race occurs.
    window.addEventListener('click', (event) => {
      if (!(event.target instanceof Element) || !event.target.closest('#stop')) return
      const read = Reflect.get(window, 'observeSessionWorkerRpc') as (() => WorkerRpcObservation) | undefined
      if (read && beforeStop === undefined) beforeStop = read()
    }, { capture: true, passive: true })
    const capture = (options: unknown) =>
      options === true ||
      (typeof options === 'object' && options !== null && Reflect.get(options, 'capture') === true)
    // Observe registration/removal without replacing any game input handlers.
    Reflect.set(window, 'addEventListener', function (this: Window, ...args: unknown[]) {
      if (args[0] === 'keydown' && args[1] && capture(args[2])) {
        const options = args[2] as AddEventListenerOptions | undefined
        if (!options?.signal?.aborted) {
          listeners.add(args[1])
          options?.signal?.addEventListener('abort', () => listeners.delete(args[1]), {
            once: true,
          })
        }
      }
      return Reflect.apply(add, this, args)
    })
    Reflect.set(window, 'removeEventListener', function (this: Window, ...args: unknown[]) {
      if (args[0] === 'keydown' && capture(args[2])) listeners.delete(args[1])
      return Reflect.apply(remove, this, args)
    })
    Worker.prototype.postMessage = function (
      message: unknown,
      transferOrOptions?: Transferable[] | StructuredSerializeOptions,
    ) {
      const request = message as { type?: string; argumentList?: { value?: unknown }[] }
      const method = request.argumentList?.[0]?.value
      if (request.type === 'APPLY' && (method === 'menuClick' || method === 'menuDismiss'))
        menuRequests.push(method)
      return Reflect.apply(post, this, [message, transferOrOptions])
    }
    Reflect.set(window, 'multiwindowMenuEvidence', {
      listeners: () => listeners.size,
      requests: () => [...menuRequests],
      beforeStop: () => beforeStop,
    })
  })
  await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  const baselineListeners = await listenerCount(page)
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("browser-multiwindow-menus.tjs","savedata/browser-multiwindow-menus.cjs",false,true,false);Scripts.execStorage("savedata/browser-multiwindow-menus.cjs");'
          : 'Scripts.execStorage("browser-multiwindow-menus.tjs");',
      ),
    },
    { name: 'browser-multiwindow-menus.tjs', mimeType: 'text/plain', buffer: Buffer.from(source) },
  ])
  await expect(page.getByText('multiwindow-menus-ready', { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  const a = page.locator('.game-window[data-window-id][aria-label="Menu window A"]'),
    b = page.locator('.game-window[data-window-id][aria-label="Menu window B"]')
  await expect(a).toBeVisible()
  await expect(b).toBeVisible()
  expect(await a.getAttribute('data-window-id')).not.toBe(await b.getAttribute('data-window-id'))
  await expect(a.locator('.game-menu-group').first()).toBeVisible()
  await expect(b.locator('.game-menu-group').first()).toBeVisible()
  return {
    a,
    b,
    baselineListeners,
    async stop(popupOpen = false) {
      const failures: unknown[] = []
      try {
        if (popupOpen) {
          // Invoke the real app stop control while the popup owns pointer input.
          await page.locator('#stop').dispatchEvent('click')
        } else await page.locator('#stop').click()
        await expect(page.locator('#status')).toHaveText('待机')
        await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
        await expect(page.locator('.game-menu-overlay')).toHaveCount(0)
        await expect(page.locator('.game-menu-popup')).toHaveCount(0)
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
        await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
        expect(errors).toEqual([])
      } catch (error) { failures.push(error) }
      try {
        // The historical log contained only an error string, not the method
        // whose reply outlived Stop. Preserve actual pending/reply metadata;
        // do not infer that every disposal error came from a geometry refresh.
        await info.attach('multiwindow-menu-stop-rpc', { contentType: 'application/json', body: JSON.stringify({
          backend, binary, popupOpen,
          before: await page.evaluate(() => Reflect.get(window, 'multiwindowMenuEvidence').beforeStop()),
          after: await observeWorkerRpc(page),
          menuRequests: await requests(page), logs: await page.locator('#logs').innerText(), pageErrors: errors,
        }, null, 2) })
      } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'Menu Stop assertion or RPC evidence failed', { cause: failures[0] })
    },
  }
}

const listenerCount = (page: Page): Promise<number> =>
  page.evaluate(() => Reflect.get(window, 'multiwindowMenuEvidence').listeners())
const requests = (page: Page): Promise<string[]> =>
  page.evaluate(() => Reflect.get(window, 'multiwindowMenuEvidence').requests())

async function shortcut(page: Page, surface: Locator, owner: string, count: number) {
  await surface.locator('canvas[data-window-id]').click()
  await expect(surface).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Shift+F6')
  await expect(page.getByText(`menu-${owner}=${count}`, { exact: true })).toBeVisible()
}

async function menuScenario(run: () => Promise<void>, cleanup: () => Promise<void>) {
  const failures: unknown[] = []
  try { await run() } catch (error) { failures.push(error) }
  try { await cleanup() } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Menu scenario and Stop evidence failed', { cause: failures[0] })
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${mode}: each Window owns its menu and the shared shortcut follows the visible active Window`, async ({
      page,
    }, info) => {
      const { a, b, stop } = await launch(page, backend, binary, info)
      await menuScenario(async () => {
        await expect(a.getByRole('button', { name: 'Popup A', exact: true })).toBeVisible()
        await expect(b.getByRole('button', { name: 'Popup B', exact: true })).toBeVisible()
        await a.getByText('Tools A', { exact: true }).click()
        await a.getByRole('button', { name: 'Count A', exact: false }).click()
        await expect(page.getByText('menu-A=1', { exact: true })).toBeVisible()
        await b.getByText('Tools B', { exact: true }).click()
        await b.getByRole('button', { name: 'Count B', exact: false }).click()
        await expect(page.getByText('menu-B=1', { exact: true })).toBeVisible()
        await evaluate(
          page,
          'countA+","+countB+","+int(itemA.checked)+","+int(itemB.checked)',
          '1,1,1,1',
        )
        await shortcut(page, a, 'A', 2)
        await evaluate(page, 'countA+","+countB', '2,1')
        await shortcut(page, b, 'B', 2)
        await evaluate(page, 'countA+","+countB', '2,2')
        await evaluate(page, '(a.visible=false,countA+","+countB)', '2,2')
        await expect(a).toBeHidden()
        await shortcut(page, b, 'B', 3)
        await evaluate(page, '(a.visible=true,b.visible=false,countA+","+countB)', '2,3')
        await expect(a).toBeVisible()
        await expect(b).toBeHidden()
        await shortcut(page, a, 'A', 3)
        await evaluate(page, 'countA+","+countB', '3,3')
      }, () => stop())
    })

    test(`${mode}: popup selection and dismissal stay with their owner and stale popup nodes cannot select a new popup`, async ({
      page,
    }, info) => {
      const { a, b, stop } = await launch(page, backend, binary, info)
      await menuScenario(async () => {
        await a.getByRole('button', { name: 'Popup A', exact: true }).click()
        const popup = page.locator('.game-menu-popup')
        await expect(popup).toHaveCount(1)
        await expect(popup).toHaveAttribute('aria-label', 'Tools A')
        const overlay = page.locator('.game-menu-overlay')
        await expect(overlay).toHaveAttribute(
          'data-window-id',
          (await a.getAttribute('data-window-id'))!,
        )
        const firstRequest = await overlay.getAttribute('data-request-id')
        expect(firstRequest).toMatch(/^[1-9]\d*$/)
        const oldButton = await popup
          .getByRole('button', { name: 'Count A', exact: false })
          .elementHandle()
        expect(oldButton).not.toBeNull()
        await popup.getByRole('button', { name: 'Count A', exact: false }).click()
        await expect(page.getByText('popup-A-closed=1', { exact: true })).toBeVisible()
        await expect(popup).toHaveCount(0)
        await evaluate(page, 'countA+","+countB+","+popupsA+","+popupsB', '1,0,1,0')
        await b.getByRole('button', { name: 'Popup B', exact: true }).click()
        await expect(popup).toHaveAttribute('aria-label', 'Tools B')
        await expect(overlay).toHaveAttribute(
          'data-window-id',
          (await b.getAttribute('data-window-id'))!,
        )
        expect(await overlay.getAttribute('data-request-id')).not.toBe(firstRequest)
        const beforeStale = await requests(page)
        expect(beforeStale).toContain('menuClick')
        expect(await oldButton!.evaluate((button) => button.isConnected)).toBe(false)
        await oldButton!.evaluate((button) =>
          button.dispatchEvent(new MouseEvent('click', { bubbles: true })),
        )
        expect(await requests(page)).toEqual(beforeStale)
        await expect(popup).toHaveAttribute('aria-label', 'Tools B')
        await popup.getByRole('button', { name: 'Count B', exact: false }).click()
        await expect(page.getByText('popup-B-closed=1', { exact: true })).toBeVisible()
        await evaluate(page, 'countA+","+countB+","+popupsA+","+popupsB', '1,1,1,1')
        await a.getByRole('button', { name: 'Popup A', exact: true }).click()
        await expect(popup).toHaveAttribute('aria-label', 'Tools A')
        await page.keyboard.press('Escape')
        await expect(popup).toHaveCount(0)
        await expect(page.getByText('popup-A-closed=2', { exact: true })).toBeVisible()
        await evaluate(page, 'countA+","+countB+","+popupsA+","+popupsB', '1,1,2,1')
        // Console evaluation focuses an app control and legitimately deactivates
        // the game. Re-enter A, then open B's popup through A's real shortcut.
        await a.locator('canvas[data-window-id]').click()
        await expect(a).toHaveAttribute('data-active', 'true')
        await expect(b).toHaveAttribute('data-active', 'false')
        // This callback stays suspended until the owning popup receives Escape.
        // No console focus or second script evaluation changes the active Window.
        await page.keyboard.press('Shift+F7')
        await expect(popup).toHaveAttribute('aria-label', 'Tools B')
        await expect(a).toHaveAttribute('data-active', 'true')
        await expect(b).toHaveAttribute('data-active', 'false')
        await page.keyboard.press('Escape')
        await expect(popup).toHaveCount(0)
        await expect(page.getByText('inactive-popup-B-closed', { exact: true })).toBeVisible()
        await expect(a.locator('.game-text-input')).toBeFocused()
        // The popup owner is B, but focus must return to the actual prior input A.
        await page.keyboard.press('Shift+F6')
        await expect(page.getByText('menu-A=2', { exact: true })).toBeVisible()
        await evaluate(page, 'countA+","+countB', '2,1')

        // If the user moves focus to the console while the popup is open,
        // Escape must not take it back to the old game input.
        await a.locator('canvas[data-window-id]').click()
        await page.keyboard.press('Shift+F7')
        await expect(popup).toHaveAttribute('aria-label', 'Tools B')
        await page.locator('#expression').focus()
        await page.keyboard.press('Escape')
        await expect(popup).toHaveCount(0)
        await expect(page.locator('#expression')).toBeFocused()
        await evaluate(page, 'countA+","+countB', '2,1')
      }, async () => stop((await page.locator('.game-menu-popup').count()) > 0))
    })

    test(`${mode}: retiring one Window disposes its menu listeners and stale callbacks while the other survives and stop clears its popup`, async ({
      page,
    }, info) => {
      const { a, b, baselineListeners, stop } = await launch(page, backend, binary, info)
      let stopped = false
      await menuScenario(async () => {
        const twoWindowListeners = await listenerCount(page)
        expect(twoWindowListeners).toBeGreaterThanOrEqual(baselineListeners + 2)
        await a.getByText('Tools A', { exact: true }).click()
        const retiredButton = await a
          .getByRole('button', { name: 'Count A', exact: false })
          .elementHandle()
        expect(retiredButton).not.toBeNull()
        await evaluate(
          page,
          '(function(){invalidate global.a;return global.countA+","+global.countB;})()',
          '0,0',
        )
        await expect(a).toHaveCount(0)
        await expect(b).toBeVisible()
        await expect.poll(() => listenerCount(page)).toBe(twoWindowListeners - 1)
        const beforeStale = await requests(page)
        expect(await retiredButton!.evaluate((button) => button.isConnected)).toBe(false)
        await retiredButton!.evaluate((button) =>
          button.dispatchEvent(new MouseEvent('click', { bubbles: true })),
        )
        await evaluate(page, 'countA+","+countB', '0,0')
        expect(await requests(page)).toEqual(beforeStale)
        await shortcut(page, b, 'B', 1)
        await evaluate(page, 'countA+","+countB', '0,1')
        await b.getByRole('button', { name: 'Popup B', exact: true }).click()
        await expect(page.locator('.game-menu-popup')).toHaveAttribute('aria-label', 'Tools B')
        const stoppedButton = await page
          .locator('.game-menu-popup')
          .getByRole('button', { name: 'Count B', exact: false })
          .elementHandle()
        expect(stoppedButton).not.toBeNull()
        await stop(true)
        stopped = true
        expect(await listenerCount(page)).toBe(baselineListeners)
        const afterStop = await requests(page)
        await stoppedButton!.evaluate((button) =>
          button.dispatchEvent(new MouseEvent('click', { bubbles: true })),
        )
        await page.keyboard.press('Shift+F6')
        expect(await requests(page)).toEqual(afterStop)
      }, async () => {
        if (!stopped) await stop((await page.locator('.game-menu-popup').count()) > 0)
      })
    })
  }
}
