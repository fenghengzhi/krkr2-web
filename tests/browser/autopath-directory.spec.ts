import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test, expect } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { solidBmp } from '../helpers/archive-patch.ts'
import { assertGameDirectoryInput, attachGameDirectoryInput, chooseGameDirectory, observeGameDirectoryInput } from '../helpers/game-directory-input.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

const source = String.raw`
var looseWindow=new Window();looseWindow.caption="Loose AutoPath";looseWindow.setInnerSize(3,2);looseWindow.setZoom(32,1);
var looseLayer=new Layer(looseWindow,null);looseWindow.add(looseLayer);looseWindow.visible=true;
function looseDraw(){System.clearGraphicCache();looseLayer.loadImages("pixel.bmp");looseWindow.update();}
function looseState(){return [Scripts.evalStorage("value.tjs"),Storages.getPlacedPath("value.tjs"),
 Storages.getPlacedPath("pixel.bmp"),looseLayer.getMainPixel(0,0)].join("|");}
Storages.addAutoPath("base/");Storages.addAutoPath("Patch/");looseDraw();
Debug.message("loose-autopath-ready");
`
const expected = {
  patch: { state: 'patch|game://./Patch/VALUE.TJS|game://./Patch/PIXEL.BMP|4478310', rgba: [68, 85, 102, 255] },
  base: { state: 'base|game://./base/value.tjs|game://./base/pixel.bmp|1122867', rgba: [17, 34, 51, 255] },
} as const

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: an actual selected folder keeps AutoPath priority above exact filename case`, async ({ page }, info) => {
    test.setTimeout(60000)
    const errors: string[] = [], failures: unknown[] = [], observations: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await observeGameDirectoryInput(page)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const directory = await mkdtemp(join(tmpdir(), 'krkr-autopath-folder-')),
      files = [
        { path: 'startup.tjs', bytes: Buffer.from(binary
          ? 'Scripts.compileStorage("observer.tjs","savedata/observer.cjs",false,true,false);Scripts.execStorage("savedata/observer.cjs");'
          : 'Scripts.execStorage("observer.tjs");') },
        { path: 'observer.tjs', bytes: Buffer.from(source) },
        { path: 'base/value.tjs', bytes: Buffer.from('"base"') },
        { path: 'base/pixel.bmp', bytes: solidBmp(0x112233) },
        { path: 'Patch/VALUE.TJS', bytes: Buffer.from('"patch"') },
        { path: 'Patch/PIXEL.BMP', bytes: solidBmp(0x445566) },
      ], canvas = page.locator('#stage canvas[data-window-id]')
    const check = async (phase: string, label: keyof typeof expected) => {
      await evaluate(page, 'looseState()', expected[label].state)
      await canvas.scrollIntoViewIfNeeded({ timeout: 5000 })
      let last: Buffer | undefined
      try {
        await expect.poll(async () => {
          last = await canvas.screenshot({ timeout: 5000 })
          const png = readScreenshotPng(last), at = (Math.floor(png.height / 2) * png.width + Math.floor(png.width / 2)) * 4,
            pixel = [...png.rgba.subarray(at, at + 4)]
          observations.push({ phase, pixel })
          return pixel
        }).toEqual([...expected[label].rgba])
      } catch (error) { failures.push(error); throw error }
      finally {
        if (last) try { await info.attach('loose-autopath-' + phase, { body: last, contentType: 'image/png' }) }
        catch (error) { failures.push(error) }
      }
    }
    try {
      for (const file of files) {
        const path = join(directory, file.path)
        await mkdir(dirname(path), { recursive: true }); await writeFile(path, file.bytes)
      }
      await info.attach('loose-autopath-inputs', { body: JSON.stringify({ files: files.map((file) => ({
        path: file.path, bytes: file.bytes.length, sha256: createHash('sha256').update(file.bytes).digest('hex'),
      })), source, scope: 'Real temporary directory selected through the folder button and native filechooser; actual webkitRelativePath is observed without replacing FileList or input events.' }, null, 2), contentType: 'application/json' })
      await page.locator('#project-mode').selectOption('auto')
      const selection = await chooseGameDirectory(page, directory)
      await expect(page.getByText('loose-autopath-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      await assertGameDirectoryInput(page, info, selection, files.map((file) => ({ path: file.path, bytes: file.bytes.length })), 'auto', 'loose-autopath')
      await expect(canvas).toHaveCount(1)
      await check('initial', 'patch')
      // Check lower-path priority immediately, before registering the high
      // path again could hide an incorrect move to the end of the path list.
      await evaluate(page, '(Storages.addAutoPath("BASE/"),looseState())', expected.patch.state)
      await evaluate(page, '(Storages.addAutoPath("pAtCh/"),looseState())', expected.patch.state)
      await evaluate(page, '(Storages.removeAutoPath("PATCH/"),looseDraw(),looseState())', expected.base.state)
      await check('removed-once', 'base')
      await evaluate(page, '(Storages.addAutoPath("Patch/"),looseDraw(),looseState())', expected.patch.state)
      await check('readded', 'patch')
      await expect(page.locator('#logs .error')).toHaveCount(0)
      expect(errors).toEqual([])
    } catch (error) { if (!failures.includes(error)) failures.push(error) }
    try { await attachGameDirectoryInput(page, info, 'loose-autopath-final') } catch (error) { failures.push(error) }
    try {
      await info.attach('loose-autopath-final', { body: JSON.stringify({ observations, errors,
        logs: await page.locator('#logs').innerText() }), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter', { timeout: 5000 })
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(canvas).toHaveCount(0)
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
    } catch (error) { failures.push(error) }
    try { await rm(directory, { recursive: true, force: true }) } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Loose AutoPath folder or cleanup failed', { cause: failures[0] })
  })
