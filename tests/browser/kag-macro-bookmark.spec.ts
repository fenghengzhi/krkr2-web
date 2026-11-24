import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { kagControlSource, kagFiles } from '../helpers/kag-scenarios.ts'
import { kagEvaluationExpected } from '../helpers/kag-evaluation.ts'
import { kagRoutingExpected } from '../helpers/kag-routing.ts'

const result = 'Alice|1|Alice|live|1|Alice|live|finished|0|1'
const script = kagControlSource + String.raw`
System.exitOnWindowClose=false;
var bookWindow=new Window();bookWindow.caption="KAG bookmark";bookWindow.setInnerSize(64,48);bookWindow.visible=true;
var bookLayer=new Layer(bookWindow,null);bookWindow.add(bookLayer);bookLayer.setSize(64,48);bookLayer.visible=true;
function writeBookmark(){var d=kagSavePoint();(Dictionary.saveStruct incontextof d)("savedata/macro-bookmark.tjs");return d.macroArgs[0].actor;}
function readBookmark(path){var s=kagResumePoint(Scripts.evalStorage(path));global.bookWindow.caption=s;return s;}
Debug.message("bookmark-ready");
`
for (const backend of ['asyncify', 'jspi']) for (const mode of ['source', 'bytecode'])
  test(`${backend}/${mode}: macro bookmark restores its active call and continues the scenario after reload`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    const files = Object.entries({ ...kagFiles, 'book.tjs': script, 'startup.tjs': mode === 'source' ? 'Scripts.execStorage("book.tjs");'
      : 'Scripts.compileStorage("book.tjs","savedata/book.cjs",false,true,false);Scripts.execStorage("savedata/book.cjs");' })
      .map(([name, value]) => ({ name, mimeType: 'text/plain', buffer: Buffer.from('\ufeff' + value, 'utf16le') }))
    if (process.env.KRKR_KAG_SDK_IMPORT === '1') {
      const dir = 'out/verification/native-eri/kag', native = JSON.parse(readFileSync(dir + '/comparison.json', 'utf8')),
        bytes = readFileSync(dir + '/game/native-bookmark.tjs')
      expect(native.commit).toBe(process.env.GITHUB_SHA)
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(native.bookmarkSha256)
      files.push({ name: 'sdk-bookmark.tjs', mimeType: 'text/plain', buffer: bytes })
      await info.attach('sdk-bookmark-sha256', { body: native.bookmarkSha256, contentType: 'text/plain' })
    }
    const errors: string[] = [], failures: unknown[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const start = async () => {
      await page.locator('#files').setInputFiles(files)
      await expect(page.locator('#logs')).toContainText('bookmark-ready')
      await expect(page.locator('#evaluate')).toBeEnabled()
    }
    try {
      await start()
      for (const [id, expected] of Object.entries({ ...kagEvaluationExpected, ...kagRoutingExpected }))
        await evaluate(page, `kagObserve(${JSON.stringify(id)})`, expected)
      if (process.env.KRKR_KAG_SDK_IMPORT === '1')
        await evaluate(page, 'readBookmark("sdk-bookmark.tjs")', result)
      await evaluate(page, 'writeBookmark()', 'Alice')
      const finished = page.waitForEvent('download')
      await page.locator('#export-saves').click()
      const download = await finished
      expect(await download.failure()).toBeNull()
      await page.reload()
      await start()
      await evaluate(page, 'readBookmark("savedata/macro-bookmark.tjs")', result)
      await expect(page.locator('.game-window-title')).toHaveText(result)
    } catch (error) { failures.push(error) }
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect.poll(() => page.workers().filter((worker) => worker.url().includes('session.worker')).length).toBe(0)
      expect(errors).toEqual([])
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Bookmark restoration or browser cleanup failed', { cause: failures[0] })
  })
