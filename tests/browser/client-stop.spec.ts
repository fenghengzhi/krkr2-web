import { test, expect } from '@playwright/test'
import {
  buildClientStopEmbedding,
  observeClientStopBoundary,
  openClientStopEmbedding,
} from '../helpers/client-stop-embedding.ts'

test.describe('actual RPC client watchdog settlement and cleanup', () => {
  let bundle: Awaited<ReturnType<typeof buildClientStopEmbedding>>
  test.beforeAll(async () => {
    bundle = await buildClientStopEmbedding()
  })

  for (const kind of ['session', 'library'] as const)
    test(`${kind}: a withheld actual shutdown reply retains its watchdog outcome and permits a fresh client`, async ({
      page,
    }, info) => {
      const errors: string[] = []
      page.on('pageerror', (error) => errors.push(error.message))
      await observeClientStopBoundary(page)
      await openClientStopEmbedding(page, bundle)
      try {
        const result = await page.evaluate(
          async ({ entry, kind }) => {
            const { SessionClient, exerciseLibraryCancellation } = (await import(entry)) as {
              SessionClient: typeof import('../../src/player/session-client.ts').SessionClient
              exerciseLibraryCancellation: typeof import('../helpers/library-client-boundary.ts').exerciseLibraryCancellation
            }
            if (kind === 'session') {
              const first = new SessionClient(() => {}),
                files = [{ path: 'startup.tjs', blob: new Blob(['var value=7;']) }]
              let second: InstanceType<typeof SessionClient> | undefined
              try {
                const identity = await first.prepare(files)
                window.clientStopBoundary.arm('stop')
                let error = ''
                try {
                  await first.stop()
                } catch (value) {
                  error = value instanceof Error ? value.message : String(value)
                }
                const afterTimeout = window.clientStopBoundary.read()
                second = new SessionClient(() => {})
                const recovered = await second.prepare(files)
                await second.stop()
                return {
                  kind,
                  error,
                  disposed: first.isDisposed,
                  identity,
                  recovered,
                  afterTimeout,
                  afterRecovery: window.clientStopBoundary.read(),
                }
              } finally {
                first.dispose()
                second?.dispose()
              }
            }
            return { kind, ...await exerciseLibraryCancellation('forced') }
          },
          { entry: bundle.entry, kind },
        )
        await info.attach('watchdog-outcome-and-recovery', {
          contentType: 'application/json',
          body: JSON.stringify(result, null, 2),
        })
        if (result.kind === 'session') {
          expect(result.error).toBe('Worker did not stop in time and was terminated')
          expect(result.disposed).toBe(true)
          expect(result.identity).toMatch(/^game-[a-f0-9]{64}$/)
          expect(result.recovered).toBe(result.identity)
        } else {
          expect(result.before.games).toEqual([])
          expect(result.outcome.error).toBe('AbortError:Library operation cancelled')
          expect(result.recovered.games).toHaveLength(1)
          expect(result.recovered.games[0]!.gameId).toBe(result.expectedGameId)
          expect(result.recovered.available).toBe(result.before.available)
        }
        const old = result.afterTimeout.workers[0]!,
          fresh = result.afterRecovery.workers[1]!
        expect(result.afterTimeout.workers).toHaveLength(1)
        expect(old.terminated).toBe(1)
        expect(old.held.map((reply) => reply.operation)).toEqual(kind === 'session' ? ['stop'] : ['importGame', 'cancel'])
        expect(old.held.every((reply) => reply.type === 'RAW')).toBe(true)
        if (kind === 'library') expect(old.sent.map((call) => call.operation)).toEqual(['connect', 'list', 'importGame', 'cancel'])
        expect(result.afterTimeout.channels[0]!.closed).toEqual([1, 1])
        expect(result.afterRecovery.workers).toHaveLength(2)
        expect(fresh.terminated).toBe(1)
        expect(fresh.held).toEqual([])
        expect(fresh.sent.map((call) => call.operation)).toContain(
          kind === 'session' ? 'prepare' : 'list',
        )
        expect(result.afterRecovery.channels.at(-1)!.closed).toEqual([1, 1])
        expect(errors).toEqual([])
      } finally {
        if (!page.isClosed())
          await info.attach('watchdog-boundary-final-observation', {
            contentType: 'application/json',
            body: JSON.stringify(
              {
                scope:
                  'Actual browser clients and RPC Workers; named actual replies withheld. Library import commits a tiny real game before transport cancellation. Session prepare only, no WASM initialization. This verifies watchdog settlement and host cleanup, not the historical WebKit slow-Stop cause.',
                bundles: bundle.hashes,
                observation: await page.evaluate(() => window.clientStopBoundary.read()),
                pageErrors: errors,
              },
              null,
              2,
            ),
          })
      }
    })

  test('library: a completed real import wins over a delayed cancel reply without terminating its client', async ({ page }, info) => {
    await observeClientStopBoundary(page); await openClientStopEmbedding(page, bundle)
    const result = await page.evaluate(async (entry) => {
      const module = await import(entry) as typeof import('../helpers/library-client-boundary.ts')
      return module.exerciseLibraryCancellation('healthy')
    }, bundle.entry)
    await info.attach('healthy-import-and-late-cancel', { contentType: 'application/json', body: JSON.stringify(result) })
    expect(result.outcome.error).toBe('')
    expect(result.outcome.game!.gameId).toBe(result.expectedGameId)
    expect(result.recovered.games).toHaveLength(1)
    expect(result.recovered.games[0]!.gameId).toBe(result.expectedGameId)
    expect(result.afterTimeout.workers).toHaveLength(1)
    expect(result.afterTimeout.workers[0]!.terminated).toBe(0)
    expect(result.afterTimeout.workers[0]!.held.map((reply) => reply.operation)).toEqual(['importGame', 'cancel'])
    expect(result.afterRecovery.workers).toHaveLength(1)
    expect(result.afterRecovery.workers[0]!.terminated).toBe(1)
    expect(result.afterRecovery.channels[0]!.closed).toEqual([1, 1])
  })

  test('library: a failed connection releases its import and retries through the same real client', async ({ page }, info) => {
    await observeClientStopBoundary(page); await openClientStopEmbedding(page, bundle)
    for (const phase of ['construction', 'post'] as const) {
      const result = await page.evaluate(async ({ entry, phase }) => {
        const module = await import(entry) as typeof import('../helpers/library-client-boundary.ts')
        return module.exerciseLibraryConnectRetry(phase)
      }, { entry: bundle.entry, phase })
      await info.attach('connection-retry-' + phase, { contentType: 'application/json', body: JSON.stringify(result) })
      expect(result.error).toContain(phase === 'construction' ? 'Worker construction unavailable' : 'connect transport unavailable')
      expect(result.recovered.games).toHaveLength(1)
      expect(result.recovered.games[0]!.gameId).toBe(result.game.gameId)
      expect(result.after.workers.length).toBeGreaterThan(result.before.workers.length)
      for (const worker of result.after.workers.slice(result.before.workers.length)) expect(worker.terminated).toBe(1)
      for (const channel of result.after.channels.slice(result.before.channels.length)) expect(channel.closed).toEqual([1, 1])
    }
    const retired = await page.evaluate(async (entry) => {
      const module = await import(entry) as typeof import('../helpers/library-client-boundary.ts')
      return module.exerciseLibraryRetiredConnection()
    }, bundle.entry)
    await info.attach('retired-connect-does-not-close-retry', { contentType: 'application/json', body: JSON.stringify(retired) })
    expect(retired.rejected).not.toBe('')
    expect(retired.recovered.available).toBe(true)
    expect(retired.recovered.games).toEqual([])
    expect(retired.after.workers.length).toBe(retired.before.workers.length + 2)
    for (const worker of retired.after.workers.slice(retired.before.workers.length)) expect(worker.terminated).toBe(1)
    for (const channel of retired.after.channels.slice(retired.before.channels.length)) expect(channel.closed).toEqual([1, 1])
  })
})
