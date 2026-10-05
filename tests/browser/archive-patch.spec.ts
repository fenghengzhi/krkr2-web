import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Locator, Page, TestInfo } from '@playwright/test'
import { test, expect } from '../helpers/library-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { archivePatchFiles } from '../helpers/archive-patch.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

// Only this authored observation program is compiled in the bytecode cases.
// The complete original startup/Initialize/KAG methods execute unchanged.
const observer = String.raw`
var archivePatchWindow=new Window();archivePatchWindow.caption="Archive patch pixels";
archivePatchWindow.setPos(720,40);archivePatchWindow.setInnerSize(48,32);archivePatchWindow.setZoom(16,1);
var archivePatchPixels=new Layer(archivePatchWindow,null);archivePatchWindow.add(archivePatchPixels);
archivePatchWindow.visible=true;
function archivePatchDraw(){
 archivePatchPixels.loadImages("patch-probe.bmp");
 archivePatchWindow.setInnerSize(archivePatchPixels.imageWidth*16,archivePatchPixels.imageHeight*16);
}
function archivePatchState(){
 return [global.patchOverride,Scripts.evalStorage("patch-value.tjs"),
  Storages.getPlacedPath("patch-value.tjs"),Storages.getPlacedPath("patch-probe.bmp"),
  Storages.getPlacedPath("first.ks"),archivePatchPixels.getMainPixel(0,0)].join("|");
}
function archivePatchSwitch(remove,add){
 if(remove!="")Storages.removeAutoPath(remove);
 if(add!="")Storages.addAutoPath(add);
 Scripts.execStorage("Override.tjs");
 archivePatchDraw();
 // The original parser retains its current scenario for an identical name.
 // Its public clear releases that scenario; the graphics cache is untouched.
 kag.conductor.clear();kag.conductor.loadScenario("first.ks");kag.conductor.startProcess();
 return archivePatchState();
}
function archivePatchSave(){
 ['"saved"'].save("patch-value.tjs","utf-8");
 return archivePatchState();
}
archivePatchDraw();
Debug.message("archive-patch-observer-ready:"+global.patchOverride);
`

type Label = 'base' | 'patch' | 'patch2'
// Literal fixture colors and archive paths, independent of the resolver/cache.
const expected = {
  base: { value: 'data.xp3>system/patch-value.tjs', image: 'data.xp3>image/patch-probe.bmp',
    scenario: 'data.xp3>scenario/first.ks', pixel: 0x112233, rgba: [17, 34, 51, 255] },
  patch: { value: 'patch.xp3>patch-value.tjs', image: 'patch.xp3>patch-probe.bmp',
    scenario: 'patch.xp3>first.ks', pixel: 0x445566, rgba: [68, 85, 102, 255] },
  patch2: { value: 'patch2.xp3>patch-value.tjs', image: 'patch2.xp3>patch-probe.bmp',
    scenario: 'patch2.xp3>first.ks', pixel: 0x778899, rgba: [119, 136, 153, 255] },
} as const
function state(label: Label, saved = false): string {
  const item = expected[label]
  return [label, saved ? 'saved' : label, 'game://./' + (saved ? 'patch-value.tjs' : item.value),
    'game://./' + item.image, 'game://./' + item.scenario, item.pixel].join('|')
}

