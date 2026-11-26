import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { FontCatalog } from '../../src/engine/graphics/font-catalog.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import type { FontSpec } from '../../src/engine/ports/graphics.ts'
import { readFontMetadata } from '../../src/formats/font/metadata.ts'

const fixture = new URL('../fixtures/font-selection/collection.ttc', import.meta.url)
const font: FontSpec = { face: 'Selection Mono', height: 20, angle: 0,
  bold: false, italic: false, strikeout: false, underline: false }

test('a one-font embedding uses independent collection members across catalog refresh, direct filenames and cache release', async () => {
  const bytes = await readFile(fixture), file = { name: 'dialogue.otc', size: bytes.length, read: async () => bytes }
  const opened: string[] = [], released: string[] = []
  const fonts = new FontService(() => file, {
    decode: async () => { throw new Error('unexpected image') }, text: () => { throw new Error('unexpected raster') },
    async loadFont(bytes) {
      const { family } = await readFontMetadata({ size: bytes.length,
        read: async (at, size) => bytes.subarray(at, at + size) })
      opened.push(family)
      return { face: family, dispose() { released.push(family) } }
    },
    measure: (_text, spec) => ({ width: spec.face === 'Selection Mono' ? 14 : 10, height: spec.height }),
  }, async (work) => {
    let step = work.next()
    while (!step.done) step = work.next()
    return step.value
  })
  const catalog = new FontCatalog({ files: () => [file], resolve: () => file, bind: (names) => fonts.registerNamed(names),
    check() {}, yield: async () => {}, warn: (text) => { throw new Error(text) }, wait: (work) => work })
  try {
    await catalog.prepare()
    assert.deepEqual(catalog.list(8, font).map((face) => face.name), ['Selection Latin', 'Selection Mono', '@Selection Mono'])
    for (const [request, width] of [[font, 14], [{ ...font, face: file.name, faceIsFileName: true }, 10],
      [{ ...font, face: 'Selection Latin' }, 10], [{ ...font, face: '@Selection Mono' }, 14]] as const)
      assert.equal((await fonts.measure('A', request)).width, width)
    await catalog.prepare()
    assert.equal((await fonts.measure('A', font)).width, 14)
    assert.deepEqual(opened, ['Selection Mono', 'Selection Latin'])
    fonts.compact()
    assert.deepEqual(released.slice().sort(), opened.slice().sort())
    assert.equal((await fonts.measure('A', font)).width, 14)
  } finally { fonts.dispose() }
  assert.deepEqual(released.slice().sort(), opened.slice().sort())
})
