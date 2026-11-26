import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FontKernel, type NativeFileFont } from '../../src/backends/text/freetype/face.ts'
import type { FontFactory, FontManifest } from '../../src/backends/text/freetype/module.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { selectSoftwareFrame } from '../helpers/software-frame.ts'
import { fontCollectionCases, fontCollectionFiles, fontCollectionFrameMismatch,
  fontCollectionGameSource, fontCollectionLists } from '../helpers/font-collection-game.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: a real font collection enumerates every family and selects physical styles without reusing its first face`, { timeout: 60000 }, async (t) => {
    const directory = new URL('../../.generated/fonts/', import.meta.url),
      manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as FontManifest,
      factory = (await import(new URL(manifest.assets.mjs.file, directory).href)).default as FontFactory,
      kernel = new FontKernel(await factory({ wasmBinary: new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory))) })),
      fixture = await fontCollectionFiles(), faces = new Map<string, NativeFileFont>(),
      opened: { collection: boolean; index: number }[] = [], failures: unknown[] = []
    let serial = 0, frame: FrameLayer[] = [], stop = async () => {}
    const open = async (bytes: Uint8Array, index: number) => {
      opened.push({ collection: String.fromCharCode(...bytes.subarray(0, 4)) === 'ttcf', index })
      const name = `collection-native-${++serial}`, face = kernel.open(bytes, index)
      faces.set(name, face)
      return { face: name, dispose() { face.dispose(); faces.delete(name) } }
    }
    try {
      const { session } = await headless({
        ...fixture.files, 'collection.tjs': fontCollectionGameSource,
        'startup.tjs': binary
          ? 'Scripts.compileStorage("collection.tjs","savedata/collection.cjs",false,true,false);Scripts.execStorage("savedata/collection.cjs");'
          : 'Scripts.execStorage("collection.tjs");',
      }, { graphics: {
        decode: async () => { throw new Error('Unexpected image decode') },
        text: () => { throw new Error('A collection family fell back to system rasterization') },
        hasFont: () => false,
        loadFont: (bytes) => open(bytes, 0),
        loadFontFace: (bytes, index) => open(bytes, index),
        measure: (text, spec) => {
          const face = faces.get(spec.face); assert(face, spec.face)
          let width = 0; for (const character of text) width += face.advance(character, spec)
          return { width, height: spec.height, ascent: face.ascent(spec.height) }
        },
        glyph: (character, spec, aa) => { const face = faces.get(spec.face); assert(face); return face.glyph(character, spec, aa) },
        dispose: () => kernel.dispose(),
      }, renderer: { present(layers, width, height) {
        if (width === 480 && height === 100)
          frame = layers.map((layer) => ({ ...layer, pixels: { ...layer.pixels, data: layer.pixels.data.slice() } }))
      }, dispose() {} } })
      stop = async () => {
        await session.stop(); assert.equal(faces.size, 0)
        assert(Object.values(session.inspectOwnership()).every((value) => value === 0))
      }
      await session.start()
      await selectSoftwareFrame(session, 'collectionWindow')
      assert.equal(await session.evaluate('collectionAll'), fontCollectionLists.all)
      assert.equal(await session.evaluate('collectionHorizontal'), fontCollectionLists.horizontal)
      assert.equal(await session.evaluate('collectionFixed'), fontCollectionLists.fixed)
      const windowId = Number(await session.evaluate('collectionWindow.__windowId'))
      for (const [phase, row] of fontCollectionCases.entries()) {
        if (phase) {
          await session.input({ type: 'down', windowId, x: 60, y: 80, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId, x: 60, y: 80, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('collectionText.font.face'), row.face)
        assert.equal(await session.evaluate('int(collectionText.font.bold)'), String(Number(row.bold)))
        assert.equal(await session.evaluate('int(collectionText.font.faceIsFileName)'), String(Number(row.file)))
        assert.equal(await session.evaluate('collectionWidths[collectionPhase]'), String(row.width))
        if (row.file) assert.equal(await session.evaluate('collectionText.font.getList(fsfTrueTypeOnly|fsfSameCharSet).join("|")'), fontCollectionLists.fileCharset)
        assert.equal(frame.length, 1)
        const image = frame[0]!.pixels
        assert.equal(fontCollectionFrameMismatch(image.data, image.width, image.height, phase), null)
      }
      assert.equal(await session.evaluate('collectionWidths.join(",")'), '20,28,36,20,20,28')
      assert.deepEqual(opened.filter((face) => face.collection).map((face) => face.index), [0, 1, 2])
      assert.deepEqual(opened.filter((face) => !face.collection).map((face) => face.index), [0, 0, 0])
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves().find((save) => save.path === 'savedata/collection.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    t.diagnostic(JSON.stringify({ fixture: fixture.evidence, opened,
      scope: 'Actual Session, physical FreeType collection members, direct standalone TTF references, complete displayed panel bytes and authored advances. This is not a Windows rasterizer equivalence claim.' }))
    try { await stop() } catch (error) { failures.push(error) }
    try { kernel.dispose() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Font collection gameplay or cleanup failed', { cause: failures[0] })
  })
