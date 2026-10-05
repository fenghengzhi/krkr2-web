import { magnifyPixelWindow } from '../helpers/pixel-window.ts'
import type { Page, TestInfo } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { test, expect } from '../helpers/library-browser.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { embedXp3, xp3Fixture } from '../helpers/xp3-fixtures.ts'
import { readScreenshotPng } from '../helpers/screenshot-png.ts'

// Literal top-down pixels, independent of the XP3 and BMP readers under test.
const colors = [
  [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255],
  [17, 34, 51], [68, 85, 102], [119, 136, 153], [170, 187, 204],
] as const
function bitmap(): Buffer {
  // BITMAPINFOHEADER, four 24-bit pixels per padded bottom-up row.
  const bytes = Buffer.alloc(78)
  bytes.write('BM'); bytes.writeUInt32LE(78, 2); bytes.writeUInt32LE(54, 10)
  bytes.writeUInt32LE(40, 14); bytes.writeInt32LE(4, 18); bytes.writeInt32LE(2, 22)
  bytes.writeUInt16LE(1, 26); bytes.writeUInt16LE(24, 28); bytes.writeUInt32LE(24, 34)
  for (let row = 0; row < 2; row++) for (let x = 0; x < 4; x++) {
    const [r, g, b] = colors[(1 - row) * 4 + x]!
    bytes.set([b, g, r], 54 + row * 12 + x * 3)
  }
  return bytes
}

const program = String.raw`
function embeddedCheck(value,label){if(!value)throw "embedded XP3: "+label;}
var embeddedValue=Scripts.evalStorage("game://./value.tjs");
var archivedValue=Scripts.evalStorage("game.exe>value.tjs");
var memberLabel=Scripts.evalStorage("game.exe>シーン/label.tjs");
embeddedCheck(archivedValue==42 && memberLabel=="雪","qualified members");
embeddedCheck(Storages.getPlacedPath("game.exe>value.tjs")=="game://./game.exe>value.tjs","placed path");
var countPath="savedata/embedded-count.txt",starts=0;
if(Storages.isExistentStorage(countPath))starts=int([].load(countPath,"utf-8")[0]);
starts++;[string(starts)].save(countPath,"utf-8");
var win=new Window();win.caption="Embedded XP3";win.visible=true;win.setInnerSize(4,2);
var pixels=new Layer(win,null);pixels.loadImages("game.exe>art/pixels.bmp");pixels.setSize(4,2);
embeddedCheck(pixels.getMainPixel(0,0)==0xff0000 && pixels.getMainPixel(3,1)==0xaabbcc,"bitmap members");
Debug.message("embedded-ready:"+starts+":"+embeddedValue+":"+archivedValue+":"+memberLabel);
`

