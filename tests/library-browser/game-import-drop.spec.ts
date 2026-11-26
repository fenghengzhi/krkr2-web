import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect } from '../helpers/library-browser.ts'
import { chooseGameDirectory, observeGameDirectoryInput } from '../helpers/game-directory-input.ts'
import { remoteManifestGame, remoteManifestUi } from '../helpers/remote-manifest-game.ts'
import { dropImportDirectory, dropImportFiles, removeImportDirectory } from '../helpers/game-import-drop.ts'
import { xp3Fixture } from '../helpers/xp3-fixtures.ts'

const looseStartup = String.raw`
class ImportDropWindow extends Window {
 function ImportDropWindow(){super.Window();caption="Dropped XP3";setInnerSize(96,64);
  var l=new Layer(this,null);add(l);l.setSize(96,64);l.holdAlpha=false;l.fillRect(0,0,96,64,0xff336699);visible=true;}
 function onFileDrop(files){Debug.message("import-window-drop:"+files.count+":"+[].load(files[0],"utf-8")[0]);}
}
var importDropWindow=new ImportDropWindow();Debug.message("import-xp3-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: directory drops and chooser imports share the original KAG chapter, save identity and library restoration`, async ({ page }, info) => {
    test.setTimeout(240000)
    await observeGameDirectoryInput(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const path = '合集/Novel/', fixture = await remoteManifestGame(binary, path), game = remoteManifestUi(page, info, path),
      failures: unknown[] = [], observations: unknown[] = [], directoryNames: string[] = []
    let folder: string | undefined
    try {
      // Import-time files do not use the running Window's smaller event limit.
      // The XP3 is opened through the same launch path as a file chooser.
      const standalone = xp3Fixture({ 'startup.tjs': Buffer.from('\ufeff' + looseStartup, 'utf16le') }).bytes,
        rootFiles = [{ path: 'data.xp3', bytes: standalone }, ...Array.from({ length: 300 }, (_, i) => ({
          path: `notes-${i}.txt`, bytes: Buffer.from('ordinary loose game file ' + i),
        }))]
      observations.push({ files: await dropImportFiles(page, rootFiles) })
      await expect(page.getByText('import-xp3-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      await expect(page.locator('#status')).toHaveText('运行中')
      await expect(page.locator('#project-mode')).toHaveValue('collection')
      const delivered = await dropImportFiles(page, [{ path: 'selection.txt', bytes: Buffer.from('window route') }], '#stage canvas[data-window-id]')
      expect(delivered.prevented).toBe(true)
      await expect(page.getByText('import-window-drop:1:window route', { exact: true })).toBeVisible({ timeout: 15000 })
      await expect(page.locator('#stage canvas[data-window-id]')).toHaveCount(1)
      await game.stop(); await page.locator('#clear-log').click()

      // An ordinary mistaken package remains an error and can be followed by
      // a fresh directory selection. No failed launch becomes a library row.
      const rejected = await dropImportFiles(page, [{ path: 'wrong.xp3', bytes: Buffer.from('This is a text document, not the selected game package.') }])
      expect(rejected.prevented).toBe(true)
      await expect(page.locator('#logs .error').first()).toBeVisible({ timeout: 15000 })
      observations.push({ rejected, error: await page.locator('#logs .error').allTextContents() })
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      await expect(page.locator('#stage canvas[data-window-id]')).toHaveCount(0)
      await expect(page.locator('.library-game')).toHaveCount(0)
      await page.locator('#clear-log').click()

      folder = await mkdtemp(join(tmpdir(), 'drop-original-kag-'))
      for (const file of fixture.inputs) {
        const name = join(folder, file.path)
        await mkdir(dirname(name), { recursive: true }); await writeFile(name, file.bytes)
      }
      await fixture.close()
      await chooseGameDirectory(page, folder)
      await game.ready(); await game.state(0, 1, true)
      await game.clickLink(0, '*selected'); await game.state(7, 2)
      await game.clickLink(0, '*save'); await game.state(7, 3)
      const saved = await game.backup('chooser-native-bookmark.json', binary)
      await game.stop(); await page.locator('#clear-log').click()
      await page.locator('#project-mode').selectOption('collection')

      // These are real OPFS directory/getFile capabilities, with the same
      // nested Japanese paths and original XP3 bytes as the real chooser.
      const directory = await dropImportDirectory(page, fixture.inputs)
      directoryNames.push(directory.name); observations.push({ directory })
      expect(directory.calls).toBe(1); expect(directory.synchronous).toBe(true)
      expect(directory.prevented).toBe(true); expect(directory.overPrevented).toBe(true)
      expect(directory.files).toEqual(fixture.inputs.map((file) => ({ path: file.path, bytes: file.bytes.length })))
      await game.ready(); await game.state(0, 1, true)
      await expect(page.locator('#project-mode')).toHaveValue('auto')
      const dropped = await game.backup('dropped-native-bookmark.json', binary)
      expect(dropped.gameId).toBe(saved.gameId); expect(dropped.slot.equals(saved.slot)).toBe(true)
      expect(await game.read('remoteStored()')).toBe('7|*checkpoint')
      await game.clickLink(1, '*load'); await game.state(7, 2)
      await game.screenshot('dropped-kag-restored')

      const title = `Dropped original KAG ${backend} ${binary ? 'bytecode' : 'source'}`
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      const item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await game.stop(); await page.reload()
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await game.ready(); await game.state(0, 1, true)
      const restored = await game.backup('library-native-bookmark.json', binary)
      expect(restored.gameId).toBe(saved.gameId); expect(restored.slot.equals(saved.slot)).toBe(true)
      await game.clickLink(1, '*load'); await game.state(7, 2)
      await game.screenshot('dropped-library-chapter')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    // Files obtained from OPFS remain owned until the game's real Stop.
    try { await game.stop() } catch (error) { failures.push(error) }
    for (const name of directoryNames) try { await removeImportDirectory(page, name) } catch (error) { failures.push(error) }
    if (folder) try { await rm(folder, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    await game.finish(failures, fixture, { observations, source: looseStartup,
      scope: 'Actual File/DataTransfer and native OPFS directory capabilities enter the production App listener; Playwright authors the DragEvent/accessor, so this does not claim an OS file-manager gesture. Original KAG files, chooser-relative paths, named save identity, source/bytecode observer and library read-back are exact.' })
  })
