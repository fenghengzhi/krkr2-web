import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'

async function backup(page: Page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.locator('#export-saves').click(),
  ])
  return JSON.parse(await readFile((await download.path())!, 'utf8')) as {
    files: { path: string; base64: string }[]
  }
}
for (const backend of ['asyncify', 'jspi']) {
  test(`${backend}: native classes, VM warnings and script dumps reach the browser and backup`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
        var observed=0,total=0,beforeWarning="";Debug.startLogToFile();
        Debug.addLoggingHandler(function(line){total++;if(line.indexOf("warning.tjs")>=0){observed++;Scripts.execStorage("observer.tjs");}});
        Scripts.execStorage("warning.tjs");Debug.message("vm-console-ready");
      `),
      },
      {
        name: 'warning.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('var warningValue=0;if(warningValue=1){}'),
      },
      {
        name: 'observer.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('beforeWarning=typeof global.warningValue;'),
      },
    ])
    await expect(page.getByText('vm-console-ready', { exact: true })).toBeVisible()
    await evaluate(page, '[observed,total,beforeWarning,warningValue].join("|")', '1|2|undefined|1')
    await evaluate(
      page,
      'Debug.console instanceof "Class" && Debug.controller instanceof "Class"',
      '1',
    )
    await evaluate(
      page,
      '(function(){var c=new Debug.console();return (c instanceof "Console") && typeof c.visible=="undefined";})()',
      '1',
    )
    await evaluate(page, 'Scripts.dump()', '')
    await evaluate(page, 'total', '3')
    const saved = await backup(page)
    const dump = saved.files.find((f) => f.path === 'savedata/krkr2-web.dump.txt')!
    const bytes = Buffer.from(dump.base64, 'base64')
    expect([...bytes.subarray(0, 2)]).toEqual([255, 254])
    const text = bytes.toString('utf16le')
    expect(text).toContain('TJS Context Dump')
    expect(text).toContain('warning.tjs')
    const log = saved.files.find((f) => f.path === 'savedata/krkr.console.log')!
    expect(Buffer.from(log.base64, 'base64').toString('utf16le')).toContain(
      'Dumped to savedata/krkr2-web.dump.txt',
    )
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    expect(errors).toEqual([])
  })

  test(`${backend}: a diagnostic observer failure preserves the primary native error and allows restart`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(`
      Debug.startLogToFile();
      Debug.addLoggingHandler(function(line){if(line.indexOf("An exception occurred")>=0)throw new Exception("secondary-log-error");});
      function crash(){return missingPrimarySymbol;}
      Debug.message("native-error-ready");
    `),
    })
    await expect(page.getByText('native-error-ready', { exact: true })).toBeVisible()
    await page.locator('#expression').fill('crash()')
    await page.locator('#evaluate').click()
    await expect(page.locator('#status')).toHaveText('运行失败')
    await expect(page.locator('#logs .error').last()).toContainText('missingPrimarySymbol')
    const saved = await backup(page),
      log = saved.files.find((f) => f.path.endsWith('krkr.console.log'))!
    expect(Buffer.from(log.base64, 'base64').toString('utf16le')).toContain('missingPrimarySymbol')
    await page
      .locator('#files')
      .setInputFiles({
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('Debug.message("native-error-fresh");'),
      })
    await expect(page.getByText('native-error-fresh', { exact: true })).toBeVisible()
    await evaluate(page, 'Debug.console instanceof "Class"', '1')
    expect(errors).toEqual([])
  })

  test(`${backend}: a suspended compiler warning observer can be stopped and released`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles([
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
        Debug.addLoggingHandler(function(line){Debug.message("compiler-observer-hold");while(true){}});
        Scripts.execStorage("warning.tjs");
      `),
      },
      {
        name: 'warning.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('var warning=0;if(warning=1){}'),
      },
    ])
    await expect(page.getByText('compiler-observer-hold', { exact: true })).toBeVisible()
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await page
      .locator('#files')
      .setInputFiles({
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('Debug.message("compiler-fresh");'),
      })
    await expect(page.getByText('compiler-fresh', { exact: true })).toBeVisible()
  })
}
