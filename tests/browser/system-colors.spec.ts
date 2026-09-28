import { expect, test } from '@playwright/test'
import { evaluate } from '../helpers/browser-expression.ts'
import {
  systemColorExpectedRows,
  systemColorPalette,
  systemColorsScript,
} from '../helpers/system-colors-script.ts'
import {
  observeSystemEmbeddingAcquisitions,
  prepareSystemPage,
  stopSystemPage,
  systemFiles,
} from '../helpers/web-system-core.ts'
import {
  buildSystemColorsEmbedding,
  openSystemColorsEmbedding,
  readPageSystemColors,
  rejectInvalidSystemColorPlayers,
  renderedTextSamples,
  startSystemColorPlayers,
  stopSystemColorPlayers,
  systemColorTextScript,
} from '../helpers/web-system-colors.ts'

const defaultSource = `
function browserSystemPalette(){var colors=[];for(var i=0;i<31;i++)colors.add(System.toActualColor(0x80000000+i));return colors.join(",");}
var browserInitialPalette=browserSystemPalette();
var browserColorWindow=new Window();browserColorWindow.visible=false;
var browserColorLayer=new Layer(browserColorWindow,null);browserColorLayer.type=ltAlpha;
browserColorLayer.setSize(2,2);browserColorLayer.fillRect(0,0,2,2,0x57112233);
browserColorLayer.setMainPixel(0,0,clWindow);
browserColorLayer.colorRect(1,0,1,1,clHighlight,255);
Debug.message("system-colors:default:"+browserInitialPalette);
`

for (const backend of ['asyncify', 'jspi'] as const) {
  for (const binary of [false, true]) {
    const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
    test(`${variant}: App samples the page CSS color scheme once and keeps its real Worker palette stable`, async ({
      page,
    }, info) => {
      const setup = await prepareSystemPage(page, backend)
      // Embedders can apply transitions to every span. Sampling must observe
      // the resolved system color instead of a temporary interpolated color.
      await page.addStyleTag({ content: 'span { transition: color 60s linear !important; }' })
      // The app creates its canvas inside this stage immediately before
      // createPlayer. A conflicting root scheme detects the wrong CSS ancestor.
      await page.locator('html').evaluate((element) => {
        element.style.colorScheme = 'dark'
      })
      await page.locator('#stage').evaluate((element) => {
        element.style.colorScheme = 'light'
      })
      const initial = await readPageSystemColors(page, '#stage')
      try {
        await page.locator('#files').setInputFiles(systemFiles(binary, defaultSource))
        await expect(
          page.getByText(`system-colors:default:${initial.palette.join(',')}`, { exact: true }),
        ).toBeVisible()
        await expect(page.locator('#runtime-info')).toContainText(backend.toUpperCase())
        expect(setup.workers).toHaveLength(1)
        expect(initial.scheme).toBe('light')
        await evaluate(
          page,
          '[browserColorLayer.getMainPixel(0,0),browserColorLayer.getMaskPixel(0,0),browserColorLayer.getMainPixel(1,0),browserColorLayer.getMaskPixel(1,0)].join(",")',
          `${initial.palette[5]},87,${initial.palette[13]},255`,
        )
        if (binary)
          await evaluate(page, 'Storages.isExistentStorage("savedata/system-core.cjs")', '1')
        await page.locator('#stage').evaluate((element) => {
          element.style.colorScheme = 'dark'
        })
        const changed = await readPageSystemColors(page, '#stage')
        expect(changed.scheme).toBe('dark')
        expect(changed.palette[5]).not.toBe(initial.palette[5])
        await evaluate(page, 'browserSystemPalette()', initial.palette.join(','))
        await evaluate(
          page,
          '(function(){browserColorLayer.setMainPixel(0,1,clWindow);return browserColorLayer.getMainPixel(0,1);})()',
          String(initial.palette[5]),
        )
        await evaluate(page, '6*7', '42')
        await info.attach('css-colors-and-real-app-worker-snapshot', {
          contentType: 'application/json',
          body: JSON.stringify({ variant, initial, changed }, null, 2),
        })
      } finally {
        await info.attach('system-colors-app-logs', {
          contentType: 'text/plain',
          body: await page.locator('#logs').innerText(),
        })
        await stopSystemPage(page, setup.errors)
        await expect.poll(() => setup.workers.every((worker) => worker.closed)).toBe(true)
      }
    })
  }
}

