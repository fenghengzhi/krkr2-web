import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { namedBookmarkSource, namedBookmarkStory } from '../helpers/kag-named-bookmarks.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: stock KAG double-clicks a named bookmark to resume its chapter after reload`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [],
      { read, clickLink } = kagGameControls(page, observations, { firstReadTimeout: 30000 }),
      canvas = page.locator('#stage canvas[data-window-id]'), menu = page.locator('#game-menus'),
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      filename = '旅のしおり.kdt', path = 'savedata/' + filename,
      wide = (value: string) => Buffer.from('\ufeff' + value, 'utf16le'),
      files = [
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(namedBookmarkStory) },
        { name: 'named-bookmarks.tjs', mimeType: 'text/plain', buffer: wide(namedBookmarkSource) },
        { name: 'Override2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("named-bookmarks.tjs","savedata/named-bookmarks.cjs",false,true,false);Scripts.execStorage("savedata/named-bookmarks.cjs");'
          : 'Scripts.execStorage("named-bookmarks.tjs");') },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide('Debug.message("named-bookmarks-ready");') },
      ]
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const state = (value: number, visits: number, title = false) => expect.poll(() => read('namedState()'), { timeout: 15000 })
      .toBe(title ? `0|TITLE|${visits}|*title|1|0|1` : `${value}|CHAPTER ${value}|${visits}|*checkpoint|2|0|1`)
    const launch = async () => {
      await page.locator('#files').setInputFiles(files)
      await expect(page.getByText('named-bookmarks-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen'); if (await leave.isVisible()) await leave.click()
      await expect(canvas).toHaveCount(1); await state(0, 1, true)
    }
    const open = async (save: boolean) => {
      const top = menu.locator('summary').filter({ hasText: /^Save\/Load$/ }), group = top.locator('..')
      await expect(top).toBeVisible(); await top.click()
      await group.getByRole('button', { name: save ? /^Save/ : /^Load/ }).click()
      const dialog = page.getByRole('dialog', { name: save ? 'Place Bookmark' : 'Follow Bookmark', exact: true })
      await expect(dialog).toBeVisible()
      await expect(page.locator('.game-window[data-window-id]')).toHaveAttribute('data-blocked', 'true')
      await expect(dialog.getByLabel('目录', { exact: true })).toHaveValue('game://./savedata/')
      return dialog
    }
    const closed = async () => {
      await expect(page.locator('.game-system-dialog')).toHaveCount(0)
      await expect(page.locator('.game-window[data-window-id]')).toHaveAttribute('data-blocked', 'false')
    }
    const backup = async (label: string) => {
      await page.locator('#save-format').selectOption('backup')
      const pending = page.waitForEvent('download', { timeout: 10000 })
      await page.locator('#export-saves').click()
      const download = await pending; expect(await download.failure()).toBeNull()
      const local = await download.path(); expect(local).not.toBeNull()
      const bytes = await readFile(local!), data = JSON.parse(bytes.toString()) as { gameId: string; files: { path: string; base64: string }[] },
        found = data.files.find((entry) => entry.path === path)
      expect(found).toBeDefined()
      const slot = Buffer.from(found!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('namedValue'); expect(slot.toString('utf16le')).toContain('*checkpoint')
      if (binary) {
        const observer = data.files.find((entry) => entry.path === 'savedata/named-bookmarks.cjs')
        expect(observer).toBeDefined(); expect(Buffer.from(observer!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      await info.attach(label, { body: bytes, contentType: 'application/json' })
      return { slot, gameId: data.gameId }
    }
    const load = async (visits: number) => {
      const dialog = await open(false), entry = dialog.getByRole('button', { name: filename, exact: true })
      await entry.click()
      // A single click only selects. All assertions while the native dialog
      // is active use the DOM; no console transaction enters the paused VM.
      await expect(dialog.getByLabel('文件名', { exact: true })).toHaveValue(filename)
      await expect(dialog).toBeVisible()
      await expect(page.locator('.game-window[data-window-id]')).toHaveAttribute('data-blocked', 'true')
      await entry.dblclick(); await closed(); await state(7, visits)
      expect(await read('namedStored()')).toBe('7|*checkpoint')
      observations.push({ namedOpen: filename, actions: ['single-click selects', 'double-click opens'], visits })
    }
    try {
      expect(createHash('sha256').update(original).digest('hex')).toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      await launch(); await clickLink(0, '*seven'); await state(7, 2)
      const save = await open(true)
      await save.getByLabel('文件名', { exact: true }).fill('旅のしおり')
      await save.getByRole('button', { name: '保存', exact: true }).click(); await closed(); await state(7, 2)
      expect(await read('namedStored()')).toBe('7|*checkpoint')
      const first = await backup('named-bookmark-created.json')
      await clickLink(0, '*ninety'); await state(99, 3)
      const overwrite = await open(true), entry = overwrite.getByRole('button', { name: filename, exact: true })
      await entry.dblclick()
      const warning = overwrite.getByRole('group', { name: '确认覆盖', exact: true })
      await expect(warning).toBeVisible(); await expect(warning).toContainText(filename)
      await expect(overwrite).toBeVisible()
      await warning.getByRole('button', { name: '返回', exact: true }).click()
      await expect(warning).not.toBeVisible()
      await overwrite.getByRole('button', { name: '取消', exact: true }).click(); await closed(); await state(99, 3)
      expect((await backup('named-bookmark-overwrite-cancelled.json')).slot.equals(first.slot)).toBe(true)
      await load(4)
      expect((await backup('named-bookmark-loaded.json')).slot.equals(first.slot)).toBe(true)
      const confirmed = await open(true)
      await confirmed.getByRole('button', { name: filename, exact: true }).dblclick()
      const confirmation = confirmed.getByRole('group', { name: '确认覆盖', exact: true })
      await expect(confirmation).toBeVisible()
      await confirmation.getByRole('button', { name: '覆盖', exact: true }).click()
      await closed(); await state(7, 4); expect(await read('namedStored()')).toBe('7|*checkpoint')
      const persisted = await backup('named-bookmark-overwrite-confirmed.json')
      expect(persisted.gameId).toBe(first.gameId)
      // Reload the actual application, then re-import exactly the same
      // original game files. The browser save namespace survives; the VM and
      // original KAG state are reconstructed from startup before Load runs.
      await page.locator('#stop').click(); await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await page.reload(); await launch()
      const reloaded = await backup('named-bookmark-after-refresh.json')
      expect(reloaded.gameId).toBe(first.gameId); expect(reloaded.slot.equals(persisted.slot)).toBe(true)
      await load(2); await clickLink(1, '*continue')
      await expect.poll(() => read('kag.currentLabel+"|"+kag.historyLayer.currentLine+"|"+int(kag.clickWaiting)'), { timeout: 15000 })
        .toBe('*continue|CONTINUE 7|1')
      await canvas.press('Enter'); await state(7, 3)
      await info.attach('named-bookmark-resumed-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const report of [
      () => info.attach('named-bookmark-author-source', { body: namedBookmarkSource + '\n' + namedBookmarkStory, contentType: 'text/plain' }),
      () => info.attach('named-bookmark-observations', { body: JSON.stringify({ backend, binary, observations, errors,
        scope: 'Unmodified KAG3 template; author freeSaveDataMode configuration, original Save/Load menus and native Storages.selectFile continuation. Real pointer file selection/double-click, explicit overwrite cancellation, unchanged named slot bytes across application reload, original chapter continuation. No test invokes a save/load function.' }, null, 2), contentType: 'application/json' }),
      async () => info.attach('named-bookmark-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await report() } catch (error) { failures.push(error) }
    try {
      if (await page.locator('.game-system-dialog').count())
        await page.locator('.game-system-dialog [data-action="stop"]').click()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Named KAG bookmark or cleanup failed', { cause: failures[0] })
  })
