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
  test(`${backend}: diagnostic-only database failures leave the game running and stopping available`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page
      .locator('#files')
      .setInputFiles({
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('var counter=1;Debug.message("quota-alone-ready");'),
      })
    await expect(page.getByText('quota-alone-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'counter', '1')
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('krkr2-web', 2)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            request.result.close()
            resolve()
          }
        }),
    )
    await evaluate(page, 'Debug.startLogToFile()', '')
    await expect(page.locator('#logs')).toContainText('日志提交失败')
    await expect(page.locator('#status')).toHaveText('运行中')
    await evaluate(page, 'counter+=1', '2')
    const saved = await backup(page)
    expect(saved.files.map((file) => file.path)).toEqual(['savedata/krkr.console.log'])
    expect(Buffer.from(saved.files[0]!.base64, 'base64').toString('utf16le')).toContain(
      'quota-alone-ready',
    )
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
  })

  test(`${backend}: Debug observers and UTF-16 log files survive browser export and reload`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const files = [
      {
        name: 'startup.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from(`
Debug.logLocation="diagnostics/";
var prior=Storages.isExistentStorage("diagnostics/krkr.console.log"),seen="";
Debug.notice("important 漢");Debug.startLogToFile();
function observer(line){Scripts.execStorage("observer.tjs");Debug.message("nested");}
Debug.addLoggingHandler(observer);Debug.addLoggingHandler(observer);
Debug.message("outer",42);Debug.removeLoggingHandler(observer);
Debug.message("debug-ready");
`),
      },
      {
        name: 'observer.tjs',
        mimeType: 'text/plain',
        buffer: Buffer.from('seen=Debug.getLastLog(1);'),
      },
    ]
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles(files)
    await expect(page.getByText('debug-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'prior', '0')
    await evaluate(page, 'seen.substr(9)', 'outer, 42\r\n')
    const first = await backup(page)
    expect(first.files.map((f) => f.path)).toEqual(['diagnostics/krkr.console.log'])
    const bytes = Buffer.from(first.files[0]!.base64, 'base64'),
      text = bytes.toString('utf16le')
    expect([...bytes.subarray(0, 2)]).toEqual([255, 254])
    expect(text).toContain('! important 漢\r\n')
    expect(text).toMatch(/\d{2}:\d{2}:\d{2} nested\r\n\d{2}:\d{2}:\d{2} outer, 42\r\n/)
    expect(text).toMatch(/debug-ready\r\n$/)
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await page.reload()
    await page.locator('#files').setInputFiles(files)
    await expect(page.getByText('debug-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'prior', '1')
    const second = Buffer.from((await backup(page)).files[0]!.base64, 'base64')
    expect(second.subarray(0, bytes.length)).toEqual(bytes)
    expect((second.toString('utf16le').match(/debug-ready/g) ?? []).length).toBe(2)
    expect(errors).toEqual([])
  })

  test(`${backend}: a failed database commit retains the primary script error and exportable log`, async ({
    page,
  }) => {
    await page.goto('/?backend=' + backend)
    await page.locator('#files').setInputFiles({
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '["original-save"].save("savedata/keep.txt");Debug.addLoggingHandler(function(line){if(line.indexOf("primary-browser-error")>=0)[line].save("savedata/observed.txt");});Debug.message("failure-ready");',
      ),
    })
    await expect(page.getByText('failure-ready', { exact: true })).toBeVisible()
    await expect(page.locator('#save-status')).toContainText('1 个存档文件，已保存')
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const request = indexedDB.open('krkr2-web', 2)
          request.onerror = () => reject(request.error)
          request.onsuccess = () => {
            request.result.close()
            resolve()
          }
        }),
    )
    await page
      .locator('#expression')
      .fill(
        'Scripts.exec("Debug.notice(\\\"context-before-error\\\");throw new Exception(\\\"primary-browser-error\\\");")',
      )
    await page.locator('#evaluate').click()
    await expect(page.locator('#logs .error')).toContainText(['primary-browser-error'])
    await expect(page.locator('#save-status')).toContainText('等待保存')
    const saved = await backup(page)
    expect(saved.files.map((file) => file.path).sort()).toEqual([
      'savedata/keep.txt',
      'savedata/krkr.console.log',
      'savedata/observed.txt',
    ])
    const log = Buffer.from(
      saved.files.find((f) => f.path.endsWith('.log'))!.base64,
      'base64',
    ).toString('utf16le')
    expect(log).toContain('! context-before-error')
    expect(log).toContain('primary-browser-error')
    expect((log.match(/primary-browser-error/g) ?? []).length).toBe(1)
    const original = Buffer.from(
      saved.files.find((f) => f.path.endsWith('keep.txt'))!.base64,
      'base64',
    ).toString('utf16le')
    expect(original).toContain('original-save')
    const observed = Buffer.from(
      saved.files.find((f) => f.path.endsWith('observed.txt'))!.base64,
      'base64',
    ).toString('utf16le')
    expect(observed).toContain('primary-browser-error')
  })
}
