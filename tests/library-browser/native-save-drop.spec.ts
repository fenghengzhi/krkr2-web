import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { dropImportDirectory, dropImportFiles, removeImportDirectory } from '../helpers/game-import-drop.ts'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { nativeSaveGameSource, nativeSaveStory, nativeSaveZipFiles, saveBytesDigest } from '../helpers/native-saves.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode/ZIP' : 'source/directory'}: dropping original KAG saves replaces the selected slot only while paused and survives a fresh game session`, async ({ page }, info) => {
    test.setTimeout(210000)
    const failures: unknown[] = [], observations: unknown[] = [], errors: string[] = [], directories: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const base = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      wide = (text: string) => Buffer.from('\ufeff' + text, 'utf16le'),
      inputs = [
        { name: 'data.xp3', mimeType: 'application/octet-stream', buffer: base },
        { name: 'first.ks', mimeType: 'text/plain', buffer: wide(nativeSaveStory) },
        { name: 'native-save-game.tjs', mimeType: 'text/plain', buffer: wide(nativeSaveGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: wide(binary
          ? 'Scripts.compileStorage("native-save-game.tjs","savedata/native-save-game.cjs",false,true,false);Scripts.execStorage("savedata/native-save-game.cjs");'
          : 'Scripts.execStorage("native-save-game.tjs");') },
      ], canvas = page.locator('#stage canvas[data-window-id]'), { read, clickLink } = kagGameControls(page, observations),
      marker = page.locator('#logs p span').filter({ hasText: /^存档已导入/ }), target = '#save-file-import'
    const start = async () => {
      await page.locator('#files').setInputFiles(inputs)
      await expect(page.getByText('native-save-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(canvas).toHaveCount(1)
    }
    const state = (progress: number, visits: number) => expect.poll(() => read('nativeSaveState()'), { timeout: 15000 })
      .toBe(`${progress}|CHECKPOINT ${progress}|${visits}|*checkpoint|5|0`)
    const exportNative = async (name: string) => {
      await page.locator('#save-format').selectOption('native')
      const downloaded = page.waitForEvent('download', { timeout: 10000 })
      await page.locator('#export-saves').click()
      const download = await downloaded
      expect(await download.failure()).toBeNull()
      const filename = await download.path(); expect(filename).not.toBeNull()
      const bytes = await readFile(filename!)
      await info.attach(name, { body: bytes, contentType: 'application/zip' })
      return nativeSaveZipFiles(bytes)
    }
    const pause = async () => {
      await page.locator('#pause').click()
      await expect(page.locator('#status')).toHaveText('已暂停')
      await expect(page.locator(target)).toHaveAttribute('data-save-drop-available', 'true')
    }
    const resume = async () => {
      await page.locator('#pause').click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator(target)).toHaveAttribute('data-save-drop-available', 'false')
    }
    try {
      expect(saveBytesDigest(base)).toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      await start(); await state(7, 1)
      await clickLink(0, '*save'); await state(7, 2)
      const saved = await exportNative('original-data-directory.zip'), slot = saved.get('migration0.bmp')!, notes = saved.get('notes/player.txt')!
      expect(slot.toString('ascii', 0, 2)).toBe('BM')
      expect(slot.subarray(54 + 64 * 3 * 48).toString('utf16le')).toContain('*checkpoint')
      expect(saved.has('outside-native.txt')).toBe(false)
      if (binary) expect(saved.get('native-save-game.cjs')!.toString('ascii', 0, 4)).toBe('TJS2')
      await clickLink(1, '*change'); await state(99, 3)
      await clickLink(0, '*save'); await state(99, 4)
      const current = await exportNative('newer-data-directory.zip')
      expect(current.get('migration0.bmp')!.equals(slot)).toBe(false)
      expect(await read('nativeStoredState()')).toBe('99|*checkpoint')

      const running = await dropImportFiles(page, [{ path: 'migration0.bmp', bytes: slot }], target)
      expect(running.prevented).toBe(true)
      await expect(page.locator('#native-save-drop-status')).toContainText('暂停')
      await expect(marker).toHaveCount(0)
      expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
      observations.push({ runningDrop: running })

      await pause()
      const collision = await dropImportFiles(page, [{ path: 'migration0.bmp', bytes: slot }, { path: 'MIGRATION0.BMP', bytes: Buffer.from('different slot') }], target)
      expect(collision.prevented).toBe(true)
      await expect(page.locator('#logs .error').last()).toContainText('重复')
      await expect(marker).toHaveCount(0)
      const rejected = await exportNative('after-rejected-conflicting-drop.zip')
      expect(rejected.get('migration0.bmp')).toEqual(current.get('migration0.bmp'))
      expect(rejected.get('notes/player.txt')).toEqual(current.get('notes/player.txt'))
      observations.push({ collision, errors: await page.locator('#logs .error').allTextContents() })
      await page.locator('#clear-log').click()

      if (!binary) {
        const dropped = await dropImportDirectory(page, [...saved].map(([path, bytes]) => ({ path, bytes })), target)
        directories.push(dropped.name)
        expect(dropped.calls).toBe(1); expect(dropped.synchronous).toBe(true); expect(dropped.prevented).toBe(true)
        observations.push({ directoryDrop: dropped })
      } else {
        const wrapped = distributionZip([...saved].map(([path, bytes]) => member('旧版/Savedata/' + path, bytes)).concat([
          member('旧版/Savedata.old/migration0.bmp', 'other directory'), member('旧版/data.xp3', 'game resource'),
        ])), open = async () => {
          const dropped = await dropImportFiles(page, [{ path: '旧版备份.zip', bytes: wrapped }], target)
          expect(dropped.prevented).toBe(true)
          await expect(page.locator('#save-zip-panel')).toBeVisible()
          const directory = page.getByLabel('ZIP 内的存档目录', { exact: true })
          await directory.selectOption('旧版/'); await directory.selectOption('旧版/Savedata/')
          await expect(page.locator('#save-zip-summary')).toContainText(`共 ${saved.size} 个文件`)
          observations.push({ zipDrop: dropped, selected: '旧版/Savedata/', sha256: saveBytesDigest(wrapped) })
        }
        await open()
        await expect(marker).toHaveCount(0)
        expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
        // Resume retires the pending directory choice. It does not silently
        // write a whole backup or leave an old confirmation for the next pause.
        await resume(); await expect(page.locator('#save-zip-panel')).toBeHidden()
        expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
        await pause(); await open()
        await page.locator('#import-save-zip-directory').click()
      }
      await expect(marker).toHaveCount(1, { timeout: 15000 })
      await expect(page.locator('#status')).toHaveText('已暂停')
      const restored = await exportNative('after-native-save-drop.zip')
      expect(restored.get('migration0.bmp')).toEqual(slot)
      expect(restored.get('notes/player.txt')).toEqual(notes)
      expect([...restored.keys()].some((path) => path.startsWith('旧版/') || path.startsWith('game-import-') || path.startsWith('savedata/'))).toBe(false)
      expect(restored.has('data.xp3')).toBe(false)
      expect([...restored.keys()].some((path) => path.includes('Savedata.old/'))).toBe(false)
      await resume(); await state(99, 4)
      expect(await read('nativeStoredState()')).toBe('7|*checkpoint')
      expect(await read('[].load("outside-native.txt")[0]')).toBe('outside-data-directory')
      await clickLink(2, '*load'); await state(7, 5)
      expect(await read('[].load(System.dataPath+"notes/player.txt")[0]')).toBe('native-sidecar:7')

      await page.reload(); await start(); await state(7, 1)
      await clickLink(1, '*change'); await state(99, 2)
      await clickLink(2, '*load'); await state(7, 3)
      expect(await read('nativeStoredState()')).toBe('7|*checkpoint')
      const fresh = await exportNative('fresh-session-restored-slot.zip')
      expect(fresh.get('migration0.bmp')).toEqual(slot)
      expect(fresh.get('notes/player.txt')).toEqual(notes)
      await canvas.scrollIntoViewIfNeeded()
      await info.attach('native-drop-restored-game', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try { await info.attach('native-save-drop-observations', { body: JSON.stringify({ observations, errors,
      logs: await page.locator('#logs').innerText(), source: nativeSaveStory + '\n' + nativeSaveGameSource,
      scope: 'Original KAG save/load tags and complete BMP thumbnail/bookmark bytes. Actual File/DataTransfer and OPFS getFile APIs; the test supplies DragEvent and the directory capability accessor, not an OS drag gesture.' }, null, 2), contentType: 'application/json' }) }
    catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    for (const name of directories) try { await removeImportDirectory(page, name) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Native save drop gameplay or cleanup failed', { cause: failures[0] })
  })
