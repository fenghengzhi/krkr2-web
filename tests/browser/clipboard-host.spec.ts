import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { ClipboardPort, ClipboardText } from '../../src/engine/ports/clipboard.ts'
import type { ClipboardRequest, ClipboardResponse } from '../../src/protocol/clipboard.ts'

// These are DOM host contracts with an injected fake port. They never call the
// platform clipboard and are not evidence of browser clipboard permissions.
type AdapterCall = { op: 'has-text' | 'read-text' | 'write-text'; text?: string }
interface FixtureOptions {
  complete?: 'clear' | 'dispose' | 'throw'
  pendingThrows?: 'start' | 'finish'
  stop?: 'throw' | 'reject'
  closeThrows?: boolean
  initialModals?: boolean
  fontGate?: boolean
}
interface ClipboardHostFixture {
  show(request: ClipboardRequest | null): void
  dispose(): void
  responses(): ClipboardResponse[]
  calls(): AdapterCall[]
  pending(): boolean[]
  closed(): number
  stopped(): number
  unhandled(): string[]
  parentEvents(): string[]
  settle(index: number, result?: ClipboardText | boolean, error?: string): void
  retain(): void
  useRetired(index: number): void
  isRetained(index: number): boolean
  openFont(): void
  fontResponses(): { id: number; face: string | null }[]
  fontStopped(): number
  textLimit(): number
}
declare global {
  interface Window {
    clipboardHost: ClipboardHostFixture
  }
}

let fixture: string, styles: string
test.beforeAll(async () => {
  styles = (
    await Promise.all(
      ['src/app/styles.css', 'src/app/game-clipboard.css'].map((path) =>
        readFile(resolve(path), 'utf8'),
      ),
    )
  ).join('\n')
  const entryId = 'virtual:clipboard-host-fixture',
    resolvedEntry = '\0clipboard-host-fixture',
    result = await build({
      configFile: false,
      publicDir: false,
      logLevel: 'error',
      plugins: [
        {
          name: 'clipboard-host-fixture',
          resolveId(id) {
            // Vite resolves library entries against root before plugin hooks.
            if (id === entryId || id === resolve(entryId)) return resolvedEntry
          },
          load(id) {
            if (id !== resolvedEntry) return
            return [
              `export { createGameClipboard } from ${JSON.stringify(resolve('src/app/game-clipboard.ts'))};`,
              `export { createGameFonts } from ${JSON.stringify(resolve('src/app/game-fonts.ts'))};`,
              `export { clipboardTextLimit } from ${JSON.stringify(resolve('src/engine/ports/clipboard.ts'))};`,
            ].join('\n')
          },
        },
      ],
      build: {
        write: false,
        minify: false,
        lib: {
          entry: entryId,
          formats: ['es'],
          fileName: () => 'clipboard.mjs',
        },
      },
    })
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      'output' in item ? item.output : [],
    ),
    entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing clipboard host bundle')
  fixture = entry.code
})

