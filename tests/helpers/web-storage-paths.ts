import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { build } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'

const base = '/storage-paths-embedding-assets/'

/** Compiled only when the hosted browser suite runs, using the real public API and RPC Worker. */
export async function buildStorageEmbedding() {
  const manifestHashes = Object.fromEntries(
      await Promise.all(
        ['wasm', 'fonts'].map(async (kind) => [
          kind,
          createHash('sha256')
            .update(await readFile(resolve(`.generated/${kind}/manifest.json`)))
            .digest('hex'),
        ]),
      ),
    ),
    bundles = new Map<string, { body: Buffer; contentType: string }>(),
    hashes: { file: string; sha256: string }[] = [],
    id = 'virtual:storage-paths-embedding',
    resolvedId = '\0storage-paths-embedding',
    result = await build({
      configFile: false,
      publicDir: false,
      base,
      logLevel: 'error',
      plugins: [
        workerRpc({ pool: 1 }),
        {
          name: 'storage-paths-embedding-entry',
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
          `wasm/manifest-${manifestHashes.wasm.slice(0, 16)}.json`,
        ),
        __KRKR_FONT_MANIFEST_FILE__: JSON.stringify(
          `fonts/manifest-${manifestHashes.fonts.slice(0, 16)}.json`,
        ),
      },
      worker: { format: 'es' },
      build: {
        write: false,
        minify: false,
        target: 'es2022',
        rollupOptions: { input: { embedding: id }, preserveEntrySignatures: 'strict' },
      },
    }),
    output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      'output' in item ? item.output : [],
    )
  let entry = ''
  for (const item of output) {
    const source = item.type === 'chunk' ? item.code : item.source,
      body = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source)
    bundles.set(item.fileName, {
      body,
      contentType: item.fileName.endsWith('.css') ? 'text/css' : 'text/javascript',
    })
    hashes.push({ file: item.fileName, sha256: createHash('sha256').update(body).digest('hex') })
    if (item.type === 'chunk' && item.isEntry) entry = base + item.fileName
  }
  if (!entry || ![...bundles.keys()].some((name) => /session\.worker-.*\.js$/.test(name)))
    throw new Error('The canonical storage embedding must emit its real Session Worker')
  return {
    entry,
    bundles,
    provenance: {
      scope:
        'Separately compiled public Player API and real RPC Worker, actual hosted WASM/font assets and IndexedDB',
      manifestHashes,
      hashes,
    },
  }
}

export async function openStorageEmbedding(
  page: Page,
  fixture: Awaited<ReturnType<typeof buildStorageEmbedding>>,
) {
  await page.context().route('**/storage-paths-embedding-assets/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(base.length),
      asset = fixture.bundles.get(name)
    return route.fulfill(asset ?? { status: 404, body: `Missing storage embedding asset: ${name}` })
  })
  await page.route('**/storage-paths-embedding.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><meta charset="utf-8"><title>Canonical public storage paths</title>',
    }),
  )
  await page.goto('/storage-paths-embedding.html')
}

const source = String.raw`
var relative=System.dataPath+"CanonicalCounter.txt",canonical=Storages.getFullPath(relative),count=0;
if(Storages.isExistentStorage(canonical))count=int([].load(relative,"utf-8")[0]);
[string(++count)].save(canonical,"utf-8");
if([].load(relative,"utf-8")[0]!=string(count) || [].load(canonical,"utf-8")[0]!=string(count))throw "canonical-player-read-after-write";
if(Storages.getPlacedPath(relative)!==canonical)throw "canonical-player-placement";
Debug.message("canonical-player-ready");
`

export async function runStorageEmbedding(
  page: Page,
  entry: string,
  backend: 'asyncify' | 'jspi',
  dataPath?: string,
) {
  return page.evaluate(
    async ({ entry, backend, dataPath, source }) => {
      const { createPlayer, createGameWindows } = (await import(entry)) as {
          createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
          createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
        },
        root = document.createElement('main'),
        canvas = document.createElement('canvas'),
        errors: string[] = []
      root.append(canvas)
      document.body.append(root)
      const windows = createGameWindows(root, canvas, () => {})
      let player: ReturnType<typeof createPlayer> | undefined,
        markReady!: () => void,
        markError!: (error: unknown) => void
      const ready = new Promise<void>((resolve, reject) => {
        markReady = resolve
        markError = reject
      })
      // Observe rejections immediately as load() can fail before ready is awaited.
      void ready.catch(() => {})
      try {
        player = createPlayer(
          canvas,
          (event) => {
            if (event.type === 'log' && event.text === 'canonical-player-ready') markReady()
          },
          () => {},
          false,
          {
            windows,
            ...(dataPath === undefined ? {} : { dataPath }),
            onError: (error) => {
              errors.push(String(error))
              markError(error)
            },
          },
        )
        await player.load(
          [{ path: 'startup.tjs', blob: new Blob([source], { type: 'text/plain' }) }],
          'startup.tjs',
          backend,
        )
        await ready
        const actual = await player.session.evaluate('[System.dataPath,canonical,count].join("|")'),
          files = (await player.session.exportSaves()).map(({ path, bytes }) => ({
            path,
            bytes: Array.from(bytes),
          })),
          gameId = player.gameId
        await player.stop()
        return { actual, files, gameId, errors, disposed: player.session.isDisposed }
      } finally {
        try {
          await player?.stop()
        } finally {
          windows.dispose()
          root.remove()
        }
      }
    },
    { entry, backend, dataPath, source },
  )
}
