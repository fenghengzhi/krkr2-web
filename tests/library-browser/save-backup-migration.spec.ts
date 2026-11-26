import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { saveTransferGame, saveTransferObserver, saveTransferStory } from '../helpers/save-transfer-game.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

interface Backup { format: string; version: number; gameId: string; files: { path: string; base64: string }[] }

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: an exported browser backup restores an older KAG edition without its original installation or local save database`, async ({ page }, info) => {
    test.setTimeout(240000)
    const failures: unknown[] = [], observations: unknown[] = [], errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const old = await saveTransferGame('old', binary), next = await saveTransferGame('new', binary),
      { read, clickLink } = kagGameControls(page, observations), canvas = page.locator('#stage canvas[data-window-id]')
    const ready = async (fixture: typeof old) => {
      await expect(page.getByText('save-transfer-ready:' + fixture.edition, { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen'); if (await leave.isVisible()) await leave.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(canvas).toHaveCount(1)
      expect(await read('transferPaths()')).toBe(`game://./${fixture.root}|game://./${fixture.dataDirectory}|game://./${fixture.root}patch.xp3>first.ks`)
    }
    const state = (edition: string, value: number, visits: number, choice = false) => expect.poll(() => read('transferState()'), { timeout: 15000 }).toBe(choice
      ? `${edition}|0|EDITION ${edition}|${visits}|*choice|3|0`
      : `${edition}|${value}|VALUE ${value}|${visits}|*checkpoint|2|0`)
    const launch = async (fixture: typeof old) => {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#files').setInputFiles({ name: fixture.edition + '.zip', mimeType: 'application/zip', buffer: fixture.bytes })
      await ready(fixture); await state(fixture.edition, 0, 1, true)
    }
    const backup = async (name: string) => {
      await page.locator('#save-format').selectOption('backup')
      const pending = page.waitForEvent('download', { timeout: 10000 })
      await page.locator('#export-saves').click()
      const download = await pending; expect(await download.failure()).toBeNull()
      const filename = await download.path(); expect(filename).not.toBeNull()
      const bytes = await readFile(filename!), value = JSON.parse(bytes.toString()) as Backup
      await info.attach(name, { body: bytes, contentType: 'application/json' })
      expect(value.format).toBe('krkr2-web-saves'); expect(value.version).toBe(1)
      return { bytes, value }
    }
    const bytesAt = (backup: Backup, path: string) => {
      const file = backup.files.find((file) => file.path === path)
      expect(file, path).toBeDefined(); return Buffer.from(file!.base64, 'base64')
    }
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    try {
      await launch(old)
      await clickLink(0, '*seven'); await state('old', 7, 2)
      await clickLink(0, '*save'); await state('old', 7, 3)
      const exported = await backup('previous-browser-backup.json'), sourceSlot = bytesAt(exported.value, old.dataDirectory + 'portable0.kdt'),
        sourceNotes = bytesAt(exported.value, old.dataDirectory + 'notes/player.txt')
      expect(sourceSlot.toString('utf16le')).toContain('transferValue')
      expect(sourceSlot.toString('utf16le')).toContain('*checkpoint')
      await stop()
      // Simulate receiving only this exported file on another browser. The
      // disposable profile contains no library resources, and its old save
      // database is removed only after all application Workers are stopped.
      await page.goto('/wasm/manifest.json')
      await page.evaluate(() => new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('krkr2-web')
        request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
        request.onblocked = () => reject(new Error('The previous test game still owns the save database'))
      }))
      await page.goto(`/?backend=${backend}`)
      await launch(next)
      await clickLink(1, '*ninety'); await state('new', 99, 2)
      await clickLink(0, '*save'); await state('new', 99, 3)
      const before = await backup('current-edition-before-migration.json'), targetSlot = bytesAt(before.value, next.dataDirectory + 'portable0.kdt'),
        targetOnly = bytesAt(before.value, next.dataDirectory + 'target-only.txt'), outside = bytesAt(before.value, next.root + 'outside.txt')
      expect(before.value.gameId).not.toBe(exported.value.gameId)
      expect(targetSlot.equals(sourceSlot)).toBe(false)
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('已暂停')
      await page.locator('#open-save-transfer').click()
      await expect(page.locator('#transfer-status')).toHaveText('此浏览器中还没有其他版本的存档。')
      await expect(page.locator('#transfer-source option')).toHaveCount(1)
      await page.locator('#close-save-transfer').click()

      // Existing whole-game JSON restoration retains its exact game-ID gate.
      const strictChooser = page.waitForEvent('filechooser')
      await page.locator('#import-saves').click()
      const strict = await strictChooser
      expect(await strict.element().getAttribute('id')).toBe('save-file')
      await strict.setFiles({ name: 'previous-browser.json', mimeType: 'application/json', buffer: exported.bytes })
      await expect(page.locator('#logs .error').last()).toContainText('另一组游戏文件')
      expect(await read('transferStored()')).toBe('99|*checkpoint')
      observations.push({ strictIdentityError: await page.locator('#logs .error').allTextContents() })
      await page.locator('#clear-log').click()

      const selectBackup = async () => {
        await expect(page.locator('#save-format')).toHaveValue('backup')
        await expect(page.locator('#native-folder-control')).toBeHidden()
        await expect(page.locator('#choose-save-backup')).toBeVisible()
        await expect(page.locator('#choose-save-zip')).toBeHidden()
        const choosing = page.waitForEvent('filechooser')
        await page.locator('#choose-save-backup').click()
        const chooser = await choosing
        expect(await chooser.element().getAttribute('id')).toBe('save-directory-backup')
        await chooser.setFiles({ name: 'previous-browser.json', mimeType: 'application/json', buffer: exported.bytes })
        await expect(page.locator('#save-zip-panel')).toBeVisible()
        await expect(page.locator('#save-zip-summary')).toContainText(exported.value.gameId)
        const directory = page.getByLabel('浏览器备份中的存档目录', { exact: true })
        await expect(directory).toHaveValue('?')
        await expect(page.locator('#import-save-zip-directory')).toBeDisabled()
        await directory.selectOption(old.root)
        await directory.selectOption(old.dataDirectory)
        await expect(page.locator('#save-zip-summary')).toContainText('替换当前游戏的同名存档')
        await expect(page.locator('#import-save-zip-directory')).toBeEnabled()
      }
      await selectBackup()
      expect(await read('transferStored()')).toBe('99|*checkpoint')
      await page.locator('#save-format').selectOption('native')
      await expect(page.locator('#save-zip-panel')).toBeHidden()
      await expect(page.locator('#choose-save-zip')).toBeVisible()
      await page.locator('#save-format').selectOption('backup')
      await expect(page.locator('#save-zip-panel')).toBeHidden()
      expect(await read('transferStored()')).toBe('99|*checkpoint')
      await selectBackup()
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#save-zip-panel')).toBeHidden()
      await state('new', 99, 3)
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('已暂停')
      await selectBackup()
      const imported = page.locator('#logs p span').filter({ hasText: /^存档已导入/ })
      await expect(imported).toHaveCount(0)
      await page.locator('#import-save-zip-directory').click()
      await expect(imported).toHaveCount(1)
      const after = await backup('current-edition-after-migration.json')
      expect(after.value.gameId).toBe(before.value.gameId)
      expect(bytesAt(after.value, next.dataDirectory + 'portable0.kdt')).toEqual(sourceSlot)
      expect(bytesAt(after.value, next.dataDirectory + 'notes/player.txt')).toEqual(sourceNotes)
      expect(bytesAt(after.value, next.dataDirectory + 'target-only.txt')).toEqual(targetOnly)
      expect(bytesAt(after.value, next.root + 'outside.txt')).toEqual(outside)
      expect(bytesAt(after.value, next.dataDirectory + 'source-only.txt')).toEqual(bytesAt(exported.value, old.dataDirectory + 'source-only.txt'))
      expect(after.value.files.some((file) => file.path.startsWith(old.root) || file.path === next.dataDirectory + 'outside.txt')).toBe(false)
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('运行中')
      await state('new', 99, 3)
      await clickLink(1, '*load'); await state('new', 7, 4)
      expect(await read('transferNotes()')).toBe('notes:7')

      const title = `Migrated KAG ${backend} ${binary ? 'bytecode' : 'source'}`
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      const item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      await expect(page.locator('.library-game')).toHaveCount(1)
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready(next); await state('new', 0, 1, true)
      const reopened = await backup('library-reopened-migrated-backup.json')
      expect(reopened.value.gameId).toBe(before.value.gameId)
      expect(bytesAt(reopened.value, next.dataDirectory + 'portable0.kdt')).toEqual(sourceSlot)
      await clickLink(2, '*load'); await state('new', 7, 2)
      expect(await read('transferNotes()')).toBe('notes:7')
      await canvas.scrollIntoViewIfNeeded()
      await info.attach('migrated-kag-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const attach of [
      () => info.attach('backup-migration-observations', { body: JSON.stringify({ inputs: [old.evidence, next.evidence], observations, errors,
        scope: 'Real old-edition JSON export, then absence of its installation and local save database. The strict original import still rejects the foreign game ID. Explicit directory migration preserves bytes and current-edition identity; real KAG Load and library refresh restore chapter 7.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('backup-migration-author-script', { body: saveTransferStory + '\n' + saveTransferObserver, contentType: 'text/plain' }),
      async () => info.attach('backup-migration-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]) try { await attach() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Browser backup migration or cleanup failed', { cause: failures[0] })
  })
