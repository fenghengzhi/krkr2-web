import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { build } from 'vite'

let fixture: string, styles: string
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve('tests/helpers/modal-window-host.ts'),
        formats: ['es'],
        fileName: () => 'modal-window-host.mjs',
      },
    },
  })
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      'output' in item ? item.output : [],
    ),
    entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing modal window host bundle')
  fixture = entry.code
  styles = output
    .filter((item) => item.type === 'asset' && item.fileName.endsWith('.css'))
    .map((item) =>
      item.type === 'asset'
        ? typeof item.source === 'string'
          ? item.source
          : new TextDecoder().decode(item.source)
        : '',
    )
    .join('\n')
  if (!styles) throw new Error('Missing real game windows CSS')
})

async function launch(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/modal-window-host.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: `<!doctype html><meta charset="utf-8"><title>Modal window host</title>
        <link rel="stylesheet" href="/modal-window-host.css">
        <button id="before-windows">Before windows</button>
        <button id="after-windows">After windows</button>`,
    }),
  )
  await page.route('**/modal-window-host.mjs', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fixture }),
  )
  await page.route('**/modal-window-host.css', (route) =>
    route.fulfill({ contentType: 'text/css', body: styles }),
  )
  await page.goto('/modal-window-host.html')
  await page.evaluate(async () => {
    const url = '/modal-window-host.mjs',
      module = (await import(url)) as typeof import('../helpers/modal-window-host.ts')
    window.modalWindowHost = module.installModalWindowHost()
  })
  return errors
}

const first = '.game-window[data-window-id="11"]',
  second = '.game-window[data-window-id="22"]'

test('beginMove distinguishes released descendant capture from loss of its own real capture', async ({ page }, info) => {
  const errors = await launch(page), canvas = page.locator(`${first} canvas`)
  await page.evaluate(() => {
    window.modalWindowHost.update(11, { borderStyle: 0 })
    window.modalWindowCapture = window.modalWindowHost.observeCanvasPointerCapture(11)
    document.querySelector<HTMLCanvasElement>('.game-window[data-window-id="11"] canvas')!
      .addEventListener('pointerdown', (event) => {
        (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
      })
  })
  try {
    for (const terminal of ['commit', 'cancel'] as const) {
      await page.evaluate(() => window.modalWindowHost.update(11, { left: 20, top: 20 }))
      await canvas.scrollIntoViewIfNeeded()
      const bounds = await canvas.boundingBox()
      if (!bounds) throw new Error('Capture handoff canvas is missing')
      const point = { x: bounds.x + 30, y: bounds.y + 30 }
      await page.mouse.move(point.x, point.y)
      await page.mouse.down()
      // Processing another real pointer event establishes the pending canvas
      // capture before the later host handoff. No capture event is synthesized.
      await page.mouse.move(point.x + 1, point.y + 1)
      expect(await page.evaluate(() => window.modalWindowCapture.snapshot().nativeHasCapture)).toBe(true)
      const setup = await page.evaluate((phase) => {
        const observation = window.modalWindowCapture.snapshot(), pointerId = observation.pointerId
        if (pointerId === undefined) throw new Error('No observed real pointer')
        if (!observation.entries.some((entry) => entry.name === 'gotpointercapture' && entry.isTrusted))
          throw new Error('The canvas has not received its real capture event')
        window.modalWindowCapture.phase(`handoff-${phase}`)
        return { pointerId, requestId: window.modalWindowHost.beginScriptMove(11, pointerId) }
      }, terminal)
      await expect(page.locator(first)).toHaveClass(/game-window-dragging/)
      await page.mouse.move(point.x + 31, point.y + 21)
      const observation = await page.evaluate(() => window.modalWindowCapture.snapshot())
      expect(observation.entries.some((entry) => entry.phase === `handoff-${terminal}` &&
        entry.name === 'lostpointercapture' && entry.isTrusted &&
        String(entry.eventTarget).startsWith('canvas'))).toBe(true)
      await expect(page.locator(first)).toHaveClass(/game-window-dragging/)
      expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
        left: '50px', top: '40px', dragging: true,
      })
      if (terminal === 'cancel') {
        await page.evaluate((pointerId) => {
          document.querySelector<HTMLElement>('.game-window[data-window-id="11"]')!
            .releasePointerCapture(pointerId)
        }, setup.pointerId)
        await page.mouse.move(point.x + 32, point.y + 22)
      }
      await page.mouse.up()
      await expect.poll(() => page.evaluate((id) => window.modalWindowHost.scriptMove(id).settled,
        setup.requestId)).toBe(true)
      const result = await page.evaluate((id) => window.modalWindowHost.scriptMove(id), setup.requestId)
      expect(result.error).toBeUndefined()
      expect(result.messages.filter((message) => message.type !== 'update')).toEqual([
        terminal === 'commit'
          ? { type: 'commit', requestId: setup.requestId, windowId: 11,
              sequence: result.messages.at(-1)!.sequence, left: 50, top: 40 }
          : { type: 'cancel', requestId: setup.requestId, windowId: 11,
              sequence: result.messages.at(-1)!.sequence },
      ])
      expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
        left: terminal === 'commit' ? '50px' : '20px',
        top: terminal === 'commit' ? '40px' : '20px', dragging: false,
      })
    }
    expect(errors).toEqual([])
  } finally {
    await page.mouse.up()
    await info.attach('begin-move-capture-handoff', {
      body: JSON.stringify(await page.evaluate(() => window.modalWindowCapture.snapshot()), null, 2),
      contentType: 'application/json',
    })
    await page.evaluate(() => {
      window.modalWindowCapture.restore()
      window.modalWindowHost.dispose()
    })
  }
})

