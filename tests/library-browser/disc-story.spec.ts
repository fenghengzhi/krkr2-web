import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { test, expect } from '../helpers/library-browser.ts'
import { discStoryGame } from '../helpers/disc-story.ts'
import { discStoryRelease } from '../helpers/disc-story-release.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'
import { assertGameDirectoryInput, attachGameDirectoryInput, chooseGameDirectory, observeGameDirectoryInput } from '../helpers/game-directory-input.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) for (const packaged of [false, true]) {
  test(`${backend}/${packaged ? 'ZIP with external disc ' : ''}${binary ? 'bytecode' : 'source'}: original KAG reads the chapter from a CD and restores its saved page after library restart`, async ({ page }, info) => {
    test.setTimeout(150000)
    const errors: string[] = [], observations: unknown[] = [], failures: unknown[] = []
    let folder: string | undefined, selection: Awaited<ReturnType<typeof chooseGameDirectory>> | undefined
    page.on('pageerror', (error) => errors.push(error.message))
    if (packaged && !binary) await observeGameDirectoryInput(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const { read, clickLink } = kagGameControls(page, observations)
    const release = packaged ? discStoryRelease(binary) : undefined,
      drive = release?.drive ?? 'G', directory = release?.directory ?? '',
      inputs = release?.files ?? discStoryGame(binary),
      canvas = page.locator('#stage canvas[data-window-id]'), title = `CD story ${backend} ${binary}${packaged ? ' ZIP' : ''}`
    const item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) })
    const ready = async () => {
      await expect(page.getByText(`story-disc-ready:${drive}:/|Moon disc scene|81`, { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect.poll(() => read('discState()')).toBe('*choice|2|0|0')
      if (packaged) {
        expect(await read('System.exePath+"|"+Storages.getFullPath("./")+"|"+System.dataPath'))
          .toBe('game://./Game/|game://./Game/data.xp3>|game://./Game/savedata/')
        expect(await read('Storages.getPlacedPath("first.ks")')).toBe('game://./Game/patch.xp3>first.ks')
        expect(await read('int(Storages.isExistentStorage("game://./notes.txt"))')).toBe('0')
        expect(await read('(function(){try{Scripts.evalStorage("game://./notes.txt");return "unexpected read";}catch(e){return "unavailable";}})()'))
          .toBe('unavailable')
      }
    }
    const chapter = async (value: number, visits: number) => {
      await expect.poll(() => read('discState()')).toBe(`*arrival|2|0|${value}`)
      await expect.poll(() => read('discVisits')).toBe(String(visits))
      expect(await read('Storages.getPlacedPath("story.ks")')).toBe(`file://./${drive.toLowerCase()}/routes/story.ks`)
      expect(await read('kag.fore.base.getMainPixel(0,0)')).toBe(String(0x336699))
      expect(await read('discRendered')).toContain(`Moon disc scene ${value}`)
    }
    const stop = async () => {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    }
    const slotBytes = async () => {
      await page.locator('#save-format').selectOption('backup')
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-saves').click()])
      expect(await download.failure()).toBeNull()
      const path = await download.path()
      if (!path) throw new Error('No save backup returned')
      const backup = JSON.parse(await readFile(path, 'utf8')) as { gameId: string; files: { path: string; base64: string }[] }
      const slot = backup.files.find((file) => file.path === directory + 'savedata/disc0.kdt')
      if (!slot) throw new Error('KAG slot 0 is missing')
      const bytes = Buffer.from(slot.base64, 'base64')
      expect(bytes.toString('utf16le')).toContain('*arrival')
      expect(backup.files.every((file) => !file.path.includes('://'))).toBe(true)
      expect(typeof backup.gameId).toBe('string'); expect(backup.gameId).not.toBe('')
      if (binary) {
        const compiled = backup.files.find((file) => file.path === directory + 'savedata/story.cjs')
        expect(compiled).toBeDefined()
        expect(Buffer.from(compiled!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      return { bytes, gameId: backup.gameId }
    }
    try {
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#cdda-discs').fill(release?.mapping ?? (binary ? 'G=game://./story.iso' : 'G=game://./story.cue'))
      if (packaged) await page.locator('#project-executable').fill('Game.zip')
      if (packaged && !binary) {
        folder = await mkdtemp(join(tmpdir(), 'krkr-external-disc-'))
        for (const file of inputs) {
          const path = join(folder, file.name)
          await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.buffer)
        }
        selection = await chooseGameDirectory(page, folder)
      } else await page.locator('#files').setInputFiles(inputs)
      await ready()
      if (selection) await assertGameDirectoryInput(page, info, selection,
        inputs.map((file) => ({ path: file.name, bytes: file.buffer.length })), 'auto', 'external-disc')
      await clickLink(0, '*enter'); await chapter(42, 1)
      await clickLink(0, '*save'); await chapter(42, 2)
      expect(await read('discSlot()')).toBe('42|*arrival')
      const before = await slotBytes()
      await clickLink(1, '*change'); await chapter(99, 3)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready()
      const reopened = await slotBytes()
      expect(reopened.bytes.equals(before.bytes)).toBe(true)
      expect(reopened.gameId).toBe(before.gameId)
      await clickLink(1, '*load'); await chapter(42, 1)
      await info.attach('restored-disc-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await info.attach('original-disc-chapter-bookmark', { body: before.bytes, contentType: 'application/octet-stream' })
      observations.push({ gameId: before.gameId, slotBytes: before.bytes.length,
        slotSha256: createHash('sha256').update(before.bytes).digest('hex') })
      await expect(page.locator('#logs .error')).toHaveCount(0); expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    for (const finish of [
      async () => { if (release) await info.attach('external-disc-input', { body: JSON.stringify(release.manifest, null, 2), contentType: 'application/json' }) },
      async () => { if (folder) await attachGameDirectoryInput(page, info, 'external-disc-final') },
      () => info.attach('disc-chapter-observations', { body: JSON.stringify({ observations, errors }), contentType: 'application/json' }),
      async () => info.attach('disc-chapter-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' }),
      stop,
      async () => { if (folder) await rm(folder, { recursive: true, force: true }) },
    ]) try { await finish() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Disc chapter or cleanup failed', { cause: failures[0] })
  })
}
