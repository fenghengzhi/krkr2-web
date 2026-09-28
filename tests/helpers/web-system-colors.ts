import { expect, type Page } from '@playwright/test'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { build } from 'vite'
import workerRpc from 'vite-plugin-worker-rpc'
import { prepareSystemPage } from './web-system-core.ts'

// The Web role mapping is part of the public contract, independent of the
// sampler implementation. These are CSS roles, not claimed Win32 RGB values.
export const expectedSystemColorCssNames = [
  'Canvas',
  'Canvas',
  'Canvas',
  'Canvas',
  'Canvas',
  'Canvas',
  'ButtonBorder',
  'CanvasText',
  'CanvasText',
  'CanvasText',
  'ButtonBorder',
  'ButtonBorder',
  'Canvas',
  'Highlight',
  'HighlightText',
  'ButtonFace',
  'ButtonFace',
  'GrayText',
  'ButtonText',
  'GrayText',
  'ButtonFace',
  'ButtonBorder',
  'ButtonBorder',
  'CanvasText',
  'Canvas',
  null,
  'LinkText',
  'Canvas',
  'Canvas',
  'Highlight',
  'Canvas',
] as const

/** Read browser-computed CSS colors without importing the production sampler. */
export async function readPageSystemColors(page: Page, selector: string) {
  return page.evaluate(
    ({ selector, names }) => {
      const anchor = document.querySelector(selector)
      if (!anchor) throw new Error(`Missing CSS color anchor: ${selector}`)
      const scheme = getComputedStyle(anchor).colorScheme,
        swatch = document.createElement('span'),
        canvas = document.createElement('canvas')
      swatch.style.colorScheme = scheme
      swatch.style.setProperty('transition', 'none', 'important')
      swatch.style.setProperty('animation', 'none', 'important')
      anchor.append(swatch)
      canvas.width = canvas.height = 1
      const context = canvas.getContext('2d')!
      try {
        const css: Record<string, string> = {},
          palette = names.map((name) => {
            if (name === null) return 0
            swatch.style.color = name
            const color = getComputedStyle(swatch).color
            css[name] = color
            context.clearRect(0, 0, 1, 1)
            context.fillStyle = color
            context.fillRect(0, 0, 1, 1)
            const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data
            if (a !== 255) throw new Error(`Non-opaque CSS system color: ${name}`)
            return r! * 65536 + g! * 256 + b!
          })
        return { scheme, css, palette }
      } finally {
        swatch.remove()
      }
    },
    { selector, names: expectedSystemColorCssNames },
  )
}

export const systemColorTextScript = `
var scTextWindow=new Window();scTextWindow.visible=true;scTextWindow.setInnerSize(48,48);
var scTextLayer=new Layer(scTextWindow,null);scTextLayer.type=ltOpaque;scTextLayer.setSize(48,48);
scTextLayer.fillRect(0,0,48,48,0xff202020);
scTextLayer.font.height=20;scTextLayer.font.face="narrow.ttf";scTextLayer.font.faceIsFileName=true;
scTextLayer.drawText(4,4,"A",0x80000008,255,false,255,0x01123456,0,16,0);
scTextLayer.drawText(4,28,"A",0x01123456,255,false,255,0x80000008,0,16,0);
var scTextPixels=[scTextLayer.getMainPixel(8,12),scTextLayer.getMainPixel(24,12),scTextLayer.getMainPixel(8,36),scTextLayer.getMainPixel(24,36)];
Debug.message("system-colors:text-ready");
`

