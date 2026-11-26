import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { registryGame } from '../helpers/registry-game.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) for (const companion of [false, true])
  test(`${backend}/${companion ? binary ? 'bytecode and companion XP3 registry' : 'source and companion loose registry' : binary ? 'bytecode and XP3 registry' : 'source and loose registry'}: an explicitly selected game registry drives the original KAG route and survives library restart`, async ({ page }, info) => {
    test.setTimeout(180000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = registryGame(binary, companion), { read, clickLink } = kagGameControls(page, observations),
      canvas = page.locator('#stage canvas[data-window-id]'), title = `Registry route ${backend} ${binary} ${companion}`,
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    const ready = async (configured: boolean) => {
      await expect(page.getByText('registry-game-ready', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect.poll(() => read('registryState()')).toBe('*choice|2|0|0')
      expect(await read('registryRendered')).toBe(configured ? 'REGISTRY ROUTE' : 'NO REGISTRY')
      expect(await read('registryVisits')).toBe('1')
      expect(await read('registryReads()')).toBe(configured ? 'REGISTRY ROUTE|7|*selected|1|1' : 'void|void|void|0|1')
      expect(await read('int(registryScore===7)')).toBe(configured ? '1' : '0')
      expect(await read('System.exePath+"|"+System.dataPath')).toBe('game://./Game/|game://./Game/savedata/')
      if (companion) {
        expect(await read('int(Storages.isExistentStorage("game://./outside-only.tjs"))')).toBe('0')
        expect(await read(`int(Storages.isExistentStorage("game://./${binary ? 'Settings.xp3' : 'settings.reg'}"))`)).toBe('0')
      }
      if (configured) await expect(page.locator('#project-status')).toContainText(fixture.publicRegistryFile)
      else await expect(page.locator('#project-status')).not.toContainText('游戏注册表：')
    }, chapter = async (value: number, visits: number) => {
      await expect.poll(() => read('registryState()')).toBe(`*checkpoint|2|0|${value}`)
      expect(await read('registryVisits')).toBe(String(visits))
      expect(await read('registryRendered')).toBe(`REGISTRY SAVED ${value}`)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }, stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }, backup = async () => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path()
      if (!path) throw new Error('No original registry-game bookmark returned')
      const data = JSON.parse(await readFile(path, 'utf8')) as { gameId: string; files: Array<{ path: string; base64: string }> },
        saved = data.files.find((file) => file.path === 'Game/savedata/registry0.kdt')
      expect(saved).toBeDefined()
      const bytes = Buffer.from(saved!.base64, 'base64')
      expect(bytes.toString('utf16le')).toContain('*checkpoint')
      expect(typeof data.gameId).toBe('string'); expect(data.gameId).not.toBe('')
      if (binary) {
        const compiled = data.files.find((file) => file.path === 'Game/savedata/registry.cjs')
        expect(compiled).toBeDefined()
        expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      return { bytes, gameId: data.gameId }
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await expect(page.locator('#registry-file')).toHaveValue('')
      // With no registry selection an XP3 keeps its original native-game
      // priority. Select the game explicitly for this default/no-read control.
      if (companion && binary) await page.locator('#project-executable').fill('RegistryGame.zip')
      await page.locator('#files').setInputFiles(fixture.files)
      await ready(false)
      await stop()
      await page.locator('#clear-log').click()
      await page.locator('#registry-file').fill(fixture.registryFile)
      if (companion && binary) await page.locator('#project-executable').fill('')
      await page.locator('#restart').click()
      await ready(true)
      await clickLink(0, '*selected'); await chapter(7, 2)
      await clickLink(0, '*save'); await chapter(7, 3)
      expect(await read('registryStored()')).toBe('7|*checkpoint')
      const before = await backup()
      await clickLink(1, '*change'); await chapter(99, 4)
      // Editing the next-import form cannot replace the live Session's source
      // or the configuration captured when saving that game to the library.
      await page.locator('#registry-file').fill(fixture.otherFile)
      expect(await read('registryReads()')).toBe('REGISTRY ROUTE|7|*selected|1|1')
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      await page.locator('#registry-file').fill(fixture.otherFile)
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready(true)
      await expect(page.locator('#registry-file')).toHaveValue(fixture.otherFile)
      expect(await read('registryStored()')).toBe('7|*checkpoint')
      const reopened = await backup()
      expect(reopened.gameId).toBe(before.gameId); expect(reopened.bytes.equals(before.bytes)).toBe(true)
      await clickLink(1, '*load'); await chapter(7, 2)
      await info.attach('restored-registry-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await info.attach('original-registry-bookmark', { body: before.bytes, contentType: 'application/octet-stream' })
      observations.push({ gameId: before.gameId, bookmarkBytes: before.bytes.length,
        bookmarkSha256: createHash('sha256').update(before.bytes).digest('hex') })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const finish of [
      () => info.attach('registry-game-inputs', { body: JSON.stringify(fixture.manifest, null, 2), contentType: 'application/json' }),
      () => info.attach('registry-game-observations', { body: JSON.stringify({ observations, errors }), contentType: 'application/json' }),
      async () => info.attach('registry-game-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      stop,
    ]) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Game registry configuration or bookmark restoration failed', { cause: failures[0] })
  })