async function launch(page: Page, options: FixtureOptions = {}) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/clipboard-host/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/clipboard-host/'.length)
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>Clipboard component contract</title>
          <link rel="stylesheet" href="/clipboard-host/styles.css">
          <button id="origin">Original focus</button><button id="other">Other control</button>
          <dialog id="child" class="game-system-dialog"><form><button id="child-origin">Child action</button></form></dialog>
          <dialog id="parent" class="game-system-dialog"><form><button id="parent-origin">Parent action</button></form></dialog>`,
      })
    if (path === 'styles.css') return route.fulfill({ contentType: 'text/css', body: styles })
    return route.fulfill({ status: 404, body: `Missing ${path}` })
  })
  await page.route('**/src/app/game-clipboard.ts', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: fixture }),
  )
  await page.goto('/clipboard-host/index.html')
  await page.evaluate(async (options) => {
    const url = '/src/app/game-clipboard.ts',
      { createGameClipboard, createGameFonts, clipboardTextLimit } = (await import(
        url
      )) as typeof import('../../src/app/game-clipboard.ts') &
        typeof import('../../src/app/game-fonts.ts') &
        typeof import('../../src/engine/ports/clipboard.ts'),
      responses: ClipboardResponse[] = [],
      calls: AdapterCall[] = [],
      pending: boolean[] = [],
      unhandled: string[] = [],
      parentEvents: string[] = [],
      fontResponses: { id: number; face: string | null }[] = [],
      operations: { resolve(value: unknown): void; reject(reason: Error): void }[] = [],
      retained: HTMLElement[] = []
    let closed = 0,
      stopped = 0,
      fontStopped = 0
    window.addEventListener('unhandledrejection', (event) => {
      unhandled.push(String(event.reason))
      event.preventDefault()
    })
    for (const dialog of document.querySelectorAll<HTMLDialogElement>('dialog')) {
      dialog.addEventListener('cancel', (event) => {
        parentEvents.push(`${dialog.id}:cancel`)
        event.preventDefault()
      })
      dialog.addEventListener('keydown', (event) => parentEvents.push(`${dialog.id}:${event.key}`))
      dialog.querySelector('form')!.addEventListener('submit', (event) => {
        parentEvents.push(`${dialog.id}:submit`)
        event.preventDefault()
      })
    }
    if (options.initialModals) {
      // DOM order is deliberately opposite to actual modal admission order.
      document.querySelector<HTMLDialogElement>('#parent')!.showModal()
      document.querySelector<HTMLDialogElement>('#child')!.showModal()
    } else document.querySelector<HTMLButtonElement>('#origin')!.focus()
    const operation = <T>(call: AdapterCall) => {
      calls.push(call)
      return new Promise<T>((resolve, reject) => {
        operations.push({ resolve: (value) => resolve(value as T), reject })
      })
    }
    const adapter: ClipboardPort = {
      hasText: () => operation<boolean>({ op: 'has-text' }),
      readText: () => operation<ClipboardText>({ op: 'read-text' }),
      writeText: (text) => operation<void>({ op: 'write-text', text }),
      close() {
        closed++
        if (options.closeThrows) throw new Error('adapter close failed')
      },
    }
    const fonts = createGameFonts({
      choose(id, face) {
        fontResponses.push({ id, face })
        fonts.update(null)
        return Promise.resolve()
      },
      preview: () => Promise.resolve(null),
      system: () => Promise.resolve(),
      stop: () => {
        // Observe the component action without creating or stopping a session.
        fontStopped++
        return Promise.resolve()
      },
    })
    const host = createGameClipboard(
      {
        complete(response) {
          responses.push(response)
          if (options.complete === 'clear') host.show(null)
          else if (options.complete === 'dispose') host.dispose()
          else if (options.complete === 'throw') throw new Error('complete failed')
        },
        pending(active) {
          pending.push(active)
          if (options.fontGate) fonts.state(!active)
          if (
            (active && options.pendingThrows === 'start') ||
            (!active && options.pendingThrows === 'finish')
          )
            throw new Error(active ? 'pending start failed' : 'pending finish failed')
        },
        stop() {
          stopped++
          if (options.stop === 'throw') throw new Error('stop threw')
          if (options.stop === 'reject') return Promise.reject(new Error('stop rejected'))
        },
      },
      adapter,
    )
    window.clipboardHost = {
      ...host,
      responses: () => [...responses],
      calls: () => [...calls],
      pending: () => [...pending],
      closed: () => closed,
      stopped: () => stopped,
      unhandled: () => [...unhandled],
      parentEvents: () => [...parentEvents],
      settle(index, result, error) {
        const work = operations[index]
        if (!work) throw new Error(`Missing clipboard operation ${index}`)
        if (error === undefined) work.resolve(result)
        else work.reject(new Error(error))
      },
      retain() {
        const panel = document.querySelector<HTMLElement>('.game-clipboard')
        if (!panel) throw new Error('Missing clipboard panel')
        retained.push(panel)
      },
      useRetired(index) {
        const panel = retained[index]
        if (!panel) throw new Error(`Missing retired clipboard panel ${index}`)
        document.body.append(panel)
        for (const action of ['perform', 'cancel', 'stop'])
          panel.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)?.click()
        panel.remove()
      },
      isRetained(index) {
        return retained[index] === document.querySelector('.game-clipboard')
      },
      openFont() {
        fonts.update({
          id: 23,
          revision: 1,
          flags: 0,
          caption: 'Font host contract',
          prompt: 'Choose a font',
          sample: 'Example',
          font: {
            face: 'serif',
            height: 20,
            bold: false,
            italic: false,
            underline: false,
            strikeout: false,
            angle: 0,
          },
          choices: [
            { name: 'serif', source: 'generic' },
            { name: 'monospace', source: 'generic' },
          ],
        })
      },
      fontResponses: () => [...fontResponses],
      fontStopped: () => fontStopped,
      textLimit: () => clipboardTextLimit,
    }
  }, options)
  return errors
}

const request = (id: number): ClipboardRequest => ({ generation: 7, id, op: 'read-text' })
const panel = '.game-clipboard',
  perform = `${panel} [data-action="perform"]`,
  cancel = `${panel} [data-action="cancel"]`,
  close = `${panel} [data-action="close"]`,
  stop = `${panel} [data-action="stop"]`

async function expectClean(page: Page, errors: string[]) {
  expect(await page.evaluate(() => window.clipboardHost.unhandled())).toEqual([])
  expect(errors).toEqual([])
}

for (const { complete, outcome } of [
  { complete: 'clear', outcome: 'success' },
  { complete: 'clear', outcome: 'error' },
  { complete: 'dispose', outcome: 'error' },
] as const)
  test(`synchronous complete ${complete} retires a ${outcome} request and preserves only its allowed notice`, async ({
    page,
  }) => {
    const errors = await launch(page, { complete })
    await page.evaluate((request) => window.clipboardHost.show(request), request(1))
    if (outcome === 'success') {
      await page.locator(perform).click()
      await page.evaluate(() =>
        window.clipboardHost.settle(0, { hasText: true, text: 'delivered once🙂' }),
      )
    } else {
      await page.locator(cancel).focus()
      await page.keyboard.press('Enter')
    }
    if (complete === 'clear' && outcome === 'error') {
      // The relay clears the active request synchronously after every reply.
      // Its error remains visible, but none of the request actions stay live.
      await expect(page.locator(panel)).toHaveCount(1)
      await expect(page.locator(panel)).toHaveAttribute('data-state', 'error')
      await expect(page.locator(perform)).toHaveCount(0)
      await expect(page.locator(cancel)).toHaveCount(0)
      await expect(page.locator(stop)).toHaveCount(0)
      await expect(page.locator(close)).toBeVisible()
      expect(await page.evaluate(() => window.clipboardHost.pending())).toEqual([true, false])
      expect(await page.evaluate(() => window.clipboardHost.responses())).toHaveLength(1)
      await page.locator(close).click()
    }
    await expect(page.locator(panel)).toHaveCount(0)
    expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([
      outcome === 'success'
        ? {
            generation: 7,
            id: 1,
            ok: true,
            result: {
              op: 'read-text',
              content: { hasText: true, text: 'delivered once🙂' },
            },
          }
        : {
            generation: 7,
            id: 1,
            ok: false,
            error: {
              name: 'AbortError',
              message: 'Clipboard request cancelled by the user',
            },
          },
    ])
    expect(await page.evaluate(() => window.clipboardHost.pending())).toEqual([true, false])
    expect(await page.evaluate(() => window.clipboardHost.closed())).toBe(
      complete === 'dispose' ? 1 : 0,
    )
    await page.evaluate((request) => window.clipboardHost.show(request), request(2))
    await expect(page.locator(panel)).toHaveCount(complete === 'dispose' ? 0 : 1)
    expect(await page.evaluate(() => window.clipboardHost.responses())).toHaveLength(1)
    await expectClean(page, errors)
  })

for (const late of ['resolve', 'reject'] as const)
  test(`retired buttons and a late ${late} cannot complete or stop a replacement request`, async ({
    page,
  }) => {
    const errors = await launch(page)
    await page.evaluate((request) => {
      window.clipboardHost.show(request)
      window.clipboardHost.retain()
      window.clipboardHost.show({ ...request, id: 2 })
      window.clipboardHost.useRetired(0)
    }, request(1))
    expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([])
    await page.locator(perform).click()
    await page.evaluate((request) => {
      window.clipboardHost.retain()
      window.clipboardHost.show(request)
      window.clipboardHost.useRetired(1)
    }, request(3))
    await page.locator(perform).click()
    expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([
      { op: 'read-text' },
      { op: 'read-text' },
    ])
    await page.evaluate((late) => {
      window.clipboardHost.settle(
        0,
        { hasText: true, text: 'retired text' },
        late === 'reject' ? 'retired failure' : undefined,
      )
      window.clipboardHost.settle(1, { hasText: true, text: 'current text🙂' })
    }, late)
    await expect(page.locator(panel)).toHaveCount(0)
    expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([
      {
        generation: 7,
        id: 3,
        ok: true,
        result: { op: 'read-text', content: { hasText: true, text: 'current text🙂' } },
      },
    ])
    expect(await page.evaluate(() => window.clipboardHost.stopped())).toBe(0)
    expect(await page.evaluate(() => window.clipboardHost.closed())).toBe(0)
    await expectClean(page, errors)
  })

test('the same nonmodal panel follows the actual top dialog and survives parent removal', async ({
  page,
}) => {
  const errors = await launch(page, { initialModals: true })
  await page.evaluate((request) => {
    window.clipboardHost.show(request)
    window.clipboardHost.retain()
  }, request(1))
  await expect(page.locator('#child > .game-clipboard')).toBeVisible()
  await expect(page.locator('#child-origin')).toBeFocused()
  expect(await page.locator(panel).evaluate((node) => node.closest('form'))).toBeNull()
  expect(await page.locator('dialog:modal').count()).toBe(2)
  await page.locator(cancel).focus()
  await page.keyboard.press('Escape')
  await expect(page.locator(close)).toBeFocused()
  expect(await page.evaluate(() => window.clipboardHost.parentEvents())).toEqual([])
  expect(await page.locator('dialog:modal').count()).toBe(2)
  await page.evaluate(() => document.querySelector<HTMLDialogElement>('#child')!.close())
  await expect(page.locator('#parent > .game-clipboard')).toBeVisible()
  expect(await page.evaluate(() => window.clipboardHost.isRetained(0))).toBe(true)
  await page.evaluate(() => {
    const parent = document.querySelector<HTMLDialogElement>('#parent')!
    parent.close()
    parent.remove()
  })
  await expect(page.locator('body > .game-clipboard')).toBeVisible()
  expect(await page.evaluate(() => window.clipboardHost.isRetained(0))).toBe(true)
  await page.locator(close).click()
  await expect(page.locator(panel)).toHaveCount(0)
  expect(await page.evaluate(() => window.clipboardHost.responses())).toHaveLength(1)
  await expectClean(page, errors)
})

test('keyboard cancellation focuses its close action and closing restores the original control', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => window.clipboardHost.show(request), request(1))
  await expect(page.locator('#origin')).toBeFocused()
  await page.locator(cancel).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(close)).toBeFocused()
  await expect(page.locator(`${panel} .game-clipboard-status`)).toContainText('AbortError')
  await page.keyboard.press('Enter')
  await expect(page.locator(panel)).toHaveCount(0)
  await expect(page.locator('#origin')).toBeFocused()
  expect(await page.evaluate(() => window.clipboardHost.responses())).toHaveLength(1)
  expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([])
  await expectClean(page, errors)
})

test('a throwing complete callback leaves one dismissible notice without delivering twice', async ({
  page,
}) => {
  const errors = await launch(page, { complete: 'throw' })
  await page.evaluate((request) => window.clipboardHost.show(request), request(1))
  await page.locator(cancel).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(panel)).toHaveCount(1)
  await expect(page.locator(`${panel} .game-clipboard-status`)).toContainText('complete failed')
  await expect(page.locator(close)).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator(panel)).toHaveCount(0)
  expect(await page.evaluate(() => window.clipboardHost.responses())).toHaveLength(1)
  expect(await page.evaluate(() => window.clipboardHost.pending())).toEqual([true, false])
  await expectClean(page, errors)
})

test('a throwing pending-start callback settles the inaccessible request as a failure', async ({
  page,
}) => {
  const errors = await launch(page, { pendingThrows: 'start' })
  await page.evaluate((request) => window.clipboardHost.show(request), request(1))
  await expect(page.locator(close)).toBeVisible()
  expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([
    {
      generation: 7,
      id: 1,
      ok: false,
      error: { name: 'Error', message: 'pending start failed' },
    },
  ])
  expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([])
  expect(await page.evaluate(() => window.clipboardHost.pending())).toEqual([true, false])
  await page.locator(close).click()
  await expect(page.locator(panel)).toHaveCount(0)
  await expectClean(page, errors)
})

test('a throwing pending-finish callback preserves the API result and leaves a close-only notice', async ({
  page,
}) => {
  const errors = await launch(page, { pendingThrows: 'finish' })
  await page.evaluate((request) => window.clipboardHost.show(request), request(1))
  await page.locator(perform).focus()
  await page.keyboard.press('Enter')
  await expect(page.locator(cancel)).toBeFocused()
  await page.evaluate(() => window.clipboardHost.settle(0, { hasText: true, text: '' }))
  await expect(page.locator(close)).toBeVisible()
  await expect(page.locator(`${panel} .game-clipboard-status`)).toContainText(
    'pending finish failed',
  )
  expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([
    {
      generation: 7,
      id: 1,
      ok: true,
      result: { op: 'read-text', content: { hasText: true, text: '' } },
    },
  ])
  await page.locator(close).click()
  await expect(page.locator(panel)).toHaveCount(0)
  await expectClean(page, errors)
})

for (const stopFailure of ['throw', 'reject'] as const)
  test(`Stop ${stopFailure} leaves a fresh close-only notice and does not revive the request`, async ({
    page,
  }) => {
    const errors = await launch(page, { stop: stopFailure })
    await page.evaluate((request) => {
      window.clipboardHost.show(request)
      window.clipboardHost.retain()
    }, request(1))
    await page.locator(stop).click()
    await expect(page.locator(close)).toBeVisible()
    await expect(page.locator(`${panel} .game-clipboard-status`)).toContainText(
      stopFailure === 'throw' ? 'stop threw' : 'stop rejected',
    )
    expect(await page.evaluate(() => window.clipboardHost.stopped())).toBe(1)
    expect(await page.evaluate(() => window.clipboardHost.closed())).toBe(1)
    expect(await page.evaluate(() => window.clipboardHost.isRetained(0))).toBe(false)
    await page.evaluate((request) => {
      window.clipboardHost.useRetired(0)
      window.clipboardHost.show(request)
    }, request(2))
    await expect(page.locator(perform)).toHaveCount(0)
    await page.locator(close).click()
    await expect(page.locator(panel)).toHaveCount(0)
    expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([])
    expect(await page.evaluate(() => window.clipboardHost.stopped())).toBe(1)
    await expectClean(page, errors)
  })

test('an adapter close exception cannot prevent Stop or leave its rejected promise unobserved', async ({
  page,
}) => {
  const errors = await launch(page, { closeThrows: true, stop: 'reject' })
  await page.evaluate((request) => window.clipboardHost.show(request), request(1))
  await page.locator(stop).click()
  await expect(page.locator(close)).toBeVisible()
  expect(await page.evaluate(() => window.clipboardHost.closed())).toBe(1)
  expect(await page.evaluate(() => window.clipboardHost.stopped())).toBe(1)
  expect(await page.evaluate(() => window.clipboardHost.pending())).toEqual([true, false])
  await page.locator(close).click()
  await expect(page.locator(panel)).toHaveCount(0)
  expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([])
  await expectClean(page, errors)
})

test('a real font modal gates its own choices during clipboard access and resumes one confirmation', async ({
  page,
}) => {
  const errors = await launch(page, { fontGate: true, complete: 'clear' })
  await page.evaluate(() => window.clipboardHost.openFont())
  const fontDialog = page.getByRole('dialog', { name: 'Font host contract' }),
    rows = fontDialog.locator('.font-choice'),
    fontActions = fontDialog.locator('.font-actions'),
    fontConfirm = fontActions.getByRole('button', { name: '确定', exact: true }),
    fontCancel = fontActions.getByRole('button', { name: '取消', exact: true }),
    fontStop = fontActions.getByRole('button', { name: '停止游戏', exact: true })
  await expect(fontDialog).toBeVisible()
  expect(await fontDialog.evaluate((node) => node.matches(':modal'))).toBe(true)
  await expect(rows.first()).toBeFocused()
  await page.evaluate((request) => window.clipboardHost.show(request), request(1))
  await expect(page.locator('.game-font-dialog > .game-clipboard')).toBeVisible()
  await expect(rows).toHaveCount(2)
  await expect(rows.nth(0)).toBeDisabled()
  await expect(rows.nth(1)).toBeDisabled()
  await expect(fontConfirm).toBeDisabled()
  await expect(fontCancel).toBeDisabled()
  await expect(
    fontActions.getByRole('button', { name: '读取本机字体', exact: true }),
  ).toBeDisabled()
  await expect(fontStop).toBeEnabled()
  await expect(page.locator(perform)).toBeEnabled()
  await fontDialog.evaluate((dialog) => {
    // Disabled native controls and retained synthetic events must both honor
    // the font host gate. These are component events, not Clipboard API input.
    const row = dialog.querySelector<HTMLButtonElement>('.font-choice:last-child')!
    row.click()
    row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    for (const button of dialog.querySelectorAll<HTMLButtonElement>('.font-actions button'))
      if (button.textContent === '确定' || button.textContent === '取消') button.click()
    dialog.dispatchEvent(new Event('cancel', { cancelable: true }))
  })
  expect(await page.evaluate(() => window.clipboardHost.fontResponses())).toEqual([])
  await expect(rows.first()).toHaveAttribute('aria-selected', 'true')
  await fontStop.click()
  expect(await page.evaluate(() => window.clipboardHost.fontStopped())).toBe(1)
  await expect(fontDialog).toBeVisible()
  await page.locator(perform).click()
  await page.evaluate(() => window.clipboardHost.settle(0, { hasText: false }))
  await expect(page.locator(panel)).toHaveCount(0)
  await expect(rows.nth(0)).toBeEnabled()
  await expect(rows.nth(1)).toBeEnabled()
  await expect(fontConfirm).toBeEnabled()
  await expect(fontCancel).toBeEnabled()
  expect(await page.evaluate(() => window.clipboardHost.pending())).toEqual([true, false])
  expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([
    {
      generation: 7,
      id: 1,
      ok: true,
      result: { op: 'read-text', content: { hasText: false } },
    },
  ])
  expect(await page.evaluate(() => window.clipboardHost.fontResponses())).toEqual([])
  await rows.nth(1).click()
  await fontConfirm.click()
  await expect(fontDialog).toHaveCount(0)
  expect(await page.evaluate(() => window.clipboardHost.fontResponses())).toEqual([
    { id: 23, face: 'monospace' },
  ])
  await expectClean(page, errors)
})

test('write previews disclose their UTF-16 truncation while the adapter receives the complete text', async ({
  page,
}) => {
  const errors = await launch(page),
    text = '🙂'.repeat(1000) + '<b>省略的尾部文本</b>終'
  await page.evaluate(
    (text) => window.clipboardHost.show({ generation: 7, id: 1, op: 'write-text', text }),
    text,
  )
  const summary = page.locator(`${panel} summary`),
    note = page.locator(`${panel} .game-clipboard-preview-note`),
    preview = page.locator(`${panel} .game-clipboard-preview`)
  await expect(summary).toContainText(String(text.length))
  await expect(summary).toContainText('UTF-16')
  await summary.click()
  await expect(preview).toHaveText(text.slice(0, 2000))
  expect(await preview.evaluate((node) => node.textContent!.length)).toBe(2000)
  await expect(note).toContainText('2000')
  await expect(note).toContainText('完整')
  expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([])
  await page.locator(perform).click()
  expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([
    { op: 'write-text', text },
  ])
  await page.evaluate(() => window.clipboardHost.settle(0))
  await expect(page.locator(panel)).toHaveCount(0)
  expect(await page.evaluate(() => window.clipboardHost.responses())).toEqual([
    { generation: 7, id: 1, ok: true, result: { op: 'write-text' } },
  ])
  await expectClean(page, errors)
})

test('a write beyond the shared clipboard text limit fails explicitly without invoking the adapter', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(() => {
    const text = 'x'.repeat(window.clipboardHost.textLimit() + 1)
    window.clipboardHost.show({ generation: 7, id: 1, op: 'write-text', text })
  })
  await expect(page.locator(close)).toBeVisible()
  await expect(page.locator(perform)).toHaveCount(0)
  expect(await page.evaluate(() => window.clipboardHost.calls())).toEqual([])
  const responses = await page.evaluate(() => window.clipboardHost.responses())
  expect(responses).toHaveLength(1)
  expect(responses[0]).toMatchObject({
    generation: 7,
    id: 1,
    ok: false,
    error: { name: 'QuotaExceededError' },
  })
  await expect(page.locator(`${panel} .game-clipboard-status`)).toContainText('QuotaExceededError')
  await page.locator(close).click()
  await expect(page.locator(panel)).toHaveCount(0)
  await expectClean(page, errors)
})
