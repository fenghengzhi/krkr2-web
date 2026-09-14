import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { readFontMetadata, validFontName } from '../../src/formats/font/metadata.ts'
import { cssFontFamily } from '../../src/backends/text/browser/families.ts'
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
test('font names preserve Unicode and CSS generics retain their keyword meaning', () => {
  for (const name of ['Selection Mono', 'Café Ω', '字体 😀']) assert(validFontName(name))
  for (const name of ['', ' bad', 'bad\0name', '\ud800', 'x'.repeat(257)])
    assert(!validFontName(name))
  assert.equal(cssFontFamily('monospace'), 'monospace')
  assert.equal(cssFontFamily('serif'), 'serif')
  assert.equal(cssFontFamily('My "Font"'), String.raw`"My \"Font\""`)
  assert.equal(cssFontFamily('@Selection Mono'), '"Selection Mono"')
})
