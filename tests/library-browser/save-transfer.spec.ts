import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect, libraryDirectories } from '../helpers/library-browser.ts'
import { saveTransferGame, saveTransferObserver, saveTransferStory } from '../helpers/save-transfer-game.ts'
import { kagGameLinkClick } from '../helpers/kag-game-controls.ts'

interface Backup { gameId: string; files: { path: string; base64: string }[] }
interface SavedRow { path: string; bytes: number[]; updatedAt: number }

for (const backend of ['asyncify', 'jspi']) for (const legacy of [false, true])
  test(`${backend}/${legacy ? 'v1 without metadata, bytecode' : 'recorded directory, source'}: copy an unavailable older KAG edition's saves and restore through the game`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = []
    let sequence = 0
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const old = await saveTransferGame('old', legacy), next = await saveTransferGame('new', legacy),
      oldTitle = 'Previous KAG edition', newTitle = 'Current KAG edition',
      row = (title: string) => page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      canvas = page.locator('#stage canvas[data-window-id]'),
      sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
    const read = async (expression: string): Promise<string> => {
      const prefix = `transfer-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Save transfer game observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const value = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 200) observations.push({ expression, value })
      return value
    }
    const ready = async (fixture: typeof old) => {
      await expect(page.getByText('save-transfer-ready:' + fixture.edition, { exact: true })).toBeVisible({ timeout: 45000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#project-status')).toContainText(fixture.root + 'Game.exe>')
      await expect(canvas).toHaveCount(1)
      await expect(canvas).toHaveAttribute('width', '640'); await expect(canvas).toHaveAttribute('height', '480')
      expect(await read('transferPaths()')).toBe(`game://./${fixture.root}|game://./${fixture.dataDirectory}|game://./${fixture.root}patch.xp3>first.ks`)
    }
    const state = async (edition: string, value: number, visits: number, choice = false) => {
      await expect.poll(() => read('transferState()'), { timeout: 15000 }).toBe(choice
        ? `${edition}|0|EDITION ${edition}|${visits}|*choice|3|0`
        : `${edition}|${value}|VALUE ${value}|${visits}|*checkpoint|2|0`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const clickLink = kagGameLinkClick(page, read, observations)
    const backup = async (label: string): Promise<Backup> => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!), value = JSON.parse(bytes.toString()) as Backup
      await info.attach(label, { body: bytes, contentType: 'application/json' })
      observations.push({ backup: label, gameId: value.gameId, files: value.files.map((file) => ({ path: file.path,
        bytes: Buffer.from(file.base64, 'base64').length, sha256: sha(Buffer.from(file.base64, 'base64')) })) })
      return value
    }
    const fileBytes = (value: Backup, path: string) => {
      const file = value.files.find((file) => file.path === path)
      expect(file, path).toBeDefined()
      return Buffer.from(file!.base64, 'base64')
    }
    const sourceRows = (id: string): Promise<SavedRow[]> => page.evaluate(async (gameId) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('krkr2-web', 1)
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
      })
      try {
        const rows = await new Promise<{ path: string; bytes: Uint8Array; updatedAt: number }[]>((resolve, reject) => {
          const tx = db.transaction('saves', 'readonly'), request = tx.objectStore('saves').index('game').getAll(gameId)
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
        })
        return rows.map((row) => ({ path: row.path, bytes: Array.from(row.bytes), updatedAt: row.updatedAt }))
          .sort((a, b) => a.path.localeCompare(b.path))
      } finally { db.close() }
    }, id)
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    const launch = async (fixture: typeof old) => {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#project-exe-directory').fill(''); await page.locator('#project-executable').fill('')
      await page.locator('#files').setInputFiles({ name: fixture.edition + '-edition.zip', mimeType: 'application/zip', buffer: fixture.bytes })
      await ready(fixture); await state(fixture.edition, 0, 1, true)
    }
    const saveLibrary = async (title: string) => {
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(row(title)).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
    }
    try {
      await launch(old)
      await clickLink(0, '*seven'); await state('old', 7, 2)
      await clickLink(0, '*save'); await state('old', 7, 3)
      expect(await read('transferStored()')).toBe('7|*checkpoint'); expect(await read('transferNotes()')).toBe('notes:7')
      const oldBackup = await backup('old-edition-actual-saves.json'), oldSlot = fileBytes(oldBackup, old.dataDirectory + 'portable0.kdt')
      expect(oldSlot.length).toBeGreaterThan(100); expect(oldSlot.toString('utf16le')).toContain('transferValue')
      await saveLibrary(oldTitle); await stop()
      await row(oldTitle).getByRole('button', { name: '移除资源', exact: true }).click()
      await expect(row(oldTitle)).toHaveCount(0)
      await expect.poll(() => libraryDirectories(page)).toEqual([])
      const originals = await sourceRows(oldBackup.gameId)
      expect(originals.find((row) => row.path === old.dataDirectory + 'portable0.kdt')?.bytes).toEqual([...oldSlot])
      await info.attach('old-edition-retained-files.json', { body: JSON.stringify(originals), contentType: 'application/json' })
      if (legacy) {
        // Use only the real files produced above. Rebuild the original v1 layout
        // without the newer reserved-game profile rows, after closing the app.
        await page.goto('/wasm/manifest.json')
        const inventory = await page.evaluate(async ({ gameId, rows }) => {
          await new Promise<void>((resolve, reject) => {
            const request = indexedDB.deleteDatabase('krkr2-web')
            request.onsuccess = () => resolve(); request.onerror = () => reject(request.error)
            request.onblocked = () => reject(new Error('Legacy save database still has an open connection'))
          })
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('krkr2-web', 1)
            request.onupgradeneeded = () => request.result.createObjectStore('saves', { keyPath: ['gameId', 'path'] }).createIndex('game', 'gameId')
            request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error)
          })
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction('saves', 'readwrite')
              for (const row of rows) tx.objectStore('saves').put({ gameId, path: row.path, bytes: Uint8Array.from(row.bytes), updatedAt: row.updatedAt })
              tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error); tx.onerror = () => reject(tx.error)
            })
            return { version: db.version, stores: Array.from(db.objectStoreNames), gameId, files: rows.length }
          } finally { db.close() }
        }, { gameId: oldBackup.gameId, rows: originals })
        expect(inventory).toEqual({ version: 1, stores: ['saves'], gameId: oldBackup.gameId, files: originals.length })
        observations.push({ legacyInventory: inventory })
        await page.goto(`/?backend=${backend}`)
      }
      await launch(next)
      await clickLink(1, '*ninety'); await state('new', 99, 2)
      await clickLink(0, '*save'); await state('new', 99, 3)
      expect(await read('transferStored()')).toBe('99|*checkpoint'); expect(await read('transferNotes()')).toBe('notes:99')
      await saveLibrary(newTitle)
      await expect(page.locator('#open-save-transfer')).toBeDisabled()
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('已暂停')
      const before = await backup('new-edition-before-copy.json')
      expect(before.gameId).not.toBe(oldBackup.gameId)
      const targetSlot = fileBytes(before, next.dataDirectory + 'portable0.kdt'), targetNotes = fileBytes(before, next.dataDirectory + 'notes/player.txt'),
        targetOnly = fileBytes(before, next.dataDirectory + 'target-only.txt'), targetOutside = fileBytes(before, next.root + 'outside.txt'),
        from = originals.filter((file) => file.path.startsWith(old.dataDirectory)),
        targetName = (path: string) => next.dataDirectory + path.slice(old.dataDirectory.length),
        kept = from.filter((file) => before.files.some((target) => target.path === targetName(file.path))).length
      expect(targetSlot.equals(oldSlot)).toBe(false); expect(kept).toBeGreaterThanOrEqual(2)
      expect(from.some((file) => file.path.endsWith('source-only.txt'))).toBe(true)
      await page.locator('#open-save-transfer').click()
      await expect(page.locator('#transfer-source')).toBeEnabled()
      expect(await page.locator('#transfer-source option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
        .toEqual(['', oldBackup.gameId])
      await page.locator('#transfer-source').selectOption(oldBackup.gameId)
      await expect(page.locator('#transfer-directory')).toBeEnabled()
      await expect(page.locator('#transfer-directory option')).toContainText(['请选择目录', '根目录（全部文件）'])
      expect(await page.locator('#transfer-directory option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)))
        .toEqual(expect.arrayContaining(['', old.root, old.dataDirectory, old.dataDirectory + 'notes/']))
      if (legacy) {
        await expect(page.locator('#transfer-directory')).toHaveValue('?')
        await expect(page.locator('#confirm-save-transfer')).toBeDisabled()
        await page.locator('#transfer-directory').selectOption(old.dataDirectory)
      } else await expect(page.locator('#transfer-directory')).toHaveValue(old.dataDirectory)
      await expect(page.locator('#transfer-destination')).toHaveText('复制到当前游戏的 ' + next.dataDirectory)
      await expect(page.locator('#transfer-replace')).not.toBeChecked()
      const copy = async (copied: number, preserved: number) => {
        await page.locator('#confirm-save-transfer').click()
        await expect(page.locator('#transfer-status')).toHaveText(`已复制 ${copied} 个文件，保留 ${preserved} 个同名文件。请通过游戏的读档功能恢复进度。`)
        await expect(page.locator('#transfer-panel')).toBeVisible()
        observations.push({ transfer: await page.locator('#transfer-status').innerText(), replace: await page.locator('#transfer-replace').isChecked() })
      }
      await copy(from.length - kept, kept)
      const preserved = await backup('new-edition-default-keeps-collisions.json')
      expect(fileBytes(preserved, next.dataDirectory + 'portable0.kdt').equals(targetSlot)).toBe(true)
      expect(fileBytes(preserved, next.dataDirectory + 'notes/player.txt').equals(targetNotes)).toBe(true)
      expect(fileBytes(preserved, next.dataDirectory + 'source-only.txt')).toEqual(Buffer.from(from.find((file) => file.path.endsWith('/source-only.txt'))!.bytes))
      expect(await sourceRows(oldBackup.gameId)).toEqual(originals)
      await page.locator('#transfer-replace').check(); await copy(from.length, 0)
      const copied = await backup('new-edition-explicit-replacement.json')
      expect(copied.gameId).toBe(before.gameId)
      expect(fileBytes(copied, next.dataDirectory + 'portable0.kdt').equals(oldSlot)).toBe(true)
      expect(fileBytes(copied, next.dataDirectory + 'notes/player.txt')).toEqual(Buffer.from(from.find((file) => file.path.endsWith('/notes/player.txt'))!.bytes))
      expect(fileBytes(copied, next.dataDirectory + 'target-only.txt').equals(targetOnly)).toBe(true)
      expect(fileBytes(copied, next.root + 'outside.txt').equals(targetOutside)).toBe(true)
      expect(copied.files.some((file) => file.path.startsWith(old.root) || file.path === next.dataDirectory + 'outside.txt')).toBe(false)
      expect(await sourceRows(oldBackup.gameId)).toEqual(originals)
      await page.locator('#close-save-transfer').click()
      await page.locator('#pause').click(); await expect(page.locator('#status')).toHaveText('运行中')
      await state('new', 99, 3) // File copying must not pretend to restore the running game.
      await clickLink(1, '*load'); await state('new', 7, 4)
      expect(await read('transferStored()')).toBe('7|*checkpoint'); expect(await read('transferNotes()')).toBe('notes:7')
      await info.attach('current-edition-restored-through-kag', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await stop(); await page.reload()
      await expect(row(oldTitle)).toHaveCount(0); await expect(page.locator('.library-game')).toHaveCount(1)
      await row(newTitle).getByRole('button', { name: '启动', exact: true }).click()
      await ready(next); await state('new', 0, 1, true)
      const reopened = await backup('new-edition-library-reopen.json')
      expect(reopened.gameId).toBe(before.gameId); expect(fileBytes(reopened, next.dataDirectory + 'portable0.kdt').equals(oldSlot)).toBe(true)
      await clickLink(2, '*load'); await state('new', 7, 2)
      expect(await read('transferNotes()')).toBe('notes:7')
      expect(await sourceRows(oldBackup.gameId)).toEqual(originals)
      await info.attach('reopened-edition-restored-through-kag', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    const reports = [
      () => info.attach('save-transfer-observations.json', { body: JSON.stringify({ backend, legacy, inputs: [old.evidence, next.evidence], observations, errors,
        scope: 'Two distinct game identities and custom data directories. Original KAG clicks write and restore a real bookmark. Source resources are removed. Default collision preservation, explicit replacement, unchanged source file bytes/timestamps, legacy v1 manual directory and persistent library reopen are asserted. Only authored observer code is compiled.' }, null, 2), contentType: 'application/json' }),
      () => info.attach('save-transfer-authored-source', { body: saveTransferStory + '\n' + saveTransferObserver, contentType: 'text/plain' }),
      () => info.attach('save-transfer-old-input', { body: old.bytes, contentType: 'application/zip' }),
      () => info.attach('save-transfer-new-input', { body: next.bytes, contentType: 'application/zip' }),
      async () => info.attach('save-transfer-logs', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
    ]
    for (const report of reports) try { await report() } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Cross-edition KAG saves or cleanup failed', { cause: failures[0] })
  })
