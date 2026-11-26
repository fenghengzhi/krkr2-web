import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { test, expect } from '../helpers/library-browser.ts'
import { discBootInput, discReleaseInput, localizedDiscRelease } from '../helpers/disc-boot.ts'
import { udfGameDisc, udfMetadataGameDisc, udfSparableGameDisc } from '../helpers/udf-game-discs.ts'
import { cloneCdDiscInput } from '../helpers/clone-cd-game.ts'
import { oemGameDiscInput } from '../helpers/oem-game-disc.ts'
import { kagGameControls } from '../helpers/kag-game-controls.ts'

const editions = [
  ...[false, true].flatMap((binary) => [
    { kind: 'disc', binary, label: binary ? 'CUE+ISO bytecode' : 'ISO-only source', suffix: '',
      names: binary ? ['boot.cue', 'boot-bytecode.iso'] : ['boot-source.iso'], open: () => discBootInput(binary) },
    { kind: 'zip', binary, label: 'ZIP release ' + (binary ? 'CUE+ISO bytecode' : 'ISO-only source'), suffix: ' ZIP',
      names: binary ? ['StoryBytecode.zip.003', 'StoryBytecode.zip.002', 'StoryBytecode.zip.001'] : ['StorySource.zip'],
      open: () => discReleaseInput(binary) },
    { kind: 'localized-zip', binary, label: binary ? 'Windows-949 CUE' : 'Windows-1251 CUE', suffix: ' localized ZIP',
      names: ['Release.zip'], open: () => localizedDiscRelease(binary) },
    { kind: 'udf', binary, label: binary ? 'UDF 2.01 bytecode' : 'UDF 1.02 source', suffix: ' UDF',
      names: [binary ? 'boot-udf201-bytecode.iso' : 'boot-udf102-source.iso'], open: () => udfGameDisc(binary) },
  ]),
  { kind: 'udf-sparable', binary: false, label: 'UDF 2.01 sparable source', suffix: ' UDF sparable',
    names: ['boot-udf201-sparable-source.iso'], open: udfSparableGameDisc },
  { kind: 'udf-metadata', binary: false, label: 'UDF 2.50 metadata source', suffix: ' UDF metadata',
    names: ['boot-udf250-metadata-source.iso'], open: () => udfMetadataGameDisc(false) },
  { kind: 'udf-bridge', binary: false, label: 'UDF 2.50 bridge source', suffix: ' UDF bridge',
    names: ['boot-udf250-bridge-source.iso'], open: () => udfMetadataGameDisc(true) },
  { kind: 'ccd', binary: false, label: 'CloneCD mixed-mode source', suffix: ' CCD',
    names: ['boot-clonecd-source.ccd', 'boot-clonecd-source.img'], open: cloneCdDiscInput },
  { kind: 'oem', binary: false, label: 'CP932 primary ISO source', suffix: ' OEM',
    names: ['boot-oem932-source.iso'], open: oemGameDiscInput },
]