async function pixelsOnScreen(page: Page, info: TestInfo, phase: string): Promise<void> {
  const canvas = page.locator('#stage canvas'), attempts: number[][][] = []
  let screenshot: Buffer | undefined
  await expect(canvas).toHaveJSProperty('width', 4)
  await expect(canvas).toHaveJSProperty('height', 2)
  await magnifyPixelWindow(canvas)
  await canvas.scrollIntoViewIfNeeded()
  try {
    await expect.poll(async () => {
      screenshot = await canvas.screenshot()
      const image = readScreenshotPng(screenshot), values = colors.map((_, index) => {
        const x = Math.floor(((index % 4) + 0.5) * image.width / 4),
          y = Math.floor((Math.floor(index / 4) + 0.5) * image.height / 2), at = (y * image.width + x) * 4
        return [...image.rgba.subarray(at, at + 4)]
      })
      attempts.push(values)
      return values
    }).toEqual(colors.map((rgb) => [...rgb, 255]))
  } finally {
    if (screenshot) await info.attach(`embedded-xp3-${phase}`, { body: screenshot, contentType: 'image/png' })
    await info.attach(`embedded-xp3-${phase}-pixels`, {
      body: JSON.stringify({ expected: colors.map((rgb) => [...rgb, 255]), attempts }), contentType: 'application/json',
    })
  }
}

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: embedded EXE XP3 imports compressed continued members, pixels and persistent overrides`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = [], failures: unknown[] = [],
      startup = binary
        ? 'Scripts.compileStorage("game.exe>scripts/main.tjs","savedata/embedded.cjs",false,true,false);Scripts.execStorage("savedata/embedded.cjs");'
        : 'Scripts.execStorage("game.exe>scripts/main.tjs");',
      archive = xp3Fixture({ 'startup.tjs': startup, 'scripts/main.tjs': program,
        'value.tjs': '42', 'シーン/label.tjs': '"雪"', 'art/pixels.bmp': bitmap() },
      { compressed: true, continuation: true }), executable = embedXp3(archive.bytes),
      title = `Embedded XP3 ${backend} ${binary ? 'bytecode' : 'source'}`
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    try {
      expect(archive.indexOffsets).toHaveLength(5)
      await info.attach('embedded-xp3-fixture', { body: executable, contentType: 'application/octet-stream' })
      await info.attach('embedded-xp3-fixture-layout', { body: JSON.stringify({
        scope: 'Authored inert MZ prefix; file-input resource extraction only, never native executable launch',
        archiveOffset: 256 * 1024 + 16, indexOffsets: archive.indexOffsets,
        segmentOffsets: archive.segmentOffsets, compressed: true, continuation: true,
      }), contentType: 'application/json' })
      await page.locator('#files').setInputFiles([
        { name: 'game.exe', mimeType: 'application/octet-stream', buffer: executable },
        { name: 'value.tjs', mimeType: 'text/plain', buffer: Buffer.from('99') },
      ])
      await expect(page.getByText('embedded-ready:1:99:42:雪', { exact: true })).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      await evaluate(page, '[Scripts.evalStorage("value.tjs"),Scripts.evalStorage("game.exe>value.tjs"),Storages.getPlacedPath("game.exe>シーン/label.tjs")].join("|")',
        '99|42|game://./game.exe>シーン/label.tjs')
      await pixelsOnScreen(page, info, 'file-import')

      // Save the original EXE and loose override through the real library UI.
      // A separate saved-file overlay must survive reconstructing this mount.
      await expect(page.locator('#save-library')).toBeEnabled()
      await page.locator('#library-title').fill(title)
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText(title)
      await expect(page.locator('#cancel-library')).toBeHidden()
      await evaluate(page, '(function(){["113"].save("game://./value.tjs","utf-8");return Scripts.evalStorage("value.tjs")+"|"+Scripts.evalStorage("game.exe>value.tjs");})()', '113|42')
      await evaluate(page, '(function(){try{["0"].save("game.exe>value.tjs","utf-8");return false;}catch(error){return Scripts.evalStorage("game.exe>value.tjs")==42;}})()', '1')
      await expect(page.locator('#save-status'))
        .toHaveText(new RegExp(`^${binary ? 3 : 2} 个存档文件，已保存到此浏览器`))
      await page.reload()
      await expect(page.locator('#library-games h3')).toHaveText(title)
      await page.locator('.library-game').getByRole('button', { name: '启动', exact: true }).click()
      await expect(page.getByText('embedded-ready:2:113:42:雪', { exact: true })).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      await evaluate(page, '[Scripts.evalStorage("value.tjs"),Scripts.evalStorage("game.exe>value.tjs"),pixels.getMainPixel(0,0),pixels.getMainPixel(3,1)].join("|")',
        '113|42|16711680|11189196')
      await pixelsOnScreen(page, info, 'library-restart')

      const pendingDownload = page.waitForEvent('download')
      await page.locator('#export-saves').click()
      const download = await pendingDownload, path = await download.path()
      expect(path).not.toBeNull()
      const backup = JSON.parse(await readFile(path!, 'utf8')) as { files: { path: string; base64: string }[] },
        savedBytes = (path: string) => {
          const saved = backup.files.find((file) => file.path === path)
          expect(saved, `Exported save ${path}`).toBeDefined()
          return Buffer.from(saved!.base64, 'base64')
        }
      expect(new TextDecoder().decode(savedBytes('savedata/embedded-count.txt')).trim()).toBe('2')
      expect(new TextDecoder().decode(savedBytes('value.tjs')).trim()).toBe('113')
      if (binary) expect(savedBytes('savedata/embedded.cjs').subarray(0, 4).toString()).toBe('TJS2')
      expect(backup.files.some((file) => file.path.includes('>'))).toBe(false)
      await info.attach('embedded-xp3-exported-saves', { body: JSON.stringify(backup), contentType: 'application/json' })
      expect(errors).toEqual([])
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    // Stop through the UI even after a failed assertion, retaining both the
    // original failure and any cleanup error instead of masking either one.
    try {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(page.locator('#stage canvas')).toHaveCount(0)
    } catch (error) { failures.push(error) }
    try {
      await info.attach('embedded-xp3-final', { body: JSON.stringify({ errors,
        logs: await page.locator('#logs').innerText(), status: await page.locator('#status').innerText(),
      }), contentType: 'application/json' })
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'Embedded XP3 scenario and cleanup failed', { cause: failures[0] })
  })
