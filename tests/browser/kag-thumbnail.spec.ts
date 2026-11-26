import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'

const scene = String.raw`
var previewPattern,previewOverlay;
var defaultPreviewWidth=kag.thumbnailWidth,defaultPreviewDepth=kag.thumbnailDepth;
function configurePreview(){
 kag.saveThumbnail=true;kag.thumbnailWidth=320;kag.thumbnailDepth=24;
}
function savePreview(){
 configurePreview();
 previewPattern=new Layer(kag,kag.fore.base);kag.add(previewPattern);
 previewPattern.type=ltOpaque;previewPattern.setSize(640,480);
 previewPattern.fillRect(0,0,640,480,0xff102030);previewPattern.fillRect(1,0,1,480,0xff906050);
 previewPattern.absolute=2100000;previewPattern.visible=true;
 return kag.saveBookMarkToFile(System.dataPath+"preview132.bmp",false);
}
function loadPreview(){
 configurePreview();
 return kag.loadBookMarkFromFile(System.dataPath+"preview132.bmp");
}
function configureIndexedPreview(){
 kag.saveThumbnail=true;kag.thumbnailWidth=defaultPreviewWidth;kag.thumbnailDepth=defaultPreviewDepth;
}
function saveIndexedPreview(){
 configureIndexedPreview();previewPattern.fillRect(0,0,640,480,0xff000000);
 previewOverlay=new Layer(kag,previewPattern);kag.add(previewOverlay);
 previewOverlay.type=ltAlpha;previewOverlay.setSize(640,480);
 previewOverlay.fillRect(0,0,640,480,0xff800000);previewOverlay.visible=true;
 return kag.saveBookMarkToFile(System.dataPath+"indexed-preview.bmp",false);
}
function loadIndexedPreview(){
 configureIndexedPreview();return kag.loadBookMarkFromFile(System.dataPath+"indexed-preview.bmp");
}
Debug.message("thumbnail-game-ready");
`

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true]) {
  test(`${backend}/${binary ? 'bytecode' : 'source'}: KAG saves exact thumbnail pixels and resumes the attached bookmark after refresh`, async ({ page }, info) => {
    test.setTimeout(90000)
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !await page.evaluate(() => 'Suspending' in WebAssembly), 'JSPI unavailable')
    const files = [
      { name: 'kag3_template.xp3', mimeType: 'application/octet-stream',
        buffer: await readFile(new URL('../fixtures/compatibility/kag3_template.xp3', import.meta.url)) },
      { name: 'save-verification.ks', mimeType: 'text/plain', buffer: await readFile(new URL('../fixtures/kag-save.ks', import.meta.url)) },
      { name: 'preview.tjs', mimeType: 'text/plain', buffer: Buffer.from(scene) },
      { name: 'AfterInit2.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
        ? 'Scripts.compileStorage("preview.tjs","savedata/preview.cjs",false,true,false);Scripts.execStorage("savedata/preview.cjs");'
        : 'Scripts.execStorage("preview.tjs");') },
    ]
    const launch = async () => {
      await page.locator('#files').setInputFiles(files)
      await expect(page.getByText('thumbnail-game-ready', { exact: true })).toBeVisible({ timeout: 30000 })
      const exit = page.locator('.leave-fullscreen')
      if (await exit.isVisible()) await exit.click()
    }
    try {
      await launch()
      await evaluate(page, '(function(){kag.conductor.loadScenario("save-verification.ks");kag.conductor.startProcess();return 1;})()', '1')
      await expect(page.locator('#logs')).toContainText('save=ready:7')
      await evaluate(page, 'savePreview()', '1')
      await evaluate(page, 'saveIndexedPreview()', '1')
      const pending = page.waitForEvent('download')
      await page.locator('#export-saves').click()
      const backup = JSON.parse(await readFile((await (await pending).path())!, 'utf8')) as { files: { path: string; base64: string }[] }
      const file = backup.files.find((entry) => entry.path === 'savedata/preview132.bmp')
      expect(file).toBeDefined()
      const bytes = Buffer.from(file!.base64, 'base64'), bmpSize = 54 + 320 * 3 * 240
      expect(bytes.toString('ascii', 0, 2)).toBe('BM')
      expect([bytes.readUInt32LE(2), bytes.readUInt32LE(10), bytes.readInt32LE(18), bytes.readInt32LE(22), bytes.readUInt16LE(28)])
        .toEqual([bmpSize, 54, 320, 240, 24])
      expect(bytes.length).toBeGreaterThan(bmpSize)
      const row = Buffer.alloc(320 * 3)
      for (let x = 0; x < 320; x++) row.set(x === 0 ? [64,64,80] : x === 1 ? [56,48,48] : [48,32,16], x * 3)
      for (let y = 0; y < 240; y++) {
        const start = 54 + y * row.length
        expect(bytes.subarray(start, start + row.length).equals(row), `BMP row ${y}`).toBe(true)
      }
      await info.attach('game-bookmark-thumbnail.bmp', { contentType: 'image/bmp', body: bytes.subarray(0, bmpSize) })
      // The original default thumbnail is 133x99. Red 128 and 127 select
      // different palette entries on odd rows in the stock dither pattern.
      const indexedFile = backup.files.find((entry) => entry.path === 'savedata/indexed-preview.bmp')
      expect(indexedFile).toBeDefined()
      const indexed = Buffer.from(indexedFile!.base64, 'base64'), offset = 54 + 1024, stride = 136, size = offset + stride * 99
      expect([indexed.toString('ascii', 0, 2), indexed.readUInt32LE(2), indexed.readUInt32LE(10),
        indexed.readInt32LE(18), indexed.readInt32LE(22), indexed.readUInt16LE(28)]).toEqual(['BM', size, offset, 133, 99, 8])
      expect(indexed.length).toBeGreaterThan(size)
      expect([...indexed.subarray(54 + 2 * 4, 54 + 4 * 4)]).toEqual([0, 0, 102, 0, 0, 0, 153, 0])
      for (let y = 0; y < 99; y++) {
        const start = offset + (98 - y) * stride
        const expected = Array.from({ length: 133 }, (_, x) => y % 2 === 0 && x % 2 === 1 ? 2 : 3)
        expect([...indexed.subarray(start, start + 133)], `indexed BMP row ${y}`).toEqual(expected)
      }
      await page.reload()
      await launch()
      await evaluate(page, 'loadPreview()', '1')
      await evaluate(page, 'f.saved', '7')
      await page.reload()
      await launch()
      await evaluate(page, '(f.saved=48,f.saved)', '48')
      await evaluate(page, 'loadIndexedPreview()', '1')
      await evaluate(page, 'f.saved', '7')
      await expect(page.locator('#logs .error')).toHaveCount(0)
    } finally {
      if (await page.locator('#stop').isEnabled()) await page.locator('#stop').press('Enter')
      await expect(page.locator('#status')).toHaveText('待机')
    }
  })
}
