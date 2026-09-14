import { test, expect, type Page } from '@playwright/test'
import { zipFixture, centralRecords } from '../helpers/zip-fixtures.ts'

async function expression(page: Page, source: string, value: string) {
  await expect(page.locator('#evaluate')).toBeEnabled()
  await page.locator('#expression').fill(source)
  await page.locator('#evaluate').click()
  await expect(page.locator('#logs p').last().locator('span')).toHaveText(value)
}
function largeIndex() {
  const local = Buffer.alloc(31)
  local.writeUInt32LE(0x04034b50)
  local.writeUInt16LE(20, 4)
  local.writeUInt16LE(1, 26)
  local[30] = 120
  const record = Buffer.alloc(47)
  record.writeUInt32LE(0x02014b50)
  record.writeUInt16LE(20, 4)
  record.writeUInt16LE(20, 6)
  record.writeUInt16LE(1, 28)
  record[46] = 120
  const index = Buffer.alloc(record.length * 65535)
  for (let at = 0; at < index.length; at += record.length) record.copy(index, at)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50)
  end.writeUInt16LE(65535, 8)
  end.writeUInt16LE(65535, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(local.length, 16)
  return Buffer.concat([local, index, end])
}
for (const backend of ['asyncify', 'jspi']) {
  for (const [kind, fixture] of [
    ['stored', '0-stream0-local640-zip640.zip'],
    ['deflate', '8-stream0-local640-zip640.zip'],
    ['zip64-stream', '8-stream1-local641-zip640.zip'],
  ]) {
    test(`${backend}: ${kind} ZIP runs Unicode scripts and images, rejects writes and restores saves`, async ({
      page,
    }) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await page.goto(`/?backend=${backend}`)
      test.skip(
        backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
        'JSPI unavailable',
      )
      const file = {
        name: 'game.data',
        mimeType: 'application/octet-stream',
        buffer: zipFixture(fixture),
      }
      await page.locator('#files').setInputFiles(file)
      await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
      await expect(page.locator('canvas')).toHaveJSProperty('width', 2)
      await expect(page.locator('canvas')).toHaveJSProperty('height', 1)
      await page.locator('canvas').evaluate((node) => {
        const c = node as HTMLCanvasElement
        c.style.width = '256px'
        c.style.height = '128px'
        c.style.imageRendering = 'pixelated'
      })
      const screenshot = await page.locator('canvas').screenshot()
      const pixel = await page.evaluate(
        async (url) => {
          const image = await createImageBitmap(await (await fetch(url)).blob()),
            canvas = new OffscreenCanvas(image.width, image.height),
            context = canvas.getContext('2d')!
          context.drawImage(image, 0, 0)
          const result = [...context.getImageData(image.width / 2, image.height / 2, 1, 1).data]
          image.close()
          return result
        },
        'data:image/png;base64,' + screenshot.toString('base64'),
      )
      expect(pixel).toEqual([51, 102, 153, 255])
      await expression(page, 'Scripts.evalStorage("game.data>シーン/value.tjs")', '42')
      await expression(
        page,
        '(function(){var failures=0,d=%[];try{saved.save("game.data>empty.bin");}catch(e){failures++;}try{(Dictionary.saveStruct incontextof d)("game.data>empty.bin","b");}catch(e){failures++;}return failures;})()',
        '2',
      )
      await expression(
        page,
        '(function(){Storages.addAutoPath("game.data>folder/");return Storages.getPlacedPath("CAFÉ.TXT");})()',
        'game.data>folder/café.txt',
      )
      await expect(page.locator('#save-status')).toContainText('1 个存档文件，已保存')
      await page.reload()
      await page.locator('#files').setInputFiles(file)
      await expect(page.locator('#logs')).toContainText('zip-ready:42:1')
      await page.locator('#stop').click()
      expect(errors).toEqual([])
    })
  }
  test(`${backend}: corrupt ZIP payload errors are visible and a clean reimport recovers`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    const bytes = zipFixture('0-stream0-local640-zip640.zip'),
      record = centralRecords(bytes).records.find((r) => r.name === 'startup.tjs')!
    bytes[record.data] ^= 1
    await page
      .locator('#files')
      .setInputFiles({ name: 'broken.zip', mimeType: 'application/zip', buffer: bytes })
    await expect(page.locator('#logs')).toContainText('ZIP CRC32 mismatch: startup.tjs')
    await expect(page.locator('#choose-files')).toBeEnabled()
    await page
      .locator('#files')
      .setInputFiles({ name: 'clean.zip', mimeType: 'application/zip', buffer: zipFixture() })
    await expect(page.locator('#logs')).toContainText('zip-ready:42:0')
    await page.locator('#stop').click()
  })
  test(`${backend}: stopping ZIP indexing cancels before the mount is published`, async ({
    page,
  }) => {
    await page.goto(`/?backend=${backend}`)
    test.skip(
      backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
      'JSPI unavailable',
    )
    await page.locator('#status').evaluate((node) => {
      document.documentElement.dataset.zipMountPublished = 'false'
      const info = document.querySelector('#runtime-info')!
      new MutationObserver(() => {
        if (/· [1-9]\d* 个资源 ·/.test(info.textContent ?? ''))
          document.documentElement.dataset.zipMountPublished = 'true'
      }).observe(info, { childList: true, subtree: true, characterData: true })
      const observer = new MutationObserver(() => {
        if (node.textContent !== '就绪') return
        observer.disconnect()
        node.setAttribute('data-zip-stop-requested', 'true')
        setTimeout(() => document.querySelector<HTMLButtonElement>('#stop')!.click(), 0)
      })
      observer.observe(node, { childList: true, subtree: true, characterData: true })
    })
    await page
      .locator('#files')
      .setInputFiles({ name: 'many.zip', mimeType: 'application/zip', buffer: largeIndex() })
    await expect(page.locator('#status')).toHaveAttribute('data-zip-stop-requested', 'true')
    await expect(page.locator('#stop')).toBeDisabled({ timeout: 1800 })
    await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
    await expect(page.locator('#logs')).not.toContainText('Resource not found: startup.tjs')
    await expect(page.locator('html')).toHaveAttribute('data-zip-mount-published', 'false')
  })
}
