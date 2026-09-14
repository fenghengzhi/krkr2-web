import { test, expect, type Page } from '@playwright/test'
import { resolve } from 'node:path'
import { build } from 'vite'
import type { WebAudioLifetimeCase } from '../helpers/web-audio-lifetime.ts'

let fixture: string
test.beforeAll(async () => {
  // This fixture is built only by the browser test job on a GitHub-hosted runner.
  // Keep its controlled device out of the production player and release bundle.
  const result = await build({
    configFile: false,
    publicDir: false,
    logLevel: 'error',
    build: {
      write: false,
      minify: false,
      lib: {
        entry: resolve('tests/helpers/web-audio-lifetime.ts'),
        formats: ['es'],
        fileName: () => 'audio-lifetime.mjs',
      },
    },
  })
  const outputs = Array.isArray(result) ? result : [result]
  const entry = outputs
    .flatMap((output) => ('output' in output ? output.output : []))
    .find((output) => output.type === 'chunk' && output.isEntry)
  if (!entry || entry.type !== 'chunk') throw new Error('Missing WebAudioHost fixture bundle')
  fixture = entry.code
})

async function exercise(page: Page, name: WebAudioLifetimeCase) {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.route('**/audio-lifetime.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>Audio lifetime</title>',
    }),
  )
  await page.route('**/audio-lifetime.mjs', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: fixture,
    }),
  )
  await page.goto('/audio-lifetime.html')
  const result = await page.evaluate(async (name) => {
    const url = '/audio-lifetime.mjs'
    const fixture = (await import(url)) as typeof import('../helpers/web-audio-lifetime.ts')
    return fixture.exerciseWebAudioLifetime(name)
  }, name)
  expect(errors).toEqual([])
  expect(result.pendingReplies).toBe(0)
  expect(result.postsAfterClose).toBe(0)
  expect(result.contextCloses).toBe(1)
  expect(result.lastState?.state).toBe('closed')
  expect(result.nodeCount).toBe(1)
  expect(result.disconnects).toBe(1)
  expect(result.portCloses).toBe(1)
  return result
}

test('closing a voice invalidates its pending browser decode before PCM can load', async ({
  page,
}) => {
  const result = await exercise(page, 'close-during-decode')
  expect(result.replies.create?.status).toBe('fulfilled')
  expect(result.replies.close?.status).toBe('fulfilled')
  expect(result.replies.oldOpen?.status).toBe('rejected')
  expect(result.decoderCalls).toBe(1)
  expect(result.commands.filter((command) => command.op === 'load')).toEqual([])
  expect(
    result.commands.filter((command) => command.id === 7).map((command) => command.op),
  ).toEqual(['create', 'close'])
  expect(result.voicesAtBoundary).toEqual([])
})

test('a newer open keeps its PCM when an older same-voice decode finishes last', async ({
  page,
}) => {
  const result = await exercise(page, 'open-supersedes-decode')
  expect(result.replies.create?.status).toBe('fulfilled')
  expect(result.replies.newOpen?.status).toBe('fulfilled')
  expect(result.replies.oldOpen?.status).toBe('rejected')
  expect(result.decoderCalls).toBe(2)
  expect(result.commands.filter((command) => command.op === 'load')).toEqual([
    { op: 'load', id: 7, sample: 0.75 },
  ])
  expect(result.voicesAtBoundary).toEqual([{ id: 7, sample: 0.75 }])
})

test('closing before AudioWorklet initialization completes cannot recreate the voice', async ({
  page,
}) => {
  const result = await exercise(page, 'close-during-initialize')
  expect(result.replies.close?.status).toBe('fulfilled')
  expect(result.replies.create?.status).toBe('rejected')
  expect(result.decoderCalls).toBe(0)
  expect(result.commands.filter((command) => command.id === 7)).toEqual([])
  expect(result.voicesAtBoundary).toEqual([])
})

test('host shutdown rejects a late native decode without posting to its closed worklet', async ({
  page,
}) => {
  const result = await exercise(page, 'shutdown-during-decode')
  expect(result.replies.create?.status).toBe('fulfilled')
  expect(result.replies.oldOpen?.status).toBe('rejected')
  expect(result.decoderCalls).toBe(1)
  expect(result.commands.filter((command) => command.op === 'load')).toEqual([])
})
