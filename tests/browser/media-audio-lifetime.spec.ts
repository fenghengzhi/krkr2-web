import { test, expect } from '@playwright/test'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { MediaAudioFault } from '../helpers/media-audio-lifetime.ts'

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
        entry: resolve('tests/helpers/media-audio-lifetime.ts'),
        formats: ['es'],
        fileName: () => 'media-audio-lifetime.mjs',
      },
    },
  })
  const entry = (Array.isArray(result) ? result : [result])
    .flatMap((item) => ('output' in item ? item.output : []))
    .find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing media audio lifetime bundle')
  fixture = entry.code
})

for (const fault of [
  'create',
  'connect',
  'disconnect',
] as const satisfies readonly MediaAudioFault[])
  test(`video audio graph cleans every ${fault} failure boundary`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/media-audio-lifetime.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><title>Media audio lifetime</title>',
      }),
    )
    await page.route('**/media-audio-lifetime.mjs', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: fixture,
      }),
    )
    await page.goto('/media-audio-lifetime.html')
    const result = await page.evaluate(async (fault) => {
      const url = '/media-audio-lifetime.mjs'
      const module = (await import(url)) as typeof import('../helpers/media-audio-lifetime.ts')
      return module.exerciseMediaAudioLifetime(fault)
    }, fault)
    await test
      .info()
      .attach('media-audio-ownership', {
        body: Buffer.from(JSON.stringify(result)),
        contentType: 'application/json',
      })
    expect(errors).toEqual([])
    expect(result.results.length).toBeGreaterThanOrEqual(7)
    for (const row of [result.control, ...result.results]) {
      expect(row.contextCloses).toBe(1)
      expect(row.intervals).toBe(0)
      expect(row.nodes.every((node) => node.disconnects === 1 && node.connections === 0)).toBe(true)
    }
  })
