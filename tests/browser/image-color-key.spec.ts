import { magnifyPixelWindow } from '../helpers/pixel-window.ts'
import { test, expect, type Page, type TestInfo } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  imageKeyExpected,
  imageKeyFiles,
  imageKeyScenarios,
  imageKeySource,
} from '../helpers/image-color-key.ts'

async function pixels(page: Page, info: TestInfo, height: number) {
  const canvas = page.locator('canvas')
  await expect(canvas).toHaveJSProperty('width', 2)
  await expect(canvas).toHaveJSProperty('height', height)
  await magnifyPixelWindow(canvas)
  const png = await canvas.screenshot()
  await info.attach('image-color-key-canvas', { body: png, contentType: 'image/png' })
  return page.evaluate(
    async ({ url, height }) => {
      const bitmap = await createImageBitmap(await (await fetch(url)).blob()),
        context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d')!
      context.drawImage(bitmap, 0, 0)
      const result = Array.from({ length: height }, (_, y) =>
        [0, 1].map((x) => [
          ...context.getImageData(
            Math.floor(((x + 0.5) * bitmap.width) / 2),
            Math.floor(((y + 0.5) * bitmap.height) / height),
            1,
            1,
          ).data,
        ]),
      )
      bitmap.close()
      return result
    },
    { url: 'data:image/png;base64,' + png.toString('base64'), height },
  )
}

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const mode = `${backend}/${binary ? 'bytecode' : 'source'}`
    for (const scenario of imageKeyScenarios) {
      test(`${mode}: loadImages ${scenario.name}`, async ({ page }, info) => {
        const errors: string[] = []
        page.on('pageerror', (error) => errors.push(error.message))
        await page.goto(`/?backend=${backend}`)
        test.skip(
          backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
          'JSPI unavailable',
        )
        try {
          await page.locator('#files').setInputFiles([
            ...Object.entries(imageKeyFiles()).map(([name, bytes]) => ({
              name,
              mimeType: 'application/octet-stream',
              buffer: Buffer.from(bytes),
            })),
            {
              name: 'startup.tjs',
              mimeType: 'text/plain',
              buffer: Buffer.from(
                binary
                  ? 'Scripts.compileStorage("image-color-key.tjs","savedata/image-color-key.cjs",false,true,false);Scripts.execStorage("savedata/image-color-key.cjs");'
                  : 'Scripts.execStorage("image-color-key.tjs");',
              ),
            },
            {
              name: 'image-color-key.tjs',
              mimeType: 'text/plain',
              buffer: Buffer.from(imageKeySource(scenario)),
            },
          ])
          await expect(page.getByText('image-key-ready', { exact: true })).toBeVisible()
          await evaluate(page, 'imageKeyRows.join("|")', imageKeyExpected(scenario))
          await evaluate(
            page,
            'imageKeyMetadata.join("")',
            scenario.rows
              .filter((row) => row.file === 'plain.png' || row.file === 'hero.png')
              .map(() => '1')
              .join(''),
          )
          const actual = await pixels(page, info, scenario.rows.length)
          await info.attach('image-color-key-pixels', {
            body: JSON.stringify({ mode, rows: scenario.rows.map((row) => row.label), actual }),
            contentType: 'application/json',
          })
          expect(actual).toEqual(scenario.rows.map((row) => row.display))
        } finally {
          if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
          await expect(page.locator('#status')).toHaveText('待机')
          await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
          await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
          expect(errors).toEqual([])
        }
      })
    }
  }
}
