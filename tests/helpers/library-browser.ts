import { test as base, expect, type Page } from '@playwright/test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// WebKit's ephemeral contexts expose getDirectory() but reject access. Exercise actual
// disk persistence in isolated disposable profiles; failure-mode tests keep default contexts.
export const test = base.extend<{ libraryProfile: string }>({
  libraryProfile: async ({}, use) => {
    const path = await mkdtemp(join(tmpdir(), 'krkr-library-test-'))
    try {
      await use(path)
    } finally {
      await rm(path, { recursive: true, force: true })
    }
  },
  context: [
    async ({ playwright, browserName, baseURL, libraryProfile }, use, testInfo) => {
      const started = performance.now(),
        context = await playwright[browserName].launchPersistentContext(libraryProfile, {
          headless: true,
          baseURL,
          viewport: { width: 1280, height: 720 },
        })
      try {
        const path = testInfo.outputPath('persistent-context.json')
        await writeFile(
          path,
          JSON.stringify(
            {
              browser: browserName,
              test: testInfo.title,
              setupMs: performance.now() - started,
              fixtureTimeoutMs: 30000,
              testTimeoutMs: testInfo.timeout,
            },
            null,
            2,
          ) + '\n',
        )
        await testInfo.attach('persistent-context', { path, contentType: 'application/json' })
        await use(context)
      } finally {
        await context.close()
      }
    },
    // Browser/profile preparation has its own bound; each scenario still has
    // the unchanged 30-second budget after the fixture is ready.
    { scope: 'test', timeout: 30000 },
  ],
  page: async ({ context }, use) => {
    // Persistent launch already owns a page. Use it instead of leaving an idle
    // initial tab beside the test's page and changing foreground scheduling.
    await use(context.pages()[0] ?? (await context.newPage()))
  },
})
export { expect }
export async function libraryDirectories(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory()
    try {
      const folder = (await root.getDirectoryHandle(
        'krkr2-library-v1',
      )) as FileSystemDirectoryHandle & { keys(): AsyncIterableIterator<string> }
      const names: string[] = []
      for await (const name of folder.keys()) names.push(name)
      return names.sort()
    } catch (error) {
      if (error instanceof DOMException && error.name === 'NotFoundError') return []
      throw error
    }
  })
}
export async function injectLibraryWorker(page: Page, source: string): Promise<void> {
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      constructor(input: string | URL, options?: WorkerOptions) {
        const url = new URL(input, location.href)
        if (url.pathname.includes('/assets/library.worker-'))
          url.searchParams.set('test-worker', crypto.randomUUID())
        super(url, options)
      }
    }
  })
  await page.route('**/assets/library.worker-*.js*', async (route) => {
    const response = await route.fetch()
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'cache-control': 'no-store' },
      body: source + '\n' + (await response.text()),
    })
  })
}