export async function buildSystemColorsEmbedding() {
  const base = '/system-colors-embedding-assets/',
    bundles = new Map<string, { body: Buffer; contentType: string }>(),
    hashes: { file: string; sha256: string }[] = [],
    wasmManifestHash = createHash('sha256')
      .update(await readFile(resolve('.generated/wasm/manifest.json')))
      .digest('hex'),
    fontManifestHash = createHash('sha256')
      .update(await readFile(resolve('.generated/fonts/manifest.json')))
      .digest('hex'),
    id = 'virtual:system-colors-embedding',
    resolvedId = '\0system-colors-embedding',
    result = await build({
      configFile: false,
      publicDir: false,
      base,
      logLevel: 'error',
      plugins: [
        workerRpc({ pool: 1 }),
        {
          name: 'system-colors-embedding-entry',
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
        rollupOptions: { input: { embedding: id }, preserveEntrySignatures: 'strict' },
      },
    }),
    output = (Array.isArray(result) ? result : [result]).flatMap((item) =>
      'output' in item ? item.output : [],
    )
  let entry = ''
  for (const item of output) {
    const source = item.type === 'chunk' ? item.code : item.source,
      body = typeof source === 'string' ? Buffer.from(source, 'utf8') : Buffer.from(source),
      contentType = item.fileName.endsWith('.css')
        ? 'text/css'
        : item.fileName.endsWith('.wasm')
          ? 'application/wasm'
          : /\.m?js$/.test(item.fileName)
            ? 'text/javascript'
            : 'application/octet-stream'
    bundles.set(item.fileName, { body, contentType })
    hashes.push({ file: item.fileName, sha256: createHash('sha256').update(body).digest('hex') })
    if (item.type === 'chunk' && item.isEntry) entry = base + item.fileName
  }
  if (!entry || ![...bundles.keys()].some((file) => /session\.worker-.*\.js$/.test(file)))
    throw new Error('The color embedding must export createPlayer and emit its real Session Worker')
  return { base, bundles, hashes, entry, wasmManifestHash, fontManifestHash }
}

export async function openSystemColorsEmbedding(
  page: Page,
  backend: string,
  bundle: Awaited<ReturnType<typeof buildSystemColorsEmbedding>>,
) {
  const setup = await prepareSystemPage(page, backend)
  await page.context().route('**/system-colors-embedding-assets/**', (route) => {
    const name = new URL(route.request().url()).pathname.slice(bundle.base.length),
      found = bundle.bundles.get(name)
    if (!found)
      return route.fulfill({ status: 404, body: `Missing color embedding asset: ${name}` })
    return route.fulfill({ body: found.body, contentType: found.contentType })
  })
  await page.route('**/system-colors-embedding.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><meta charset="utf-8"><title>System color embedding contract</title>' +
        [...bundle.bundles.keys()]
          .filter((name) => name.endsWith('.css'))
          .map((name) => `<link rel="stylesheet" href="${bundle.base + name}">`)
          .join(''),
    }),
  )
  await page.goto('/system-colors-embedding.html')
  return setup
}

interface ColorEmbedding {
  player: ReturnType<typeof import('../../src/player/create-player.ts').createPlayer>
  root: HTMLElement
  errors: string[]
  logs: string[]
}
declare global {
  interface Window {
    systemColorEmbeddings?: ColorEmbedding[]
  }
}

/** Two concurrently live Players must retain separately copied startup palettes. */
export async function startSystemColorPlayers(
  page: Page,
  entry: string,
  backend: 'asyncify' | 'jspi',
  binary: boolean,
  palettes: readonly (readonly number[])[],
  source: string,
) {
  const font = Array.from(await readFile(resolve('tests/fixtures/font/narrow.ttf')))
  return page.evaluate(
    async ({ entry, backend, binary, palettes, source, font }) => {
      const { createPlayer, createGameWindows } = (await import(entry)) as {
        createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
        createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
      }
      window.systemColorEmbeddings = []
      const paletteReads: number[] = []
      for (const [index, palette] of palettes.entries()) {
        const root = document.createElement('main'),
          canvas = document.createElement('canvas'),
          logs: string[] = [],
          errors: string[] = []
        root.id = `system-color-player-${index}`
        root.className = 'stage'
        root.style.width = '320px'
        root.style.height = '128px'
        root.style.position = 'relative'
        root.append(canvas)
        document.body.append(root)
        const supplied = [...palette]
        let configuredPalette: readonly number[] | undefined = supplied,
          reads = 0
        const options: import('../../src/player/create-player.ts').PlayerOptions = {
            windows: createGameWindows(root, canvas, () => {}),
            get systemColors() {
              reads++
              if (reads > 1) throw new Error('Player read the system color option more than once')
              return configuredPalette
            },
            set systemColors(colors) {
              configuredPalette = colors
            },
            onError: (error) => errors.push(String(error)),
          },
          player = createPlayer(
            canvas,
            (event) => {
              if (event.type === 'log') logs.push(event.text)
            },
            () => {},
            false,
            options,
          )
        window.systemColorEmbeddings.push({ player, root, logs, errors })
        supplied.fill(0)
        options.systemColors = new Array<number>(31).fill(0)
        paletteReads.push(reads)
      }
      const results = []
      for (const [index, { player, logs, errors }] of window.systemColorEmbeddings.entries()) {
        const loaded = await player.load(
          [
            {
              path: 'startup.tjs',
              blob: new Blob([
                binary
                  ? 'Scripts.compileStorage("system-colors.tjs","savedata/system-colors.cjs",false,true,false);Scripts.execStorage("savedata/system-colors.cjs");'
                  : 'Scripts.execStorage("system-colors.tjs");',
              ]),
            },
            { path: 'system-colors.tjs', blob: new Blob([source]) },
            { path: 'narrow.ttf', blob: new Blob([new Uint8Array(font)]) },
            { path: 'identity.txt', blob: new Blob([`system-colors-player-${index}`]) },
          ],
          'startup.tjs',
          backend,
        )
        const rows = await player.session.evaluate('systemColorRows.join("\\n")'),
          pixels = await player.session.evaluate('scTextPixels.join(",")'),
          saved = (await player.session.exportSaves()).map(({ path, bytes }) => ({
            path,
            header: Array.from(bytes.subarray(0, 4)),
          }))
        results.push({ backend: loaded.backend, rows, pixels, logs, errors, saved })
      }
      // Read the first Player again after the second has initialized its palette.
      const firstAfterSecond = await window.systemColorEmbeddings[0]!.player.session.evaluate(
        '(function(){var colors=[];for(var i=0;i<31;i++)colors.add(System.toActualColor(0x80000000+i));return colors.join(",");})()',
      )
      return { results, firstAfterSecond, paletteReads }
    },
    { entry, backend, binary, palettes, source, font },
  )
}

