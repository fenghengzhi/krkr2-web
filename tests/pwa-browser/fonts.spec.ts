import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { readFile } from 'node:fs/promises'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: first file-font load succeeds after browser cold restart with the server closed`, async ({
    page,
    context,
    playwright,
    browserName,
    libraryProfile,
  }) => {
    const server = await pwaServer(),
      fontRequests: string[] = []
    context.on('request', (request) => {
      if (request.url().includes('/fonts/')) fontRequests.push(request.url())
    })
    try {
      await page.goto(server.url + `?backend=${backend}`)
      await page.locator('#files').setInputFiles([
        {
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(`
var w=new Window();w.visible=true;w.setInnerSize(64,32);var a=new Layer(w,null);a.setSize(64,32);a.type=ltAlpha;
a.font.height=20;a.font.face="narrow.ttf";a.font.faceIsFileName=true;
function firstFontLoad(){a.drawText(0,0,"AV",0x123456);var r=a.font.getGlyphDrawRect("AV");return [a.font.getTextWidth("AV"),r.left,r.top,r.right,r.bottom,a.getMaskPixel(4,10),a.getMainPixel(4,10)].join(",");}
Debug.message("offline-font-ready");`),
        },
        {
          name: 'narrow.ttf',
          mimeType: 'font/ttf',
          buffer: await readFile('tests/fixtures/font/narrow.ttf'),
        },
      ])
      await expect(page.getByText('offline-font-ready', { exact: true })).toBeVisible()
      expect(fontRequests).toEqual([])
      await expect(page.locator('#save-library')).toBeEnabled()
      await page.locator('#library-title').fill('Offline font')
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText('Offline font')
      await prepareOffline(page)
      await context.close()
      await server.close()
      const reopened = await playwright[browserName].launchPersistentContext(libraryProfile, {
        headless: true,
      })
      try {
        const next = reopened.pages()[0] ?? (await reopened.newPage())
        await next.goto(server.url + `?backend=${backend}`)
        await expect(next.locator('#library-games h3')).toHaveText('Offline font')
        await next
          .locator('.library-game')
          .getByRole('button', { name: '启动', exact: true })
          .click()
        await expect(next.getByText('offline-font-ready', { exact: true })).toBeVisible()
        await expect(next.locator('#evaluate')).toBeEnabled()
        await evaluate(next, 'firstFontLoad()', '24,0,2,18,16,255,1193046')
        await next
          .locator('#expression')
          .fill(
            'Debug.message("offline-font-choice:"+a.font.doUserSelect(fsfTrueTypeOnly,"Offline font selection","Choose","AV")+":"+a.font.face)',
          )
        await next.locator('#evaluate').click()
        const chooser = next.getByRole('dialog', { name: 'Offline font selection', exact: true })
        await expect(chooser).toBeVisible()
        await expect(chooser.getByRole('option')).toHaveCount(1)
        await expect(chooser.locator('.font-sample')).toHaveAttribute(
          'data-font-face',
          'Krkr Synthetic narrow',
        )
        await chooser.getByRole('button', { name: '确定', exact: true }).click()
        await expect(
          next.getByText('offline-font-choice:1:Krkr Synthetic narrow', { exact: true }),
        ).toBeVisible()
        await evaluate(next, 'a.font.getTextWidth("AV")', '24')
        await expect(next.locator('#offline-panel')).toHaveAttribute('data-ready', 'true')
      } finally {
        await reopened.close()
      }
    } finally {
      await server.close()
    }
  })
