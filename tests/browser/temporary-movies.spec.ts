import { readFile } from 'node:fs/promises'
import { test, expect } from '@playwright/test'
import { transformWithOxc } from 'vite'

test.use({ serviceWorkers: 'block' })
test('temporary movie storage keeps a live movie through recovery and removes cancelled, failed and abandoned copies', async ({ page }) => {
  const entry = 'tests/helpers/temporary-movie-worker.ts'
  const modules = new Set([entry, 'src/backends/files/temporary-movies.ts', 'src/engine/scheduler/control.ts'])
  await page.context().route('**/__movie-test/**', async (route) => {
    const path = new URL(route.request().url()).pathname.slice('/__movie-test/'.length)
    if (!modules.has(path)) return route.fulfill({ status: 404 })
    const compiled = await transformWithOxc(await readFile(path, 'utf8'), path)
    await route.fulfill({ contentType: 'text/javascript', body: compiled.code })
  })
  await page.goto('/')
  const result = await page.evaluate(async (entry) => {
    const worker = new Worker('/__movie-test/' + entry, { type: 'module' })
    try {
      return await new Promise((resolve, reject) => {
        worker.onmessage = ({ data }) => resolve(data)
        worker.onerror = (event) => reject(new Error(event.message || 'Temporary movie worker failed'))
        worker.postMessage('start')
      })
    } finally { worker.terminate() }
  }, entry)
  expect(result).toEqual({ live: true, orphan: false, count: 3, preserved: [7, 23, 199],
    shortRead: expect.stringContaining('invalid range'), cancellation: 'AbortError', afterCancellation: ['unrelated'] })
})