for (const backend of ['asyncify', 'jspi']) for (const edition of editions) {
  const { binary, kind } = edition, localized = kind === 'localized-zip', packaged = kind === 'zip' || localized,
    udf = kind.startsWith('udf'), oem = kind === 'oem'
  test(`${backend}/${edition.label}: importing the complete disc boots original KAG and restores its chapter after library refresh`, async ({ page }, info) => {
    test.setTimeout(180000)
    const input = edition.open(),
      drive = packaged ? 'G' : 'D', medium = `file://./${drive.toLowerCase()}/`,
      gameDirectory = oem ? '表game/' : 'discgame/',
      localizedCue = 'Release.zip>Media/' + (binary ? 'Диск.cue' : '한글.cue'),
      mapping = localized ? 'G=' + localizedCue : packaged ? (binary ? 'G=Media/boot.cue' : 'G=StorySource.zip>Media/boot-source.iso') : '',
      launcher = localized ? localizedCue : packaged && binary ? 'StoryBytecode.zip>Media/boot.cue' : '',
      errors: string[] = [], observations: unknown[] = [], failures: unknown[] = [],
      title = `Boot disc ${backend} ${binary}${edition.suffix}`, canvas = page.locator('#stage canvas[data-window-id]'),
      item = page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title, exact: true }) }),
      { read, clickLink } = kagGameControls(page, observations)
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const ready = async () => {
      await expect(page.getByText(`story-disc-ready:${drive}:/|Moon disc scene|81`, { exact: true })).toBeVisible({ timeout: 45000 })
      const leave = page.locator('.leave-fullscreen')
      if (await leave.isVisible()) await leave.click()
      await expect.poll(() => read('discState()')).toBe('*choice|2|0|0')
      expect(await read('discBootPaths()')).toBe([
        medium + gameDirectory, medium + gameDirectory + 'data.xp3>', 'game://./savedata/',
        medium + gameDirectory + 'data.xp3>startup.tjs', medium + gameDirectory + 'patch.xp3>first.ks', medium + gameDirectory,
      ].join('|'))
      expect(await read('System.exeName+"|"+System.getArgument("-disc-edition")'))
        .toBe(medium + gameDirectory + 'story.exe|pressing')
      if (oem) expect(await read('discOemPaths()')).toBe(`${drive}|${medium}表/表.ks|42`)
      expect(await read('Storages.getPlacedPath("game://./startup.tjs")')).not.toBe('game://./startup.tjs')
    }, chapter = async (progress: number, visits: number) => {
      await expect.poll(() => read('[discState(),discVisits,discRendered].join("|")'))
        .toBe(`*arrival|2|0|${progress}|${visits}|Moon disc scene ${progress}`)
      expect(await read(oem ? 'Storages.getPlacedPath("表.ks")' : 'Storages.getPlacedPath("story.ks")'))
        .toBe(medium + (oem ? '表/表.ks' : 'routes/story.ks'))
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
      const bytes = await readFile(path), saved = JSON.parse(bytes.toString()) as { gameId: string; files: Array<{ path: string; base64: string }> },
        slot = saved.files.find((file) => file.path === 'savedata/disc0.kdt')
      if (!slot) throw new Error('Original KAG slot 0 is absent')
      expect(saved.files.every((file) => !file.path.includes('://') && !file.path.includes(':'))).toBe(true)
      if (binary) {
        const script = saved.files.find((file) => file.path === 'savedata/story.cjs')
        expect(script).toBeDefined()
        expect(Buffer.from(script!.base64, 'base64').toString('ascii', 0, 4)).toBe('TJS2')
      }
      expect(typeof saved.gameId).toBe('string')
      expect(saved.gameId).not.toBe('')
      return { bytes, gameId: saved.gameId, slot: Buffer.from(slot.base64, 'base64') }
    }
    try {
      if (binary || packaged || udf || kind === 'ccd' || oem) await page.locator('#project-mode').selectOption('auto')
      await expect(page.locator('#project-mode')).toHaveValue(binary || packaged || udf || kind === 'ccd' || oem ? 'auto' : 'collection')
      await page.locator('#cdda-discs').fill(mapping)
      if (oem) {
        await expect(page.locator('#disc-name-encoding')).toHaveValue('cp437')
        await page.locator('#disc-name-encoding').selectOption('shift_jis')
      }
      if (localized) {
        await page.locator('#zip-encoding').selectOption(binary ? 'windows-1251' : 'euc-kr')
        await page.locator('#cue-encoding').selectOption(binary ? 'euc-kr' : 'windows-1251')
        await expect(page.locator('#script-encoding')).toHaveValue('auto')
      }
      if (packaged) {
        await page.locator('#project-exe-directory').fill('')
        await page.locator('#project-executable').fill(launcher)
      }
      expect(input.files.map((file) => file.name)).toEqual(edition.names)
      observations.push({ kind, packaged, sparable: kind === 'udf-sparable', drive, mapping, launcher,
        files: input.files.map((file) => ({ name: file.name, bytes: file.buffer.length,
          sha256: createHash('sha256').update(file.buffer).digest('hex') })) })
      const picker = page.locator('#files')
      // The application consumes and clears FileList in its change handler
      // so the player can select the same disc again. Observe the actual
      // selection during dispatch, while the filenames and bytes are present.
      const selection = await picker.evaluateHandle((node) => {
        const input = node as HTMLInputElement
        const selected: { name: string; size: number }[] = []
        input.addEventListener('change', () => {
          for (const file of input.files ?? []) selected.push({ name: file.name, size: file.size })
        }, { capture: true, once: true })
        return selected
      })
      try {
        await picker.setInputFiles(input.files)
        const selected = await selection.jsonValue()
        observations.push({ selected })
        expect(selected).toEqual(input.files.map((file) => ({ name: file.name, size: file.buffer.length })))
      } finally { await selection.dispose() }
      await ready()
      await clickLink(0, '*enter'); await chapter(42, 1)
      await info.attach('disc-first-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await clickLink(0, '*save'); await chapter(42, 2)
      expect(await read('discSlot()')).toBe('42|*arrival')
      const before = await backup()
      expect(before.slot.toString('utf16le')).toContain('*arrival')
      await clickLink(1, '*change'); await chapter(99, 3)
      await page.locator('#library-title').fill(title); await page.locator('#save-library').click()
      await expect(item).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await stop(); await page.reload()
      if (localized) {
        const preferred = binary ? 'euc-kr' : 'windows-1251'
        const editor = item.getByLabel('无 BOM 的 CUE 文件编码'), save = item.getByRole('button', { name: '保存设置', exact: true })
        await item.locator('summary').click()
        await expect(editor).toHaveValue(preferred)
        for (const setting of ['auto', preferred]) {
          await editor.selectOption(setting)
          await save.click(); await expect(save).toBeEnabled()
          await page.reload(); await item.locator('summary').click()
          await expect(editor).toHaveValue(setting)
        }
        await item.locator('summary').click()
        await page.locator('#cue-encoding').selectOption('utf-8')
        await page.locator('#zip-encoding').selectOption('big5')
      }
      if (packaged) {
        // Reopening the saved game must use its recorded disc binding, rather
        // than the unrelated next-import settings left in the page form.
        await page.locator('#cdda-discs').fill('D=missing-next-import.iso')
      }
      if (oem) {
        // The saved project must retain the primary-directory encoding even
        // when the player chooses a different encoding for the next import.
        await page.locator('#disc-name-encoding').selectOption('cp437')
        await expect(page.locator('#disc-name-encoding')).toHaveValue('cp437')
        observations.push({ nextImportDiscEncoding: 'cp437', savedDiscEncoding: 'shift_jis' })
      }
      await item.getByRole('button', { name: '启动', exact: true }).click()
      await ready()
      const reopened = await backup()
      expect(reopened.gameId).toBe(before.gameId)
      expect(reopened.slot.equals(before.slot)).toBe(true)
      await clickLink(1, '*load'); await chapter(42, 1)
      expect(await read('discSlot()')).toBe('42|*arrival')
      await info.attach('disc-restored-chapter', { body: await canvas.screenshot({ timeout: 5000 }), contentType: 'image/png' })
      await info.attach('original-disc-bookmark', { body: before.slot, contentType: 'application/octet-stream' })
      observations.push({ gameId: before.gameId, originalSlotSha256: createHash('sha256').update(before.slot).digest('hex'), originalSlotBytes: before.slot.length })
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
}
