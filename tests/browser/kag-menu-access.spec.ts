import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { menuAccessGameSource, menuAccessStory } from '../helpers/kag-menu-access.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: keyboard menus open stock KAG history, save/load a chapter and return to its title`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      { read, clickLink } = kagGameControls(page, observations, { firstReadTimeout: 30000 }),
      canvas = page.locator('#stage canvas[data-window-id]'), menu = page.locator('#game-menus'),
      keyboard = page.locator('#stage textarea.game-text-input'),
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url))
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const ready = async () => {
      await expect(page.getByText('keyboard-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const fullscreen = page.locator('.leave-fullscreen'); if (await fullscreen.isVisible()) await fullscreen.click()
      await expect(canvas).toHaveCount(1); await expect(canvas).toHaveAttribute('width', '640')
      await expect(canvas).toHaveAttribute('height', '480')
    }
    const state = async (progress: number, label: string, links: number, actions: string) => {
      await expect.poll(() => read('keyboardGameState()'), { timeout: 15000 }).toBe(`${progress}|${label}|${links}|0|0|${actions}`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const focusGame = async () => {
      // The story is stopped at a choice. This blank interior point has no
      // link; it restores actual player focus without advancing the scenario.
      await canvas.scrollIntoViewIfNeeded(); const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      await canvas.click({ position: { x: 620 * box!.width / 640, y: 460 * box!.height / 480 } })
      await expect(keyboard).toBeFocused()
    }
    const openMenu = async (caption: string) => {
      await focusGame(); await page.keyboard.press('F10')
      const top = menu.locator(':scope > .game-menu-group > details > summary[aria-disabled="false"]'), names = await top.allTextContents()
      const index = names.indexOf(caption); expect(index).toBeGreaterThanOrEqual(0)
      await expect(top.first()).toBeFocused()
      for (let i = 0; i < index; i++) await page.keyboard.press('ArrowRight')
      await expect(top.nth(index)).toBeFocused(); await page.keyboard.press('ArrowDown')
      const group = top.nth(index).locator('..')
      await expect(group).toHaveAttribute('open', '')
      observations.push({ keyboardMenu: caption, keys: ['F10', ...Array(index).fill('ArrowRight'), 'ArrowDown'] })
      return group
    }
    const confirm = async (yes: boolean) => {
      const dialog = page.locator('.game-window[aria-label="Confirm"]'), surface = dialog.locator('canvas'),
        owner = page.locator('.game-window').filter({ has: menu })
      await expect(dialog).toHaveCount(1); await expect(owner).toHaveAttribute('data-blocked', 'true')
      // No VM observation is submitted while the original showModal is active.
      if (!yes) await surface.press('Escape')
      else {
        await expect.poll(() => surface.evaluate((element) => {
          const c = element as HTMLCanvasElement, content = c.parentElement!
          return c.width > 0 && c.height > 0 && c.width === Math.round(parseFloat(content.style.width)) &&
            c.height === Math.round(parseFloat(content.style.height))
        })).toBe(true)
        const size = await surface.evaluate((element) => ({ width: (element as HTMLCanvasElement).width, height: (element as HTMLCanvasElement).height })),
          zoom = (await dialog.getAttribute('data-zoom'))!.split('/').map(Number),
          width = Math.round(size.width * zoom[1]! / zoom[0]!), height = Math.round(size.height * zoom[1]! / zoom[0]!)
        expect(width).toBeGreaterThanOrEqual(200); expect(height).toBeGreaterThan(60)
        await surface.scrollIntoViewIfNeeded(); const box = await surface.boundingBox(); expect(box).not.toBeNull()
        // Unchanged YesNoDialog: Yes=(floor((w-150)/2), th+35), 70x25;
        // its window height is 2*th+60.
        const x = Math.floor((width - 150) / 2) + 35, y = (height - 60) / 2 + 47.5
        await surface.click({ position: { x: x * box!.width / width, y: y * box!.height / height } })
      }
      await expect(dialog).toHaveCount(0); await expect(owner).toHaveAttribute('data-blocked', 'false')
      observations.push({ originalConfirmation: yes ? 'Yes' : 'Escape/No' })
    }
    const bookmarkMenu = async (caption: 'Save' | 'Load') => {
      const group = await openMenu(caption), first = group.locator(':scope > .game-menu-group > button').first()
      await expect(first).toBeEnabled(); await expect(first).toBeFocused()
      await page.keyboard.press('Enter'); await confirm(true)
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull(); const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), data = JSON.parse(bytes.toString()) as { files: { path: string; base64: string }[] },
        found = data.files.find((entry) => entry.path === 'savedata/keyboard0.kdt')
      expect(found).toBeDefined(); const slot = Buffer.from(found!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('keyboardProgress'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const compiled = data.files.find((entry) => entry.path === 'savedata/keyboard-game.cjs')
        expect(compiled).toBeDefined(); expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      await info.attach(name, { body: bytes, contentType: 'application/json' }); return slot
    }
    try {
      expect(createHash('sha256').update(original).digest('hex')).toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      const wide = (value: string) => Buffer.from('\ufeff' + value, 'utf16le')
      await page.locator('#files').setInputFiles([
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(menuAccessStory) },
        { name: 'keyboard-game.tjs', mimeType: 'text/plain', buffer: wide(menuAccessGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("keyboard-game.tjs","savedata/keyboard-game.cjs",false,true,false);Scripts.execStorage("savedata/keyboard-game.cjs");'
          : 'Scripts.execStorage("keyboard-game.tjs");') },
      ])
      await ready(); await state(0, '*title', 1, '')
      await page.locator('#expression').fill('host text remains unchanged')
      await page.locator('#expression').press('Alt+z')
      await expect(page.locator('#expression')).toHaveValue('host text remains unchanged')
      await expect(menu.locator('details[open]')).toHaveCount(0)
      await focusGame()
      // Actual explicit shortcut has priority over access-key navigation.
      await page.keyboard.press('Shift+F6'); await expect(page.getByText('keyboard-actions:O', { exact: true })).toBeVisible()
      await expect(keyboard).toBeFocused()
      await page.keyboard.press('Control+Alt+z'); await expect(menu.locator('details[open]')).toHaveCount(0)
      const composing = await keyboard.evaluate((element) => {
        const event = new KeyboardEvent('keydown', { key: 'z', altKey: true, isComposing: true, bubbles: true, cancelable: true })
        element.dispatchEvent(event); return event.defaultPrevented
      })
      expect(composing).toBe(false); await expect(menu.locator('details[open]')).toHaveCount(0)
      await page.keyboard.press('Alt+z')
      const access = menu.locator('details').filter({ has: page.locator('summary', { hasText: /^Access$/ }) })
      await expect(access).toHaveAttribute('open', '')
      await expect(access.getByRole('button', { name: /Once/ })).toBeFocused()
      await page.keyboard.press('d'); await expect(access.getByRole('button', { name: 'First', exact: true })).toBeFocused()
      await page.keyboard.press('d'); await expect(access.getByRole('button', { name: 'Second', exact: true })).toBeFocused()
      await expect(page.getByText('keyboard-actions:O', { exact: true })).toHaveCount(1)
      await page.keyboard.press('Enter'); await expect(page.getByText('keyboard-actions:O2', { exact: true })).toBeVisible()
      await expect(keyboard).toBeFocused()
      await page.keyboard.press('Alt+z'); await page.keyboard.press('ArrowDown')
      await expect(access.getByRole('button', { name: 'First', exact: true })).toBeFocused()
      await page.keyboard.press('Escape'); await expect(access.locator(':scope > summary')).toBeFocused()
      await page.keyboard.press('Escape'); await expect(keyboard).toBeFocused()
      await page.keyboard.press('Alt+p')
      const popup = page.locator('.game-menu-popup')
      await expect(popup).toBeVisible(); await expect(popup.getByRole('button', { name: /Once/ })).toBeFocused()
      await page.keyboard.press('ArrowDown'); await expect(popup.getByRole('button', { name: 'First', exact: true })).toBeFocused()
      await page.keyboard.press('d'); await expect(popup.getByRole('button', { name: 'Second', exact: true })).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(popup).toHaveCount(0); await expect(page.getByText('keyboard-popup-closed', { exact: true })).toBeVisible()
      await expect(page.getByText('keyboard-actions:O22', { exact: true })).toBeVisible(); await expect(keyboard).toBeFocused()
      await clickLink(0, '*chapter'); await state(7, '*checkpoint', 2, 'O22')
      await openMenu('System'); await page.keyboard.press('l')
      await expect(keyboard).toBeFocused()
      await expect.poll(() => read('int(kag.historyLayer.visible)'), { timeout: 15000 }).toBe('1')
      await info.attach('original-history', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await canvas.press('Escape'); await state(7, '*checkpoint', 2, 'O22')
      await bookmarkMenu('Save'); await state(7, '*checkpoint', 2, 'O22')
      expect(await read('keyboardSaved()')).toBe('7|*checkpoint'); const saved = await backup('keyboard-saved.json')
      await clickLink(0, '*change'); await state(99, '*checkpoint', 2, 'O22')
      await bookmarkMenu('Load'); await state(7, '*checkpoint', 2, 'O22')
      await page.locator('#restart').click(); await ready(); await state(0, '*title', 1, '')
      expect((await backup('keyboard-restarted.json')).equals(saved)).toBe(true)
      await bookmarkMenu('Load'); await state(7, '*checkpoint', 2, '')
      await clickLink(1, '*continue')
      await expect.poll(() => read('kag.currentLabel+"|"+kag.historyLayer.currentLine+"|"+int(kag.clickWaiting)'), { timeout: 15000 }).toBe('*continue|CONTINUE 7|1')
      await canvas.press('Enter'); await state(7, '*checkpoint', 2, '')
      await openMenu('System'); await page.keyboard.press('r'); await confirm(false)
      await state(7, '*checkpoint', 2, '')
      await openMenu('System'); await page.keyboard.press('r'); await confirm(true)
      await state(0, '*title', 1, '')
      await info.attach('returned-title', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('keyboard-menu-source', { body: menuAccessStory + '\n' + menuAccessGameSource, contentType: 'text/plain' }),
      () => info.attach('keyboard-menu-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unchanged KAG template menu/History/bookmark/Confirm handlers. Real F10/arrows/access keys/Enter and Yes/No pointer or Escape; console only observes. Authored story and observer are source or compiled bytecode.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('keyboard-menu-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Keyboard KAG menus or cleanup failed', { cause: failures[0] })
  })
