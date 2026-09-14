import { browserLaunchOptions } from '../helpers/browser-launch.ts'
import { test, expect } from '../helpers/library-browser.ts'
import { prepareOffline } from '../helpers/offline-browser.ts'
import { pwaServer } from '../helpers/pwa-server.ts'
import { evaluate } from '../helpers/browser-expression.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: native Debug classes and dump files survive a cold offline browser restart`, async ({
    page,
    context,
    playwright,
    browserName,
    libraryProfile,
  }) => {
    const server = await pwaServer()
    try {
      await page.goto(server.url + '?backend=' + backend)
      await page.locator('#script-debug').check()
      await page.locator('#files').setInputFiles({
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
      var recovered=false;
      if(Storages.isExistentStorage("savedata/krkr2-web.dump.txt")){
        var oldDump=[].load("savedata/krkr2-web.dump.txt").join("\\n");
        recovered=oldDump.indexOf("TJS Context Dump")>=0;
      }
      Scripts.dump();var callTrace=Scripts.getTraceString();Debug.message("offline-native-dump-ready");
    `),
      })
      await expect(page.getByText('offline-native-dump-ready', { exact: true })).toBeVisible()
      await evaluate(page, 'recovered', '0')
      await page.locator('#library-title').fill('Native Debug')
      await page.locator('#save-library').click()
      await expect(page.locator('#library-games h3')).toHaveText('Native Debug')
      await prepareOffline(page)
      await context.close()
      await server.close()
      const reopened = await playwright[browserName].launchPersistentContext(libraryProfile, {
        ...browserLaunchOptions,
      })
      try {
        const next = reopened.pages()[0] ?? (await reopened.newPage())
        await next.goto(server.url + '?backend=' + backend)
        await expect(next.locator('#library-games h3')).toHaveText('Native Debug')
        await next.locator('#script-debug').check()
        await next
          .locator('.library-game')
          .getByRole('button', { name: '启动', exact: true })
          .click()
        await expect(next.getByText('offline-native-dump-ready', { exact: true })).toBeVisible()
        await evaluate(next, 'recovered', '1')
        await evaluate(
          next,
          'callTrace.indexOf("startup.tjs(")===0 && callTrace.indexOf("top level script")>0',
          '1',
        )
        await evaluate(
          next,
          'Debug.console instanceof "Class" && Debug.controller instanceof "Class"',
          '1',
        )
        await evaluate(
          next,
          '(function(){var c=new Debug.console();return typeof c.visible;})()',
          'undefined',
        )
      } finally {
        await reopened.close()
      }
    } finally {
      await server.close()
    }
  })
