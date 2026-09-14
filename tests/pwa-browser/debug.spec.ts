import { browserLaunchOptions } from '../helpers/browser-launch.ts'
import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: saved Debug logs can be read and appended after a cold offline browser restart`, async ({
    page,
    context,
    playwright,
    browserName,
    libraryProfile,
  }) => {
    const server = await pwaServer()
    try {
      await page.goto(server.url + '?backend=' + backend)
      await page.locator('#files').setInputFiles({
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
var recovered=false;
if(Storages.isExistentStorage("savedata/krkr.console.log")){
 var old=[].load("savedata/krkr.console.log").join("\\n");
 recovered=old.indexOf("before-offline")>=0;
}
Debug.startLogToFile();Debug.message("before-offline");Debug.message("offline-log-ready");
`),
      })
      await expect(page.getByText('offline-log-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'recovered', '0')
      await page.locator('#library-title').fill('Debug log')
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText('Debug log')
      await prepareOffline(page)
      await context.close()
      await server.close()
      const reopened = await playwright[browserName].launchPersistentContext(libraryProfile, {
        ...browserLaunchOptions,
      })
      try {
        const next = reopened.pages()[0] ?? (await reopened.newPage())
        await next.goto(server.url + '?backend=' + backend)
        await expect(next.locator('#library-games h3')).toHaveText('Debug log')
        await next
          .locator('.library-game')
          .getByRole('button', { name: '启动', exact: true })
          .click()
        await expect(next.getByText('offline-log-ready', { exact: true })).toBeVisible()
        await evaluate(next, 'recovered', '1')
        await evaluate(
          next,
          'Scripts.exec("var current=[].load(\\\"savedata/krkr.console.log\\\").join(\\\"\\\\n\\\");")',
          '',
        )
        await evaluate(
          next,
          'current.indexOf("before-offline",current.indexOf("before-offline")+1)>=0',
          '1',
        )
      } finally {
        await reopened.close()
      }
    } finally {
      await server.close()
    }
  })
