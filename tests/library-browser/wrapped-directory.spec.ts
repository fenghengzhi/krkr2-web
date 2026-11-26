import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect } from '../helpers/library-browser.ts'
import { chooseGameDirectory, observeGameDirectoryInput } from '../helpers/game-directory-input.ts'
import { chooseRemoteManifest, remoteManifestGame, remoteManifestUi, submitRemoteManifest } from '../helpers/remote-manifest-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const source of ['folder', 'manifest']) {
  test(`${backend}/${source}: a wrapped original KAG release keeps its chapter and native bookmark when reopened`, async ({ page }, info) => {
    test.setTimeout(150000)
    await observeGameDirectoryInput(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const path = '合集/Novel/', compiled = source === 'manifest'
    const fixture = await remoteManifestGame(compiled, path), game = remoteManifestUi(page, info, path), failures: unknown[] = []
    let folder: string | undefined
    try {
      if (source === 'folder') {
        folder = await mkdtemp(join(tmpdir(), 'wrapped-krkr-'))
        for (const item of fixture.inputs) {
          const name = join(folder, item.path)
          await mkdir(dirname(name), { recursive: true })
          await writeFile(name, item.bytes)
        }
        await writeFile(join(folder, 'collection.tjs'),
          'System.exitOnNoWindowStartup=false; Debug.message("selected-custom-entry:"+System.exePath);')
        await fixture.close()
        await chooseGameDirectory(page, folder)
      } else {
        await chooseRemoteManifest(page, false)
        await submitRemoteManifest(page, fixture.server.url + '/manifest')
      }
      await game.ready()
      await game.state(0, 1, true)
      await expect(page.locator('#project-mode')).toHaveValue('auto')
      await expect(page.locator('#project-exe-directory')).toHaveValue('')
      await expect(page.locator('#project-status')).toContainText(path + 'data.xp3>')
      await game.clickLink(0, '*selected'); await game.state(7, 2)
      await game.clickLink(0, '*save'); await game.state(7, 3)
      const first = await game.backup('wrapped-native-bookmark.json', compiled)

      if (source === 'folder') {
        // The same files used to require this path by hand. Keep the same
        // namespace when the player switches between automatic and explicit.
        await game.stop()
        await page.locator('#clear-log').click()
        await page.locator('#project-exe-directory').fill('合集/novel/')
        await page.locator('#restart').click()
      } else {
        const title = 'Wrapped original KAG ' + backend
        await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
        const item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
        await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
        await game.stop(); await fixture.close(); await page.reload()
        await item.getByRole('button', { name: '启动', exact: true }).click()
      }
      await game.ready(); await game.state(0, 1, true)
      const after = await game.backup('reopened-native-bookmark.json', compiled)
      expect(after.gameId).toBe(first.gameId)
      expect(after.slot.equals(first.slot)).toBe(true)
      expect(await game.read('remoteStored()')).toBe('7|*checkpoint')
      await game.clickLink(1, '*load'); await game.state(7, 2)
      await game.screenshot('wrapped-kag-restored')
      if (source === 'folder') {
        await game.stop(); await page.locator('#clear-log').click()
        await page.locator('#project-exe-directory').fill('')
        await page.locator('#entry').fill('collection.tjs')
        await page.locator('#restart').click()
        await expect(page.getByText('selected-custom-entry:game://./', { exact: true })).toBeVisible()
      }
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    if (folder) try { await rm(folder, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    await game.finish(failures, fixture, { source, gameDirectory: path })
  })
}
