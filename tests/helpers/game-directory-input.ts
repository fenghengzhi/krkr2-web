import { basename } from 'node:path'
import { expect, type Page, type TestInfo } from '@playwright/test'

interface DirectoryEvent {
  type: string
  at: number
  trusted: boolean
  count: number
  files: { name: string; path: string; bytes: number }[]
  mode: string | undefined
  selectedIndex: number | undefined
  executableDirectory: string | undefined
  root: string | undefined
}
interface DirectoryObservation { events: DirectoryEvent[]; dropped: number }
declare global { interface Window { gameDirectoryInput: DirectoryObservation } }

/** Capture the browser's actual FileList before the application clears the
 * input. No files, input events or change handlers are replaced. */
export async function observeGameDirectoryInput(page: Page) {
  await page.addInitScript(() => {
    const observation: DirectoryObservation = { events: [], dropped: 0 }
    window.gameDirectoryInput = observation
    for (const type of ['input', 'change']) document.addEventListener(type, (event) => {
      const input = event.target
      if (!(input instanceof HTMLInputElement) || input.id !== 'folder') return
      if (observation.events.length >= 32) { observation.dropped++; return }
      const mode = document.querySelector<HTMLSelectElement>('#project-mode')
      observation.events.push({ type, at: performance.now(), trusted: event.isTrusted,
        count: input.files?.length ?? 0,
        files: [...(input.files ?? [])].slice(0, 128).map((file) => ({
          name: file.name, path: file.webkitRelativePath, bytes: file.size,
        })), mode: mode?.value, selectedIndex: mode?.selectedIndex,
        executableDirectory: document.querySelector<HTMLInputElement>('#project-exe-directory')?.value,
        root: document.querySelector<HTMLInputElement>('#project-root')?.value })
    }, true)
  })
}

export async function chooseGameDirectory(page: Page, directory: string) {
  const before = await page.evaluate(() => window.gameDirectoryInput.events.length),
    choosing = page.waitForEvent('filechooser', { timeout: 5000 })
  const [chooser] = await Promise.all([choosing, page.locator('#choose-folder').click({ timeout: 5000 })])
  expect(await chooser.element().getAttribute('id')).toBe('folder')
  expect(await chooser.element().getAttribute('webkitdirectory')).not.toBeNull()
  expect(chooser.isMultiple()).toBe(true)
  await chooser.setFiles(directory, { timeout: 15000 })
  return { before, topDirectory: basename(directory) }
}

export async function attachGameDirectoryInput(page: Page, info: TestInfo, phase: string) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const state = await Promise.race([page.evaluate(() => ({
      observation: window.gameDirectoryInput,
      mode: document.querySelector<HTMLSelectElement>('#project-mode')?.value,
      selectedIndex: document.querySelector<HTMLSelectElement>('#project-mode')?.selectedIndex,
      executableDirectory: document.querySelector<HTMLInputElement>('#project-exe-directory')?.value,
      root: document.querySelector<HTMLInputElement>('#project-root')?.value,
      currentFileCount: document.querySelector<HTMLInputElement>('#folder')?.files?.length,
    })), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Directory input evidence read timed out')), 3000)
    })])
    await info.attach('directory-input-' + phase, { contentType: 'application/json', body: JSON.stringify(state, null, 2) })
    return state
  } finally { clearTimeout(timer) }
}

/** Call after the existing game-ready barrier: early startup may legitimately
 * occupy the page thread, and diagnostics must not replace game readiness. */
export async function assertGameDirectoryInput(page: Page, info: TestInfo,
  selection: Awaited<ReturnType<typeof chooseGameDirectory>>, files: readonly { path: string; bytes: number }[],
  mode: 'auto' | 'root', phase: string) {
  const state = await attachGameDirectoryInput(page, info, phase),
    events = state.observation.events.slice(selection.before),
    expected = files.map((file) => ({ name: file.path.split('/').at(-1)!,
      path: selection.topDirectory + '/' + file.path, bytes: file.bytes }))
      .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  expect(state.observation.dropped).toBe(0)
  expect(events.map((event) => event.type)).toEqual(['input', 'change'])
  for (const event of events) {
    expect(event.mode).toBe(mode)
    expect(event.count).toBe(expected.length)
    expect([...event.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).toEqual(expected)
  }
  expect(state.mode).toBe(mode)
  expect(state.currentFileCount, 'The application consumed and cleared the real directory input').toBe(0)
}
