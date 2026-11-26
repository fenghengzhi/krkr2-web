import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test, expect } from '../helpers/library-browser.ts'
import { discBootInput } from '../helpers/disc-boot.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'CUE+ISO bytecode' : 'ISO-only source'}: importing the complete disc boots original KAG and restores its chapter after library refresh`, async ({ page }, info) => {
    test.setTimeout(180000)
    const input = discBootInput(binary), errors: string[] = [], observations: unknown[] = [], failures: unknown[] = [],
      title = `Boot disc ${backend} ${binary}`, canvas = page.locator('#stage canvas[data-window-id]'),
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      { read, clickLink } = kagGameControls(page, observations)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const ready = async () => {
      await expect(page.getByText('story-disc-ready:D:/|Moon disc scene|81', { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect.poll(() => read('discState()')).toBe('*choice|2|0|0')
      expect(await read('discBootPaths()')).toBe([
        'file://./d/discgame/', 'file://./d/discgame/data.xp3>', 'game://./savedata/',
        'file://./d/discgame/data.xp3>startup.tjs', 'file://./d/discgame/patch.xp3>first.ks', 'file://./d/discgame/',
      ].join('|'))
      expect(await read('System.exeName+"|"+System.getArgument("-disc-edition")'))
        .toBe('file://./d/discgame/story.exe|pressing')
      expect(await read('Storages.getPlacedPath("game://./startup.tjs")')).not.toBe('game://./startup.tjs')
    }, chapter = async (progress: number, visits: number) => {
      await expect.poll(() => read('discState()')).toBe(`*arrival|2|0|${progress}`)
      expect(await read('discVisits')).toBe(String(visits))
      expect(await read('discRendered')).toBe(`Moon disc scene ${progress}`)
      expect(await read('Storages.getPlacedPath("story.ks")')).toBe('file://./d/routes/story.ks')
      expect(await read('kag.fore.base.getMainPixel(0,0)')).toBe(String(0x336699))
    }, stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }, backup = async () => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path()
      if (!path) throw new Error('No disc-game save backup returned')
      const bytes = await readFile(path), saved = JSON.parse(bytes.toString()) as { files: Array<{ path: string; base64: string }> },
        slot = saved.files.find((file) => file.path === 'savedata/disc0.kdt')
      if (!slot) throw new Error('Original KAG slot 0 is absent')
      expect(saved.files.every((file) => !file.path.includes('://') && !file.path.includes(':'))).toBe(true)
      if (binary) {
        const script = saved.files.find((file) => file.path === 'savedata/story.cjs')
        expect(script).toBeDefined()
        expect(Buffer.from(script!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      return { bytes, slot: Buffer.from(slot.base64, 'base64') }
    }
    try {
      if (binary) await page.locator('#project-mode').selectOption('auto')
      await expect(page.locator('#project-mode')).toHaveValue(binary ? 'auto' : 'collection')
      await page.locator('#cdda-discs').fill('')
      expect(input.files.map((file) => file.name)).toEqual(binary ? ['boot.cue', 'boot-bytecode.iso'] : ['boot-source.iso'])
      await page.locator('#files').setInputFiles(input.files)
      expect(await page.locator('#files').evaluate((node) => Array.from((node as HTMLInputElement).files!, (file) => file.name)))
        .toEqual(input.files.map((file) => file.name))
      await ready()
      await clickLink(0, '*enter'); await chapter(42, 1)
      await info.attach('disc-first-chapter', { body: await canvas.screenshot(), contentType: 'image/png' })
      await clickLink(0, '*save'); await chapter(42, 2)
      expect(await read('discSlot()')).toBe('42|*arrival')
      const before = await backup()
      expect(before.slot.toString('utf16le')).toContain('*arrival')
      await clickLink(1, '*change'); await chapter(99, 3)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready()
      expect((await backup()).slot.equals(before.slot)).toBe(true)
      await clickLink(1, '*load'); await chapter(42, 1)
      expect(await read('discSlot()')).toBe('42|*arrival')
      await info.attach('disc-restored-chapter', { body: await canvas.screenshot(), contentType: 'image/png' })
      await info.attach('original-disc-bookmark', { body: before.slot, contentType: 'application/octet-stream' })
      observations.push({ originalSlotSha256: createHash('sha256').update(before.slot).digest('hex'), originalSlotBytes: before.slot.length })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const finish of [
      () => info.attach('disc-boot-input', { body: JSON.stringify(input.manifest, null, 2), contentType: 'application/json' }),
      () => info.attach('disc-boot-observations', { body: JSON.stringify({ observations, errors }), contentType: 'application/json' }),
      async () => info.attach('disc-boot-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      stop,
    ]) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Original disc boot or cleanup failed', { cause: failures[0] })
  })
