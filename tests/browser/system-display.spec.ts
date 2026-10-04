import { expect, test } from '@playwright/test'
import {
  otherSystemDisplayMetrics,
  systemDisplayExpected,
  systemDisplayMetrics,
} from '../helpers/system-display-script.ts'
import { observeSystemEmbeddingAcquisitions } from '../helpers/web-system-core.ts'
import {
  buildSystemColorsEmbedding,
  openSystemColorsEmbedding,
} from '../helpers/web-system-colors.ts'
import {
  observeSystemDisplay,
  readSystemDisplay,
  readSystemDisplayDom,
  rejectInvalidSystemDisplayPlayers,
  rejectSystemDisplayObserverFailure,
  startSystemDisplayPlayers,
  stopSystemDisplayPlayers,
} from '../helpers/web-system-display.ts'

test.describe('native System display through public Players and actual Session Workers', () => {
  test.setTimeout(90000)
  let bundle: Awaited<ReturnType<typeof buildSystemColorsEmbedding>>
  test.beforeAll(async () => {
    bundle = await buildSystemColorsEmbedding()
  })

  for (const backend of ['asyncify', 'jspi'] as const) {
    for (const binary of [false, true]) {
      const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
      test(`${variant}: independent DOM stages follow actual resize and each Player's fullscreen roster, then disconnect and recreate`, async ({
        page,
      }, info) => {
        await observeSystemDisplay(page)
        const setup = await openSystemColorsEmbedding(page, backend, bundle),
          measurements: unknown[] = []
        let proof: Awaited<ReturnType<typeof startSystemDisplayPlayers>> = []
        try {
          proof = await startSystemDisplayPlayers(page, bundle.entry, backend, binary, [
            {},
            { explicitDesktop: true },
          ])
          expect(setup.workers).toHaveLength(2)
          for (const result of proof) {
            const oracle = await readSystemDisplayDom(page, result.index)
            measurements.push({ phase: 'initial', index: result.index, oracle })
            expect(result.backend).toBe(backend)
            expect(result.initial).toBe(systemDisplayExpected(oracle))
            expect(result.actual).toBe(systemDisplayExpected(oracle))
            expect(result.checks).toBe('6|6|6|6|6')
            expect(result.reads).toBe(1)
            expect(result.canvasReparented).toBe(true)
            expect(result.errors).toEqual([])
            expect(result.saved).toEqual(
              binary ? [{ path: 'savedata/system-display.cjs', header: [84, 74, 83, 50] }] : [],
            )
          }
          expect(proof[0]!.actual).not.toBe(proof[1]!.actual)
          const initialSecond = await readSystemDisplay(page, 1)
          // Resize the original canvas parent after createGameWindows has moved
          // the canvas into its surface. The captured embedding stage still owns
          // the logical desktop and screen dimensions.
          await page.evaluate(() => {
            const first = window.systemDisplayEmbeddings![0]!
            first.desktop.style.width = '347px'
            first.desktop.style.height = '211px'
          })
          let resizedFirst = await readSystemDisplayDom(page, 0)
          measurements.push({ phase: 'stage-resize', index: 0, oracle: resizedFirst })
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(resizedFirst))
          expect(await readSystemDisplay(page, 1)).toBe(initialSecond)
          await page.evaluate(() => {
            window.systemDisplayEmbeddings![0]!.desktop.style.padding = '13px'
          })
          resizedFirst = await readSystemDisplayDom(page, 0)
          measurements.push({ phase: 'padding-only-resize', index: 0, oracle: resizedFirst })
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(resizedFirst))
          expect(await readSystemDisplay(page, 1)).toBe(initialSecond)

          await page.evaluate(() =>
            window.systemDisplayEmbeddings![0]!.player.session.evaluate(
              'sdWindow.fullScreen=true;',
            ),
          )
          const fullscreen = await readSystemDisplayDom(page, 0, true)
          measurements.push({ phase: 'fullscreen', index: 0, oracle: fullscreen })
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(fullscreen))
          expect(await readSystemDisplay(page, 1)).toBe(initialSecond)
          await page.setViewportSize({ width: 1107, height: 731 })
          const resizedFullscreen = await readSystemDisplayDom(page, 0, true)
          measurements.push({
            phase: 'fullscreen-viewport-resize',
            index: 0,
            oracle: resizedFullscreen,
          })
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(resizedFullscreen))
          expect(await readSystemDisplay(page, 1)).toBe(initialSecond)
          // Session transfers fullscreen ownership when the second Window
          // requests it, clearing the first Window's flag without a host exit
          // action. Geometry must follow that owner and return to the desktop
          // after the second Window exits fullscreen.
          // Session.evaluate uses TJS expression mode. Keep the statement list
          // inside a called function and retain the second Window on global.
          await page.evaluate(() =>
            window.systemDisplayEmbeddings![0]!.player.session.evaluate(
              '(function(){global.sdSecondWindow=new Window();sdSecondWindow.caption="Display secondary";sdSecondWindow.setInnerSize(84,52);sdSecondWindow.visible=true;sdSecondWindow.fullScreen=true;})()',
            ),
          )
          await expect(
            page.locator(
              '#system-display-player-0 .game-window-fullscreen[aria-label="Display secondary"]',
            ),
          ).toHaveCount(1)
          expect(
            await page.evaluate(() =>
              window.systemDisplayEmbeddings![0]!.player.session.evaluate(
                '[sdWindow.fullScreen,sdSecondWindow.fullScreen].join("|")',
              ),
            ),
          ).toBe('0|1')
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(resizedFullscreen))
          await page.evaluate(() =>
            window.systemDisplayEmbeddings![0]!.player.session.evaluate(
              'sdSecondWindow.fullScreen=false;',
            ),
          )
          await expect(
            page.locator('#system-display-player-0 .game-window-fullscreen'),
          ).toHaveCount(0)
          expect(
            await page.evaluate(() =>
              window.systemDisplayEmbeddings![0]!.player.session.evaluate(
                '[sdWindow.fullScreen,sdSecondWindow.fullScreen].join("|")',
              ),
            ),
          ).toBe('0|0')
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(resizedFirst))
          expect(await readSystemDisplay(page, 1)).toBe(initialSecond)
          await page.evaluate(() =>
            window.systemDisplayEmbeddings![0]!.player.session.evaluate(
              '(function(){sdWindow.fullScreen=false;invalidate sdSecondWindow;})()',
            ),
          )

          await page.evaluate(async () => {
            const first = window.systemDisplayEmbeddings![0]!
            await first.player.session.pause()
            first.desktop.style.width = '379px'
            first.desktop.style.height = '239px'
          })
          const pausedGeometry = await readSystemDisplayDom(page, 0)
          // Native script evaluation cannot run while paused. Observe the real
          // transport admission before resuming and reading the native property.
          await expect
            .poll(() =>
              page.evaluate(
                () =>
                  window
                    .systemDisplayObservation()
                    .packets.filter(({ worker }) => worker === 0)
                    .at(-1)?.update.metrics,
              ),
            )
            .toEqual(pausedGeometry)
          await page.evaluate(() => window.systemDisplayEmbeddings![0]!.player.session.resume())
          await expect
            .poll(() => readSystemDisplay(page, 0))
            .toBe(systemDisplayExpected(pausedGeometry))
          expect(await readSystemDisplay(page, 1)).toBe(initialSecond)
          await page.evaluate(() => window.systemDisplayEmbeddings![0]!.player.stop())
          await expect.poll(() => setup.workers[0]!.closed).toBe(true)
          const stoppedPackets = await page.evaluate(
            () =>
              window.systemDisplayObservation().packets.filter(({ worker }) => worker === 0).length,
          )
          await page.evaluate(() => {
            const first = window.systemDisplayEmbeddings![0]!,
              second = window.systemDisplayEmbeddings![1]!
            first.desktop.style.width = '411px'
            second.desktop.style.width = '509px'
          })
          await page.setViewportSize({ width: 1083, height: 709 })
          const resizedSecond = await readSystemDisplayDom(page, 1)
          await expect
            .poll(() => readSystemDisplay(page, 1))
            .toBe(systemDisplayExpected(resizedSecond))
          expect(
            await page.evaluate(
              () =>
                window.systemDisplayObservation().packets.filter(({ worker }) => worker === 0)
                  .length,
            ),
          ).toBe(stoppedPackets)
          expect(
            await page.evaluate(() =>
              window.systemDisplayObservation().activeObserverTargets.flat(),
            ),
          ).not.toContain('system-display-parent-0')
          const recreated = await startSystemDisplayPlayers(page, bundle.entry, backend, binary, [
              { explicitDesktop: true },
            ]),
            freshOracle = await readSystemDisplayDom(page, 2)
          proof.push(...recreated)
          expect(recreated[0]!.actual).toBe(systemDisplayExpected(freshOracle))
          expect(recreated[0]!.generation).toBeGreaterThan(proof[1]!.generation)
          expect(await readSystemDisplay(page, 1)).toBe(systemDisplayExpected(resizedSecond))
          expect(setup.workers).toHaveLength(3)
        } finally {
          const cleanup = await stopSystemDisplayPlayers(page),
            observation = await page.evaluate(() => window.systemDisplayObservation())
          await info.attach('native-system-display-dom-and-worker-proof', {
            contentType: 'application/json',
            body: JSON.stringify(
              {
                variant,
                proof,
                measurements,
                cleanup,
                observation,
                wasmManifestHash: bundle.wasmManifestHash,
                hashes: bundle.hashes,
              },
              null,
              2,
            ),
          })
          expect(
            cleanup.every(
              ({ disposed, liveWindows, errors }) =>
                disposed && liveWindows === 0 && errors.length === 0,
            ),
          ).toBe(true)
          expect(observation.activeObserverTargets).toEqual([])
          await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
          expect(setup.errors).toEqual([])
        }
      })

      test(`${variant}: copied injected geometry ignores DOM and fullscreen changes, while revision and generation guards reach real Workers`, async ({
        page,
      }, info) => {
        await observeSystemDisplay(page)
        const setup = await openSystemColorsEmbedding(page, backend, bundle),
          metrics = [systemDisplayMetrics, otherSystemDisplayMetrics]
        let proof: Awaited<ReturnType<typeof startSystemDisplayPlayers>> = []
        try {
          proof = await startSystemDisplayPlayers(
            page,
            bundle.entry,
            backend,
            binary,
            metrics.map((metrics) => ({ metrics })),
          )
          for (const [index, result] of proof.entries()) {
            expect(result.actual).toBe(systemDisplayExpected(metrics[index]!))
            expect(result.initial).toBe(systemDisplayExpected(metrics[index]!))
            expect(result.checks).toBe('6|6|6|6|6')
            expect(result.reads).toBe(1)
            expect(result.errors).toEqual([])
          }
          const beforeResize = await page.evaluate(
            () => window.systemDisplayObservation().packets.length,
          )
          await page.evaluate(async () => {
            for (const embedding of window.systemDisplayEmbeddings!) {
              embedding.desktop.style.width = '523px'
              embedding.desktop.style.height = '317px'
              await embedding.player.session.evaluate('sdWindow.fullScreen=true;')
            }
          })
          await page.setViewportSize({ width: 1079, height: 701 })
          // A real layout pass and a native TJS RPC provide completion evidence;
          // injected dimensions must stay fixed through both kinds of changes.
          await page.evaluate(
            () =>
              new Promise<void>((resolve) =>
                requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
              ),
          )
          for (const [index, value] of metrics.entries())
            expect(await readSystemDisplay(page, index)).toBe(systemDisplayExpected(value))
          expect(await page.evaluate(() => window.systemDisplayObservation().packets.length)).toBe(
            beforeResize,
          )
          expect(
            await page.evaluate(() =>
              window.systemDisplayObservation().activeObserverTargets.flat(),
            ),
          ).not.toContain('system-display-parent-0')
          const changed = { ...otherSystemDisplayMetrics, desktopWidth: 733 }
          await page.evaluate(
            async ({ changed }) => {
              const session = window.systemDisplayEmbeddings![0]!.player.session
              await session.setSystemDisplay({ revision: 10, metrics: changed })
              changed.desktopWidth = 1
              await session.setSystemDisplay({ revision: 9, metrics: changed })
              await session.setSystemDisplay({ revision: 10, metrics: changed })
            },
            { changed },
          )
          expect(await readSystemDisplay(page, 0)).toBe(systemDisplayExpected(changed))
          expect(await readSystemDisplay(page, 1)).toBe(
            systemDisplayExpected(otherSystemDisplayMetrics),
          )
          const generation = proof[0]!.generation
          expect(
            await page.evaluate(
              ({ generation, metrics }) =>
                window.sendRawSystemDisplay(0, generation + 1000, { revision: 1000, metrics }),
              { generation, metrics: systemDisplayMetrics },
            ),
          ).toBe('RAW')
          expect(
            await page.evaluate(
              ({ generation, metrics }) =>
                window.sendRawSystemDisplay(0, generation, { revision: 9, metrics }),
              { generation, metrics: systemDisplayMetrics },
            ),
          ).toBe('RAW')
          expect(await readSystemDisplay(page, 0)).toBe(systemDisplayExpected(changed))
          // A valid successor below the rejected generation's revision proves
          // that a foreign generation did not advance the live engine's clock.
          expect(
            await page.evaluate(
              ({ generation, metrics }) =>
                window.sendRawSystemDisplay(0, generation, { revision: 11, metrics }),
              { generation, metrics: systemDisplayMetrics },
            ),
          ).toBe('RAW')
          expect(await readSystemDisplay(page, 0)).toBe(systemDisplayExpected(systemDisplayMetrics))
          await page.evaluate(async (metrics) => {
            const session = window.systemDisplayEmbeddings![0]!.player.session
            await session.pause()
            await session.setSystemDisplay({ revision: 12, metrics })
            await session.resume()
          }, changed)
          expect(await readSystemDisplay(page, 0)).toBe(systemDisplayExpected(changed))
          expect(
            await page.evaluate(() =>
              window.systemDisplayEmbeddings![0]!.player.session.evaluate(
                '*(&global.sdWidthReference)',
              ),
            ),
          ).toBe('733')
        } finally {
          const cleanup = await stopSystemDisplayPlayers(page),
            observation = await page.evaluate(() => window.systemDisplayObservation())
          await info.attach('injected-system-display-real-worker-revision-proof', {
            contentType: 'application/json',
            body: JSON.stringify(
              {
                variant,
                metrics,
                proof,
                cleanup,
                observation,
                wasmManifestHash: bundle.wasmManifestHash,
                hashes: bundle.hashes,
              },
              null,
              2,
            ),
          })
          expect(cleanup).toEqual(
            metrics.map(() => ({ disposed: true, liveWindows: 0, errors: [] })),
          )
          expect(observation.activeObserverTargets).toEqual([])
          await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
          expect(setup.errors).toEqual([])
        }
      })
    }
  }

  test('invalid injected display configuration rejects before host acquisition and a fresh valid Player still runs', async ({
    page,
  }, info) => {
    await observeSystemEmbeddingAcquisitions(page)
    const setup = await openSystemColorsEmbedding(page, 'asyncify', bundle),
      rejected = await rejectInvalidSystemDisplayPlayers(page, bundle.entry)
    await info.attach('invalid-system-display-acquisitions', {
      contentType: 'application/json',
      body: JSON.stringify(rejected, null, 2),
    })
    expect(rejected).toHaveLength(13)
    expect(setup.workers).toHaveLength(0)
    for (const result of rejected) {
      expect(result.constructed, result.name).toBe(false)
      expect(result.error, result.name).toMatch(/^Error: System display/)
      expect(result.before.errors, result.name).toEqual([])
      expect(result.after, result.name).toEqual(result.before)
    }
    const observerFailure = await rejectSystemDisplayObserverFailure(page, bundle.entry)
    await info.attach('partial-display-observer-setup-cleanup', {
      contentType: 'application/json',
      body: JSON.stringify(observerFailure, null, 2),
    })
    expect(observerFailure.error).toBe('Error: synthetic system display second observe failure')
    expect(observerFailure.constructed).toBe(false)
    expect(observerFailure.admissions).toBe(2)
    expect(observerFailure.createdObservers).toBe(2)
    expect(observerFailure.disconnectedObservers).toBe(2)
    expect(observerFailure.disposed).toBe(true)
    expect(observerFailure.errors).toEqual([])
    expect(observerFailure.after.created.Worker).toBe(observerFailure.before.created.Worker)
    expect(setup.workers).toHaveLength(0)
    try {
      const [fresh] = await startSystemDisplayPlayers(page, bundle.entry, 'asyncify', false, [{}])
      expect(fresh!.actual).toBe(systemDisplayExpected(await readSystemDisplayDom(page, 0)))
      expect(fresh!.checks).toBe('6|6|6|6|6')
      expect(fresh!.errors).toEqual([])
    } finally {
      expect(await stopSystemDisplayPlayers(page)).toEqual([
        { disposed: true, liveWindows: 0, errors: [] },
      ])
      await expect.poll(() => setup.workers.every(({ closed }) => closed)).toBe(true)
      expect(setup.errors).toEqual([])
    }
  })
})