test('a held beginMove suppresses game clicks while an external host control can abort it', async ({ page }, info) => {
  const errors = await launch(page), canvas = page.locator(`${first} canvas`), failures: unknown[] = []
  await page.evaluate(() => {
    window.modalWindowHost.update(11, { borderStyle: 2 })
    window.modalWindowCapture = window.modalWindowHost.observeCanvasPointerCapture(11)
    document.querySelector<HTMLCanvasElement>('.game-window[data-window-id="11"] canvas')!
      .addEventListener('pointerdown', (event) => {
        (event.currentTarget as HTMLCanvasElement).setPointerCapture(event.pointerId)
      })
    const stop = document.querySelector<HTMLButtonElement>('#before-windows')!
    stop.dataset.calls = '0'
    stop.addEventListener('click', () => {
      stop.dataset.calls = String(Number(stop.dataset.calls) + 1)
      window.modalWindowHost.dispose()
    })
  })
  try {
    await canvas.scrollIntoViewIfNeeded()
    const bounds = await canvas.boundingBox()
    if (!bounds) throw new Error('Move canvas is missing')
    await page.mouse.move(bounds.x + 30, bounds.y + 30)
    await page.mouse.down()
    await page.mouse.move(bounds.x + 31, bounds.y + 31)
    const requestId = await page.evaluate(() => {
      const pointerId = window.modalWindowCapture.snapshot().pointerId
      if (pointerId === undefined) throw new Error('No real held pointer')
      window.modalWindowHost.clearActions()
      return window.modalWindowHost.beginScriptMove(11, pointerId)
    })
    await expect(page.locator(first)).toHaveClass(/game-window-dragging/)
    // DOM control activation avoids releasing the held drag pointer. The
    // game control remains suppressed; the external app control must run.
    await page.locator(`${first} .game-window-close`).evaluate((element) => (element as HTMLButtonElement).click())
    expect(await page.evaluate(() => window.modalWindowHost.actions())).toEqual([])
    await page.evaluate(() => window.modalWindowHost.openPopup(11))
    const popup = page.locator('.game-menu-overlay[data-window-id="11"][data-request-id="1"]')
    expect(await popup.evaluate((element) => element.parentElement === document.body)).toBe(true)
    await popup.getByRole('button', { name: 'Choose held game popup', exact: true })
      .evaluate((element) => (element as HTMLButtonElement).click())
    expect(await page.evaluate(() => window.modalWindowHost.menuSelections())).toEqual([])
    expect(await page.evaluate((id) => window.modalWindowHost.scriptMove(id).settled, requestId)).toBe(false)
    await page.locator('#before-windows').evaluate((element) => (element as HTMLButtonElement).click())
    await expect(page.locator('#before-windows')).toHaveAttribute('data-calls', '1')
    await expect.poll(() => page.evaluate((id) => window.modalWindowHost.scriptMove(id).settled, requestId)).toBe(true)
    const result = await page.evaluate((id) => window.modalWindowHost.scriptMove(id), requestId)
    expect(result.error).toBeUndefined()
    expect(result.messages.filter((message) => message.type !== 'update')).toEqual([])
    await expect(page.locator('.game-window,.game-window-flow-space,.game-menu-overlay')).toHaveCount(0)
    expect(errors).toEqual([])
  } catch (error) { failures.push(error) }
  try { await page.mouse.up() } catch (error) { failures.push(error) }
  try {
    await info.attach('begin-move-host-control', { contentType: 'application/json',
      body: JSON.stringify(await page.evaluate(() => window.modalWindowCapture.snapshot()), null, 2) })
  } catch (error) { failures.push(error) }
  try { await page.evaluate(() => window.modalWindowCapture.restore()) } catch (error) { failures.push(error) }
  try { await page.evaluate(() => window.modalWindowHost.dispose()) } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length > 1) throw new AggregateError(failures, 'Host control scenario and cleanup failed', { cause: failures[0] })
})

