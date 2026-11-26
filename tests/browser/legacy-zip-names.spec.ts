import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import { legacyZip } from '../helpers/legacy-zip-names.ts'

const utf16 = (text: string) => Buffer.from('\ufeff' + text, 'utf16le')
const menu = String.raw`
var zipWindow=new Window();zipWindow.caption="Archive chapters";zipWindow.setInnerSize(160,64);zipWindow.visible=true;
var zipRoot=new Layer(zipWindow,null);zipWindow.add(zipRoot);zipRoot.setSize(160,64);zipRoot.holdAlpha=false;
zipRoot.fillRect(0,0,160,64,0xff29496b);
var zipChapter=Scripts.evalStorage("maps.zip>表.tjs");
function zipSaved(name){return [].load(System.dataPath+name+".sav","utf-8")[0];}
zipRoot.onClick=function(){global.Debug.message("chapter:"+global.zipChapter+"|"+global.zipSaved("ソ")+"|"+global.zipSaved("中"));};
Debug.message("chapter-menu:"+zipChapter);
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: import a Shift_JIS chapter and read Japanese and Chinese save ZIPs through the game`, async ({ page }, info) => {
    test.setTimeout(90000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const maps = legacyZip([{ name: Buffer.from([0x95, 0x5c, 46, 116, 106, 115]), bytes: utf16('"CHAPTER"') }])
    const startup = utf16(binary
      ? 'Scripts.compileStorage("menu.tjs",System.dataPath+"menu.cjs",false,true,false);Scripts.execStorage(System.dataPath+"menu.cjs");'
      : 'Scripts.execStorage("menu.tjs");')
    const files = [{ name: 'startup.tjs', bytes: startup }, { name: 'menu.tjs', bytes: utf16(menu) }, { name: 'maps.zip', bytes: maps }]
    const packed = legacyZip(files.map(({ name, bytes }) => ({
      name: Buffer.concat([Buffer.from([0x83, 0x5c, 47]), Buffer.from(name)]), bytes,
    })))
    const slot = (name: number[], text: string) => legacyZip([{ name: Buffer.from([...name, 46, 115, 97, 118]), bytes: text }])
    try {
      for (const mode of ['collection', 'auto']) {
        await page.locator('#project-mode').selectOption(mode)
        // Recover the original bytes from an incorrectly selected name decoder
        // by restarting the same import with the right setting.
        await page.locator('#zip-encoding').selectOption(mode === 'auto' ? 'utf-8' : 'shift_jis')
        const menuReady = page.getByText('chapter-menu:CHAPTER', { exact: true }), prior = await menuReady.count()
        const inputs = mode === 'auto' ? [{ name: 'Release.zip', bytes: packed }] : files
        await page.locator('#files').setInputFiles(inputs.map(({ name, bytes }) => ({ name, buffer: bytes, mimeType: 'application/octet-stream' })))
        if (mode === 'auto') {
          await expect(page.locator('#logs')).toContainText('ZIP 文件名无法按 utf-8 解码')
          await expect(menuReady).toHaveCount(prior)
          await expect(page.locator('#restart')).toBeEnabled()
          await page.locator('#zip-encoding').selectOption('shift_jis')
          await page.locator('#restart').click()
        }
        await expect(menuReady).toHaveCount(prior + 1)
        await evaluate(page, 'Storages.getPlacedPath("maps.zip>表.tjs")',
          'game://./' + (mode === 'auto' ? 'ソ/' : '') + 'maps.zip>表.tjs')
        // Change the next import's encoding. The current game keeps its selection.
        await page.locator('#zip-encoding').selectOption('cp437')
        await page.locator('#save-format').selectOption('native')
        await page.locator('#pause').click()
        await expect(page.locator('#status')).toHaveText('已暂停')
        for (const [encoding, bytes] of [['', slot([0x83, 0x5c], 'JP')], ['gbk', slot([0xd6, 0xd0], 'CN')]] as const) {
          await page.locator('#native-zip-encoding').selectOption(encoding)
          const note = page.locator('#logs p span').filter({ hasText: /^存档已导入/ }), before = await note.count()
          const chooser = page.waitForEvent('filechooser')
          await page.locator('#import-saves').click()
          await (await chooser).setFiles({ name: 'slot.zip', mimeType: 'application/zip', buffer: bytes })
          await expect(note).toHaveCount(before + 1)
        }
        await page.locator('#pause').click()
        await expect(page.locator('#status')).toHaveText('运行中')
        const canvas = page.locator('.game-window').filter({ has: page.locator('.game-window-title', { hasText: /^Archive chapters$/ }) }).locator('canvas')
        const played = page.getByText('chapter:CHAPTER|JP|CN', { exact: true }), before = await played.count()
        await canvas.click(); await expect(played).toHaveCount(before + 1)
        await info.attach(mode + '-archive-menu', { body: await canvas.screenshot(), contentType: 'image/png' })
        await page.locator('#stop').press('Enter'); await expect(page.locator('#status')).toHaveText('待机')
      }
      expect(errors).toEqual([])
    } finally {
      await info.attach('archive-name-log', { body: await page.locator('#logs').innerText(), contentType: 'text/plain' })
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
    }
  })
}
