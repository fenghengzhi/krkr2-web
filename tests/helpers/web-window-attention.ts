import { test, expect, type Locator, type Page } from '@playwright/test'

let launchSequence = 0

export async function launchWindowAttention(
  page: Page,
  backend: string,
  binary: boolean,
  source: string,
  extraFiles: { name: string; mimeType: string; buffer: Buffer }[] = [],
  reusePage = false,
) {
  const errors: string[] = [],
    marker = `window-attention-ready-${++launchSequence}`
  page.on('pageerror', (error) => errors.push(error.message))
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
          ? 'Scripts.compileStorage("window-attention.tjs","savedata/window-attention.cjs",false,true,false);Scripts.execStorage("savedata/window-attention.cjs");'
          : 'Scripts.execStorage("window-attention.tjs");',
      ),
    },
    {
      name: 'window-attention.tjs',
      mimeType: 'text/plain',
      buffer: Buffer.from(source + `\nDebug.message(${JSON.stringify(marker)});`),
    },
    ...extraFiles,
  ])
  await expect(page.getByText(marker, { exact: true })).toBeVisible()
  await expect(page.locator('#evaluate')).toBeEnabled()
  const surface = (caption: string) =>
    page.locator('.game-window[data-window-id]').filter({
      has: page.locator('.game-window-title', { hasText: new RegExp(`^${caption}$`) }),
    })
  return {
    surface,
    async stop() {
      // A failed assertion can leave a native modal open, making page controls
      // inert. Use its real Stop action so cleanup cannot hide that failure
      // behind a second click timeout.
      const dialogStop = page.locator('dialog[open]:visible').getByRole('button', {
        name: '停止游戏',
        exact: true,
      })
      if (await dialogStop.count()) await dialogStop.last().click()
      else if (await page.locator('#stop').isEnabled()) await page.locator('#stop').click()
      await expect(page.locator('#status')).toHaveText('待机')
      await expect(page.locator('.game-window[data-window-id]')).toHaveCount(0)
      await expect(page.locator('.game-text-input')).toHaveCount(0)
      await expect(page.locator('#logs')).not.toContainText('Worker did not stop in time')
      await expect(page.locator('#logs')).not.toContainText('RPC client has been disposed')
      expect(errors).toEqual([])
    },
  }
}

/** Compare the actual hidden textarea DOM anchor to the rendered canvas.
 * This is not an observation of the operating system's IME candidate window. */
export async function expectAttentionAnchor(surface: Locator, x: number, y: number) {
  await expect
    .poll(() =>
      surface.evaluate(
        (element, point) => {
          const canvas = element.querySelector<HTMLCanvasElement>('canvas[data-window-id]')!,
            text = element.querySelector<HTMLTextAreaElement>('.game-text-input')!,
            image = canvas.getBoundingClientRect(),
            caret = text.getBoundingClientRect()
          return Math.max(
            Math.abs(caret.x - image.x - canvas.clientWidth * point.x),
            Math.abs(caret.y - image.y - canvas.clientHeight * point.y),
          )
        },
        { x, y },
      ),
    )
    .toBeLessThan(1.5)
}

export async function clickGame(surface: Locator) {
  const canvas = surface.locator('canvas[data-window-id]')
  await canvas.click({ position: { x: 8, y: 8 } })
  await expect(surface.locator('.game-text-input')).toBeFocused()
  await expect(surface).toHaveAttribute('data-active', 'true')
}

/** Explicitly constructed DOM composition sequence, not physical OS IME. */
export async function startComposition(text: Locator, value: string) {
  await text.evaluate((element, value) => {
    const input = element as HTMLTextAreaElement
    input.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }))
    input.dispatchEvent(new CompositionEvent('compositionupdate', { data: value, bubbles: true }))
    input.value = value
    input.dispatchEvent(
      new InputEvent('input', {
        data: value,
        inputType: 'insertCompositionText',
        isComposing: true,
        bubbles: true,
      }),
    )
  }, value)
}

export async function finishComposition(text: Locator, value: string) {
  await text.evaluate((element, value) => {
    const input = element as HTMLTextAreaElement
    input.dispatchEvent(new CompositionEvent('compositionend', { data: value, bubbles: true }))
    input.value = value
    input.dispatchEvent(
      new InputEvent('input', {
        data: value,
        inputType: 'insertFromComposition',
        bubbles: true,
      }),
    )
  }, value)
}
