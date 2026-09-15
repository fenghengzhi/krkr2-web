import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { MenuPopupIdentity, MenuView } from '../../src/engine/scene/menus.ts'

interface MenuHostAction {
  type: 'choose' | 'dismiss'
  windowId: number
  id?: number
  popup?: MenuPopupIdentity
}

interface MenuModalHost {
  popup(windowId: number, requestId: number): void
  clearPopup(windowId: number): void
  blocked(windowId: number, value: boolean): void
  fontSelection(value: boolean): void
  active(windowId: number): void
  actions(): MenuHostAction[]
  escapes(): { target: string; prevented: boolean }[]
  focusChanges(): string[]
  clearObservations(): void
}

declare global {
  interface Window {
    menuModalHost: MenuModalHost
  }
}

const bundles = new Map<string, string>()
let styles: string
test.beforeAll(async () => {
  styles = await readFile(resolve('src/app/styles.css'), 'utf8')
  for (const [name, entry] of [
    ['windows', 'tests/helpers/modal-window-host.ts'],
    ['menus', 'src/app/game-menus.ts'],
  ] as const) {
    const result = await build({
      configFile: false,
      publicDir: false,
      logLevel: 'error',
      build: {
        write: false,
        minify: false,
        lib: { entry: resolve(entry), formats: ['es'], fileName: () => `${name}.mjs` },
      },
    })
    const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      'output' in item ? item.output : [],
    )
    if (!output.some((item) => item.type === 'chunk' && item.isEntry))
      throw new Error(`Missing menu modal host ${name} bundle`)
    for (const item of output) {
      if (item.type === 'chunk') bundles.set(item.fileName, item.code)
      else if (item.fileName.endsWith('.css'))
        styles +=
          '\n' +
          (typeof item.source === 'string' ? item.source : new TextDecoder().decode(item.source))
    }
  }
})

