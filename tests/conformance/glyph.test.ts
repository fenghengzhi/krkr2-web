import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { shadowGlyph, colorGlyph } from '../../src/engine/graphics/glyph.ts'
const reference = JSON.parse(
  readFileSync(new URL('../fixtures/font/native.json', import.meta.url), 'utf8'),
)
function finish<T>(work: Generator<void, T>): T {
  while (true) {
    const next = work.next()
    if (next.done) return next.value
  }
}
const mask = {
  width: 4,
  height: 3,
  left: -2,
  top: 3,
  coverage: new Uint8Array([0, 16, 64, 128, 255, 32, 200, 70, 30, 1, 254, 128]),
}
test('integer glyph shadow agrees with 30 independent native radius/level outputs', () => {
  for (const sample of reference.reports[0].shadows) {
    const actual = finish(shadowGlyph(mask, sample.level, sample.radius))
    assert.deepEqual([...actual.coverage], sample.coverage)
    assert.equal(actual.width, sample.width)
    assert.equal(actual.height, sample.height)
    assert.equal(actual.left, mask.left - sample.radius)
    assert.equal(actual.top, mask.top - sample.radius)
    if (sample.radius) {
      const negative = finish(shadowGlyph(mask, sample.level, -sample.radius))
      assert.deepEqual(negative.coverage, actual.coverage)
      assert.equal(negative.left, mask.left + sample.radius)
    }
  }
})
test('glyph coloring preserves every coverage byte and excludes color alpha', () => {
  const pixels = finish(colorGlyph(mask, 0xff123456))
  assert.equal(pixels.left, -2)
  assert.equal(pixels.top, 3)
  for (let i = 0; i < mask.coverage.length; i++)
    assert.deepEqual([...pixels.data.subarray(i * 4, i * 4 + 4)], [18, 52, 86, mask.coverage[i]])
})
