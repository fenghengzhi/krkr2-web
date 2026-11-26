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

test('mapped TFT shadows retain their native 65-level rounding before expansion to public RGBA', () => {
  const row = [0,64,128,192,255,192,64,0], glyph = { width: 8, height: 3, left: 0, top: 0,
    native65: true, coverage: Uint8Array.from([...row, ...row, ...row]) }
  const half = finish(shadowGlyph(glyph, 128, 0))
  assert.equal(half.native65, true)
  assert.deepEqual([...half.coverage.slice(0, 8)], [0,32,64,96,128,96,32,0])
  const blurred = finish(shadowGlyph(glyph, 255, 1))
  assert.equal(blurred.native65, true)
  assert.deepEqual([blurred.width, blurred.height, blurred.left, blurred.top], [10,5,-1,-1])
  assert.deepEqual([...blurred.coverage.slice(20, 30)], [0,12,56,108,176,192,152,68,12,0])
})

test('KAG outline emphasis 512 saturates coverage instead of rejecting it or wrapping an alpha byte', () => {
  const values = [0,16,64,128,200,255], plain = { width: 6, height: 1, left: 0, top: 0, coverage: Uint8Array.from(values) }
  assert.deepEqual([...finish(shadowGlyph(plain, 512, 0)).coverage], [0,32,128,255,255,255])
  assert.deepEqual([...finish(shadowGlyph(plain, 256, 0)).coverage], values)
  const row = [0,64,128,192,255,192,64,0], mapped = { width: 8, height: 3, left: 0, top: 0,
    native65: true, coverage: Uint8Array.from([...row, ...row, ...row]) }
  assert.deepEqual([...finish(shadowGlyph(mapped, 512, 0)).coverage.slice(0,8)], [0,128,255,255,255,255,128,0])
  const blurred = finish(shadowGlyph(mapped, 512, 1))
  assert.deepEqual([blurred.width,blurred.height,blurred.left,blurred.top], [10,5,-1,-1])
  assert.deepEqual([...blurred.coverage.slice(21,29)], [36,120,240,255,255,255,156,36])
})