export async function stopSystemColorPlayers(page: Page) {
  return page.evaluate(async () => {
    const results = []
    for (const { player, root, errors } of window.systemColorEmbeddings ?? []) {
      const cleanupErrors: string[] = []
      try {
        await player.stop()
      } catch (error) {
        cleanupErrors.push(`Player cleanup failed: ${String(error)}`)
      } finally {
        results.push({
          disposed: player.session.isDisposed,
          liveWindows: root.querySelectorAll('.game-window').length,
          errors: [...errors, ...cleanupErrors],
        })
        root.remove()
      }
    }
    delete window.systemColorEmbeddings
    return results
  })
}

export async function rejectInvalidSystemColorPlayers(page: Page, entry: string) {
  return page.evaluate(async (entry) => {
    const { createPlayer, createGameWindows } = (await import(entry)) as {
        createPlayer: typeof import('../../src/player/create-player.ts').createPlayer
        createGameWindows: typeof import('../../src/app/game-windows.ts').createGameWindows
      },
      valid = () => new Array<number>(31).fill(0),
      changed = (value: unknown) => {
        const palette: unknown[] = valid()
        palette[4] = value
        return palette
      },
      reserved = valid(),
      sparse = valid()
    reserved[25] = 1
    delete sparse[4]
    const cases: [string, unknown][] = [
        ['null', null],
        ['not-array', {}],
        ['short', valid().slice(1)],
        ['long', [...valid(), 0]],
        ['sparse', sparse],
        ['fraction', changed(1.5)],
        ['negative', changed(-1)],
        ['tagged', changed(0x80000005)],
        ['wide', changed(0x100000000)],
        ['nan', changed(NaN)],
        ['infinity', changed(Infinity)],
        ['string', changed('1')],
        ['reserved', reserved],
      ],
      results = []
    for (const [name, colors] of cases) {
      const root = document.createElement('main'),
        canvas = document.createElement('canvas')
      root.append(canvas)
      document.body.append(root)
      const windows = createGameWindows(root, canvas, () => {}),
        before = structuredClone(window.systemEmbeddingCounters)
      let player: ReturnType<typeof createPlayer> | undefined,
        error: string | null = null,
        events = 0,
        audio = 0
      try {
        player = createPlayer(
          canvas,
          () => events++,
          () => audio++,
          false,
          {
            windows,
            systemColors: colors as readonly number[],
          },
        )
      } catch (caught) {
        error = String(caught)
      } finally {
        try {
          await player?.stop()
        } finally {
          windows.dispose()
          root.remove()
        }
      }
      results.push({
        name,
        error,
        constructed: !!player,
        events,
        audio,
        before,
        after: structuredClone(window.systemEmbeddingCounters),
      })
    }
    return results
  }, entry)
}

export async function renderedTextSamples(page: Page, playerIndex: number) {
  const canvas = page.locator(`#system-color-player-${playerIndex} canvas:visible`)
  await expect(canvas).toHaveCount(1)
  await expect(canvas).toHaveJSProperty('width', 48)
  await expect(canvas).toHaveJSProperty('height', 48)
  await canvas.evaluate((element) => {
    element.style.width = '48px'
    element.style.height = '48px'
    element.style.imageRendering = 'pixelated'
    const bounds = element.getBoundingClientRect(),
      host = element.closest('.game-window') as HTMLElement
    host.style.translate = `${Math.ceil(bounds.left) - bounds.left}px ${Math.ceil(bounds.top) - bounds.top}px`
  })
  const png = await canvas.screenshot({ scale: 'css' }),
    pixels = await page.evaluate(
      async (url) => {
        const image = await createImageBitmap(await (await fetch(url)).blob()),
          context = new OffscreenCanvas(image.width, image.height).getContext('2d')!
        context.drawImage(image, 0, 0)
        const pixels = [
          [8, 12],
          [24, 12],
          [8, 36],
          [24, 36],
        ].map(([x, y]) => [
          ...context.getImageData(
            Math.floor(((x! + 0.5) * image.width) / 48),
            Math.floor(((y! + 0.5) * image.height) / 48),
            1,
            1,
          ).data,
        ])
        image.close()
        return pixels
      },
      'data:image/png;base64,' + png.toString('base64'),
    )
  return { png, pixels }
}
