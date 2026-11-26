import { test, expect } from '../helpers/library-browser.ts'
import { chooseRemoteManifest, remoteManifestGame, remoteManifestUi, submitRemoteManifest } from '../helpers/remote-manifest-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode explicit root' : 'source automatic root'}: a remote KAG collection saves without rereading its manifest and restores its bookmark with the server closed`, async ({ page }, info) => {
    test.setTimeout(150000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await remoteManifestGame(binary), game = remoteManifestUi(page, info), failures: unknown[] = [],
      afterCloseRequests: string[] = [], title = `Remote KAG ${backend} ${binary ? 'compiled' : 'source'}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      manifestRequests = () => fixture.server.requests.filter((request) => request.method === 'GET' &&
        (request.path === '/manifest' || request.path === '/release/catalog.json')).map((request) => request.path)
    page.on('request', (request) => {
      if (fixture.closed && request.url().startsWith(fixture.server.url + '/')) afterCloseRequests.push(request.url())
    })
    try {
      await chooseRemoteManifest(page, binary)
      await submitRemoteManifest(page, fixture.server.url + '/manifest')
      await game.ready(); await game.state(0, 1, true)
      expect(manifestRequests()).toEqual(['/manifest', '/release/catalog.json'])
      // The original list disappears before either bookmark or library Save.
      // All original file endpoints still serve their fixed bytes until Stop.
      fixture.retireManifest()
      await game.clickLink(0, '*selected'); await game.state(7, 2)
      await game.clickLink(0, '*save'); await game.state(7, 3)
      expect(await game.read('remoteStored()')).toBe('7|*checkpoint')
      const before = await game.backup('remote-slot-before-library.json', binary)
      await game.clickLink(1, '*change'); await game.state(99, 4)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      expect(manifestRequests()).toEqual(['/manifest', '/release/catalog.json'])
      const gets = fixture.server.requests.filter((request) => request.method === 'GET')
      for (const input of fixture.inputs) expect(gets.some((request) => request.path === input.url && !!request.range)).toBe(true)
      await game.stop(); await fixture.close(); await page.reload()
      // Unrelated next-import controls cannot redirect a recorded library game.
      await page.locator('#project-mode').selectOption('root')
      await page.locator('#project-root').fill('missing-game/')
      await page.locator('#remote-url').fill(fixture.server.url + '/missing-manifest')
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await game.ready(); await game.state(0, 1, true)
      expect(await game.read('remoteStored()')).toBe('7|*checkpoint')
      const after = await game.backup('remote-slot-after-library.json', binary)
      expect(after.gameId).toBe(before.gameId); expect(after.slot.equals(before.slot)).toBe(true)
      await game.clickLink(1, '*load'); await game.state(7, 2)
      await game.screenshot('remote-library-restored-chapter')
      expect(afterCloseRequests).toEqual([])
      expect(manifestRequests()).toEqual(['/manifest', '/release/catalog.json'])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    await game.finish(failures, fixture, { manifestRetiredBeforeSave: true, afterCloseRequests })
  })
