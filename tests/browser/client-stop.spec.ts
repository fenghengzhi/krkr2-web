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
            const { SessionClient, LibraryClient } = (await import(entry)) as {
              SessionClient: typeof import('../../src/player/session-client.ts').SessionClient
              LibraryClient: typeof import('../../src/player/library-client.ts').LibraryClient
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
            const first = new LibraryClient(() => {})
            let second: InstanceType<typeof LibraryClient> | undefined
            try {
              const before = await first.call('list')
              window.clientStopBoundary.arm('cancel')
              // An unused operation is still a real acknowledged Worker call.
              // The fault withholds its reply, not the underlying cancellation.
              await first.cancel('watchdog-boundary-unused-operation')
              const afterTimeout = window.clientStopBoundary.read()
              second = new LibraryClient(() => {})
              const recovered = await second.call('list')
              second.close()
              return {
                kind,
                before,
                recovered,
                afterTimeout,
                afterRecovery: window.clientStopBoundary.read(),
              }
            } finally {
              first.close()
              second?.close()
            }
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
          expect(result.recovered.games).toEqual([])
          expect(result.recovered.available).toBe(result.before.available)
        }
        const old = result.afterTimeout.workers[0]!,
          fresh = result.afterRecovery.workers[1]!
        expect(result.afterTimeout.workers).toHaveLength(1)
        expect(old.terminated).toBe(1)
        expect(old.held).toHaveLength(1)
        expect(old.held[0]!.operation).toBe(kind === 'session' ? 'stop' : 'cancel')
        expect(old.held[0]!.type).toBe('RAW')
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
                  'Actual browser clients and RPC Workers; exactly one actual reply withheld. Session prepare only, no WASM initialization. This verifies watchdog settlement and host cleanup, not the historical WebKit slow-Stop cause.',
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
})