test('modal blocking preserves Window visibility and focusability while excluding its DOM from focus', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: true }))
  expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
    view: { visible: true, focusable: true },
    hidden: false,
    inert: true,
    ariaDisabled: 'true',
    focusable: 'true',
    canvasTabIndex: -1,
    closeTabIndex: -1,
    leaveTabIndex: -1,
    closeDisabled: true,
    leaveDisabled: true,
  })
  await page.locator('#before-windows').focus()
  await page.locator(`${first} canvas`).evaluate((canvas: HTMLCanvasElement) => canvas.focus())
  await expect(page.locator('#before-windows')).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator(`${second} .game-window-close`)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator(`${second} canvas`)).toBeFocused()

  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: false }))
  const unblocked = await page.evaluate(() => window.modalWindowHost.snapshot(11))
  expect(unblocked).toMatchObject({
    view: { visible: true, focusable: true },
    hidden: false,
    inert: false,
    focusable: 'true',
    canvasTabIndex: 0,
    closeTabIndex: 0,
    leaveTabIndex: 0,
    closeDisabled: false,
    leaveDisabled: false,
  })
  expect(unblocked.ariaDisabled).not.toBe('true')
  await page.locator('#before-windows').focus()
  await page.keyboard.press('Tab')
  await expect(page.locator(`${first} .game-window-close`)).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator(`${first} canvas`)).toBeFocused()
  expect(errors).toEqual([])
})

test('blocked window guards synthetic activation and chrome events even when inert is bypassed', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(() => {
    window.modalWindowHost.update(11, { blocked: true })
    window.modalWindowHost.clearActions()
    const element = document.querySelector('.game-window[data-window-id="11"]')!
    element.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
    for (const selector of ['canvas', '.game-window-header', '.game-window-resize'])
      element.querySelector(selector)!.dispatchEvent(
        new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          pointerId: 99,
          clientX: 30,
          clientY: 60,
        }),
      )
    for (const selector of ['.game-window-close', '.game-window-leave-fullscreen'])
      element
        .querySelector(selector)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  expect(await page.evaluate(() => window.modalWindowHost.actions())).toEqual([])
  expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
    dragging: false,
    left: '20px',
    top: '20px',
    width: '320px',
  })
  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: false }))
  await page.locator(`${first} .game-window-close`).dispatchEvent('click')
  expect(await page.evaluate(() => window.modalWindowHost.actions())).toEqual([
    { type: 'close', windowId: 11, surfaceEpoch: 1 },
  ])
  expect(errors).toEqual([])
})

