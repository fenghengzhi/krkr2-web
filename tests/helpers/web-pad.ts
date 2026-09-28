import { test, expect, type Page } from '@playwright/test'

let sequence = 0

/** Actual Worker startup for every Pad case, including compiled TJS bytecode. */
export async function launchPads(
  page: Page,
  backend: string,
  binary: boolean,
  source: string,
  extraFiles: { name: string; mimeType: string; buffer: Buffer }[] = [],
  reusePage = false,
) {
  const controls = observePads(page),
    marker = `pad-ready-${++sequence}`
  if (!reusePage) await page.goto(`/?backend=${backend}`)
  test.skip(
    backend === 'jspi' && !(await page.evaluate(() => 'Suspending' in WebAssembly)),
    'JSPI unavailable',
  )
  await page.locator('#files').setInputFiles([
    {
      name: 'startup.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        binary
          ? 'Scripts.compileStorage("pad-proof.tjs","savedata/pad-proof.cjs",false,true,false);Scripts.execStorage("savedata/pad-proof.cjs");'
          : 'Scripts.execStorage("pad-proof.tjs");',
      ),
    },
    {
      name: 'pad-proof.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + `\nDebug.message(${JSON.stringify(marker)});`),
    },
    ...extraFiles,
  ])
  await expect(page.getByText(marker, { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  return controls
}

export function observePads(page: Page) {
  const errors: string[] = [],
    onError = (error: Error) => errors.push(error.message)
  page.on('pageerror', onError)
  return {
    async stopped() {
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-pad, .game-pad-save')).toHaveCount(0)
      await expect(page.locator('.game-window[data-window-id], .game-text-input')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
      expect(errors).toEqual([])
      page.off('pageerror', onError)
    },
    async stop() {
      const modalStop = page.locator('dialog[open]:visible').getByRole('button', {
        name: '停止游戏',
        exact: true,
      })
      if (await modalStop.count()) await modalStop.last().click()
      else if (await page.locator('#stop').isEnabled())
        // A failed modal assertion may leave the surrounding controls inert.
        // Cleanup retires the same application session rather than timing out.
        await page.locator('#stop').dispatchEvent('click')
      await this.stopped()
    },
  }
}

export const padSource = String.raw`
System.exitOnWindowClose=false;
var first=new Pad(),second=new Pad();
first.title="First pad";first.text="first";first.left=0;first.top=0;first.width=320;first.height=220;first.visible=true;
second.title="Second pad";second.text="second";second.left=350;second.top=0;second.width=320;second.height=220;second.visible=true;
`

export function padSurface(page: Page, title: string) {
  return page.locator('.game-pad[data-pad-id]').filter({
    has: page.locator('.game-pad-title', { hasText: new RegExp(`^${title}$`) }),
  })
}
