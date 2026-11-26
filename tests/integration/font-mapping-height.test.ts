import assert from 'node:assert/strict'
import test from 'node:test'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { selectSoftwareFrame } from '../helpers/software-frame.ts'
import { fontMappingHeightCases, fontMappingHeightFiles, fontMappingHeightSource, fontMappingHeightMismatch } from '../helpers/font-mapping-height.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: default and normalized font heights retain independent mapped subtitle glyphs`, { timeout: 60000 }, async () => {
    let frame: FrameLayer[] = []
    const { session } = await headless({ ...fontMappingHeightFiles(), 'signed-font.tjs': fontMappingHeightSource,
      'startup.tjs': 'System.exitOnNoWindowStartup=false;System.exitOnWindowClose=false;' + (binary
        ? 'Scripts.compileStorage("signed-font.tjs","savedata/signed-font.cjs",false,true,false);Scripts.execStorage("savedata/signed-font.cjs");'
        : 'Scripts.execStorage("signed-font.tjs");') }, {
      graphics: {
        decode: async () => { throw new Error('Unexpected image decode') },
        text: () => { throw new Error('The mapped subtitle must not rasterize a fallback glyph') },
        measure: (text, font) => {
          assert.equal(font.height, 12, 'Raster backends retain the positive drawing height')
          return { width: text.length * 6, height: font.height, ascent: 0 }
        },
      },
      renderer: { present(layers, width, height) {
        if (width === 320 && height === 144) frame = layers.map((layer) => ({ ...layer, pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
      }, dispose() {} },
    }), failures: unknown[] = []
    try {
      await session.start()
      for (const row of fontMappingHeightCases)
        assert.equal(await session.evaluate(`fontMappingHeightObserve(${JSON.stringify(row.id)})`), row.expected, row.id)
      await session.evaluate('signedFontMenu()')
      await selectSoftwareFrame(session, 'signedFontWindow')
      const id = Number(await session.evaluate('signedFontWindow.__windowId'))
      for (let phase = 0; phase < 3; phase++) {
        if (phase) {
          await session.input({ type: 'down', windowId: id, x: 160, y: 120, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId: id, x: 160, y: 120, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('[signedFontPhase,signedFontLeft.font.height,signedFontLeft.font.getTextWidth("AA"),signedFontRight.font.getTextWidth("AA")].join("|")'),
          `${phase}|${phase === 1 ? 12 : -12}|${phase === 1 ? 106 : 74}|106`)
        assert.equal(frame.length, 1)
        const pixels = frame[0]!.pixels
        assert.equal(fontMappingHeightMismatch(pixels.data, pixels.width, pixels.height, phase), null)
      }
      if (binary) assert.equal(Buffer.from(session.exportSaves().find((save) => save.path === 'savedata/signed-font.cjs')!.bytes).toString('ascii', 0, 4), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await session.stop(); assert(Object.values(session.inspectOwnership()).every((count) => count === 0)) }
    catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Signed subtitle mappings or cleanup failed', { cause: failures[0] })
  })
