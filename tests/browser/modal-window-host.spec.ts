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
  }) => {
    const errors = await launch(page),
      handle = page.locator(
        `${first} ${kind === 'move' ? '.game-window-title' : '.game-window-resize'}`,
      ),
      original = await page.evaluate(() => window.modalWindowHost.snapshot(11))
    await handle.scrollIntoViewIfNeeded()
    const bounds = await handle.boundingBox()
    if (!bounds) throw new Error('Window gesture handle is missing')
    const x = bounds.x + bounds.width / 2,
      y = bounds.y + bounds.height / 2
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 60, y + 35)
    await expect(page.locator(first)).toHaveClass(/game-window-dragging/)
    const preview = await page.evaluate(() => window.modalWindowHost.snapshot(11))
    if (kind === 'move') {
      expect(preview.left).not.toBe(original.left)
      expect(preview.top).not.toBe(original.top)
    } else expect(preview.width).not.toBe(original.width)

    await page.evaluate(() => window.modalWindowHost.update(11, { blocked: true }))
    expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
      dragging: false,
      left: original.left,
      top: original.top,
      width: original.width,
      aspectRatio: original.aspectRatio,
    })
    await page.mouse.move(x + 90, y + 55)
    await page.mouse.up()
    expect(
      await page.evaluate(() =>
        window.modalWindowHost
          .actions()
          .filter((action) => ['move', 'resize'].includes(action.type)),
      ),
    ).toEqual([])

    await page.evaluate(() => {
      window.modalWindowHost.update(11, { blocked: false })
      window.modalWindowHost.clearActions()
    })
    await page.mouse.move(x, y)
    await page.mouse.down()
    await page.mouse.move(x + 30, y + 20)
    await page.mouse.up()
    const committed = await page.evaluate(() =>
      window.modalWindowHost.actions().filter((action) => ['move', 'resize'].includes(action.type)),
    )
    expect(committed).toHaveLength(1)
    expect(committed[0]).toMatchObject({ type: kind, windowId: 11, surfaceEpoch: 1 })
    expect(await page.evaluate(() => window.modalWindowHost.snapshot(11))).toMatchObject({
      dragging: false,
    })
    expect(errors).toEqual([])
  })
