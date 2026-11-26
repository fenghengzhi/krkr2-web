import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FontKernel } from '../../src/backends/text/freetype/face.ts'
import type { FontFactory, FontManifest } from '../../src/backends/text/freetype/module.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { selectSoftwareFrame } from '../helpers/software-frame.ts'
import { textMetricCases, textMetricFiles, textMetricSource, textMetricFrameMismatch } from '../helpers/text-metric-cache.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: dialogue blank rows follow the owning bitmap font cache through text, font and image changes`, { timeout: 60000 }, async () => {
    const directory = new URL('../../.generated/fonts/', import.meta.url),
      manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as FontManifest,
      factory = (await import(new URL(manifest.assets.mjs.file, directory).href)).default as FontFactory,
      kernel = new FontKernel(await factory({ wasmBinary: new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory))) })),
      face = kernel.open(new Uint8Array(await readFile(new URL('../fixtures/font/narrow.ttf', import.meta.url)))), failures: unknown[] = []
    let frame: FrameLayer[] = [], stop = async () => {}
    try {
      const { session } = await headless({ ...textMetricFiles(), 'text-metric.tjs': textMetricSource, 'startup.tjs': binary
        ? 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;Scripts.compileStorage("text-metric.tjs","savedata/text-metric.cjs",false,true,false);Scripts.execStorage("savedata/text-metric.cjs");'
        : 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;Scripts.execStorage("text-metric.tjs");' }, {
        graphics: {
          decode: async () => { throw new Error('Unexpected image decode') },
          text: () => { throw new Error('The authored font must supply glyphs') },
          hasFont: (name) => name === 'ＭＳ Ｐゴシック',
          measure: (text, spec) => {
            assert.equal(spec.face, 'ＭＳ Ｐゴシック'); assert.equal(spec.height, 24)
            let width = 0; for (const ch of text) width += face.advance(ch, spec)
            return { width, height: spec.height, ascent: face.ascent(spec.height) }
          },
          glyph: (ch, spec, aa) => face.glyph(ch, spec, aa),
        }, renderer: { present(layers, width, height) {
          if (width === 320 && height === 112) frame = layers.map((layer) => ({ ...layer, pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
        }, dispose() {} },
      })
      stop = async () => { await session.stop(); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
      await session.start()
      for (const row of textMetricCases)
        assert.equal(await session.evaluate(`textMetricObserve(${JSON.stringify(row.id)})`), row.expected, row.id)
      await session.evaluate('textMetricMenu()')
      await selectSoftwareFrame(session, 'textMetricWindow')
      const id = Number(await session.evaluate('textMetricWindow.__windowId'))
      for (const [phase, height] of [0, 24, 24, 0].entries()) {
        if (phase) {
          await session.input({ type: 'down', windowId: id, x: 160, y: 96, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId: id, x: 160, y: 96, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('textMetricPhase+"|"+textMetricHeight'), `${phase}|${height}`)
        assert.equal(frame.length, 1)
        const pixels = frame[0]!.pixels
        assert.equal(textMetricFrameMismatch(pixels.data, pixels.width, pixels.height, phase), null)
      }
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((save) => save.path === 'savedata/text-metric.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try { face.dispose(); kernel.dispose() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Dialogue text metrics or cleanup failed', { cause: failures[0] })
  })