test('blocked fullscreen window ignores Escape and exit until it is unblocked', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(() => {
    window.modalWindowHost.update(11, { fullScreen: true, blocked: true })
    window.modalWindowHost.clearActions()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    document
      .querySelector('.game-window[data-window-id="11"] .game-window-leave-fullscreen')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
  expect(await page.evaluate(() => window.modalWindowHost.actions())).toEqual([])
  await expect(page.locator(first)).toHaveClass(/game-window-fullscreen/)
  await expect(page.locator(`${first} .game-window-leave-fullscreen`)).toBeDisabled()
  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: false }))
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.modalWindowHost.actions())).toEqual([
    { type: 'exitFullScreen', windowId: 11, surfaceEpoch: 1 },
  ])
  expect(errors).toEqual([])
})

test('modal windows stay above blocked topmost and fullscreen owners and restore their original stacking', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(() => {
    window.modalWindowHost.update(11, { stayOnTop: true })
    window.modalWindowHost.update(22, { left: 40, top: 40 })
  })
  const initial = await page.evaluate(() => [
    window.modalWindowHost.snapshot(11),
    window.modalWindowHost.snapshot(22),
  ])
  expect(initial[0]!.zIndex).toBeGreaterThan(initial[1]!.zIndex)

  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: true }))
  const aboveTopmost = await page.evaluate(() => [
    window.modalWindowHost.snapshot(11),
    window.modalWindowHost.snapshot(22),
  ])
  expect(aboveTopmost[0]!.view).toMatchObject({ stayOnTop: true, fullScreen: false })
  expect(aboveTopmost[1]!.zIndex).toBeGreaterThan(aboveTopmost[0]!.zIndex)
  await page.locator(`${second} .game-window-close`).click()
  expect(
    await page.evaluate(() =>
      window.modalWindowHost.actions().filter((action) => action.type === 'close'),
    ),
  ).toEqual([{ type: 'close', windowId: 22, surfaceEpoch: 1 }])

  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: false }))
  const restoredTopmost = await page.evaluate(() => [
    window.modalWindowHost.snapshot(11),
    window.modalWindowHost.snapshot(22),
  ])
  expect(restoredTopmost[0]!.zIndex).toBeGreaterThan(restoredTopmost[1]!.zIndex)
  expect(restoredTopmost[0]!.view.stayOnTop).toBe(true)

  await page.evaluate(() => {
    // Put the normal stage outside the viewport before fullscreen. The modal
    // must use the fullscreen desktop origin while preserving its script bounds.
    document.querySelector<HTMLElement>('.game-desktop')!.style.marginTop = '1200px'
    window.modalWindowHost.update(11, { fullScreen: true })
    window.modalWindowHost.clearActions()
  })
  await expect(page.locator(first)).toHaveClass(/game-window-fullscreen/)
  const fullscreenBounds = await page.locator(first).boundingBox()
  expect(fullscreenBounds).toMatchObject({ x: 0, y: 0 })
  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: true }))
  const aboveFullscreen = await page.evaluate(() => [
    window.modalWindowHost.snapshot(11),
    window.modalWindowHost.snapshot(22),
  ])
  expect(aboveFullscreen[0]!).toMatchObject({
    view: { stayOnTop: true, fullScreen: true },
    fullscreen: true,
  })
  expect(aboveFullscreen[1]!).toMatchObject({
    view: { left: 40, top: 40, fullScreen: false, stayOnTop: false },
    position: 'fixed',
  })
  expect(aboveFullscreen[1]!.zIndex).toBeGreaterThan(aboveFullscreen[0]!.zIndex)
  expect(await page.locator(first).boundingBox()).toEqual(fullscreenBounds)
  await expect(page.locator(second)).toBeInViewport({ ratio: 1 })
  expect(await page.locator(second).boundingBox()).toMatchObject({ x: 40, y: 40 })
  await page.locator(`${second} .game-window-close`).click()
  expect(
    await page.evaluate(() =>
      window.modalWindowHost.actions().filter((action) => action.type === 'close'),
    ),
  ).toEqual([{ type: 'close', windowId: 22, surfaceEpoch: 1 }])
  expect(
    await page.evaluate(() =>
      window.modalWindowHost.actions().filter((action) => action.type === 'exitFullScreen'),
    ),
  ).toEqual([])

  const title = await page.locator(`${second} .game-window-title`).boundingBox()
  if (!title) throw new Error('Modal title is missing')
  const x = title.x + title.width / 2,
    y = title.y + title.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x + 15, y + 10)
  await expect(page.locator(second)).toHaveClass(/game-window-dragging/)
  await page.evaluate(() => window.modalWindowHost.update(11, { blocked: false }))
  const restoredFullscreen = await page.evaluate(() => [
    window.modalWindowHost.snapshot(11),
    window.modalWindowHost.snapshot(22),
  ])
  expect(restoredFullscreen[0]!.zIndex).toBeGreaterThan(restoredFullscreen[1]!.zIndex)
  expect(restoredFullscreen[0]!).toMatchObject({
    view: { stayOnTop: true, fullScreen: true },
    fullscreen: true,
  })
  expect(restoredFullscreen[1]!).toMatchObject({
    position: '',
    dragging: false,
    left: '40px',
    top: '40px',
  })
  await page.mouse.up()
  expect(
    await page.evaluate(() =>
      window.modalWindowHost.actions().filter((action) => action.type === 'move'),
    ),
  ).toEqual([])
  expect(await page.locator(first).boundingBox()).toEqual(fullscreenBounds)
  expect(errors).toEqual([])
})

