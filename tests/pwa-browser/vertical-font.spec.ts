import { browserLaunchOptions } from '../helpers/browser-launch.ts'
import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import { readFile } from 'node:fs/promises'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: first vertical glyph and substitution load works after a cold offline restart`, async ({
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
      await page.goto(server.url + '?backend=' + backend)
      await page.locator('#files').setInputFiles([
        {
          name: 'startup.tjs',
          mimeType: 'text/plain',
          buffer: Buffer.from(
            'var w=new Window(),a=new Layer(w,null);w.visible=true;w.setInnerSize(64,128);a.setSize(64,128);a.type=ltAlpha;function firstVertical(){a.font.getList(0);a.font.face="@Krkr Vertical vert";a.font.height=20;a.font.angle=2700;a.drawText(24,4,"漢A、",0xffffff);return [a.font.getTextWidth("漢A、"),a.getMaskPixel(7,10),a.getMaskPixel(10,27),a.getMaskPixel(18,37)].join(",");}Debug.message("offline-vertical-ready");',
          ),
        },
        {
          name: 'vertical.ttf',
          mimeType: 'font/ttf',
          buffer: await readFile('tests/fixtures/text-layout/vert.ttf'),
        },
      ])
      await expect(page.getByText('offline-vertical-ready', { exact: true })).toBeVisible()
      expect(fontRequests).toEqual([])
      await page.locator('#library-title').fill('Vertical font')
      await expect(page.locator('#save-library')).toBeEnabled()
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText('Vertical font')
      await prepareOffline(page)
      await context.close()
      await server.close()
      const reopened = await playwright[browserName].launchPersistentContext(libraryProfile, {
        ...browserLaunchOptions,
      })
      try {
        const next = reopened.pages()[0] ?? (await reopened.newPage())
        await next.goto(server.url + '?backend=' + backend)
        await expect(next.locator('#library-games h3')).toHaveText('Vertical font')
        await next
          .locator('.library-game')
          .getByRole('button', { name: '启动', exact: true })
          .click()
        await expect(next.getByText('offline-vertical-ready', { exact: true })).toBeVisible()
        await evaluate(next, 'firstVertical()', '52,255,255,255')
      } finally {
        await reopened.close()
      }
    } finally {
      await server.close()
    }
  })
