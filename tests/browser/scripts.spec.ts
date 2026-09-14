import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { evaluate } from '../helpers/browser-expression.ts'
import { scriptsFixture, reentrantScriptsFixture } from '../helpers/scripts-fixture.ts'

for (const backend of ['asyncify', 'jspi'])
  test(`${backend}: native Scripts execution, compilation and reflection reach browser saves`, async ({
    page,
  }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.addInitScript(() => {
      const original = Worker.prototype.postMessage
      const pending: (() => void)[] = []
      const gate = {
        held: true,
        requests: 0,
        requestsOnReimport: undefined as number | undefined,
        release() {
          gate.held = false
          for (const send of pending.splice(0)) send()
        },
      }
      Object.assign(window, { scriptStopGate: gate })
      // The input handler requests the next launch before this document
      // listener releases the old stop, without another driver round trip.
      document.addEventListener('change', (event) => {
        if (
          event.target instanceof HTMLInputElement &&
          event.target.id === 'files' &&
          gate.held &&
          gate.requests
        ) {
          gate.requestsOnReimport = gate.requests
          gate.release()
        }
      })
      Worker.prototype.postMessage = function (
        message: unknown,
        transferOrOptions?: Transferable[] | StructuredSerializeOptions,
      ) {
        const request = message as { type?: string; argumentList?: { value?: unknown }[] }
        const send = () => Reflect.apply(original, this, [message, transferOrOptions])
        if (request.type === 'APPLY' && request.argumentList?.[0]?.value === 'stop') {
          gate.requests++
          if (gate.held) {
            pending.push(send)
            return
          }
        }
        send()
      }
    })
    await page.goto('/?backend=' + backend)
    await page.locator('#script-debug').check()
    await page.locator('#files').setInputFiles(
      Object.entries(scriptsFixture).map(([name, source]) => ({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(source),
      })),
    )
    await expect(page.getByText('native-scripts-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'scope.value', '9')
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.locator('#export-saves').click(),
    ])
    const backup = JSON.parse(await readFile((await download.path())!, 'utf8'))
    const output = backup.files.find(
      (file: { path: string }) => file.path === 'savedata/native.cjs',
    )
    expect(Buffer.from(output.base64, 'base64').subarray(0, 4).toString()).toBe('TJS2')
    await page.locator('#stop').click()
    await expect(page.locator('#choose-files')).toBeDisabled()
    await page.locator('#files').setInputFiles(
      Object.entries(reentrantScriptsFixture).map(([name, source]) => ({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(source),
      })),
    )
    const stopRequests = await page.evaluate(() => {
      const gate = (
        window as unknown as { scriptStopGate: { requestsOnReimport: number | undefined } }
      ).scriptStopGate
      return gate.requestsOnReimport
    })
    expect(stopRequests).toBe(1)
    await expect(page.getByText('reentrant-scripts-ready', { exact: true })).toBeVisible()
    await evaluate(page, 'outerResult', '84')
    await page.locator('#stop').click()
    await expect(page.locator('#status')).toHaveText('待机')
    await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
    expect(errors).toEqual([])
  })
