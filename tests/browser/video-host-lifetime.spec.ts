import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { WebVideoLifetimeCase } from '../helpers/web-video-lifetime.ts'

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
        entry: resolve('tests/helpers/web-video-lifetime.ts'),
        formats: ['es'],
        fileName: () => 'video-host-lifetime.mjs',
      },
    },
  })
  const entry = (Array.isArray(result) ? result : [result])
    .flatMap((item) => ('output' in item ? item.output : []))
    .find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing video lifetime bundle')
  fixture = entry.code
})

for (const name of [
  'creation-after-audio',
  'insertion-after-registration',
  'close-first-frame',
  'supersede-first-frame',
  'shutdown-failure',
  'cancel-failure',
] as const satisfies readonly WebVideoLifetimeCase[])
  test(`browser video resources: ${name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/video-host-lifetime.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Video lifetime</title>',
      }),
    )
    await page.route('**/video-host-lifetime.mjs', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: fixture,
      }),
    )
    await page.route('**/video-host-lifetime.mp4', (route) =>
      route.fulfill({
        contentType: 'video/mp4',
        body: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      }),
    )
    await page.goto('/video-host-lifetime.html')
    const result = await page.evaluate(async (name) => {
      const url = '/video-host-lifetime.mjs'
      const module = (await import(url)) as typeof import('../helpers/web-video-lifetime.ts')
      const bytes = new Uint8Array(await (await fetch('/video-host-lifetime.mp4')).arrayBuffer())
      return module.exerciseWebVideoLifetime(name, bytes)
    }, name)
    await test.info().attach('video-host-ownership', {
      body: Buffer.from(JSON.stringify(result)),
      contentType: 'application/json',
    })
    expect(errors).toEqual([])
    expect(result.audioCloses).toBe(result.connected)
    expect(result.revokedUrls).toBe(result.createdUrls)
    expect(result.connected).toBe(
      ['shutdown-failure', 'supersede-first-frame', 'cancel-failure'].includes(name) ? 2 : 1,
    )
    expect(result.observerCloses).toBe(1)
    expect([
      result.pendingReplies,
      result.liveAudio,
      result.liveUrls,
      result.pendingFrames,
      result.videos,
    ]).toEqual([0, 0, 0, 0, 0])
    expect(result.messages).toEqual([])
    if (name === 'cancel-failure') {
      expect(result.cancelledResources).toMatchObject({ audio: 0, urls: 0, frames: 0, videos: 0 })
      expect(result.cancelledResources?.error).toContain('video-audio-close')
    }
  })
