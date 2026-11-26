import { readdir, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { expect, test, type Page, type TestInfo } from '@playwright/test'

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
  const info = test.info(), topDirectory = basename(directory)
  const initial = await page.evaluate(() => ({ before: window.gameDirectoryInput.events.length,
      mode: document.querySelector<HTMLSelectElement>('#project-mode')?.value,
      executableDirectory: document.querySelector<HTMLInputElement>('#project-exe-directory')?.value,
      root: document.querySelector<HTMLInputElement>('#project-root')?.value })), before = initial.before,
    choosing = page.waitForEvent('filechooser', { timeout: 5000 })
  const [chooser] = await Promise.all([choosing, page.locator('#choose-folder').click({ timeout: 5000 })])
  expect(await chooser.element().getAttribute('id')).toBe('folder')
  expect(await chooser.element().getAttribute('webkitdirectory')).not.toBeNull()
  expect(chooser.isMultiple()).toBe(true)
  try { await chooser.setFiles(directory, { timeout: 15000 }) }
  catch (error) {
    if (info.project.name !== 'webkit' || !(error instanceof Error) || error.name !== 'TimeoutError') throw error
    // Frozen WebKit traces show native input/change and a running game while
    // Playwright's directory completion promise times out. Admit only that
    // already-completed real selection, independently of the transport wait.
    // Never repeat the selection, inject files/events, or suppress another error.
    try {
      // Callers retain this unchanged fixture directory until selection and
      // game assertions finish. Inspect it only for this exceptional proof;
      // ordinary successful selections do not gain a file-count restriction.
      const expected: DirectoryEvent['files'] = []
      const collect = async (relative = ''): Promise<void> => {
        for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
          const path = relative ? relative + '/' + item.name : item.name
          if (item.isDirectory()) await collect(path)
          else {
            if (!item.isFile()) throw new Error('Directory fixture must contain only regular files and directories')
            if (expected.length >= 128) throw new Error('Directory fixture exceeds the complete FileList observation bound')
            expected.push({ name: item.name, path: topDirectory + '/' + path, bytes: (await stat(join(directory, path))).size })
          }
        }
      }
      await collect()
      const state = await attachGameDirectoryInput(page, info, 'chooser-timeout-' + before),
        events = state.observation.events.slice(before), sorted = (files: DirectoryEvent['files']) =>
          [...files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
      expect(expected.length).toBeGreaterThan(0)
      expect(state.observation.dropped).toBe(0)
      expect(events.map((event) => event.type)).toEqual(['input', 'change'])
      for (const event of events) {
        expect(event.trusted).toBe(true)
        expect(event.count).toBe(expected.length)
        expect(sorted(event.files)).toEqual(sorted(expected))
        expect(event.mode).toBe(initial.mode)
        expect(event.executableDirectory).toBe(initial.executableDirectory)
        expect(event.root).toBe(initial.root)
      }
      expect(state.mode).toBe(initial.mode === 'collection' ? 'auto' : initial.mode)
      expect(state.executableDirectory).toBe(initial.executableDirectory)
      expect(state.root).toBe(initial.root)
      expect(state.currentFileCount).toBe(0)
      expect(state.status).toBe('运行中')
      expect(state.evaluateEnabled).toBe(true)
      expect(state.gameCanvases).toBeGreaterThan(0)
      expect(page.workers().filter((worker) => worker.url().includes('session.worker'))).toHaveLength(1)
      await info.attach('directory-upload-completed-after-transport-timeout-' + before, {
        contentType: 'application/json', body: JSON.stringify({
          transportError: { name: error.name, message: error.message, stack: error.stack }, initial,
          expected: sorted(expected), acknowledgement: 'Complete trusted FileList and change, consumed input, live game and Worker',
          scope: 'The original Playwright timeout is retained. Existing game-ready, pixels, root selection and save assertions still follow.',
        }, null, 2),
      })
    } catch (evidenceError) {
      throw new AggregateError([error, evidenceError], 'Directory selection completion was not independently established', { cause: error })
    }
  }
  return { before, topDirectory }
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
      status: document.querySelector('#status')?.textContent,
      evaluateEnabled: document.querySelector<HTMLButtonElement>('#evaluate')?.disabled === false,
      gameCanvases: document.querySelectorAll('.game-window canvas[data-window-id]').length,
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
