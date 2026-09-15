import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { WebVideoMixingCase } from '../helpers/web-video-mixing.ts'

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
        entry: resolve('tests/helpers/web-video-mixing.ts'),
        formats: ['es'],
        fileName: () => 'video-mixing-host.mjs',
      },
    },
  })
  const entry = (Array.isArray(result) ? result : [result])
    .flatMap((item) => ('output' in item ? item.output : []))
    .find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing video mixing host bundle')
  fixture = entry.code
})

for (const name of [
  'replacement',
  'budget',
  'surface-and-epoch',
  'non-mixer',
  'close-failure',
  'cancel-failure',
  'retire-failure',
  'shutdown-failure',
] as const satisfies readonly WebVideoMixingCase[])
  test(`browser video mixing ownership: ${name}`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/video-mixing-host.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Video mixing ownership</title>',
      }),
    )
    await page.route('**/video-mixing-host.mjs', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: fixture,
      }),
    )
    await page.route('**/video-mixing-host.mp4', (route) =>
      route.fulfill({
        contentType: 'video/mp4',
        body: readFileSync(new URL('../fixtures/video/colors.mp4', import.meta.url)),
      }),
    )
    await page.goto('/video-mixing-host.html')
    const result = await page.evaluate(async (name) => {
      const url = '/video-mixing-host.mjs'
      const module = (await import(url)) as typeof import('../helpers/web-video-mixing.ts')
      const bytes = new Uint8Array(await (await fetch('/video-mixing-host.mp4')).arrayBuffer())
      return module.exerciseWebVideoMixing(name, bytes)
    }, name)
    await test.info().attach('video-mixing-ownership', {
      body: Buffer.from(JSON.stringify(result)),
      contentType: 'application/json',
    })
    expect(errors).toEqual([])
    expect(result.audioCloses).toBe(result.connected)
    expect(result.revokedUrls).toBe(result.createdUrls)
    expect([
      result.pendingReplies,
      result.liveAudio,
      result.liveUrls,
      result.pendingFrames,
      result.mixingCanvases,
    ]).toEqual([0, 0, 0, 0, 0])
    expect(result.messages).toEqual([])
    if (name === 'budget') expect(result.evidence.limitBytes).toBe(64 * 1024 * 1024)
    if (name === 'replacement') expect(result.evidence.invalidReplacements).toBe(7)
    if (name.endsWith('-failure')) expect(result.evidence.cleanupError).toContain('mixing-remove')
  })
