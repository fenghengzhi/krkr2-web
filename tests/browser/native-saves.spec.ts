import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { inflateSync } from 'node:zlib'
import { expect, test } from '@playwright/test'
import { distributionZip, member } from '../helpers/deflated-distribution.ts'
import { nativeSaveGameSource, nativeSaveStory, nativeSaveZipFiles, nativeSdkResult,
  nativeSdkSaveFiles, nativeSdkSaveReference, saveBytesDigest } from '../helpers/native-saves.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode/ZIP' : 'source/folder'}: native save files preserve KAG thumbnails, SDK macro bookmarks and restored player progress`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], errors: string[] = [], observations: unknown[] = [], imports: unknown[] = []
    let sequence = 0, folder: string | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const canvas = page.locator('#stage canvas[data-window-id]'), sdk = nativeSdkSaveFiles(),
      original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
      utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le'),
      files = [
        { name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
        { name: 'first.ks', mimeType: 'text/plain', buffer: utf16(nativeSaveStory) },
        { name: 'native-save-game.tjs', mimeType: 'text/plain', buffer: utf16(nativeSaveGameSource) },
        { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: utf16(binary
          ? 'Scripts.compileStorage("native-save-game.tjs","savedata/native-save-game.cjs",false,true,false);Scripts.execStorage("savedata/native-save-game.cjs");'
          : 'Scripts.execStorage("native-save-game.tjs");') },
        ...['entry.ks', 'chapter.ks'].map((name) => ({ name, mimeType: 'text/plain', buffer: sdk.get(name)! })),
      ]
    const read = async (expression: string): Promise<string> => {
      const prefix = `native-save-read-${++sequence}:`
      await expect(page.locator('#evaluate')).toBeEnabled()
      await page.evaluate((source) => {
        const input = document.querySelector<HTMLInputElement>('#expression')!, button = document.querySelector<HTMLButtonElement>('#evaluate')!
        if (button.disabled) throw new Error('Native save observer is unavailable')
        input.focus({ preventScroll: true }); input.value = source; button.click()
      }, `${JSON.stringify(prefix)}+string(Scripts.eval(${JSON.stringify(expression)}))`)
      const output = page.locator('#logs p span').filter({ hasText: new RegExp('^' + prefix) }).last()
      await expect(output).toBeVisible({ timeout: 5000 })
      const value = ((await output.textContent()) ?? '').slice(prefix.length)
      if (observations.length < 160) observations.push({ expression, value })
      return value
    }
    const start = async () => {
      await page.locator('#files').setInputFiles(files)
      await expect(page.getByText('native-save-game-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
      await expect(canvas).toHaveCount(1)
      await expect(page.locator('#status')).toHaveText('运行中')
    }
    const state = async (progress: number, visits: number) => {
      await expect.poll(() => read('nativeSaveState()'), { timeout: 15000 })
        .toBe(`${progress}|CHECKPOINT ${progress}|${visits}|*checkpoint|5|0`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }
    const clickLink = async (index: number, target: string) => {
      const raw = await read(`(function(){var m=kag.current,l=m.links[${index}];
        var x=l.x[0]+(l.w[0]>>1),y=l.y[0]+(l.h[0]>>1);
        if(!l.fixed[0]){x+=m.lineLayerOriginX+m.getLineLayerLeftOffset();y+=m.lineLayerOriginY+m.getLineLayerTopOffset();}
        for(var p=m;p!==null;p=p.parent){x+=p.left;y+=p.top;}
        return [x,y,l.w[0],l.h[0],l.target,int(m.selProcessLock)].join("|");})()`), parts = raw.split('|')
      expect(parts).toHaveLength(6); expect(parts[4]).toBe(target); expect(parts[5]).toBe('0')
      const [x, y, width, height] = parts.slice(0, 4).map(Number)
      expect(width).toBeGreaterThan(0); expect(height).toBeGreaterThan(0)
      expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThan(640)
      expect(y).toBeGreaterThanOrEqual(0); expect(y).toBeLessThan(480)
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      const box = await canvas.boundingBox(); expect(box).not.toBeNull()
      observations.push({ click: target, point: [x, y], box })
      await canvas.click({ position: { x: x! * box!.width / 640, y: y! * box!.height / 480 }, timeout: 5000 })
    }
    const download = async (mode: 'backup' | 'native', label: string): Promise<Buffer> => {
      await page.locator('#save-format').selectOption(mode)
      const pending = page.waitForEvent('download', { timeout: 10000 })
      await page.locator('#export-saves').click()
      const result = await pending
      expect(await result.failure()).toBeNull()
      const path = await result.path(); expect(path).not.toBeNull()
      const bytes = await readFile(path!)
      await info.attach(label, { body: bytes, contentType: mode === 'native' ? 'application/zip' : 'application/json' })
      observations.push({ exported: mode, name: result.suggestedFilename(), bytes: bytes.length, sha256: saveBytesDigest(bytes) })
      return bytes
    }
    const pause = async () => {
      await page.locator('#save-format').selectOption('native')
      await expect(page.locator('#import-saves')).toBeDisabled()
      await page.locator('#pause').click()
      await expect(page.locator('#status')).toHaveText('已暂停')
      await expect(page.locator('#import-saves')).toBeEnabled()
    }
    const resume = async () => {
      await page.locator('#pause').click()
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#import-saves')).toBeDisabled()
    }
    const importFiles = async (selected: { name: string; mimeType: string; buffer: Buffer }[], label: string) => {
      const marker = page.locator('#logs p span').filter({ hasText: /^存档已导入/ }), before = await marker.count(),
        choosing = page.waitForEvent('filechooser', { timeout: 5000 })
      await page.locator('#import-saves').click()
      const chooser = await choosing
      expect(await chooser.element().getAttribute('id')).toBe('native-save-files')
      await chooser.setFiles(selected)
      await expect(marker).toHaveCount(before + 1)
      imports.push({ mode: label, files: selected.map((file) => ({ name: file.name, bytes: file.buffer.length, sha256: saveBytesDigest(file.buffer) })) })
      await expect(page.locator('#status')).toHaveText('已暂停')
    }
    try {
      expect(saveBytesDigest(original)).toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
      await start(); await state(7, 1)
      await clickLink(0, '*save'); await state(7, 2)
      expect(await read('nativeStoredState()')).toBe('7|*checkpoint')
      const dataPath = (await read('System.dataPath')).replace(/^game:\/\/\.\//, ''),
        backup = JSON.parse((await download('backup', 'native-all-files-before.json')).toString()) as { files: { path: string; base64: string }[] },
        zip = await download('native', 'native-data-directory-original.zip'), entries = nativeSaveZipFiles(zip),
        expected = new Map(backup.files.filter((file) => file.path.startsWith(dataPath))
          .map((file) => [file.path.slice(dataPath.length), Buffer.from(file.base64, 'base64')]))
      expect(dataPath).toBe('savedata/')
      expect(backup.files.some((file) => file.path === 'outside-native.txt')).toBe(true)
      expect([...entries.keys()].sort()).toEqual([...expected.keys()].sort())
      for (const [name, bytes] of entries) expect(bytes.equals(expected.get(name)!)).toBe(true)
      expect(entries.has('outside-native.txt')).toBe(false)
      expect([...entries.keys()].some((name) => name.startsWith('savedata/'))).toBe(false)
      const bookmark = entries.get('migration0.bmp'), notes = entries.get('notes/player.txt')
      expect(bookmark).toBeDefined(); expect(notes).toBeDefined()
      expect([...notes!.subarray(0, 5)]).toEqual([0xfe, 0xfe, 2, 0xff, 0xfe])
      expect(notes!.readBigUInt64LE(5)).toBe(BigInt(notes!.length - 21))
      const noteText = inflateSync(notes!.subarray(21), { maxOutputLength: 1024 })
      expect(notes!.readBigUInt64LE(13)).toBe(BigInt(noteText.length))
      expect(noteText.equals(Buffer.from('native-sidecar:7\r\n', 'utf16le'))).toBe(true)
      expect(bookmark!.toString('ascii', 0, 2)).toBe('BM')
      const bmpBytes = 54 + 64 * 3 * 48
      expect([bookmark!.readUInt32LE(2), bookmark!.readUInt32LE(10), bookmark!.readInt32LE(18),
        bookmark!.readInt32LE(22), bookmark!.readUInt16LE(28)]).toEqual([bmpBytes, 54, 64, 48, 24])
      expect(bookmark!.length).toBeGreaterThan(bmpBytes + 2)
      expect([...bookmark!.subarray(bmpBytes, bmpBytes + 2)]).toEqual([255, 254])
      const payload = bookmark!.subarray(bmpBytes).toString('utf16le')
      expect(payload).toContain('nativeProgress'); expect(payload).toContain('*checkpoint')
      await info.attach('native-kag-bookmark-payload.txt', { body: payload, contentType: 'text/plain' })
      if (binary) expect(entries.get('native-save-game.cjs')!.toString('ascii', 0, 4)).toBe('TJS2')

      // Overwrite the actual slot before import: merely changing live f would
      // not distinguish restoration from reading the old database entry.
      await clickLink(1, '*change'); await state(99, 3)
      await clickLink(0, '*save'); await state(99, 4)
      expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
      await pause()
      await importFiles([
        { name: 'migration0.bmp', mimeType: 'image/bmp', buffer: bookmark! },
        { name: 'sdk-bookmark.tjs', mimeType: 'application/octet-stream', buffer: sdk.get('native-bookmark.tjs')! },
      ], 'multiple-raw-native-files')
      const restoredBytes = nativeSaveZipFiles(await download('native', 'native-after-raw-import.zip'))
      expect(restoredBytes.get('migration0.bmp')!.equals(bookmark!)).toBe(true)
      expect(restoredBytes.get('sdk-bookmark.tjs')!.equals(sdk.get('native-bookmark.tjs')!)).toBe(true)
      await resume(); await state(99, 4)
      expect(await read('nativeStoredState()')).toBe('7|*checkpoint')
      await clickLink(2, '*load'); await state(7, 5)
      await clickLink(3, '*sdk'); await state(7, 6)
      expect(await read('nativeSdkResult')).toBe(nativeSdkResult)

      // A fresh Worker must use the imported file; game startup initializes f
      // to7, so change it back to99 before invoking the original load tag.
      await page.reload(); await start(); await state(7, 1)
      await clickLink(1, '*change'); await state(99, 2)
      await clickLink(2, '*load'); await state(7, 3)
      await clickLink(3, '*sdk'); await state(7, 4)
      expect(await read('nativeSdkResult')).toBe(nativeSdkResult)

      await clickLink(1, '*change'); await state(99, 5)
      await clickLink(0, '*save'); await state(99, 6)
      expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
      await pause()
      if (binary) await importFiles([{ name: 'native-data.zip', mimeType: 'application/zip', buffer: zip }], 'single-native-ZIP')
      else {
        folder = await mkdtemp(join(tmpdir(), 'krkr-native-save-'))
        const selectedRoot = join(folder, 'original-data-directory')
        for (const [name, bytes] of entries) {
          const path = join(selectedRoot, name)
          await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes)
        }
        const marker = page.locator('#logs p span').filter({ hasText: /^存档已导入/ }), before = await marker.count(),
          choosing = page.waitForEvent('filechooser', { timeout: 5000 })
        await page.locator('#choose-native-save-folder').click()
        const chooser = await choosing
        expect(await chooser.element().getAttribute('id')).toBe('native-save-folder')
        await chooser.setFiles(selectedRoot, { timeout: 15000 })
        await expect(marker).toHaveCount(before + 1)
        imports.push({ mode: 'real-folder', topDirectory: 'original-data-directory', relativeFiles: [...entries.keys()] })
      }
      const after = nativeSaveZipFiles(await download('native', 'native-after-container-import.zip'))
      for (const name of ['migration0.bmp', 'notes/player.txt']) expect(after.get(name)!.equals(entries.get(name)!)).toBe(true)
      expect([...after.keys()].some((name) => name.startsWith('original-data-directory/'))).toBe(false)
      await resume(); await state(99, 6)
      expect(await read('nativeStoredState()')).toBe('7|*checkpoint')
      expect(await read('[].load(System.dataPath+"notes/player.txt")[0]')).toBe('native-sidecar:7')
      expect(await read('[].load("outside-native.txt")[0]')).toBe('outside-data-directory')

      await clickLink(0, '*save'); await state(99, 7)
      expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
      await pause()
      const wrapped = distributionZip([
        ...Array.from(entries, ([name, bytes]) => member('旧版/SaveData/' + name, bytes)),
        member('旧版/SaveData.old/migration0.bmp', 'different slot'),
        member('旧版/Assets/scene.txt', 'game content'),
      ])
      const chooseDirectory = async () => {
        const choosing = page.waitForEvent('filechooser')
        await page.getByRole('button', { name: '从 ZIP 中选择存档目录' }).click()
        await (await choosing).setFiles({ name: '旧版备份.zip', mimeType: 'application/zip', buffer: wrapped })
        const selector = page.getByLabel('ZIP 内的存档目录', { exact: true })
        await selector.selectOption('旧版/')
        await selector.selectOption('旧版/SaveData/')
        await expect(page.locator('#save-zip-summary')).toContainText(`共 ${entries.size} 个文件`)
      }
      await chooseDirectory()
      await resume()
      await expect(page.locator('#save-zip-panel')).toBeHidden()
      expect(await read('nativeStoredState()')).toBe('99|*checkpoint')
      await pause(); await chooseDirectory()
      const marker = page.locator('#logs p span').filter({ hasText: /^存档已导入/ }), before = await marker.count()
      await page.getByRole('button', { name: '导入此目录' }).click()
      await expect(marker).toHaveCount(before + 1)
      const selected = nativeSaveZipFiles(await download('native', 'selected-save-directory.zip'))
      expect(selected.get('migration0.bmp')).toEqual(bookmark)
      expect(selected.get('notes/player.txt')).toEqual(entries.get('notes/player.txt'))
      expect([...selected.keys()].some((name) => name.startsWith('旧版/'))).toBe(false)
      imports.push({ mode: 'selected-desktop-backup-directory', directory: '旧版/SaveData/', sha256: saveBytesDigest(wrapped) })
      await resume()
      expect(await read('nativeStoredState()')).toBe('7|*checkpoint')
      await page.reload(); await start(); await state(7, 1)
      await clickLink(1, '*change'); await state(99, 2)
      await clickLink(2, '*load'); await state(7, 3)
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      await info.attach('native-restored-kag.png', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(4, '*finish')
      await expect(page.getByText('native-save-story-finished:7', { exact: true })).toBeVisible()
      await expect.poll(() => read('nativeSaveState()')).toBe('7|FINISHED|3|*finish|0|0')
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    try {
      await info.attach('native-save-observations.json', { body: JSON.stringify({ backend, binary, observations, imports, errors,
        sdkReference: nativeSdkSaveReference, scope: 'Original KAG Window save/load tags use real link clicks, including slot overwrite, paused native-file/container import and refresh. Fixed original SDK bytes independently restore a KAGParser macro/call snapshot through a game link; this is not claimed to be a Windows MainWindow save.' }, null, 2), contentType: 'application/json' })
      await info.attach('native-save-story.ks', { body: nativeSaveStory, contentType: 'text/plain' })
      await info.attach('native-save-log.txt', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    try { if (folder) await rm(folder, { recursive: true, force: true }) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Native save migration or cleanup failed', { cause: failures[0] })
  })
