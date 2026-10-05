import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Page, TestInfo } from '@playwright/test'
import { test, expect } from '../helpers/library-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { projectRootFiles } from '../helpers/project-root-fixtures.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

type Name = 'A' | 'B'
const expected = {
  A: { directory: 'games/A/content-data/', value: 'games/A/content-data/project-value.tjs',
    pixel: 0x778899, rgba: [119, 136, 153, 255] },
  B: { directory: 'games/B/data.xp3>', value: 'games/B/data.xp3>project-value.tjs',
    pixel: 0x336699, rgba: [51, 102, 153, 255] },
} as const
function state(name: Name, saved: string) {
  return [name, name + '-patch', name + '-root', name + '-root',
    `game://./games/${name}/`, `game://./games/${name}/savedata/`,
    'game://./' + expected[name].value, `game://./games/${name}/patch.xp3>project-pixel.bmp`,
    expected[name].pixel, saved].join('|')
}
async function ready(page: Page, name: Name, saved: string) {
  await expect(page.getByText(`project-ready:${name}:${saved}`, { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText(`project-first:${name}`, { exact: true }).last()).toBeVisible({ timeout: 30000 })
  await expect(page.locator('#evaluate')).toBeEnabled()
  await expect(page.locator('#project-status')).toContainText(expected[name].directory)
  await expect(page.locator('#project-status')).toContainText(`games/${name}/`)
  const leave = page.locator('.leave-fullscreen')
  if (await leave.isVisible()) await leave.click()
  await evaluate(page, 'projectState()', state(name, saved))
}
async function pixels(page: Page, info: TestInfo, name: Name, phase: string) {
  const surface = page.locator('.game-window[data-window-id]').filter({
    has: page.locator('.game-window-title', { hasText: new RegExp(`^Project pixels ${name}$`) }),
  }), canvas = surface.locator('canvas[data-window-id]'), readings: number[][] = [], errors: unknown[] = []
  let screenshot: Buffer | undefined
  try {
    await canvas.scrollIntoViewIfNeeded()
    await expect.poll(async () => {
      screenshot = await canvas.screenshot()
      const png = readScreenshotPng(screenshot), at = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4,
        color = [...png.rgba.subarray(at, at + 4)]
      readings.push(color)
      return color
    }).toEqual([...expected[name].rgba])
  } catch (error) { errors.push(error) }
  try { if (screenshot) await info.attach(`project-${name}-${phase}`, { body: screenshot, contentType: 'image/png' }) }
  catch (error) { errors.push(error) }
  try { await info.attach(`project-${name}-${phase}-pixels`, { body: JSON.stringify({ readings, expected: expected[name].rgba }), contentType: 'application/json' }) }
  catch (error) { errors.push(error) }
  if (errors.length === 1) throw errors[0]
  if (errors.length) throw new AggregateError(errors, 'Project pixels and evidence failed', { cause: errors[0] })
}
async function stop(page: Page) {
  const modal = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
  if (await modal.count()) await modal.last().click()
  else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
  await expect(page.locator('#stop')).toBeDisabled()
  await expect(page.locator('#stage canvas')).toHaveCount(0)
  await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
}
async function backup(page: Page) {
  const pending = page.waitForEvent('download')
  await page.locator('#export-saves').click()
  const download = await pending, path = await download.path()
  expect(path).not.toBeNull()
  return JSON.parse(await readFile(path!, 'utf8')) as { gameId: string; files: { path: string; base64: string }[] }
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: selected KAG folder/archive roots retain sibling patches and isolate saves through library restarts`, async ({ page }, info) => {
    test.setTimeout(180000)
    const failures: unknown[] = [], pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const fixture = await projectRootFiles(binary),
      directory = await mkdtemp(join(tmpdir(), 'krkr-project-roots-')),
      exported = new Map<Name, Awaited<ReturnType<typeof backup>>>(),
      title = (name: Name) => `Project root ${name} ${backend} ${binary ? 'bytecode' : 'source'}`,
      libraryItem = (name: Name) => page.locator('.library-game').filter({ has: page.getByRole('heading', { name: title(name), exact: true }) })
    try {
      for (const file of fixture.files) {
        const path = join(directory, file.path)
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes)
      }
      await info.attach('project-root-fixture', { body: JSON.stringify(fixture.provenance), contentType: 'application/json' })
      await page.locator('#project-mode').selectOption('auto')
      await page.locator('#project-exe-directory').fill('games/A/')
      await page.locator('#folder').setInputFiles(directory)
      await expect(page.locator('#project-mode')).toHaveValue('auto')
      await ready(page, 'A', 'none')
      await evaluate(page, 'Storages.isExistentStorage(System.exePath+"data.xp3")', '1')
      await evaluate(page, '(function(){try{return Scripts.evalStorage(System.exePath+"data.xp3>startup.tjs");}catch(error){return error.message;}})()',
        'Unsupported XP3 index compression: 7')
      await evaluate(page, '(function(){Storages.addAutoPath(System.exePath+"data.xp3>");var result;try{result=Scripts.evalStorage("not-present-anywhere.tjs");}catch(error){result=error.message;}Storages.removeAutoPath(System.exePath+"data.xp3>");return result;})()',
        'Unsupported XP3 index compression: 7')
      await evaluate(page, 'projectState()', state('A', 'none'))
      await pixels(page, info, 'A', 'auto-content-data')
      await expect(page.locator('#save-library')).toBeEnabled()
      await page.locator('#library-title').fill(title('A'))
      await page.locator('#save-library').click()
      await expect(libraryItem('A')).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await evaluate(page, 'projectWrite("A-saved")', 'A-saved')
      await expect(page.locator('#save-status')).toHaveText(/^\d+ 个存档文件，已保存到此浏览器/)
      exported.set('A', await backup(page))
      await stop(page)

      // Import the exact same folder bytes; only the chosen project changes.
      // Identical absolute save addresses must still have independent game IDs.
      await page.locator('#project-mode').selectOption('root')
      await page.locator('#project-exe-directory').fill('games/B/')
      await page.locator('#project-root').fill('games/B/data.xp3>')
      await page.locator('#folder').setInputFiles(directory)
      await expect(page.locator('#project-mode')).toHaveValue('root')
      await ready(page, 'B', 'none')
      await pixels(page, info, 'B', 'explicit-archive')
      await expect(page.locator('#save-library')).toBeEnabled()
      await page.locator('#library-title').fill(title('B'))
      await page.locator('#save-library').click()
      await expect(libraryItem('B')).toBeVisible(); await expect(page.locator('#cancel-library')).toBeHidden()
      await expect(page.locator('.library-game')).toHaveCount(2)
      await evaluate(page, 'projectWrite("B-saved")', 'B-saved')
      await expect(page.locator('#save-status')).toHaveText(/^\d+ 个存档文件，已保存到此浏览器/)
      exported.set('B', await backup(page))
      expect(exported.get('A')!.gameId).toMatch(/^game-[a-f0-9]{64}$/)
      expect(exported.get('B')!.gameId).not.toBe(exported.get('A')!.gameId)
      for (const name of ['A', 'B'] as const) {
        const files = exported.get(name)!.files, saved = files.find((file) => file.path === 'shared-project-save.txt')
        expect(saved).toBeDefined()
        expect(Buffer.from(saved!.base64, 'base64').toString('utf8').trim()).toBe(`${name}-saved`)
        if (binary) {
          const script = files.find((file) => file.path === `games/${name}/savedata/project-observer.cjs`)
          expect(script).toBeDefined()
          expect(Buffer.from(script!.base64, 'base64').subarray(0, 4).toString()).toBe('TJS2')
        }
        expect(files.some((file) => file.path.includes('>'))).toBe(false)
      }

      await page.reload()
      await expect(page.locator('.library-game')).toHaveCount(2)
      // A deliberately unrelated next-import selection cannot override the
      // frozen project recorded by either saved library entry.
      await page.locator('#project-mode').selectOption('root')
      await page.locator('#project-exe-directory').fill('missing-game/')
      await page.locator('#project-root').fill('missing-game/')
      for (const name of ['A', 'B'] as const) {
        await libraryItem(name).getByRole('button', { name: '启动', exact: true }).click()
        await ready(page, name, `${name}-saved`)
        await pixels(page, info, name, 'library-restored-root')
        const restored = await backup(page)
        expect(restored.gameId).toBe(exported.get(name)!.gameId)
        await stop(page)
      }
      expect(pageErrors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try { await stop(page) } catch (error) { failures.push(error) }
    try { await info.attach('project-root-final', { body: JSON.stringify({
      exported: Object.fromEntries(exported), pageErrors, logs: await page.locator('#logs').innerText(),
      projectStatus: await page.locator('#project-status').innerText(),
      scope: 'Real folder input, selected project namespaces and library persistence; no collection fallback or KAG method replacement',
    }), contentType: 'application/json' }) } catch (error) { failures.push(error) }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Project root scenario and cleanup failed', { cause: failures[0] })
  })