async function launch(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/menu-modal-host/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/menu-modal-host/'.length)
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>Menu modal host</title>
          <link rel="stylesheet" href="/menu-modal-host/styles.css">
          <button id="before-windows">Before windows</button>
          <button id="after-windows">After windows</button>`,
      })
    if (path === 'styles.css') return route.fulfill({ contentType: 'text/css', body: styles })
    const body = bundles.get(path)
    if (body === undefined) return route.fulfill({ status: 404, body: `Missing ${path}` })
    return route.fulfill({ contentType: 'text/javascript', body })
  })
  await page.goto('/menu-modal-host/index.html')
  await page.evaluate(async () => {
    const windowsUrl = '/menu-modal-host/windows.mjs',
      menusUrl = '/menu-modal-host/menus.mjs',
      windows = (await import(windowsUrl)) as typeof import('../helpers/modal-window-host.ts'),
      { createGameMenus } = (await import(menusUrl)) as typeof import('../../src/app/game-menus.ts')
    window.modalWindowHost = windows.installModalWindowHost()
    const views = new Map<number, ReturnType<typeof createGameMenus>>(),
      roots = new Map<number, MenuView>(),
      actions: MenuHostAction[] = [],
      escapes: { target: string; prevented: boolean }[] = [],
      focusChanges: string[] = []
    let active = 11,
      fontSelecting = false
    const node = (id: number, caption: string, children: MenuView[] = []): MenuView => ({
      id,
      caption,
      children,
      enabled: true,
      visible: true,
      checked: false,
      radio: false,
      shortcut: '',
    })
    for (const windowId of [11, 22]) {
      const element = document.querySelector<HTMLElement>(
          `.game-window[data-window-id="${windowId}"]`,
        )!,
        canvas = element.querySelector<HTMLCanvasElement>('canvas')!,
        container = element.querySelector<HTMLElement>('.game-window-menu')!,
        root = node(windowId * 10, `Root ${windowId}`, [
          node(windowId * 10 + 1, `Popup ${windowId}`, [
            node(windowId * 10 + 2, `Choose ${windowId}`),
          ]),
        ]),
        clear = () => views.get(windowId)!.update({ root }),
        view = createGameMenus(
          container,
          () => canvas,
          (id, popup) => {
            actions.push({
              type: 'choose',
              windowId,
              id,
              popup: popup && { windowId: popup.windowId, requestId: popup.requestId },
            })
            clear()
          },
          (popup) => {
            actions.push({
              type: 'dismiss',
              windowId,
              popup: popup && { windowId: popup.windowId, requestId: popup.requestId },
            })
            clear()
          },
          { active: () => active === windowId },
        )
      roots.set(windowId, root)
      views.set(windowId, view)
      view.state(true, 320, 180)
      view.update({ root })
    }
    const targetName = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return ''
      return target.closest<HTMLElement>('.game-window')?.dataset.windowId ?? target.id
    }
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape')
        escapes.push({ target: targetName(event.target), prevented: event.defaultPrevented })
    })
    document.addEventListener('focusin', (event) => focusChanges.push(targetName(event.target)))
    const updateModal = (windowId: number) => {
      views
        .get(windowId)!
        .modal(fontSelecting || !!window.modalWindowHost.snapshot(windowId).view.blocked)
    }
    window.menuModalHost = {
      popup(windowId, requestId) {
        views.get(windowId)!.update({
          root: roots.get(windowId)!,
          popup: { windowId, requestId, id: windowId * 10 + 1, x: 20, y: 20, flags: 0 },
        })
      },
      clearPopup(windowId) {
        views.get(windowId)!.update({ root: roots.get(windowId)! })
      },
      blocked(windowId, value) {
        // Exercise both safeguards: the body popup must yield even before the
        // Window container becomes inert, without restoring its old focus.
        views.get(windowId)!.modal(fontSelecting || value)
        window.modalWindowHost.update(windowId, { blocked: value })
      },
      fontSelection(value) {
        fontSelecting = value
        for (const windowId of views.keys()) updateModal(windowId)
      },
      active(windowId) {
        active = windowId
      },
      actions: () => actions.map((action) => ({ ...action })),
      escapes: () => escapes.map((event) => ({ ...event })),
      focusChanges: () => [...focusChanges],
      clearObservations() {
        actions.length = 0
        escapes.length = 0
        focusChanges.length = 0
        window.modalWindowHost.clearActions()
      },
    }
  })
  return errors
}

const parent = '.game-window[data-window-id="11"]',
  child = '.game-window[data-window-id="22"]',
  overlay = '.game-menu-overlay',
  popup = '.game-menu-popup'

test('blocking a popup owner removes its body overlay and leaves child focus, pointer input and Escape available', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.locator(`${parent} canvas`).focus()
  await page.evaluate(() => window.menuModalHost.popup(11, 101))
  await expect(page.locator(popup).getByRole('button', { name: 'Choose 11' })).toBeFocused()
  const retiredButton = await page
      .locator(popup)
      .getByRole('button', { name: 'Choose 11' })
      .elementHandle(),
    retiredOverlay = await page.locator(overlay).elementHandle()
  expect(retiredButton).not.toBeNull()
  expect(retiredOverlay).not.toBeNull()
  await page.evaluate(() => {
    window.menuModalHost.clearObservations()
    window.menuModalHost.blocked(11, true)
  })
  await expect(page.locator(overlay)).toHaveCount(0)
  expect(await page.evaluate(() => window.modalWindowHost.snapshot(11).inert)).toBe(true)
  expect(await page.evaluate(() => window.menuModalHost.focusChanges())).not.toContain('11')
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([])

  // The pointer must pass through the former body overlay to the real child.
  await page.locator(`${child} canvas`).click()
  expect(await page.evaluate(() => window.modalWindowHost.actions())).toContainEqual({
    type: 'activate',
    windowId: 22,
    surfaceEpoch: 1,
  })
  await page.locator(`${child} canvas`).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator(`${child} canvas`)).toBeFocused()
  expect(await page.evaluate(() => window.menuModalHost.escapes())).toEqual([
    { target: '22', prevented: false },
  ])
  for (const element of [retiredButton!, retiredOverlay!])
    await element.evaluate((node) =>
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })),
    )
  // A later snapshot for the still-unwinding parent must remain noninteractive.
  await page.evaluate(() => window.menuModalHost.popup(11, 102))
  await expect(page.locator(overlay)).toHaveCount(0)
  await expect(page.locator(`${child} canvas`)).toBeFocused()
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([])
  expect(errors).toEqual([])
})

test('unblocking permits a fresh popup while reattached retired buttons and overlays cannot operate it', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.locator(`${parent} canvas`).focus()
  await page.evaluate(() => window.menuModalHost.popup(11, 201))
  const retired = await page.locator(overlay).elementHandle()
  expect(retired).not.toBeNull()
  await page.evaluate(() => {
    window.menuModalHost.blocked(11, true)
    window.menuModalHost.clearPopup(11)
    window.menuModalHost.blocked(11, false)
    window.menuModalHost.popup(11, 202)
    window.menuModalHost.clearObservations()
  })
  await expect(page.locator(overlay)).toHaveAttribute('data-request-id', '202')
  await retired!.evaluate((node) => {
    document.body.append(node)
    node
      .querySelector('button')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    node.remove()
  })
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([])
  await expect(page.locator(overlay)).toHaveAttribute('data-request-id', '202')
  await page.locator(popup).getByRole('button', { name: 'Choose 11' }).click()
  await expect(page.locator(overlay)).toHaveCount(0)
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([
    { type: 'choose', windowId: 11, id: 112, popup: { windowId: 11, requestId: 202 } },
  ])
  expect(errors).toEqual([])
})

test('an explicit popup on an inactive unblocked Window still accepts Escape and restores its actual focus origin', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.locator(`${parent} canvas`).focus()
  await page.evaluate(() => {
    window.menuModalHost.active(11)
    window.menuModalHost.popup(22, 301)
  })
  await expect(page.locator(popup).getByRole('button', { name: 'Choose 22' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.locator(overlay)).toHaveCount(0)
  await expect(page.locator(`${parent} canvas`)).toBeFocused()
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([
    { type: 'dismiss', windowId: 22, popup: { windowId: 22, requestId: 301 } },
  ])
  expect(errors).toEqual([])
})

test('popup removal cannot restore a focus origin that became inert or take focus from the child', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.locator(`${parent} canvas`).focus()
  await page.evaluate(() => window.menuModalHost.popup(22, 401))
  await expect(page.locator(popup).getByRole('button', { name: 'Choose 22' })).toBeFocused()
  await page.evaluate(() => {
    window.modalWindowHost.update(11, { blocked: true })
    window.menuModalHost.clearObservations()
    window.menuModalHost.clearPopup(22)
  })
  expect(await page.evaluate(() => window.menuModalHost.focusChanges())).not.toContain('11')
  await expect(page.locator(`${parent} canvas`)).not.toBeFocused()

  await page.evaluate(() => window.menuModalHost.popup(22, 402))
  await page.locator(`${child} canvas`).focus()
  await page.evaluate(() => window.menuModalHost.clearPopup(22))
  await expect(page.locator(`${child} canvas`)).toBeFocused()
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([])
  expect(errors).toEqual([])
})

test('font selection suppresses an existing popup without cancelling it or restoring its previous focus', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.locator(`${parent} canvas`).focus()
  await page.evaluate(() => window.menuModalHost.popup(11, 501))
  await expect(page.locator(popup).getByRole('button', { name: 'Choose 11' })).toBeFocused()
  await page.evaluate(() => {
    window.menuModalHost.clearObservations()
    window.menuModalHost.fontSelection(true)
  })
  await expect(page.locator(overlay)).toHaveCount(0)
  expect(await page.evaluate(() => window.menuModalHost.focusChanges())).not.toContain('11')
  await page.locator('#after-windows').focus()
  await page.keyboard.press('Escape')
  await expect(page.locator('#after-windows')).toBeFocused()
  expect(await page.evaluate(() => window.menuModalHost.escapes())).toEqual([
    { target: 'after-windows', prevented: false },
  ])
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([])
  await page.evaluate(() => {
    window.menuModalHost.clearPopup(11)
    window.menuModalHost.fontSelection(false)
    window.menuModalHost.popup(11, 502)
  })
  await page.locator(popup).getByRole('button', { name: 'Choose 11' }).click()
  expect(await page.evaluate(() => window.menuModalHost.actions())).toEqual([
    { type: 'choose', windowId: 11, id: 112, popup: { windowId: 11, requestId: 502 } },
  ])
  expect(errors).toEqual([])
})