async function pixels(surface: Locator, info: TestInfo, phase: string, label: Label) {
  const canvas = surface.locator('canvas[data-window-id]'), readings: number[][] = [], failures: unknown[] = []
  let screenshot: Buffer | undefined
  try {
    await canvas.scrollIntoViewIfNeeded()
    await expect.poll(async () => {
      screenshot = await canvas.screenshot()
      const png = readScreenshotPng(screenshot), offset =
        (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4,
        color = [...png.rgba.subarray(offset, offset + 4)]
      readings.push(color)
      return color
    }).toEqual([...expected[label].rgba])
  } catch (error) { failures.push(error) }
  try {
    if (screenshot) await info.attach(`archive-patch-${phase}`, { body: screenshot, contentType: 'image/png' })
  } catch (error) { failures.push(error) }
  try {
    await info.attach(`archive-patch-${phase}-pixels`, { body: JSON.stringify({
      expected: expected[label].rgba, readings,
      observation: 'Actual rendered canvas screenshot, independently decoded PNG; no graphics-cache clearing',
    }), contentType: 'application/json' })
  } catch (error) { failures.push(error) }
  if (failures.length === 1) throw failures[0]
  if (failures.length) throw new AggregateError(failures, 'Archive pixels and evidence attachment failed', { cause: failures[0] })
}

async function ready(page: Page) {
  await expect(page.getByText('archive-patch-observer-ready:patch2', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('patch-first:patch2', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.locator('#evaluate')).toBeEnabled()
  const exit = page.locator('.leave-fullscreen')
  if (await exit.isVisible()) await exit.click()
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode observer' : 'source observer'}: original KAG selects patch archives independently of import order, cache and saved overlays`,
    async ({ page }, info) => {
      test.setTimeout(120000)
      const failures: unknown[] = [], errors: string[] = [],
        original = await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)),
        manifest = JSON.parse(await readFile(new URL('../fixtures/compatibility/kag3_template.zip.json', import.meta.url), 'utf8')) as {
          entries: { name: string; sha256: string }[]
        },
        archives = archivePatchFiles(),
        afterInit = binary
          ? 'Scripts.compileStorage("archive-observer.tjs","savedata/archive-observer.cjs",false,true,false);Scripts.execStorage("savedata/archive-observer.cjs");'
          : 'Scripts.execStorage("archive-observer.tjs");',
        files = [{ name: 'kag3_template.xp3', mimeType: 'application/octet-stream', buffer: original },
          ...archives.map((file) => ({ name: file.path, mimeType: 'application/octet-stream', buffer: file.bytes })),
          { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: Buffer.from(afterInit) },
          { name: 'archive-observer.tjs', mimeType: 'text/plain', buffer: Buffer.from(observer) }],
        title = `Archive patches ${backend} ${binary ? 'bytecode' : 'source'}`,
        surface = page.locator('.game-window[data-window-id]').filter({
          has: page.locator('.game-window-title', { hasText: /^Archive patch pixels$/ }),
        })
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`/?backend=${backend}`)
      test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
      try {
        expect(createHash('sha256').update(original).digest('hex'))
          .toBe('5a1bdb7d33b7077a47ebfb889524c381216c44b65e8dc69d6c9cbb3453458644')
        expect(manifest.entries.find((entry) => entry.name === 'system/Initialize.tjs')?.sha256)
          .toBe('01f2b1544a686dc77a4e24bcaf7ec50d564a8de92447c64f51615539b3b41cab')
        expect(archives.map((file) => file.path)).toEqual(['patch2.xp3', 'patch4.xp3', 'patch.xp3', 'data.xp3'])
        await info.attach('archive-patch-provenance', { body: JSON.stringify({
          scope: 'Complete unchanged original KAG startup/Initialize. Only authored archive-observer.tjs is source/bytecode parametrized.',
          binaryObserver: binary, originalInitializeSha256: manifest.entries.find((entry) => entry.name === 'system/Initialize.tjs')!.sha256,
          inputOrder: files.map((file) => ({ path: file.name, bytes: file.buffer.length,
            sha256: createHash('sha256').update(file.buffer).digest('hex') })),
          missingPatch3: true, patch4ImportedButNotAutoRegistered: true,
        }), contentType: 'application/json' })
        await info.attach('archive-patch-authored-observer', { body: observer, contentType: 'text/plain' })
        await page.locator('#files').setInputFiles(files)
        await ready(page)
        await evaluate(page, 'archivePatchState()', state('patch2'))
        await evaluate(page, '[Storages.getPlacedPath("system/Initialize.tjs"),Scripts.evalStorage("data.xp3>system/patch-value.tjs"),Scripts.evalStorage("patch4.xp3>patch-value.tjs")].join("|")',
          'game://./kag3_template.xp3>system/Initialize.tjs|base|patch4')
        await expect(page.getByText('patch-first:patch4', { exact: true })).toHaveCount(0)
        await pixels(surface, info, 'initial-patch2', 'patch2')

        // Persist the exact original archives through the library UI. KAG,
        // rather than the importer, will register patch paths again on restart.
        await expect(page.locator('#save-library')).toBeEnabled()
        await page.locator('#library-title').fill(title)
        await page.locator('#save-library').click()
        await expect(page.locator('#library-games h3')).toHaveText(title)
        await expect(page.locator('#cancel-library')).toBeHidden()

        await evaluate(page, 'archivePatchSwitch("patch2.xp3>","")', state('patch'))
        await expect(page.getByText('patch-first:patch', { exact: true })).toBeVisible()
        await pixels(surface, info, 'removed-patch2', 'patch')
        await evaluate(page, 'archivePatchSwitch("patch.xp3>","")', state('base'))
        await expect(page.getByText('patch-first:base', { exact: true })).toBeVisible()
        await pixels(surface, info, 'removed-patch', 'base')
        await evaluate(page, 'archivePatchSwitch("","patch.xp3>")', state('patch'))
        await expect(page.getByText('patch-first:patch', { exact: true })).toHaveCount(2)
        await pixels(surface, info, 'reused-patch-cache', 'patch')
        await evaluate(page, 'archivePatchSave()', state('patch', true))
        await expect(page.locator('#save-status')).toHaveText(/^\d+ 个存档文件，已保存到此浏览器/)
        await evaluate(page, '[Scripts.evalStorage("patch.xp3>patch-value.tjs"),Scripts.evalStorage("data.xp3>system/patch-value.tjs")].join("|")', 'patch|base')

        await page.reload()
        await expect(page.locator('#library-games h3')).toHaveText(title)
        await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
        await ready(page)
        await evaluate(page, 'archivePatchState()', state('patch2', true))
        await expect(page.getByText('patch-first:patch4', { exact: true })).toHaveCount(0)
        await pixels(surface, info, 'restarted-patch2-with-save', 'patch2')

        const pending = page.waitForEvent('download')
        await page.locator('#export-saves').click()
        const download = await pending, path = await download.path()
        expect(path).not.toBeNull()
        const backup = JSON.parse(await readFile(path!, 'utf8')) as { files: { path: string; base64: string }[] },
          saved = backup.files.find((file) => file.path === 'patch-value.tjs')
        expect(saved).toBeDefined()
        expect(Buffer.from(saved!.base64, 'base64').toString('utf8').trim()).toBe('"saved"')
        if (binary) {
          const compiled = backup.files.find((file) => file.path === 'savedata/archive-observer.cjs')
          expect(compiled).toBeDefined()
          expect(Buffer.from(compiled!.base64, 'base64').subarray(0, 4).toString()).toBe('TJS2')
        }
        expect(backup.files.some((file) => file.path.includes('>'))).toBe(false)
        await info.attach('archive-patch-exported-saves', { body: JSON.stringify(backup), contentType: 'application/json' })
        expect(errors).toEqual([])
        await expect(page.locator('#logs .error')).toHaveCount(0)
      } catch (error) { failures.push(error) }
      try {
        await info.attach('archive-patch-final', { body: JSON.stringify({ errors,
          logs: await page.locator('#logs').innerText(), status: await page.locator('#status').innerText(),
        }), contentType: 'application/json' })
      } catch (error) { failures.push(error) }
      try {
        const modalStop = page.locator('dialog[open]:visible').getByRole('button', { name: '停止游戏', exact: true })
        if (await modalStop.count()) await modalStop.last().click()
        else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
        await expect(page.locator('#stop')).toBeDisabled()
        await expect(page.locator('#stage canvas')).toHaveCount(0)
        await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      } catch (error) { failures.push(error) }
      if (failures.length === 1) throw failures[0]
      if (failures.length) throw new AggregateError(failures, 'KAG archive patch scenario and cleanup failed', { cause: failures[0] })
    })
