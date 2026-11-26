import assert from 'node:assert/strict'
import test from 'node:test'
import { fontFamilyNames } from '../../src/engine/graphics/font-family.ts'
import { cssFontStack } from '../../src/backends/text/browser/families.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import type { FontSpec } from '../../src/engine/ports/graphics.ts'

test('English and localized Mincho identities retain exact-name priority, vertical names and their serif family', () => {
  assert.deepEqual(fontFamilyNames('ＭＳ Ｐ明朝'), ['ＭＳ Ｐ明朝', 'MS PMincho'])
  assert.deepEqual(fontFamilyNames('@mS mInChO'), ['@mS mInChO', '@ＭＳ 明朝'])
  assert.deepEqual(fontFamilyNames('ＭＳ ゴシック'), ['ＭＳ ゴシック'])
  assert.equal(cssFontStack('ＭＳ Ｐ明朝,Game Font'), '"ＭＳ Ｐ明朝","MS PMincho","Game Font","Times New Roman","Liberation Serif","Times",serif')
  assert.equal(cssFontStack('MS PMincho'), '"MS PMincho","ＭＳ Ｐ明朝","Times New Roman","Liberation Serif","Times",serif')
  assert.equal(cssFontStack('\t@ＭＳ 明朝 '), '"ＭＳ 明朝","MS Mincho",serif')
  assert.equal(cssFontStack('MS Mincho'), '"MS Mincho","ＭＳ 明朝",serif')
  assert.equal(cssFontStack('ＭＳ ゴシック'), '"ＭＳ ゴシック",sans-serif')
})

test('trusted system and packaged Mincho names satisfy the same candidate without promoting a later family', async () => {
  const queries: string[] = [], selected: FontSpec[] = [], released: string[] = [], spec: FontSpec = {
    face: '', height: 20, angle: 0, bold: false, italic: false, underline: false, strikeout: false,
  }, fonts = new FontService(async () => { throw new Error('Unexpected direct-file lookup') }, {
    decode: async () => { throw new Error('No image') }, text: () => { throw new Error('No text') },
    hasFont: (name) => { queries.push(name); return false },
    loadFont: async (bytes) => ({ face: `file-${bytes[0]}`, dispose() { released.push(`file-${bytes[0]}`) } }),
    measure: (_text, font) => { selected.push(font); return { width: 1, height: 20 } },
  }, async (work) => { let row = work.next(); while (!row.done) row = work.next(); return row.value })
  const family = (id: number) => ({ resource: { name: id + '.ttf', size: 1, read: async () => new Uint8Array([id]) }, bold: false, italic: false })
  try {
    fonts.registerNamed(new Map([['game', [family(1)]]]))
    fonts.registerSystem(['MS PMincho'])
    await fonts.measure('A', { ...spec, face: 'ＭＳ Ｐ明朝,Game' })
    assert.equal(selected.at(-1)!.face, 'ＭＳ Ｐ明朝'); assert.deepEqual(queries, [])
    fonts.registerSystem(['ＭＳ 明朝'])
    await fonts.measure('A', { ...spec, face: 'MS Mincho,Game' })
    assert.equal(selected.at(-1)!.face, 'MS Mincho'); assert.deepEqual(queries, [])
    fonts.registerSystem([])
    await fonts.measure('A', { ...spec, face: 'ＭＳ Ｐ明朝,Game' })
    assert.equal(selected.at(-1)!.face, 'file-1'); assert.deepEqual(queries, ['ＭＳ Ｐ明朝'])
    fonts.registerNamed(new Map([['game', [family(1)]], ['ms pmincho', [family(2)]], ['ｍｓ ｐ明朝', [family(3)]]]))
    for (const [name, expected] of [['ＭＳ Ｐ明朝,Game', 'file-3'], ['MS PMincho,Game', 'file-2'],
      ['Game,ＭＳ Ｐ明朝', 'file-1'], ['@MS PMincho,Game', 'file-2']] as const) {
      await fonts.measure('A', { ...spec, face: name }); assert.equal(selected.at(-1)!.face, expected)
    }
    assert.equal(selected.at(-1)!.verticalFace, true)
    assert.deepEqual(queries, ['ＭＳ Ｐ明朝'])
  } finally { fonts.dispose() }
  assert.deepEqual(released.sort(), ['file-1', 'file-1', 'file-2', 'file-3'])
})