test.describe('public createPlayer system color palettes', () => {
  let bundle: Awaited<ReturnType<typeof buildSystemColorsEmbedding>>
  test.beforeAll(async () => {
    bundle = await buildSystemColorsEmbedding()
  })

  for (const backend of ['asyncify', 'jspi'] as const) {
    for (const binary of [false, true]) {
      const variant = `${backend}/${binary ? 'bytecode' : 'source'}`
      test(`${variant}: copied palettes reach separate real Workers, exact System and Layer entries, and visible file-font text`, async ({
        page,
      }, info) => {
        const setup = await openSystemColorsEmbedding(page, backend, bundle),
          otherPalette = systemColorPalette.map((value, index) =>
            index === 25 ? 0 : value ^ 0xffffff,
          ),
          palettes = [systemColorPalette, otherPalette]
        let proof: Awaited<ReturnType<typeof startSystemColorPlayers>> | undefined
        try {
          proof = await startSystemColorPlayers(
            page,
            bundle.entry,
            backend,
            binary,
            palettes,
            systemColorsScript + systemColorTextScript,
          )
          expect(proof.firstAfterSecond).toBe(systemColorPalette.join(','))
          expect(proof.paletteReads).toEqual([1, 1])
          expect(setup.workers).toHaveLength(2)
          expect(setup.workers.every((worker) => !worker.closed)).toBe(true)
          for (const [index, result] of proof.results.entries()) {
            const palette = palettes[index]!,
              textColors = [palette[8]!, 0x123456, 0x563412, 0x000008]
            expect(result.backend).toBe(backend)
            expect(result.rows).toBe(systemColorExpectedRows(palette).join('\n'))
            expect(result.pixels).toBe(textColors.join(','))
            expect(result.errors).toEqual([])
            expect(result.logs).toContain('system-colors:text-ready')
            expect(result.saved).toEqual(
              binary ? [{ path: 'savedata/system-colors.cjs', header: [84, 74, 83, 50] }] : [],
            )
            const rendered = await renderedTextSamples(page, index)
            await info.attach(`system-color-player-${index}-real-file-font`, {
              body: rendered.png,
              contentType: 'image/png',
            })
            expect(rendered.pixels).toEqual(
              textColors.map((color) => [color >>> 16, (color >>> 8) & 255, color & 255, 255]),
            )
          }
        } finally {
          const cleanup = await stopSystemColorPlayers(page)
          await info.attach('public-color-palettes-real-worker-proof', {
            contentType: 'application/json',
            body: JSON.stringify(
              {
                variant,
                palettes,
                proof,
                cleanup,
                scope:
                  'Public createPlayer and createGameWindows, actual Session Worker, hosted native WASM and file-font kernel; no runtime or glyph doubles',
                wasmManifestHash: bundle.wasmManifestHash,
                fontManifestHash: bundle.fontManifestHash,
                hashes: bundle.hashes,
                workers: setup.workers.map(({ url, closed }) => ({ url, closed })),
              },
              null,
              2,
            ),
          })
          expect(cleanup).toEqual(
            palettes.map(() => ({ disposed: true, liveWindows: 0, errors: [] })),
          )
          await expect.poll(() => setup.workers.every((worker) => worker.closed)).toBe(true)
          expect(setup.errors).toEqual([])
        }
      })
    }
  }

  test('invalid palettes reject before host acquisition and a fresh valid public Player still runs', async ({
    page,
  }, info) => {
    await observeSystemEmbeddingAcquisitions(page)
    const setup = await openSystemColorsEmbedding(page, 'asyncify', bundle),
      rejected = await rejectInvalidSystemColorPlayers(page, bundle.entry)
    await info.attach('invalid-system-color-palette-acquisitions', {
      contentType: 'application/json',
      body: JSON.stringify(rejected, null, 2),
    })
    expect(setup.workers).toEqual([])
    expect(rejected).toHaveLength(13)
    for (const result of rejected) {
      expect(result.constructed).toBe(false)
      expect(result.error).toMatch(/^Error: System color/)
      expect(result.events).toBe(0)
      expect(result.audio).toBe(0)
      expect(result.before.installed).toContain('MessageChannel')
      expect(result.before.installed).toContain('Worker')
      expect(result.before.installed.some((name) => /AudioContext$/.test(name))).toBe(true)
      expect(result.before.errors).toEqual([])
      expect(result.after).toEqual(result.before)
    }
    try {
      const recovered = await startSystemColorPlayers(
        page,
        bundle.entry,
        'asyncify',
        false,
        [systemColorPalette],
        systemColorsScript + systemColorTextScript,
      )
      expect(recovered.results[0]!.rows).toBe(systemColorExpectedRows().join('\n'))
      expect(recovered.results[0]!.errors).toEqual([])
    } finally {
      expect(await stopSystemColorPlayers(page)).toEqual([
        { disposed: true, liveWindows: 0, errors: [] },
      ])
      await expect.poll(() => setup.workers.map((worker) => worker.closed)).toEqual([true])
      expect(setup.errors).toEqual([])
    }
  })
})
