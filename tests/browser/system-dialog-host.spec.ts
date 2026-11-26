import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { SystemDialogRequest } from '../../src/engine/ports/system-dialogs.ts'

type DialogAction = { kind: 'choose'; id: number; value: string | null } | { kind: 'stop' }
  | { kind: 'openFile'; id: number; filterIndex: number; filename: string; size: number }
interface SystemDialogHost {
  update(request: SystemDialogRequest | null, pendingIds: number[]): void
  state(active: boolean): void
  dispose(): void
  actions(): DialogAction[]
  settle(index: number, error?: string, accepted?: boolean): void
  focusChanges(): string[]
  clearFocusChanges(): void
  gameKeys(): string[]
  retain(): void
  useRetired(): void
}
declare global {
  interface Window {
    systemDialogHost: SystemDialogHost
  }
}

let fixture: string, styles: string
test.beforeAll(async () => {
  styles = await readFile(resolve('src/app/styles.css'), 'utf8')
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve('src/app/game-dialogs.ts'),
        formats: ['es'],
        fileName: () => 'dialogs.mjs',
      },
    },
  })
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      'output' in item ? item.output : [],
    ),
    entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing system dialog host bundle')
  fixture = entry.code
})

async function launch(page: Page) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/system-dialog-host/**', (route) => {
    const path = new URL(route.request().url()).pathname.slice('/system-dialog-host/'.length)
    if (path === 'index.html')
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><meta charset="utf-8"><title>System dialog host</title>
          <link rel="stylesheet" href="/system-dialog-host/styles.css">
          <div id="origin-parent"><button id="origin">Original focus</button></div>
          <button id="child-window">Child Window</button>`,
      })
    if (path === 'styles.css') return route.fulfill({ contentType: 'text/css', body: styles })
    if (path === 'dialogs.mjs')
      return route.fulfill({ contentType: 'text/javascript', body: fixture })
    return route.fulfill({ status: 404, body: `Missing ${path}` })
  })
  await page.goto('/system-dialog-host/index.html')
  await page.evaluate(async () => {
    const url = '/system-dialog-host/dialogs.mjs',
      { createGameDialogs } = (await import(url)) as typeof import('../../src/app/game-dialogs.ts'),
      actions: DialogAction[] = [],
      pending: { resolve(accepted?: boolean): void; reject(error: Error): void }[] = [],
      focusChanges: string[] = [],
      gameKeys: string[] = []
    let retired: HTMLDialogElement | null = null
    const operation = () =>
      new Promise<boolean | undefined>((resolve, reject) => pending.push({ resolve, reject }))
    const host = createGameDialogs({
      choose(id, value) {
        actions.push({ kind: 'choose', id, value })
        return operation()
      },
      openFile(id, filterIndex, file) {
        actions.push({ kind: 'openFile', id, filterIndex, filename: file.name, size: file.size })
        return operation().then(accepted => accepted !== false)
      },
      stop() {
        actions.push({ kind: 'stop' })
        return operation().then(() => {})
      },
    })
    document.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement) focusChanges.push(event.target.id)
    })
    window.addEventListener('keydown', (event) => gameKeys.push(event.key))
    window.systemDialogHost = {
      ...host,
      actions: () => [...actions],
      settle(index, error, accepted) {
        const item = pending[index]
        if (!item) throw new Error(`Missing operation ${index}`)
        if (error === undefined) item.resolve(accepted)
        else item.reject(new Error(error))
      },
      focusChanges: () => [...focusChanges],
      clearFocusChanges: () => {
        focusChanges.length = 0
      },
      gameKeys: () => [...gameKeys],
      retain() {
        retired = document.querySelector<HTMLDialogElement>('.game-system-dialog')
      },
      useRetired() {
        if (!retired) throw new Error('Missing retired dialog')
        document.body.append(retired)
        retired.querySelector<HTMLFormElement>('form')!.requestSubmit()
        retired.dispatchEvent(new Event('cancel', { cancelable: true }))
        retired.querySelector<HTMLButtonElement>('[data-action="stop"]')!.click()
        retired.remove()
      },
    }
  })
  await page.locator('#origin').focus()
  return errors
}

const request = (
  id: number,
  kind: 'inform' | 'input-string' = 'input-string',
): SystemDialogRequest => ({
  id,
  kind,
  caption: `Dialog ${id}`,
  text: `Prompt ${id}`,
  value: '初始値🙂',
})
const dialog = '.game-system-dialog',
  input = `${dialog} input`,
  confirm = `${dialog} [data-action="confirm"]`,
  cancel = `${dialog} [data-action="cancel"]`,
  stop = `${dialog} [data-action="stop"]`

test('inform uses a native modal with literal text, keyboard focus and one pending response', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => window.systemDialogHost.update(request, [request.id]), {
    ...request(1, 'inform'),
    caption: '<script>标题</script>',
    text: '<img src=x onerror=alert(1)>\n下一行',
  })
  await expect(page.getByRole('dialog', { name: '<script>标题</script>' })).toBeVisible()
  await expect(page.locator(`${dialog} p`).first()).toHaveText(
    '<img src=x onerror=alert(1)>\n下一行',
  )
  await expect(page.locator(`${dialog} img, ${dialog} script`)).toHaveCount(0)
  expect(await page.locator(dialog).evaluate((node) => node.matches(':modal'))).toBe(true)
  await expect(page.locator(confirm)).toBeFocused()
  await page.locator('#origin').evaluate((node: HTMLElement) => node.focus())
  await expect(page.locator(confirm)).toBeFocused()
  await page.keyboard.press('Enter')
  await page.keyboard.press('Escape')
  await expect(page.locator(confirm)).toBeDisabled()
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 1, value: '' },
  ])
  expect(await page.evaluate(() => window.systemDialogHost.gameKeys())).toEqual([])
  await page.evaluate(() => window.systemDialogHost.settle(0))
  await expect(page.locator(dialog)).toBeVisible()
  await expect(page.locator(confirm)).toBeDisabled()
  await page.evaluate(() => window.systemDialogHost.update(null, []))
  await expect(page.locator(dialog)).toHaveCount(0)
  await expect(page.locator('#origin')).toBeFocused()
  expect(errors).toEqual([])
})

test('a ready response hides before retirement and restores focus only if no child claimed it', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => window.systemDialogHost.update(request, [16]), request(16))
  await page.locator(confirm).click()
  await page.evaluate(() => {
    window.systemDialogHost.update(null, [16])
    window.systemDialogHost.settle(0)
  })
  await expect(page.locator(dialog)).toHaveCount(0)
  await expect(page.locator('#origin')).not.toBeFocused()
  await page.evaluate(() => window.systemDialogHost.update(null, []))
  await expect(page.locator('#origin')).toBeFocused()

  await page.evaluate((request) => window.systemDialogHost.update(request, [17]), request(17))
  await page.locator(confirm).click()
  await page.evaluate(() => {
    window.systemDialogHost.update(null, [17])
    window.systemDialogHost.settle(1)
    document.querySelector<HTMLButtonElement>('#child-window')!.focus()
  })
  await page.evaluate(() => window.systemDialogHost.update(null, []))
  await expect(page.locator('#child-window')).toBeFocused()
  expect(errors).toEqual([])
})

test('inputString retains Unicode and distinguishes empty confirmation from Escape cancellation', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(
    (request) => window.systemDialogHost.update(request, [request.id]),
    request(2),
  )
  await expect(page.getByLabel('输入内容', { exact: true })).toHaveValue('初始値🙂')
  await page.locator(input).fill('')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 2, value: '' },
  ])
  await page.evaluate(
    (request) => {
      window.systemDialogHost.settle(0)
      window.systemDialogHost.update(null, [])
      window.systemDialogHost.update(request, [request.id])
    },
    { ...request(3), caption: '' },
  )
  await expect(page.getByRole('dialog', { name: '输入文字' })).toBeVisible()
  await expect(page.locator(`${dialog} h2`)).toHaveText('')
  await page.locator(input).fill('取消前の入力🙂')
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 2, value: '' },
    { kind: 'choose', id: 3, value: null },
  ])
  await page.evaluate(() => {
    window.systemDialogHost.settle(1)
    window.systemDialogHost.dispose()
  })
  expect(errors).toEqual([])
})

test('IME composition and legacy keyCode 229 do not submit or cancel the dialog', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(
    (request) => window.systemDialogHost.update(request, [request.id]),
    request(4),
  )
  await page.locator(input).evaluate((node: HTMLInputElement) => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true }),
    )
    node.form!.requestSubmit()
    node.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true }),
    )
    node.closest('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }))
    node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true }))
    node.form!.requestSubmit()
    node.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }))
  })
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([])
  await page.locator(input).fill('確定した文字🙂')
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 4, value: '確定した文字🙂' },
  ])
  await page.evaluate(() => {
    window.systemDialogHost.settle(0)
    window.systemDialogHost.dispose()
  })
  expect(errors).toEqual([])
})

test('a child request and temporary Window coverage retain the parent input, selection and focus', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate(
    (request) => window.systemDialogHost.update(request, [request.id]),
    request(5),
  )
  await page.locator(input).fill('親の編集🙂を保つ')
  await page
    .locator(input)
    .evaluate((node: HTMLInputElement) => node.setSelectionRange(1, 4, 'backward'))
  await page.evaluate(
    (request) => {
      window.systemDialogHost.clearFocusChanges()
      window.systemDialogHost.update(request, [5, 6])
    },
    request(6, 'inform'),
  )
  await expect(page.locator(dialog)).toHaveCount(1)
  expect(await page.evaluate(() => window.systemDialogHost.focusChanges())).not.toContain('origin')
  await page.locator(confirm).click()
  await page.evaluate((request) => {
    window.systemDialogHost.settle(0)
    window.systemDialogHost.update(request, [5])
  }, request(5))
  await expect(page.locator(input)).toHaveValue('親の編集🙂を保つ')
  await expect(page.locator(input)).toBeFocused()
  expect(
    await page
      .locator(input)
      .evaluate((node: HTMLInputElement) => [
        node.selectionStart,
        node.selectionEnd,
        node.selectionDirection,
      ]),
  ).toEqual([1, 4, 'backward'])
  await page.evaluate(() => {
    window.systemDialogHost.clearFocusChanges()
    window.systemDialogHost.update(null, [5])
    document.querySelector<HTMLButtonElement>('#child-window')!.focus()
  })
  await expect(page.locator(dialog)).toHaveCount(0)
  await expect(page.locator('#child-window')).toBeFocused()
  expect(await page.evaluate(() => window.systemDialogHost.focusChanges())).not.toContain('origin')
  await page.evaluate((request) => window.systemDialogHost.update(request, [5]), request(5))
  await expect(page.locator(input)).toHaveValue('親の編集🙂を保つ')
  await expect(page.locator(input)).toBeFocused()
  await page.evaluate(() => {
    window.systemDialogHost.update(null, [5])
    document.querySelector<HTMLButtonElement>('#child-window')!.focus()
    window.systemDialogHost.update(null, [])
  })
  await expect(page.locator('#child-window')).toBeFocused()
  expect(errors).toEqual([])
})

test('retired DOM and a rejected old receipt cannot act on a replacement request', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => window.systemDialogHost.update(request, [7]), request(7))
  await page.evaluate(() => window.systemDialogHost.retain())
  await page.locator(confirm).click()
  await page.evaluate((request) => {
    window.systemDialogHost.update(request, [8])
    window.systemDialogHost.useRetired()
    window.systemDialogHost.settle(0, 'old receipt failed')
  }, request(8))
  await expect(page.locator(input)).toHaveValue('初始値🙂')
  await expect(page.locator(confirm)).toBeEnabled()
  await expect(page.locator(`${dialog} [role="status"]`)).toBeEmpty()
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 7, value: '初始値🙂' },
  ])
  await page.locator(cancel).click()
  await page.evaluate((request) => {
    window.systemDialogHost.dispose()
    window.systemDialogHost.settle(1, 'disposed receipt failed')
    window.systemDialogHost.update(request, [9])
  }, request(9))
  await expect(page.locator(dialog)).toHaveCount(0)
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toHaveLength(2)
  expect(errors).toEqual([])
})

test('a failed receipt can retry while a settled live receipt remains single use across coverage', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => window.systemDialogHost.update(request, [10]), request(10))
  await page.locator(confirm).click()
  await page.evaluate(() => window.systemDialogHost.settle(0, 'Try again'))
  await expect(page.locator(`${dialog} [role="status"]`)).toHaveText('Try again')
  await expect(page.locator(confirm)).toBeEnabled()
  await page.locator(input).fill('retry🙂')
  await page.keyboard.press('Enter')
  await page.evaluate((request) => {
    window.systemDialogHost.settle(1)
    window.systemDialogHost.update(null, [10])
    window.systemDialogHost.update(request, [10])
  }, request(10))
  await expect(page.locator(input)).toHaveValue('retry🙂')
  await expect(page.locator(confirm)).toBeDisabled()
  await expect(page.locator(cancel)).toBeDisabled()
  await page.keyboard.press('Escape')
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 10, value: '初始値🙂' },
    { kind: 'choose', id: 10, value: 'retry🙂' },
  ])
  await page.evaluate(() => window.systemDialogHost.dispose())
  expect(errors).toEqual([])
})

test('an ignored response can retry after a child scope without touching the child focus or status', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => window.systemDialogHost.update(request, [13]), request(13))
  await page.locator(input).fill('parent retry🙂')
  await page.locator(confirm).click()
  await page.evaluate(
    (request) => {
      window.systemDialogHost.update(request, [13, 14])
      window.systemDialogHost.settle(0, undefined, false)
    },
    request(14, 'inform'),
  )
  await expect(page.locator(confirm)).toBeFocused()
  await expect(page.locator(`${dialog} [role="status"]`)).toBeEmpty()
  await page.evaluate((request) => window.systemDialogHost.update(request, [13]), request(13))
  await expect(page.locator(input)).toHaveValue('parent retry🙂')
  await expect(page.locator(confirm)).toBeEnabled()
  await expect(page.locator(`${dialog} [role="status"]`)).toBeEmpty()
  await page.locator(confirm).click()
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([
    { kind: 'choose', id: 13, value: 'parent retry🙂' },
    { kind: 'choose', id: 13, value: 'parent retry🙂' },
  ])
  await page.evaluate(() => {
    window.systemDialogHost.settle(1)
    window.systemDialogHost.dispose()
  })
  expect(errors).toEqual([])
})

test('inactive dialogs keep Stop available, report a failed Stop and ignore duplicate requests', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => {
    window.systemDialogHost.update(request, [11])
    window.systemDialogHost.state(false)
  }, request(11))
  await expect(page.locator(confirm)).toBeDisabled()
  await expect(page.locator(cancel)).toBeDisabled()
  await expect(page.locator(input)).toHaveAttribute('readonly', '')
  await page.keyboard.press('Escape')
  await page.locator(input).evaluate((node: HTMLInputElement) => node.form!.requestSubmit())
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([])
  await page.locator(stop).click()
  await expect(page.locator(stop)).toBeDisabled()
  await page.locator(stop).dispatchEvent('click')
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([{ kind: 'stop' }])
  await page.evaluate(() => window.systemDialogHost.settle(0, 'Stop failed'))
  await expect(page.locator(`${dialog} [role="status"]`)).toHaveText('Stop failed')
  await expect(page.locator(stop)).toBeEnabled()
  await expect(page.locator(confirm)).toBeDisabled()
  await page.evaluate(() => window.systemDialogHost.state(true))
  await expect(page.locator(confirm)).toBeEnabled()
  await page.locator(stop).click()
  await page.evaluate(() => {
    window.systemDialogHost.dispose()
    window.systemDialogHost.settle(1)
  })
  await expect(page.locator(dialog)).toHaveCount(0)
  expect(errors).toEqual([])
})

test('a device picker resumes once after a pause but discards files when another dialog takes over', async ({ page }) => {
  const errors = await launch(page), expected: DialogAction[] = []
  const selector = (id: number): SystemDialogRequest => ({
    id, kind: 'storage-selector', caption: `Open bookmark ${id}`, text: 'Choose a game bookmark', value: '',
    selector: { save: false, name: '', initialDirectory: 'game://./savedata/', defaultExtension: 'kdt',
      filters: [{ label: 'Bookmark', pattern: '*.kdt' }, { label: 'All files', pattern: '*.*' }],
      filterIndex: 1, entries: [], directories: ['game://./savedata/'] },
  })
  const show = (value: SystemDialogRequest, ids = [value.id]) =>
    page.evaluate(({ value, ids }) => window.systemDialogHost.update(value, ids), { value, ids })
  const openPicker = async () => {
    const chooser = page.waitForEvent('filechooser')
    await page.getByRole('button', { name: '从设备打开文件…', exact: true }).click()
    return chooser
  }
  const assertActions = () => expect.poll(() => page.evaluate(() => window.systemDialogHost.actions())).toEqual(expected)
  await show(selector(20))
  await page.getByLabel('文件类型', { exact: true }).selectOption('2')
  const first = await openPicker()
  await page.evaluate(() => window.systemDialogHost.state(false))
  await first.setFiles({ name: '旅のしおり', mimeType: 'application/octet-stream', buffer: Buffer.from([1, 2, 3, 4]) })
  expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual([])
  await expect(page.locator(confirm)).toBeDisabled()
  await page.evaluate(() => window.systemDialogHost.state(true))
  expected.push({ kind: 'openFile', id: 20, filterIndex: 2, filename: '旅のしおり', size: 4 })
  await assertActions()
  // Repeated activation notifications and the eventual transport receipt
  // cannot submit the same OS selection a second time.
  await page.evaluate(() => {
    window.systemDialogHost.state(false); window.systemDialogHost.state(true)
    window.systemDialogHost.state(true); window.systemDialogHost.settle(0, undefined, true)
  })
  await expect(page.locator(confirm)).toBeDisabled(); await assertActions()
  await page.evaluate(() => window.systemDialogHost.update(null, []))

  for (const [id, retained] of [[21, true], [23, false]] as const) {
    const parent = selector(id), child = request(id + 1, 'inform')
    await show(parent)
    const late = await openPicker()
    await page.evaluate(() => window.systemDialogHost.state(false))
    await late.setFiles({ name: 'old-selection.kdt', mimeType: 'application/octet-stream', buffer: Buffer.from([9, 9]) })
    expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual(expected)
    // Cover the retained parent, or retire it completely while paused.
    await show(child, retained ? [id, child.id] : [child.id])
    await page.evaluate(() => window.systemDialogHost.state(true))
    await expect(page.getByRole('dialog', { name: child.caption, exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual(expected)
    await page.locator(confirm).click()
    expected.push({ kind: 'choose', id: child.id, value: '' })
    await assertActions()
    await page.evaluate(index => window.systemDialogHost.settle(index), expected.length - 1)
    const next = retained ? parent : selector(id + 100)
    await show(next)
    await page.evaluate(() => { window.systemDialogHost.state(false); window.systemDialogHost.state(true) })
    await expect(page.getByRole('button', { name: '从设备打开文件…', exact: true })).toBeEnabled()
    expect(await page.evaluate(() => window.systemDialogHost.actions())).toEqual(expected)
    // A fresh user selection still works after the obsolete file was retired.
    const fresh = await openPicker()
    await fresh.setFiles({ name: 'current.kdt', mimeType: 'application/octet-stream', buffer: Buffer.from([7]) })
    expected.push({ kind: 'openFile', id: next.id, filterIndex: 1, filename: 'current.kdt', size: 1 })
    await assertActions()
    await page.evaluate(index => {
      window.systemDialogHost.settle(index, undefined, true)
      window.systemDialogHost.update(null, [])
    }, expected.length - 1)
  }
  await page.evaluate(() => window.systemDialogHost.dispose())
  expect(errors).toEqual([])
})

test('disposing a covered system dialog does not steal focus from a newer native modal', async ({
  page,
}) => {
  const errors = await launch(page)
  await page.evaluate((request) => {
    window.systemDialogHost.update(request, [15])
    const newer = document.createElement('dialog'),
      input = document.createElement('input')
    newer.id = 'font-dialog'
    input.id = 'font-input'
    newer.append(input)
    document.body.append(newer)
    newer.showModal()
    input.focus()
    window.systemDialogHost.state(false)
    window.systemDialogHost.clearFocusChanges()
    window.systemDialogHost.dispose()
  }, request(15))
  await expect(page.locator('#font-input')).toBeFocused()
  await expect(page.locator(dialog)).toHaveCount(0)
  expect(await page.evaluate(() => window.systemDialogHost.focusChanges())).not.toContain('origin')
  await page.evaluate(() => {
    const newer = document.querySelector<HTMLDialogElement>('#font-dialog')!
    newer.close()
    newer.remove()
  })
  expect(errors).toEqual([])
})

for (const unavailable of ['inert', 'hidden', 'disabled', 'disconnected'] as const)
  test(`retiring a dialog cannot restore an ${unavailable} focus origin`, async ({ page }) => {
    const errors = await launch(page)
    await page.evaluate(
      (request) => window.systemDialogHost.update(request, [12]),
      request(12, 'inform'),
    )
    await page.evaluate((unavailable) => {
      const origin = document.querySelector<HTMLButtonElement>('#origin')!,
        parent = document.querySelector<HTMLElement>('#origin-parent')!
      if (unavailable === 'inert') parent.inert = true
      else if (unavailable === 'hidden') parent.hidden = true
      else if (unavailable === 'disabled') origin.disabled = true
      else origin.remove()
      window.systemDialogHost.clearFocusChanges()
      window.systemDialogHost.update(null, [])
    }, unavailable)
    expect(await page.evaluate(() => window.systemDialogHost.focusChanges())).not.toContain(
      'origin',
    )
    await expect(page.locator(dialog)).toHaveCount(0)
    expect(errors).toEqual([])
  })
