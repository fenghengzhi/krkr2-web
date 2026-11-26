import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFontFaces, readFontMetadata, validFontName } from '../../src/formats/font/metadata.ts'
import { standaloneFontBytes } from '../../src/formats/font/collection.ts'
import { cssFontFamily, cssFontStack } from '../../src/backends/text/browser/families.ts'
import { filterFonts } from '../../src/engine/graphics/font-catalog.ts'
import type { FontDescriptor } from '../../src/engine/ports/fonts.ts'
const root = new URL('../fixtures/font-selection/', import.meta.url)
const reference = JSON.parse(await readFile(new URL('reference.json', root), 'utf8')) as {
  cases: {
    file: string
    family: string
    fixedPitch: boolean | null
    outline: boolean
    charsets: (number | 'unicode')[]
    vertical: boolean
    bold: boolean
    italic: boolean
  }[]
}
const source = (bytes: Uint8Array) => ({
  size: bytes.length,
  read: async (offset: number, length: number) => bytes.subarray(offset, offset + length),
})
test('font filtering matches all 256 original native flag and charset combinations', async () => {
  const native = JSON.parse(await readFile(new URL('filter-reference.json', root), 'utf8')) as {
    rows: FontDescriptor[]
    cases: { flags: number; charset: number; names: string[] }[]
  }
  assert.equal(native.cases.length, 256)
  for (const row of native.cases)
    assert.deepEqual(
      filterFonts(native.rows, row.flags, row.charset).map((font) => font.name),
      row.names,
      JSON.stringify([row.flags, row.charset]),
    )
})
test('font metadata reads real name/post/OS2/cmap records, Mac Roman and first collection face', async () => {
  for (const row of reference.cases) {
    const bytes = await readFile(new URL(row.file, root)),
      actual = await readFontMetadata(source(bytes))
    assert.deepEqual(
      actual,
      {
        family: row.family,
        fixedPitch: row.fixedPitch ?? undefined,
        outline: row.outline,
        charsets: row.charsets,
        vertical: row.vertical,
        bold: row.bold,
        italic: row.italic,
      },
      row.file,
    )
  }
})
test('metadata reads bounded headers without glyph outlines and rejects broken directories or cancellation', async () => {
  const bytes = await readFile(new URL('latin.ttf', root)),
    count = bytes.readUInt16BE(4)
  const glyphRecord = Array.from({ length: count }, (_, i) => 12 + i * 16).find(
      (at) => bytes.toString('ascii', at, at + 4) === 'glyf',
    )!,
    glyphStart = bytes.readUInt32BE(glyphRecord + 8),
    glyphEnd = glyphStart + bytes.readUInt32BE(glyphRecord + 12)
  let readBytes = 0
  await readFontMetadata({
    size: bytes.length,
    read: async (offset, length) => {
      assert(offset + length <= glyphStart || offset >= glyphEnd, 'Metadata touched glyph outlines')
      readBytes += length
      return bytes.subarray(offset, offset + length)
    },
  })
  assert(readBytes < bytes.length)
  const broken = Buffer.from(bytes)
  broken.writeUInt32BE(bytes.length + 1, 20)
  await assert.rejects(readFontMetadata(source(broken)), /directory/)
  await assert.rejects(readFontMetadata(source(bytes.subarray(0, 11))), /budget/)
  await assert.rejects(
    readFontMetadata(source(bytes), () => {
      throw new Error('cancelled')
    }),
    /cancelled/,
  )
  await assert.rejects(
    readFontMetadata({ size: bytes.length, read: async () => new Uint8Array() }),
    /Truncated/,
  )
})