for (const kind of ['move', 'resize'] as const)
  test(`modal blocking cancels an in-flight ${kind} and its later pointerup cannot commit`, async ({
    page,
  }, info) => {
    const errors = await launch(page),
      handle = page.locator(
        `${first} ${kind === 'move' ? '.game-window-title' : '.game-window-resize'}`,
      ),
      original = await page.evaluate(() => window.modalWindowHost.snapshot(11))
    await page.evaluate((gesture) => {
      window.modalWindowCapture = window.modalWindowHost.observePointerCapture(11, gesture)
    }, kind)
    try {
      await handle.scrollIntoViewIfNeeded()
      const bounds = await handle.boundingBox()
      if (!bounds) throw new Error('Window gesture handle is missing')
      const x = bounds.x + bounds.width / 2,
        y = bounds.y + bounds.height / 2,
        rolledBack = {
          dragging: false,
          left: original.left,
          top: original.top,
          width: original.width,
          aspectRatio: original.aspectRatio,
        }
      for (const releaseFailure of [null, 'NotFoundError', 'Error'] as const) {
        const phase = releaseFailure ? `synthetic-${releaseFailure}` : 'native-cancel'
        await page.evaluate((value) => {
          window.modalWindowCapture.phase(value)
          window.modalWindowHost.update(11, { blocked: false })
          window.modalWindowHost.clearActions()
        }, phase)
        await page.mouse.move(x, y)
        await page.mouse.down()
        await page.mouse.move(x + 60, y + 35)
        await expect(page.locator(first)).toHaveClass(/game-window-dragging/)
        const preview = await page.evaluate(() => window.modalWindowHost.snapshot(11))
        if (kind === 'move') {
          expect(preview.left).not.toBe(original.left)
          expect(preview.top).not.toBe(original.top)
        } else expect(preview.width).not.toBe(original.width)

        // Both injected failures start from native capture established by the
        // real mouse. hasPointerCapture and setPointerCapture never get faked.
        expect(
          await page.evaluate(() => window.modalWindowCapture.snapshot().nativeHasCapture),
        ).toBe(true)
        const outcome = await page.evaluate((failure) => {
          window.modalWindowCapture.phase(`before-block-${failure ?? 'native'}`)
          if (failure) window.modalWindowCapture.injectReleaseFailure(failure)
          try {
            window.modalWindowHost.update(11, { blocked: true })
            return null
          } catch (error) {
            return {
              name:
                error instanceof Error || error instanceof DOMException ? error.name : typeof error,
              message:
                error instanceof Error || error instanceof DOMException
                  ? error.message
                  : String(error),
              isDOMException: error instanceof DOMException,
            }
          } finally {
            // The injected call did not invoke native release. Restore the
            // native pass-through before the real pointerup releases capture.
            window.modalWindowCapture.restoreRelease()
            window.modalWindowCapture.phase(`after-block-${failure ?? 'native'}`)
          }
        }, releaseFailure)
        if (releaseFailure === 'Error')
          expect(outcome).toEqual({
            name: 'Error',
            message: 'Synthetic unexpected releasePointerCapture failure',
            isDOMException: false,
          })
        else expect(outcome).toBeNull()
        expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
          ...rolledBack,
          inert: releaseFailure === 'Error' ? original.inert : true,
          ariaDisabled: releaseFailure === 'Error' ? original.ariaDisabled : 'true',
        })
        await page.mouse.move(x + 90, y + 55)
        await page.mouse.up()
        expect(
          await page.evaluate(() => window.modalWindowCapture.snapshot().nativeHasCapture),
        ).toBe(false)
        expect(
          await page.evaluate(() =>
            window.modalWindowHost
              .actions()
              .filter((action) => ['move', 'resize'].includes(action.type)),
          ),
        ).toEqual([])
        expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject(
          rolledBack,
        )
      }

      await page.evaluate(() => {
        window.modalWindowCapture.phase('fresh-gesture')
        window.modalWindowHost.update(11, { blocked: false })
        window.modalWindowHost.clearActions()
      })
      await page.mouse.move(x, y)
      await page.mouse.down()
      await page.mouse.move(x + 30, y + 20)
      await page.mouse.up()
      const committed = await page.evaluate(() =>
        window.modalWindowHost
          .actions()
          .filter((action) => ['move', 'resize'].includes(action.type)),
      )
      expect(committed).toHaveLength(1)
      expect(committed[0]).toMatchObject({ type: kind, windowId: 11, surfaceEpoch: 1 })
      expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
        dragging: false,
      })
      const observation = await page.evaluate(() => window.modalWindowCapture.snapshot()),
        events = observation.entries.filter((entry) => entry.type === 'event'),
        injected = observation.entries.filter((entry) => entry.type === 'synthetic-release')
      expect(observation.dropped).toBe(0)
      expect(observation.entries.length).toBeLessThanOrEqual(observation.limit)
      expect(events.filter((entry) => entry.name === 'pointerdown')).toHaveLength(4)
      expect(events.filter((entry) => entry.name === 'pointerup')).toHaveLength(4)
      expect(events.every((entry) => entry.isTrusted === true)).toBe(true)
      expect(injected).toMatchObject([
        {
          nativeReleaseInvoked: false,
          nativeHasCapture: true,
          error: { name: 'NotFoundError', isDOMException: true },
        },
        {
          nativeReleaseInvoked: false,
          nativeHasCapture: true,
          error: { name: 'Error', isDOMException: false },
        },
      ])
      expect(errors).toEqual([])
    } finally {
      const evidence = await page
        .evaluate(() => {
          const observation = window.modalWindowCapture.snapshot(),
            surface = window.modalWindowHost.snapshot(11),
            actions = window.modalWindowHost.actions()
          window.modalWindowCapture.restore()
          return { observation, surface, actions }
        })
        .catch((error: unknown) => ({ observationReadError: String(error) }))
      await info.attach(`modal-${kind}-native-pointer-capture`, {
        contentType: 'application/json',
        body: JSON.stringify({ kind, errors, ...evidence }, null, 2),
      })
    }
  })
