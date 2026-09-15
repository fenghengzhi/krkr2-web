import { expect, test } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'
import type { WasmManifest } from '../../src/backends/script/tjs-wasm/module.ts'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  exportSystemSaves,
  observedUuid,
  observeSystemEmbeddingAcquisitions,
  prepareSystemPage,
  readSystemRandom,
  rejectSystemEmbeddingPaths,
  runSystemEmbedding,
  stopSystemPage,
  systemFiles,
  systemIdentityProgram,
  systemMark,
  systemPersistenceProgram,
  systemPrefix,
  systemText,
  uuidPattern,
  type SystemBackup,
} from '../helpers/web-system-core.ts'

for (const backend of ['asyncify', 'jspi']) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`

    test(`${variant}: native System identity, readonly metadata and real Worker Web Crypto survive rejected operations`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend, true)
      try {
        await page.locator('#files').setInputFiles(systemFiles(binary, systemIdentityProgram))
        await expect(systemMark(page, 'identity-ready')).toBeVisible()
        await expect(page.locator('#evaluate')).toBeEnabled()
        await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
        expect(setup.workers).toHaveLength(1)
        expect(setup.routed).toHaveLength(1)
        const before = await readSystemRandom(setup.workers[0])
        await evaluate(page, 'runSystemUUID()', 'complete')
        const proof = await readSystemRandom(setup.workers[0]),
          calls = proof.calls.slice(before.calls.length),
          first = (await page.getByText(/^system-core-proof:uuid:first:/).innerText()).slice(
            (systemPrefix + 'uuid:first:').length,
          ),
          second = (await page.getByText(/^system-core-proof:uuid:second:/).innerText()).slice(
            (systemPrefix + 'uuid:second:').length,
          )
        await info.attach('system-native-worker-uuid-observation', {
          contentType: 'application/json',
          body: JSON.stringify(
            { variant, routed: setup.routed, before, proof, first, second },
            null,
            2,
          ),
        })
        expect(proof).toMatchObject({
          secure: true,
          worker: true,
          installed: true,
          errors: [],
          dropped: 0,
        })
        // Compare only calls after startup, so unrelated kernel initialization
        // cannot masquerade as the intentionally discarded middle UUID call.
        expect(calls).toHaveLength(3)
        expect(calls.every((bytes) => bytes.length === 16)).toBe(true)
        expect(first).toMatch(uuidPattern)
        expect(second).toMatch(uuidPattern)
        expect(first).toBe(observedUuid(calls[0]))
        expect(second).toBe(observedUuid(calls[2]))

        const project = JSON.parse(await readFile(resolve('package.json'), 'utf8')) as {
            name: string
            version: string
          },
          native = await readFile(resolve('third_party/tjs2/tjs.cpp'), 'utf8'),
          nativeVersion = ['Major', 'Minor', 'Release']
            .map((part) => {
              const found = native.match(new RegExp(`TJSVersion${part}\\s*=\\s*(\\d+)`))
              if (!found) throw new Error(`The vendored TJS ${part} version is unavailable`)
              return found[1]
            })
            .join('.'),
          information = await page.getByText(/^system-core-proof:information:/).innerText()
        await expect(systemMark(page, `version:${project.version}.0`)).toBeVisible()
        expect(information).toContain(`${project.name}/${project.version}.0`)
        expect(information).toContain(`TJS2/${nativeVersion}`)
        expect(information).not.toMatch(/2\.32\.2\.426|\/Users\/|[A-Za-z]:\\/)
        await evaluate(
          page,
          'System.onActivate===null && System.onDeactivate===null && System.exceptionHandler===null',
          '1',
        )
        await evaluate(page, '6*7', '42')
        await info.attach('system-native-worker-uuid-and-metadata', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              variant,
              routed: setup.routed,
              worker: setup.workers[0].url,
              before,
              proof,
              first,
              second,
              information,
              nativeVersion,
              scope:
                'Actual Worker Web Crypto samples and v4 formatting; no entropy-quality or cross-process uniqueness claim',
            },
            null,
            2,
          ),
        })
      } finally {
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.every((entry) => entry.closed)).toBe(true)
      }
    })

    test(`${variant}: System paths use real resources and persisted save aliases isolated by game identity`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend),
        firstFiles = systemFiles(binary, systemPersistenceProgram, 'game A'),
        otherFiles = systemFiles(binary, systemPersistenceProgram, 'game B'),
        backups: SystemBackup[] = [],
        expectedPaths = [
          'savedata/system-binary.bin',
          'savedata/system-counter.txt',
          'savedata/system-text.txt',
          ...(binary ? ['savedata/system-core.cjs'] : []),
        ].sort()
      try {
        await page.locator('#files').setInputFiles(firstFiles)
        await expect(systemMark(page, 'persistence:0:1')).toBeVisible()
        await expect(systemMark(page, 'persistence-ready')).toBeVisible()
        const initialVersion = await page.getByText(/^system-core-proof:version:/).innerText(),
          initialInformation = await page.getByText(/^system-core-proof:information:/).innerText()
        backups.push(await exportSystemSaves(page))
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.map((entry) => entry.closed)).toEqual([true])
        await info.attach('system-paths-game-a-initial-logs', {
          contentType: 'text/plain',
          body: await page.locator('#logs').innerText(),
        })

        // A real stopped Worker and document reload rule out an in-memory
        // SaveOverlay carrying these files into the next Session.
        await page.reload()
        await page.locator('#files').setInputFiles(firstFiles)
        await expect(systemMark(page, 'persistence:3:2')).toBeVisible()
        await expect(systemMark(page, 'persistence-ready')).toBeVisible()
        await expect(page.getByText(/^system-core-proof:version:/)).toHaveText(initialVersion)
        await expect(page.getByText(/^system-core-proof:information:/)).toHaveText(
          initialInformation,
        )
        backups.push(await exportSystemSaves(page))
        expect(backups[1].gameId).toBe(backups[0].gameId)
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.map((entry) => entry.closed)).toEqual([true, true])
        await info.attach('system-paths-game-a-restored-logs', {
          contentType: 'text/plain',
          body: await page.locator('#logs').innerText(),
        })
        await page.locator('#clear-log').click()

        // Both games execute exactly the same program and paths. Only an
        // inert mounted identity file changes, so the absence is gameId scope.
        await page.locator('#files').setInputFiles(otherFiles)
        await expect(systemMark(page, 'persistence:0:1')).toBeVisible()
        await expect(systemMark(page, 'persistence-ready')).toBeVisible()
        backups.push(await exportSystemSaves(page))
        expect(backups[2].gameId).not.toBe(backups[0].gameId)
        await stopSystemPage(page, setup.errors)
        await expect
          .poll(() => setup.workers.map((entry) => entry.closed))
          .toEqual([true, true, true])
        await info.attach('system-paths-game-b-isolated-logs', {
          contentType: 'text/plain',
          body: await page.locator('#logs').innerText(),
        })
        await page.locator('#clear-log').click()

        await page.locator('#files').setInputFiles(firstFiles)
        await expect(systemMark(page, 'persistence:3:3')).toBeVisible()
        await expect(systemMark(page, 'persistence-ready')).toBeVisible()
        backups.push(await exportSystemSaves(page))
        expect(backups[3].gameId).toBe(backups[0].gameId)
        for (const [index, backup] of backups.entries()) {
          expect(backup).toMatchObject({ format: 'krkr2-web-saves', version: 1 })
          expect(backup.gameId).toMatch(/^game-[0-9a-f]{64}$/)
          expect(backup.files.map((file) => file.path).sort()).toEqual(expectedPaths)
          const saved = (path: string) =>
            Buffer.from(backup.files.find((file) => file.path === path)!.base64, 'base64')
          expect(
            saved('savedata/system-counter.txt')
              .toString('utf8')
              .replace(/^\uFEFF/, '')
              .trim(),
          ).toBe(['1', '2', '1', '3'][index])
          expect(
            saved('savedata/system-text.txt')
              .toString('utf8')
              .replace(/^\uFEFF/, '')
              .trim(),
          ).toBe(systemText)
          expect(saved('savedata/system-binary.bin').subarray(0, 8).toString('ascii')).toBe(
            'KBAD100\0',
          )
          if (binary)
            expect(saved('savedata/system-core.cjs').subarray(0, 4).toString('ascii')).toBe('TJS2')
        }
        await info.attach('system-paths-real-indexeddb-and-backups', {
          contentType: 'application/json',
          body: JSON.stringify({ variant, initialVersion, initialInformation, backups }, null, 2),
        })
      } finally {
        await info.attach('system-paths-collected-backups', {
          contentType: 'application/json',
          body: JSON.stringify({ variant, backups }, null, 2),
        })
        await info.attach('system-paths-final-session-logs', {
          contentType: 'text/plain',
          body: await page.locator('#logs').innerText(),
        })
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.every((entry) => entry.closed)).toBe(true)
      }
    })
  }

  test(`${backend}: production loader rejects missing nativeSystem while retaining nativeClipboard and recovers with an intact kernel`, async ({
    page,
  }, info) => {
    const setup = await prepareSystemPage(page, backend),
      manifestBytes = await readFile(resolve('.generated/wasm/manifest.json')),
      manifestHash = createHash('sha256').update(manifestBytes).digest('hex'),
      manifestPath = `/wasm/manifest-${manifestHash.slice(0, 16)}.json`,
      matchManifest = (url: URL) => url.pathname === manifestPath,
      intercepted: { url: string; original: WasmManifest; served: WasmManifest }[] = [],
      routeErrors: string[] = []
    await page.context().route(matchManifest, async (route) => {
      try {
        const response = await route.fetch(),
          bytes = await response.body()
        if (!response.ok() || !bytes.equals(manifestBytes))
          throw new Error('The served WASM manifest differs from this exact hosted build')
        const original = JSON.parse(bytes.toString('utf8')) as WasmManifest,
          served = structuredClone(original)
        if (served.capabilities?.nativeSystem !== 1 || served.capabilities.nativeClipboard !== 1)
          throw new Error(
            'The real hosted manifest must provide nativeSystem=1 and nativeClipboard=1',
          )
        delete served.capabilities.nativeSystem
        intercepted.push({ url: route.request().url(), original, served })
        await route.fulfill({ response, json: served })
      } catch (error) {
        routeErrors.push(String(error))
        await route.abort('failed')
      }
    })
    try {
      await page
        .locator('#files')
        .setInputFiles(
          systemFiles(
            false,
            `Debug.message("${systemPrefix}manifest-startup-must-not-run");System.createUUID();`,
          ),
        )
      await expect(page.locator('#logs')).toContainText(
        'WASM manifest is missing native System support',
      )
      await expect(page.locator('#status')).toHaveText('运行失败')
      await expect(page.locator('#choose-files')).toBeEnabled()
      await expect(page.locator('#stop')).toBeDisabled()
      await expect(page.locator('#evaluate')).toBeDisabled()
      await expect(systemMark(page, 'manifest-startup-must-not-run')).toHaveCount(0)
      await expect(page.locator('.game-clipboard')).toHaveCount(0)
      await expect.poll(() => setup.workers.map((entry) => entry.closed)).toEqual([true])
      expect(routeErrors).toEqual([])
      expect(intercepted).toHaveLength(1)
      const rejected = intercepted[0]
      expect({
        ...rejected.served,
        capabilities: { ...rejected.served.capabilities, nativeSystem: 1 },
      }).toEqual(rejected.original)
      expect(rejected.served.capabilities?.nativeClipboard).toBe(1)
      const rejectedLogs = await page.locator('#logs').innerText()
      expect(rejectedLogs).not.toContain('Worker did not stop in time')
      expect(rejectedLogs).not.toContain('RPC client has been disposed')
      await info.attach('missing-native-system-loader-logs', {
        body: rejectedLogs,
        contentType: 'text/plain',
      })

      await page.context().unroute(matchManifest)
      await page
        .locator('#files')
        .setInputFiles(
          systemFiles(
            false,
            `var recovered=System.createUUID();Debug.message("${systemPrefix}manifest-recovered:"+recovered);`,
          ),
        )
      await expect(page.getByText(/^system-core-proof:manifest-recovered:/)).toBeVisible()
      await expect(page.locator('#evaluate')).toBeEnabled()
      const recovered = (
        await page.getByText(/^system-core-proof:manifest-recovered:/).innerText()
      ).slice((systemPrefix + 'manifest-recovered:').length)
      expect(recovered).toMatch(uuidPattern)
      await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
      expect(setup.workers).toHaveLength(2)
      expect(setup.errors).toEqual([])
    } finally {
      await info.attach('missing-native-system-manifest-intervention', {
        contentType: 'application/json',
        body: JSON.stringify(
          {
            manifestPath,
            manifestHash,
            intercepted,
            routeErrors,
            workers: setup.workers.map(({ url, closed }) => ({ url, closed })),
          },
          null,
          2,
        ),
      })
      await page.context().unroute(matchManifest)
      if (await page.locator('#stop').isEnabled()) await stopSystemPage(page, setup.errors)
      await expect.poll(() => setup.workers.every((entry) => entry.closed)).toBe(true)
    }
  })
}

test.describe('public createPlayer System dataPath embedding', () => {
  const base = '/system-core-embedding-assets/',
    bundles = new Map<string, { body: Buffer; contentType: string }>(),
    hashes: { file: string; sha256: string }[] = []
  let entry: string, wasmManifestHash: string, fontManifestHash: string

  test.beforeAll(async () => {
    wasmManifestHash = createHash('sha256')
      .update(await readFile(resolve('.generated/wasm/manifest.json')))
      .digest('hex')
    fontManifestHash = createHash('sha256')
      .update(await readFile(resolve('.generated/fonts/manifest.json')))
      .digest('hex')
    const id = 'virtual:system-core-embedding',
      resolvedId = '\0system-core-embedding',
      result = await build({
        configFile: false,
        publicDir: false,
        base,
        logLevel: 'error',
        // Use the actual public source and its production RPC plugin. This is
        // a separately compiled embedding fixture, not the app's shipped JS.
        plugins: [
          workerRpc({ pool: 1 }),
          {
            name: 'system-core-embedding-entry',
            resolveId(value) {
              if (value === id || value === resolve(id)) return resolvedId
            },
            load(value) {
              if (value !== resolvedId) return
              return [
                `export { createPlayer } from ${JSON.stringify(resolve('src/player/create-player.ts'))};`,
                `export { createGameWindows } from ${JSON.stringify(resolve('src/app/game-windows.ts'))};`,
              ].join('\n')
            },
          },
        ],
        define: {
          __KRKR_WASM_MANIFEST_FILE__: JSON.stringify(
            `wasm/manifest-${wasmManifestHash.slice(0, 16)}.json`,
          ),
          __KRKR_FONT_MANIFEST_FILE__: JSON.stringify(
            `fonts/manifest-${fontManifestHash.slice(0, 16)}.json`,
          ),
        },
        worker: { format: 'es' },
        build: {
          write: false,
          minify: false,
          target: 'es2022',
          rollupOptions: {
            input: { embedding: id },
            preserveEntrySignatures: 'strict',
          },
        },
      }),
      output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
        'output' in item ? item.output : [],
      )
    for (const item of output) {
      const source = item.type === 'chunk' ? item.code : item.source,
        body = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source),
        contentType = item.fileName.endsWith('.css')
          ? 'text/css'
          : item.fileName.endsWith('.wasm')
            ? 'application/wasm'
            : item.fileName.endsWith('.js') || item.fileName.endsWith('.mjs')
              ? 'text/javascript'
              : 'application/octet-stream'
      bundles.set(item.fileName, { body, contentType })
      hashes.push({ file: item.fileName, sha256: createHash('sha256').update(body).digest('hex') })
      if (item.type === 'chunk' && item.isEntry) entry = base + item.fileName
    }
    if (!entry || ![...bundles.keys()].some((file) => /session\.worker-.*\.js$/.test(file)))
      throw new Error(
        'The embedding fixture must export createPlayer and emit its real Session Worker',
      )
  })

  async function openEmbedding(page: import('@playwright/test').Page, backend: string) {
    const setup = await prepareSystemPage(page, backend)
    await observeSystemEmbeddingAcquisitions(page)
    await page.context().route('**/system-core-embedding-assets/**', (route) => {
      const name = new URL(route.request().url()).pathname.slice(base.length),
        found = bundles.get(name)
      if (!found) return route.fulfill({ status: 404, body: `Missing embedding asset: ${name}` })
      return route.fulfill({ body: found.body, contentType: found.contentType })
    })
    await page.route('**/system-core-embedding.html', (route) =>
      route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8"><title>System public embedding contract</title>',
      }),
    )
    await page.goto('/system-core-embedding.html')
    return setup
  }

  for (const backend of ['asyncify', 'jspi'] as const)
    test(`${backend}/source: public options configure a stable custom save directory across Worker restart and omitted defaults`, async ({
      page,
    }, info) => {
      const setup = await openEmbedding(page, backend),
        configured = '$(appdatapath)/custom/../slots',
        results: Awaited<ReturnType<typeof runSystemEmbedding>>[] = []
      try {
        results.push(await runSystemEmbedding(page, entry, backend, configured))
        await expect.poll(() => setup.workers.map((worker) => worker.closed)).toEqual([true])
        await page.reload()
        results.push(await runSystemEmbedding(page, entry, backend, configured))
        await expect.poll(() => setup.workers.map((worker) => worker.closed)).toEqual([true, true])
        results.push(await runSystemEmbedding(page, entry, backend))
        await expect
          .poll(() => setup.workers.map((worker) => worker.closed))
          .toEqual([true, true, true])

        expect(results.map((result) => result.actual)).toEqual([
          'savedata/slots/|savedata/slots/|other|1|savedata/|savedata/',
          'savedata/slots/|savedata/slots/|other|2|savedata/|savedata/',
          'savedata/|savedata/|other|1|savedata/|savedata/',
        ])
        expect(results.map((result) => result.configuredArgument)).toEqual([
          configured,
          configured,
          '<absent>',
        ])
        expect(results.map((result) => result.supplied)).toEqual([true, true, false])
        expect(new Set(results.map((result) => result.gameId)).size).toBe(1)
        expect(
          results.map((result) => result.logs.filter((line) => line.startsWith(systemPrefix))),
        ).toEqual([
          [`${systemPrefix}embedding:savedata/slots/:1`],
          [`${systemPrefix}embedding:savedata/slots/:2`],
          [`${systemPrefix}embedding:savedata/:1`],
        ])
        for (const result of results) {
          expect(result).toMatchObject({ backend, disposed: true, liveWindows: 0, errors: [] })
          expect(result.audio.at(-1)).toBe('closed')
        }
        const saves = (index: number) =>
          Object.fromEntries(
            results[index].files.map((file) => [
              file.path,
              Buffer.from(file.bytes)
                .toString('utf8')
                .replace(/^\uFEFF/, '')
                .trim(),
            ]),
          )
        expect(saves(0)).toEqual({ 'savedata/slots/embedding-counter.txt': '1' })
        expect(saves(1)).toEqual({ 'savedata/slots/embedding-counter.txt': '2' })
        expect(saves(2)).toEqual({
          'savedata/slots/embedding-counter.txt': '2',
          'savedata/embedding-counter.txt': '1',
        })
        await expect(page.locator('#system-embedding-root')).toHaveCount(0)
        expect(setup.errors).toEqual([])
      } finally {
        await info.attach('public-system-datapath-embedding', {
          contentType: 'application/json',
          body: JSON.stringify(
            {
              scope:
                'Separately Vite-compiled real createPlayer/createGameWindows source and RPC Worker; actual hosted WASM/font artifacts and real IndexedDB',
              wasmManifestHash,
              fontManifestHash,
              hashes,
              configured,
              results,
              workers: setup.workers.map(({ url, closed }) => ({ url, closed })),
            },
            null,
            2,
          ),
        })
      }
    })

  test('invalid public dataPath options reject before channels, audio or Worker acquisition and a fresh valid Player still runs', async ({
    page,
  }, info) => {
    const setup = await openEmbedding(page, 'asyncify'),
      paths = [
        '/outside-game',
        '../outside-game',
        'https://example.invalid/save',
        'game.xp3>save',
        '$(unknown)/save',
        './C:\\save',
        'inside/../web+file://host/save',
      ],
      rejected = await rejectSystemEmbeddingPaths(page, entry, paths)
    await info.attach('public-system-datapath-rejected-acquisitions', {
      contentType: 'application/json',
      body: JSON.stringify(
        { paths, rejected, wasmManifestHash, fontManifestHash, hashes },
        null,
        2,
      ),
    })
    expect(setup.workers).toEqual([])
    const expectedErrors = [
      /^Error: Invalid resource path:/,
      /^Error: Resource path escapes game root$/,
      /^Error: Invalid System dataPath: absolute URL or drive$/,
      /^Error: Invalid System dataPath: unknown macro or archive directory$/,
      /^Error: Invalid System dataPath: unknown macro or archive directory$/,
      /^Error: Invalid System dataPath: absolute URL or drive$/,
      /^Error: Invalid System dataPath: absolute URL or drive$/,
    ]
    for (const [index, item] of rejected.entries()) {
      expect(item.constructed).toBe(false)
      expect(item.error).toMatch(expectedErrors[index])
      expect(item.events).toBe(0)
      expect(item.audio).toBe(0)
      expect(item.before.installed).toContain('MessageChannel')
      expect(item.before.installed).toContain('Worker')
      expect(item.before.installed.some((name) => /AudioContext$/.test(name))).toBe(true)
      expect(item.before.errors).toEqual([])
      expect(item.after).toEqual(item.before)
    }
    expect(await page.locator('.game-window').count()).toBe(0)
    const recovered = await runSystemEmbedding(page, entry, 'asyncify')
    await expect.poll(() => setup.workers.map((worker) => worker.closed)).toEqual([true])
    expect(recovered.actual).toBe('savedata/|savedata/|other|1|savedata/|savedata/')
    expect(recovered).toMatchObject({
      supplied: false,
      configuredArgument: '<absent>',
      disposed: true,
      liveWindows: 0,
      errors: [],
    })
    expect(recovered.audio.at(-1)).toBe('closed')
    expect(setup.errors).toEqual([])
    await info.attach('public-system-datapath-rejected-recovery', {
      contentType: 'application/json',
      body: JSON.stringify(
        { recovered, workers: setup.workers.map(({ url, closed }) => ({ url, closed })) },
        null,
        2,
      ),
    })
  })
})
