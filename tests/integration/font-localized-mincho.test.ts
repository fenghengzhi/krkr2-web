import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FontKernel, type NativeFileFont } from '../../src/backends/text/freetype/face.ts'
import type { FontFactory, FontManifest } from '../../src/backends/text/freetype/module.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { selectSoftwareFrame } from '../helpers/software-frame.ts'
import { authoredMinchoFont, localizedMinchoCases, localizedMinchoFrameMismatch, localizedMinchoGameSource } from '../helpers/font-localized-mincho.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: localized Mincho dialogue names select packaged outlines and retain player font-choice order`, { timeout: 60000 }, async () => {
    const directory = new URL('../../.generated/fonts/', import.meta.url),
      manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as FontManifest,
      factory = (await import(new URL(manifest.assets.mjs.file, directory).href)).default as FontFactory,
      kernel = new FontKernel(await factory({ wasmBinary: new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory))) })),
      faces = new Map<string, NativeFileFont>(), failures: unknown[] = [],
      narrow = new Uint8Array(await readFile(new URL('../fixtures/font/narrow.ttf', import.meta.url))),
      wide = new Uint8Array(await readFile(new URL('../fixtures/font/wide.ttf', import.meta.url)))
    let serial = 0, frame: FrameLayer[] = [], stop = async () => {}
    try {
      const { session } = await headless({
        'narrow.ttf': narrow, 'wide.ttf': wide,
        'pmincho.ttf': authoredMinchoFont(narrow, 'MS PMincho'), 'mincho.ttf': authoredMinchoFont(wide, 'MS Mincho'),
        'dialogue.tjs': localizedMinchoGameSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("dialogue.tjs","savedata/dialogue.cjs",false,true,false);Scripts.execStorage("savedata/dialogue.cjs");'
          : 'Scripts.execStorage("dialogue.tjs");',
      }, { graphics: {
        decode: async () => { throw new Error('Unexpected image') }, text: () => { throw new Error('Packaged face fell back to system text') },
        hasFont: () => false,
        loadFont: async (bytes) => {
          const name = `mincho-${++serial}`, face = kernel.open(bytes); faces.set(name, face)
          return { face: name, dispose() { face.dispose(); faces.delete(name) } }
        },
        measure: (text, spec) => {
          const face = faces.get(spec.face); assert(face, spec.face)
          let width = 0; for (const ch of text) width += face.advance(ch, spec)
          return { width, height: spec.height, ascent: face.ascent(spec.height) }
        },
        glyph: (ch, spec, aa) => { const face = faces.get(spec.face); assert(face); return face.glyph(ch, spec, aa) },
        dispose: () => kernel.dispose(),
      }, renderer: { present(layers, width, height) {
        if (width === 360 && height === 100) frame = layers.map((layer) => ({ ...layer, pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
      }, dispose() {} } })
      stop = async () => {
        await session.stop(); assert.equal(faces.size, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      }
      await session.start(); await selectSoftwareFrame(session, 'candidateWindow')
      const windowId = Number(await session.evaluate('candidateWindow.__windowId'))
      for (const [phase, row] of localizedMinchoCases.entries()) {
        if (phase) {
          await session.input({ type: 'down', windowId, x: 60, y: 80, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId, x: 60, y: 80, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('candidateText.font.face'), row.face)
        assert.equal(await session.evaluate('candidateWidths[candidatePhase]'), String(row.width))
        assert.equal(frame.length, 1)
        const image = frame[0]!.pixels
        assert.equal(localizedMinchoFrameMismatch(image.data, image.width, image.height, phase), null)
      }
      assert.equal(await session.evaluate('candidateWidths.join(",")'), '20,20,36,36,36,20')
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves().find((save) => save.path === 'savedata/dialogue.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try { kernel.dispose() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Localized Mincho game or cleanup failed', { cause: failures[0] })
  })
