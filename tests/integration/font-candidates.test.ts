import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { FontKernel, type NativeFileFont } from '../../src/backends/text/freetype/face.ts'
import type { FontFactory, FontManifest } from '../../src/backends/text/freetype/module.ts'
import type { FrameLayer } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
import { selectSoftwareFrame } from '../helpers/software-frame.ts'
import { fontCandidateCases, fontCandidateFrameMismatch, fontCandidateGameSource } from '../helpers/font-candidate-game.ts'

for (const binary of [false, true])
  test(`${binary ? 'bytecode' : 'source'}: ordinary dialogue selects packaged font candidates before enumeration and keeps direct-file reference pixels`, { timeout: 60000 }, async () => {
    const directory = new URL('../../.generated/fonts/', import.meta.url),
      manifest = JSON.parse(await readFile(new URL('manifest.json', directory), 'utf8')) as FontManifest,
      factory = (await import(new URL(manifest.assets.mjs.file, directory).href)).default as FontFactory,
      kernel = new FontKernel(await factory({ wasmBinary: new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory))) })),
      faces = new Map<string, NativeFileFont>(), failures: unknown[] = []
    let serial = 0, frame: FrameLayer[] = []
    let stop = async () => {}
    try {
    const { session } = await headless({
      'narrow.ttf': new Uint8Array(await readFile(new URL('../fixtures/font/narrow.ttf', import.meta.url))),
      'wide.ttf': new Uint8Array(await readFile(new URL('../fixtures/font/wide.ttf', import.meta.url))),
      'candidate.tjs': fontCandidateGameSource,
      'startup.tjs': binary
        ? 'Scripts.compileStorage("candidate.tjs","savedata/candidate.cjs",false,true,false);Scripts.execStorage("savedata/candidate.cjs");'
        : 'Scripts.execStorage("candidate.tjs");',
    }, { graphics: {
      decode: async () => { throw new Error('Unexpected image decode') },
      text: () => { throw new Error('A packaged candidate fell back to system text') },
      hasFont: () => false, // This headless host explicitly has no installed system faces.
      loadFont: async (bytes) => {
        const name = `candidate-${++serial}`, face = kernel.open(bytes); faces.set(name, face)
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
      await session.start()
      await selectSoftwareFrame(session, 'candidateWindow')
      const windowId = Number(await session.evaluate('candidateWindow.__windowId'))
      for (const [phase, row] of fontCandidateCases.entries()) {
        if (phase) {
          await session.input({ type: 'down', windowId, x: 60, y: 80, button: 0, shift: 8, clicks: 0 })
          await session.input({ type: 'up', windowId, x: 60, y: 80, button: 0, shift: 0, clicks: 1 })
        }
        await session.idle()
        assert.equal(await session.evaluate('candidateText.font.face'), row.face)
        assert.equal(await session.evaluate('candidateWidths[candidatePhase]'), String(row.width))
        assert.equal(frame.length, 1)
        const image = frame[0]!.pixels
        assert.equal(fontCandidateFrameMismatch(image.data, image.width, image.height, phase), null)
      }
      assert.equal(await session.evaluate('candidateWidths.join(",")'), '20,36,20,36,20')
      if (binary) assert.equal(new TextDecoder().decode(session.exportSaves().find((save) => save.path === 'savedata/candidate.cjs')!.bytes.subarray(0, 4)), 'TJS2')
    } catch (error) { failures.push(error) }
    try { await stop() } catch (error) { failures.push(error) }
    try { kernel.dispose() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length) throw new AggregateError(failures, 'Font candidate game or cleanup failed', { cause: failures[0] })
  })
