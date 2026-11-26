import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { discSwapGame } from '../helpers/disc-swap-game.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: a player swaps the live story disc and restores its chapter while the library retains the original pressing`, async ({ page }, info) => {
    test.setTimeout(180000)
    const errors: string[] = [], observations: unknown[] = [], failures: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const fixture = discSwapGame(binary), { read, clickLink } = kagGameControls(page, observations),
      // The bytecode route selects its second disc from the device only while
      // playing. Its persisted game therefore owns just two original files.
      initialFiles = binary ? fixture.files.filter((file) => file.name !== 'story.iso') : fixture.files,
      title = `Swap story disc ${backend} ${binary}`,
      canvas = page.locator('#stage canvas[data-window-id]'),
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    const discPanel = async () => {
      if (!await page.locator('#live-disc').evaluate((element) => (element as HTMLDetailsElement).open))
        await page.locator('#live-disc summary').click()
      await expect(page.locator('#live-disc-drive')).toBeVisible()
    }, volumes = async (expected: string) => {
      await expect.poll(() => read('swapVolumes()'), { timeout: 10000 }).toBe(expected)
      await expect(page.locator('#logs .error')).toHaveCount(0)
    }, ready = async () => {
      await expect(page.getByText('disc-swap-ready:Disc identification scene', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect.poll(() => read('swapState()')).toBe('*first|2|0|0')
      expect(await read('swapOpening')).toBe('Disc identification scene')
      expect(await read('System.exePath+"|"+System.dataPath')).toBe('game://./Game/|game://./Game/savedata/')
      await volumes('D||1|0')
    }, chapter = async (value: number, visits: number) => {
      await expect.poll(() => read('swapState()')).toBe(`*arrival|2|0|${value}`)
      expect(await read('swapRendered')).toBe(`Moon disc scene ${value}`)
      expect(await read('swapVisits')).toBe(String(visits))
      expect(await read('kag.fore.base.getMainPixel(0,0)')).toBe(String(0x336699))
      expect(await read('[kag.fore.base.width,kag.fore.base.height].join("|")')).toBe('640|480')
      expect(await read('(function(){var b=kag.fore.base,v=[];for(var y=0;y<4;y++)for(var x=0;x<4;x++)v.add(b.getMainPixel(x,y));return v.join(",");})()'))
        .toBe(Array(16).fill(String(0x336699)).join(','))
      await volumes('|D|0|1')
    }, insertStory = async (modal = false) => {
      await discPanel()
      await page.locator('#live-disc-drive').fill('D')
      if (binary) {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }),
          page.locator('#choose-live-disc').click()])
        expect(await chooser.element().getAttribute('id')).toBe('live-disc-files')
        await chooser.setFiles(fixture.files.filter((file) => file.name === 'story.iso'))
      } else {
        await page.locator('#live-disc-path').fill('story.iso')
        await expect(page.locator('#insert-disc')).toBeEnabled()
        await page.locator('#insert-disc').click()
      }
      // While System.inform owns the VM, use the actual host response. Script
      // observations resume only after the player confirms that same dialog.
      if (!modal) await volumes('|D|0|1')
      await expect(page.locator('#live-disc-status')).toHaveText('D 盘已换入 story.iso')
      observations.push({ operation: binary ? 'choose-device-disc' : 'insert-imported-disc',
        status: await page.locator('#live-disc-status').innerText() })
    }, backup = async () => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download', { timeout: 10000 }), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path()
      if (!path) throw new Error('The original disc-swap bookmark was not exported')
      const data = JSON.parse(await readFile(path, 'utf8')) as { gameId: string; files: Array<{ path: string; base64: string }> },
        saved = data.files.find((file) => file.path === 'Game/savedata/swap0.kdt')
      expect(saved).toBeDefined()
      const slot = Buffer.from(saved!.base64, 'base64')
      expect(slot.toString('utf16le')).toContain('*arrival')
      expect(typeof data.gameId).toBe('string'); expect(data.gameId).not.toBe('')
      if (binary) {
        const compiled = data.files.find((file) => file.path === 'Game/savedata/swap.cjs')
        expect(compiled).toBeDefined()
        expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      return { gameId: data.gameId, slot }
    }, stop = async () => {
      const dialog = page.locator('.game-system-dialog[open]').last()
      if (await dialog.isVisible()) await dialog.getByRole('button', { name: '停止游戏', exact: true }).click({ timeout: 5000 })
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#project-executable').fill('Game.zip')
      await page.locator('#cdda-discs').fill('D=plain.iso')
      await page.locator('#files').setInputFiles(initialFiles)
      await ready()
      await discPanel()
      await page.locator('#live-disc-drive').fill('D')
      await page.locator('#eject-disc').click()
      await volumes('||0|0')
      await expect(page.locator('#live-disc-status')).toHaveText('D 盘已弹出。')
      await page.locator('#reset-disc').click()
      await volumes('D||1|0')
      await expect(page.locator('#live-disc-status')).toHaveText('D 盘已恢复启动时的设置。')
      expect(await read('[].load("D:/scene.txt","utf-8")[0]')).toBe('Disc identification scene')
      if (binary) {
        await clickLink(0, '*enter')
        const dialog = page.getByRole('dialog', { name: 'Next disc', exact: true })
        await expect(dialog).toBeVisible()
        await expect(dialog).toHaveAttribute('data-kind', 'inform')
        await expect(dialog.getByText('Insert the story disc, then press OK.', { exact: true })).toBeVisible()
        const requestId = await dialog.getAttribute('data-request-id')
        expect(requestId).not.toBeNull()
        await expect(dialog.locator('#live-disc')).toHaveCount(1)
        await expect(page.getByText('disc-swap-modal-resumed', { exact: true })).toHaveCount(0)
        await insertStory(true)
        await expect(dialog).toBeVisible()
        await expect(dialog).toHaveAttribute('data-request-id', requestId!)
        await expect(page.getByText('disc-swap-modal-resumed', { exact: true })).toHaveCount(0)
        observations.push({ modalSwapRequest: requestId, status: await dialog.locator('#live-disc-status').innerText() })
        await dialog.getByRole('button', { name: '确定', exact: true }).click()
        await expect(dialog).toBeHidden()
        await expect(page.getByText('disc-swap-modal-resumed', { exact: true })).toBeVisible()
      } else {
        await insertStory()
        await expect.poll(() => read('swapState()')).toBe('*first|2|0|0')
        await clickLink(0, '*enter')
      }
      await chapter(42, 1)
      expect(await read('swapContinued')).toBe(binary ? '1' : '0')
      await info.attach('second-disc-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(0, '*save'); await chapter(42, 2)
      expect(await read('swapStored()')).toBe('42|*arrival')
      const saved = await backup()
      await clickLink(1, '*change'); await chapter(99, 3)
      // Save while the second disc is inserted. The persisted launch settings
      // must still describe the first pressing, not the live drive override.
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await expect(item.getByText(new RegExp(`· ${initialFiles.length} 个源文件 ·`))).toBeVisible()
      await stop(); await page.reload()
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready()
      await expect(item.getByText(new RegExp(`· ${initialFiles.length} 个源文件 ·`))).toBeVisible()
      const reopened = await backup()
      expect(reopened.gameId).toBe(saved.gameId); expect(reopened.slot.equals(saved.slot)).toBe(true)
      await insertStory()
      await clickLink(1, '*load'); await chapter(42, 1)
      expect(await read('swapContinued')).toBe('0')
      expect(await read('swapStored()')).toBe('42|*arrival')
      await info.attach('restored-second-disc-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await info.attach('original-disc-swap-bookmark', { body: saved.slot, contentType: 'application/octet-stream' })
      observations.push({ gameId: saved.gameId, slotBytes: saved.slot.length,
        slotSha256: createHash('sha256').update(saved.slot).digest('hex') })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const finish of [
      () => info.attach('disc-swap-inputs', { body: JSON.stringify({ ...fixture.manifest,
        initialFiles: initialFiles.map((file) => file.name), liveDeviceOnly: binary ? 'story.iso' : undefined }, null, 2), contentType: 'application/json' }),
      () => info.attach('disc-swap-observations', { body: JSON.stringify({ errors, observations }), contentType: 'application/json' }),
      async () => info.attach('disc-swap-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      stop,
    ]) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Live disc swap or original game restoration failed', { cause: failures[0] })
  })
