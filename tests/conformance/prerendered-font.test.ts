import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { readPrerenderedFont } from '../../src/formats/font/prerendered.ts'
const path = new URL('../fixtures/font/', import.meta.url)
const read = (name: string) => new Uint8Array(readFileSync(new URL(name, path)))
const reference = JSON.parse(readFileSync(new URL('reference.json', path), 'utf8'))
function finish<T>(work: Generator<void, T>): T {
  while (true) {
    const next = work.next()
    if (next.done) return next.value
  }
}
for (const version of [0, 1])
  test(`pre-rendered font v${version} restores indices, signed metrics and all 65 coverage levels`, () => {
    const font = finish(readPrerenderedFont(read(`coverage-v${version}.tft`)))
    assert.equal(font.glyphs.size, reference.glyphs.length)
    for (const entry of reference.glyphs) {
      const glyph = font.find(entry.code)!
      for (const key of [
        'width',
        'height',
        'originX',
        'originY',
        'incX',
        'incY',
        'advance',
      ] as const)
        assert.equal(glyph[key], entry[key])
      assert.deepEqual(
        [...glyph.coverage],
        entry.levels.map((n: number) => Math.min(255, n * 4)),
      )
    }
    for (const code of [0, 31, 33, 64, 67, 0x4e2e, 0xfffe]) assert.equal(font.find(code), undefined)
  })
test('malformed pre-rendered font indices, overlaps, coverage and runs are rejected', () => {
  const original = read('coverage-v1.tft')
  const change = (apply: (bytes: Uint8Array, view: DataView) => void) => {
    const bytes = original.slice()
    apply(bytes, new DataView(bytes.buffer))
    assert.throws(() => finish(readPrerenderedFont(bytes)))
  }
  for (const size of [0, 21, 35])
    assert.throws(() => finish(readPrerenderedFont(original.subarray(0, size))))
  change((bytes) => {
    bytes[22] = 2
  })
  change((bytes) => {
    bytes[23] = 1
  })
  change((_bytes, v) => v.setUint32(24, 65537, true))
  change((_bytes, v) => v.setUint32(28, 0, true))
  change((_bytes, v) => v.setUint32(32, 36, true))
  change((_bytes, v) => v.setUint16(38, 31, true))
  change((_bytes, v) => v.setUint32(68, 0, true))
  change((_bytes, v) => v.setUint16(72, 65535, true))
  const glyph = finish(readPrerenderedFont(original)).find(65)!
  assert.equal(glyph.width, 3)
  change((bytes, v) => {
    bytes[v.getUint32(68, true)] = 0x41
  })
  change((bytes, v) => {
    bytes[v.getUint32(68, true) + 1] = 0xff
  })
  assert.throws(
    () => finish(readPrerenderedFont(original.subarray(0, original.length - 1))),
    /Truncated/,
  )
})

test('glyph bytes and signed metadata match the compiled reference decoder', () => {
  const native = JSON.parse(readFileSync(new URL('native.json', path), 'utf8'))
  for (const report of native.reports) {
    const font = finish(readPrerenderedFont(read(`coverage-v${report.version}.tft`)))
    for (const glyph of report.glyphs)
      assert.deepEqual(
        { ...font.find(glyph.code), coverage: [...font.find(glyph.code)!.coverage] },
        glyph,
      )
  }
})
