import assert from 'node:assert/strict'
import test from 'node:test'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { mappedTextCases, mappedTextExpected, mappedTextFiles, mappedTextSource, mappedTextFrameMismatch } from '../helpers/mapped-text.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: mapped subtitles use stock 65-level colors, alpha and shadow before actual player fade clicks`, { timeout: 60000 }, async () => {
    let frame: FrameLayer[] = []
    const { session } = await headless({ ...mappedTextFiles(), 'mapped-text.tjs': mappedTextSource,
      'startup.tjs': 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;' + (binary
        ? 'Scripts.compileStorage("mapped-text.tjs","savedata/mapped-text.cjs",false,true,false);Scripts.execStorage("savedata/mapped-text.cjs");'
        : 'Scripts.execStorage("mapped-text.tjs");') }, {
      graphics: {
        decode: async () => { throw new Error('Unexpected image decode') },
        text: () => { throw new Error('The authored mapped glyph must not use a raster fallback') },
        measure: (_text, font) => ({ width: 0, height: font.height, ascent: 0 }),
      },
      renderer: { present(layers, width, height) {
        if (width === 320 && height === 112) frame = layers.map((layer) => ({ ...layer, pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
      }, dispose() {} },
    }), failures: unknown[] = []
    try {
      await session.start()
      for (const row of mappedTextCases) {
        const shadow = 'shadow' in row ? row.shadow : 'void'
        assert.equal(await session.evaluate(`mappedTextObserve(${JSON.stringify(row.id)},${row.face},${row.opacity},${row.hold},${shadow})`), mappedTextExpected(row), row.id)
      }
      await session.evaluate('mappedTextMenu()')
      const id = Number(await session.evaluate('mappedWindow.__windowId'))
      for (let phase = 0; phase < 4; phase++) {
        if (phase) {
          await session.input({ type: 'down', windowId: id, x: 160, y: 96, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId: id, x: 160, y: 96, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('mappedPhase'), String(phase))
        assert.equal(frame.length, 1)
        const pixels = frame[0]!.pixels
        assert.equal(mappedTextFrameMismatch(pixels.data, pixels.width, pixels.height, phase), null)
      }
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((save) => save.path === 'savedata/mapped-text.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Mapped subtitle or cleanup failed', { cause: failures[0] })
  })
