import { test, expect } from '@playwright/test'
import { chooseRemoteManifest, remoteManifestGame, remoteManifestUi, submitRemoteManifest } from '../helpers/remote-manifest-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode explicit root' : 'source automatic root'}: a remote manifest rejects an invalid list before file reads, cancels its body and opens real KAG`, async ({ page }, info) => {
    test.setTimeout(120000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = await remoteManifestGame(binary), game = remoteManifestUi(page, info), failures: unknown[] = [],
      evidence: unknown[] = []
    let restartRejected = false
    try {
      await chooseRemoteManifest(page, binary)
      await submitRemoteManifest(page, fixture.server.url + '/invalid/catalog.json')
      await expect(page.locator('#logs .error')).not.toHaveCount(0)
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(page.locator('#load-url')).toBeEnabled()
      const invalidRequests = fixture.server.requests.filter((request) => request.method === 'GET')
      expect(invalidRequests.map((request) => request.path)).toEqual(['/invalid/catalog.json'])
      // A failed launch may retain the UI's empty initial canvas. It must not
      // create a game Window or leave the session Worker alive.
      await expect(page.locator('#stage canvas[data-window-id]')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      evidence.push({ phase: 'invalid', requests: [...invalidRequests], logs: await page.locator('#logs').innerText(),
        initialCanvases: await page.locator('#stage canvas').count() })
      await page.locator('#clear-log').click()

      await submitRemoteManifest(page, fixture.server.url + '/held/catalog.json')
      await expect.poll(() => fixture.held.seen).toBe(1)
      await game.stop()
      await expect.poll(() => fixture.held.aborted).toBe(true)
      fixture.release()
      await expect(page.locator('#logs')).not.toContainText('remote-manifest-game-ready')
      expect(fixture.server.requests.filter((request) => request.path.startsWith('/held/') && request.method === 'GET')
        .map((request) => request.path)).toEqual(['/held/catalog.json'])
      evidence.push({ phase: 'held-body-stop', aborted: fixture.held.aborted, released: fixture.held.released })

      await submitRemoteManifest(page, fixture.server.url + '/manifest')
      await game.ready(); await game.state(0, 1, true)
      await game.clickLink(0, '*selected'); await game.state(7, 2)
      await game.screenshot('remote-kag-chapter')
      const gets = fixture.server.requests.filter((request) => request.method === 'GET')
      expect(gets.filter((request) => request.path === '/manifest')).toHaveLength(1)
      expect(gets.filter((request) => request.path === '/release/catalog.json')).toHaveLength(1)
      expect(gets.some((request) => request.path === '/release/packages/update.bin' && !!request.range)).toBe(true)
      expect(gets.some((request) => request.path === '/release/extras/prompt%20%231.tjs')).toBe(true)
      expect(gets.some((request) => request.path === '/packages/update.bin' || request.path === '/data.xp3')).toBe(false)
      expect(gets.filter((request) => request.path.startsWith('/invalid/')).map((request) => request.path)).toEqual(['/invalid/catalog.json'])
      expect(gets.filter((request) => request.path.startsWith('/held/')).map((request) => request.path)).toEqual(['/held/catalog.json'])
      await expect(page.locator('#logs .error')).toHaveCount(0)

      // A new explicit launch follows the manifest URL again, unlike saving
      // the already running collection into the library's frozen snapshot.
      const beforeRestart = fixture.server.requests.length
      fixture.retireManifest()
      await page.locator('#restart').click()
      await expect(page.locator('#logs .error').filter({ hasText: 'HTTP 404' }).first()).toBeVisible()
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(page.locator('#load-url')).toBeEnabled()
      await expect(page.locator('#stage canvas[data-window-id]')).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      const restartGets = fixture.server.requests.slice(beforeRestart).filter((request) => request.method === 'GET')
      expect(restartGets.map((request) => request.path)).toEqual(['/manifest'])
      evidence.push({ phase: 'restart-refetch-rejected', requests: restartGets,
        logs: await page.locator('#logs').innerText() })
      restartRejected = true
    } catch (error) { failures.push(error) }
    await game.finish(failures, fixture, evidence, restartRejected)
  })
