import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { WebVideoWindowsCase } from '../helpers/web-video-windows.ts'

let fixture: string
test.beforeAll(async () => {
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve('tests/helpers/web-video-windows.ts'),
        formats: ['es'],
        fileName: () => 'video-windows.mjs',
      },
    },
  })
  const entry = (Array.isArray(result) ? result : [result])
    .flatMap((item) => ('output' in item ? item.output : []))
    .find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing video windows bundle')
  fixture = entry.code
})

for (const name of [
  'geometry-and-visibility',
  'close-isolation',
  'late-attachment',
  'detach-and-reattach',
  'stale-surfaces',
  'remove-during-first-frame',
  'remove-during-seek',
] as const satisfies readonly WebVideoWindowsCase[])
  test(`browser video window ownership: ${name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/video-windows.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Video windows</title>',
      }),
    )
    await page.route('**/video-windows.mjs', (route) =>
      route.fulfill({ contentType: 'text/javascript', body: fixture }),
    )
    await page.route('**/video-windows.mp4', (route) =>
      route.fulfill({
        contentType: 'video/mp4',
        body: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      }),
    )
    await page.goto('/video-windows.html')
    const result = await page.evaluate(async (name) => {
      const url = '/video-windows.mjs'
      const module = (await import(url)) as typeof import('../helpers/web-video-windows.ts')
      const bytes = new Uint8Array(await (await fetch('/video-windows.mp4')).arrayBuffer())
      return module.exerciseWebVideoWindows(name, bytes)
    }, name)
    await test.info().attach('video-window-ownership', {
      body: Buffer.from(JSON.stringify(result)),
      contentType: 'application/json',
    })
    expect(errors).toEqual([])
    expect(result.closedAudio.length).toBe(result.createdVideos)
    expect(new Set(result.closedAudio).size).toBe(result.createdVideos)
    expect(result.revokedUrls).toBe(result.createdUrls)
    expect([
      result.pendingReplies,
      result.liveAudio,
      result.liveUrls,
      result.pendingFrames,
    ]).toEqual([0, 0, 0, 0])
    expect(result.messages).toEqual([])
    expect(result.createdVideos).toBe(
      name === 'close-isolation'
        ? 3
        : ['geometry-and-visibility', 'remove-during-first-frame', 'remove-during-seek'].includes(
              name,
            )
          ? 2
          : 1,
    )
    if (name === 'remove-during-first-frame') expect(result.cancelledHeldFrames).toBe(1)
  })
