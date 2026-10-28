import { test, expect } from '@playwright/test'
import { bmpNativeFiles, bmpNativeSource } from '../helpers/bmp-native-files.ts'
import { magnifyPixelWindow } from '../helpers/pixel-window.ts'

for (const backend of ['asyncify', 'jspi']) for (const binary of [false, true])
  test(`${backend}/${binary ? 'bytecode' : 'source'}: portable CORE and RGB555 mask reach the canvas`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto(`/?backend=${backend}`)
    test.skip(backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)), 'JSPI unavailable')
    await page.locator('#files').setInputFiles([
      ...Object.entries(bmpNativeFiles()).map(([name, buffer]) => ({ name, buffer, mimeType: 'image/bmp' })),
      { name: 'bmp-native.tjs', mimeType: 'text/plain', buffer: Buffer.from(bmpNativeSource) },
      { name: 'startup.tjs', mimeType: 'text/plain', buffer: Buffer.from(binary
        ? 'Scripts.compileStorage("bmp-native.tjs","savedata/bmp-native.cjs",false,true,false);Scripts.execStorage("savedata/bmp-native.cjs");'
        : 'Scripts.execStorage("bmp-native.tjs");') },
    ])
    await expect(page.locator('#logs')).toContainText('bmp-native-ready:1')
    const canvas = page.locator('canvas')
    await expect(canvas).toHaveJSProperty('width', 3)
    await expect(canvas).toHaveJSProperty('height', 1)
    await magnifyPixelWindow(canvas)
    const bytes = await canvas.screenshot(), pixels = await page.evaluate(async (url) => {
      const image = await createImageBitmap(await (await fetch(url)).blob()), surface = new OffscreenCanvas(image.width, image.height), context = surface.getContext('2d')!
      context.drawImage(image, 0, 0)
      const result = [0, 1, 2].map((x) => [...context.getImageData(Math.floor((x + 0.5) * image.width / 3), Math.floor(image.height / 2), 1, 1).data])
      image.close(); return result
    }, 'data:image/png;base64,' + bytes.toString('base64'))
    expect(pixels).toEqual([[54, 0, 0, 255], [0, 181, 0, 255], [0, 0, 20, 255]])
    await page.locator('#stop').click()
    await expect(page.locator('#stop')).toBeDisabled()
    expect(errors).toEqual([])
  })