test('collection metadata follows each directory, shares table reads and leaves glyph outlines untouched', async () => {
  const ttc = await readFile(new URL('collection.ttc', root))
  const glyphs: [number, number][] = []
  for (let i = 0; i < ttc.readUInt32BE(8); i++) {
    const dir = ttc.readUInt32BE(12 + 4 * i)
    for (let j = 0; j < ttc.readUInt16BE(dir + 4); j++) {
      const at = dir + 12 + j * 16
      if (ttc.toString('ascii', at, at + 4) === 'glyf')
        glyphs.push([ttc.readUInt32BE(at + 8), ttc.readUInt32BE(at + 12)])
    }
  }
  assert.equal(glyphs.length, 2)
  const reads = new Set<string>(), metadata = []
  for await (const face of readFontFaces({ size: ttc.length, async read(at, length) {
    const range = at + ':' + length
    assert(!reads.has(range), 'shared table fetched twice: ' + range)
    reads.add(range)
    for (const [start, size] of glyphs) assert(at + length <= start || at >= start + size)
    return ttc.subarray(at, at + length)
  } })) metadata.push(face)
  for (const [i, name] of ['latin.ttf', 'mono.ttf'].entries())
    assert.deepEqual(metadata[i], await readFontMetadata(source(await readFile(new URL(name, root)))))
  assert.equal(metadata.length, 2)
})

test('a single-face loader receives the selected collection member with standalone offsets and checksums', async () => {
  const ttc = await readFile(new URL('collection.ttc', root))
  const original = Buffer.from(ttc)
  for (const [index, file] of ['latin.ttf', 'mono.ttf'].entries()) {
    const member = Buffer.from(standaloneFontBytes(ttc, index)), dir = ttc.readUInt32BE(12 + 4 * index)
    assert.deepEqual(await readFontMetadata(source(member)),
      await readFontMetadata(source(await readFile(new URL(file, root)))))
    let sum = 0
    for (let i = 0; i < member.length; i += 4) sum = (sum + member.readUInt32BE(i)) >>> 0
    assert.equal(sum, 0xb1b0afba)
    for (let j = 0; j < member.readUInt16BE(4); j++) {
      const record = 12 + j * 16, tag = member.toString('ascii', record, record + 4)
      const before = ttc.readUInt32BE(dir + record + 8), after = member.readUInt32BE(record + 8)
      const length = member.readUInt32BE(record + 12)
      assert.equal(length, ttc.readUInt32BE(dir + record + 12))
      const expected = ttc.subarray(before, before + length), actual = member.subarray(after, after + length)
      if (tag === 'head') {
        assert.deepEqual(actual.subarray(0, 8), expected.subarray(0, 8))
        assert.deepEqual(actual.subarray(12), expected.subarray(12))
      } else assert.deepEqual(actual, expected, tag)
    }
  }
  assert.deepEqual(ttc, original)
})
test('font names preserve Unicode and CSS generics retain their keyword meaning', () => {
  for (const name of ['Selection Mono', 'Café Ω', '字体 😀']) assert(validFontName(name))
  for (const name of ['', ' bad', 'bad\0name', '\ud800', 'x'.repeat(257)])
    assert(!validFontName(name))
  assert.equal(cssFontFamily('monospace'), 'monospace')
  assert.equal(cssFontFamily('serif'), 'serif')
  assert.equal(cssFontFamily('My "Font"'), String.raw`"My \"Font\""`)
  assert.equal(cssFontFamily('@Selection Mono'), '"Selection Mono"')
  assert.equal(cssFontStack('MS PMincho'), '"MS PMincho","Times New Roman","Liberation Serif","Times",serif')
  assert.equal(cssFontStack('@ms pmincho'), '"ms pmincho","Times New Roman","Liberation Serif","Times",serif')
  assert.equal(cssFontStack('MS PMincho,Game Face'), '"MS PMincho","Game Face","Times New Roman","Liberation Serif","Times",serif')
  assert.equal(cssFontStack('Game Face,MS PMincho'), '"Game Face","MS PMincho",sans-serif')
  assert.equal(cssFontStack('My "Font"'), String.raw`"My \"Font\"",sans-serif`)
})
