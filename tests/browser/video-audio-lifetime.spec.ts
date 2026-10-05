import { test, expect } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { VideoAudioLifetimeCase } from '../helpers/web-video-audio-lifetime.ts'

let entryFile: string
const files = new Map<string, string | Uint8Array>()
test.beforeAll(async () => {
  const result = await build({ configFile: false, publicDir: false, base: './', logLevel: 'error', build: {
    write: false, minify: false, lib: { entry: resolve('tests/helpers/web-video-audio-lifetime.ts'),
      formats: ['es'], fileName: () => 'video-audio-lifetime.mjs' },
  } })
  const output = (Array.isArray(result) ? result : [result]).flatMap((item) => 'output' in item ? item.output : [])
  for (const item of output) files.set(item.fileName, item.type === 'chunk' ? item.code : item.source)
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing video audio lifetime bundle')
  entryFile = entry.fileName
})

for (const name of ['url-failure', 'audio-failure', 'frame-failure', 'close-candidate', 'cancel-candidate',
  'window-candidate', 'supersede-candidate', 'old-graph-cleanup', 'opening-newer-command'] as const satisfies readonly VideoAudioLifetimeCase[]) {
  test(`real video audio candidate lifetime: ${name}`, async ({ page }) => {
    test.setTimeout(60000)
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    await page.route('**/video-audio-lifetime.html', (route) => route.fulfill({ contentType: 'text/html',
      body: '<!doctype html><title>Video selected-track lifetime</title>' }))
    await page.route('**/video-audio-lifetime/**', (route) => {
      const path = new URL(route.request().url()).pathname.replace('/video-audio-lifetime/', ''), body = files.get(path)
      if (body === undefined) return route.fulfill({ status: 404, body: `Unknown video lifetime bundle ${path}` })
      return route.fulfill({ contentType: /\.(m?js)$/.test(path) ? 'text/javascript' : 'application/octet-stream',
        body: typeof body === 'string' ? body : Buffer.from(body) })
    })
    await page.route('**/video-audio-lifetime.mp4', (route) => route.fulfill({ contentType: 'video/mp4',
      body: readFileSync(resolve('out/verification/video-tracks/multitrack.mp4')) }))
    await page.goto('/video-audio-lifetime.html')
    const result = await page.evaluate(async ({ name, entryFile }) => {
      const url = `/video-audio-lifetime/${entryFile}`,
        module = await import(url) as typeof import('../helpers/web-video-audio-lifetime.ts'),
        bytes = new Uint8Array(await (await fetch('/video-audio-lifetime.mp4')).arrayBuffer())
      return module.exerciseVideoAudioLifetime(name, bytes)
    }, { name, entryFile })
    await test.info().attach('video-audio-candidate-ownership', { body: JSON.stringify({ name, result }, null, 2),
      contentType: 'application/json' })
    expect(errors).toEqual([])
    expect(result.errors).toEqual([])
    expect(result.connected).toBe(result.closed)
    expect(result.createdUrls).toBe(result.revokedUrls)
    expect([result.liveGraphs, result.liveUrls, result.pendingFrames, result.pendingReplies, result.videos]).toEqual([0, 0, 0, 0, 0])
    if (name.endsWith('failure') || name === 'opening-newer-command') expect(result.rollbackPreserved).toBe(true)
    else if (name === 'old-graph-cleanup') expect(result.oldCleanupRecovered).toBe(true)
    else expect(result.lateDeliverySafe).toBe(true)
    if (name.endsWith('failure') || name === 'supersede-candidate' || name === 'old-graph-cleanup') expect(result.mixingPreserved).toBe(true)
  })
}
