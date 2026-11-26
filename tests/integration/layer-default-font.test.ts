import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FontKernel } from '../../src/backends/text/freetype/face.ts'
import type { FontFactory, FontManifest } from '../../src/backends/text/freetype/module.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import type { InputView } from '../../src/engine/ports/input.ts'
import { headless } from '../helpers/headless.ts'
import { layerDefaultFontCases, layerDefaultFontSource, layerDefaultFontFrameMismatch } from '../helpers/layer-default-font.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: fresh Layer font keeps the native signed default and gives rendering and attention its absolute size`, { timeout: 60000 }, async () => {
    const directory = new URL('../../.generated/fonts/', import.meta.url),
      manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as FontManifest,
      factory = (await import(new URL(manifest.assets.mjs.file, directory).href)).default as FontFactory,
      kernel = new FontKernel(await factory({ wasmBinary: new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory))) })),
      face = kernel.open(new Uint8Array(await readFile(new URL('../fixtures/font/narrow.ttf', import.meta.url)))), failures: unknown[] = []
    let frame: FrameLayer[] = [], stop = async () => {}
    try {
      const { session, events } = await headless({ 'default-font.tjs': layerDefaultFontSource, 'startup.tjs': binary
        ? 'Scripts.compileStorage("default-font.tjs","savedata/default-font.cjs",false,true,false);Scripts.execStorage("savedata/default-font.cjs");defaultFontSample="AV 中";defaultFontMenu();'
        : 'Scripts.execStorage("default-font.tjs");defaultFontSample="AV 中";defaultFontMenu();' }, {
        // This headless embedding supplies an authored face for the requested
        // system name. Actual glyphs/metrics still use the fixed FreeType WASM.
        graphics: {
          decode: async () => { throw new Error('Unexpected image decode') },
          text: () => { throw new Error('The authored font must supply glyphs') },
          hasFont: (name) => name === 'ＭＳ Ｐゴシック',
          measure: (text, spec) => {
            assert.equal(spec.face, 'ＭＳ Ｐゴシック'); assert([12, 24].includes(spec.height))
            let width = 0; for (const ch of text) width += face.advance(ch, spec)
            return { width, height: spec.height, ascent: face.ascent(spec.height) }
          },
          glyph: (ch, spec, aa) => face.glyph(ch, spec, aa),
        }, renderer: { present(layers, width, height) {
          if (width === 320 && height === 144) frame = layers.map((layer) => ({ ...layer, pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
        }, dispose() {} },
      })
      stop = async () => { await session.stop(); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
      await session.start()
      const id = Number(await session.evaluate('defaultFontWindow.__windowId')),
        view = (): InputView => {
          for (let i = events.length - 1; i >= 0; i--) {
            const event = events[i]!
            if (event.type === 'window-input' && event.windowId === id) return event.input
          }
          throw new Error('No default-font attention publication')
        }
      for (const row of layerDefaultFontCases)
        assert.equal(await session.evaluate(`layerDefaultFontObserve(${JSON.stringify(row.id)})`), row.expected, row.id)
      for (const [phase, height] of [-12, 12, 24].entries()) {
        if (phase) {
          await session.input({ type: 'down', windowId: id, x: 160, y: 120, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId: id, x: 160, y: 120, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('defaultFontText.font.face+"|"+defaultFontText.font.height'), `ＭＳ Ｐゴシック|${height}`)
        assert.equal(await session.evaluate('defaultFontText.font.getTextHeight("AV")'), String(Math.abs(height)))
        assert.equal(frame.length, 1)
        const pixels = frame[0]!.pixels
        assert.equal(layerDefaultFontFrameMismatch(pixels.data, pixels.width, pixels.height, phase), null)
        assert.deepEqual(view().attention?.font, { face: 'ＭＳ Ｐゴシック', height, bold: false, italic: false, underline: false, strikeout: false })
        assert.deepEqual([view().attention?.x, view().attention?.y], [8, 36])
      }
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((save) => save.path === 'savedata/default-font.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try { face.dispose(); kernel.dispose() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Default Layer font or cleanup failed', { cause: failures[0] })
  })
