import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readVerticalSubstitutions } from '../../src/formats/font/vertical-substitutions.ts'
import { verticalOrientation, browserVerticalGlyph } from '../../src/engine/graphics/vertical.ts'
const directory = new URL('../fixtures/text-layout/', import.meta.url)
test('BMP vertical orientation matches Unicode 17 and uses presentation forms only for transformed characters', async () => {
  const values = Array.from({ length: 65536 }, () => 'R'),
    data = await readFile(
      new URL('../../third_party/unicode/VerticalOrientation-17.0.0.txt', import.meta.url),
      'utf8',
    )
  for (const raw of data.split('\n')) {
    const line = raw.split('#')[0]!.trim()
    if (!line) continue
    const [span, value] = line.split(';').map((s) => s.trim()),
      [from, to = from] = span!.split('..').map((s) => parseInt(s, 16))
    for (let code = from!; code <= Math.min(to!, 65535); code++) values[code] = value!
  }
  for (let code = 0; code < values.length; code++)
    assert.equal(verticalOrientation(code), values[code], code.toString(16))
  assert.deepEqual(browserVerticalGlyph('漢'), { character: '漢', upright: true })
  assert.deepEqual(browserVerticalGlyph('A'), { character: 'A', upright: false })
  assert.deepEqual(browserVerticalGlyph('、'), { character: '\ufe11', upright: true })
  assert.deepEqual(browserVerticalGlyph('（'), { character: '\ufe35', upright: true })
  for (const invalid of [-1, 65536, NaN, 0.5]) assert.equal(verticalOrientation(invalid), 'R')
})
test('vertical GSUB choices match native HarfBuzz across single, extension, range and multiple subtable fonts', async () => {
  const reference = JSON.parse(await readFile(new URL('shaping.json', directory), 'utf8')) as {
    fonts: Record<string, string>
    cases: {
      file: string
      feature: string | null
      nominal: number
      glyph: number
      substitution: number
    }[]
  }
  assert.equal(reference.cases.length, 56)
  for (const file of Object.keys(reference.fonts)) {
    const bytes = await readFile(new URL(file, directory)),
      layout = readVerticalSubstitutions(bytes)
    for (const row of reference.cases.filter((row) => row.file === file)) {
      assert.equal(layout?.feature ?? null, row.feature, file)
      assert.equal(
        layout?.substitute(row.nominal) ?? row.nominal,
        row.substitution,
        file + ' ' + row.nominal,
      )
    }
  }
})
test('malformed vertical table offsets fail without accessing outside the SFNT or GSUB table', async () => {
  const bytes = await readFile(new URL('vert.ttf', directory)),
    record = Array.from({ length: bytes.readUInt16BE(4) }, (_, i) => 12 + i * 16).find(
      (at) => bytes.toString('ascii', at, at + 4) === 'GSUB',
    )!,
    offset = bytes.readUInt32BE(record + 8),
    length = bytes.readUInt32BE(record + 12)
  const bad = Buffer.from(bytes)
  bad.writeUInt32BE(bytes.length + 1, record + 8)
  assert.throws(() => readVerticalSubstitutions(bad), /file bounds/)
  const feature = Buffer.from(bytes)
  feature.writeUInt16BE(length + 1, offset + 6)
  assert.throws(() => readVerticalSubstitutions(feature), /table bounds/)
  const tiny = Buffer.from(bytes)
  tiny.writeUInt32BE(9, record + 12)
  assert.throws(() => readVerticalSubstitutions(tiny), /bounds/)
  assert.equal(readVerticalSubstitutions(new Uint8Array()), undefined)
})
