import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { FontKernel, type NativeFileFont } from '../../src/backends/text/freetype/face.ts'
import { headless } from '../helpers/headless.ts'
import type { FontFactory, FontManifest } from '../../src/backends/text/freetype/module.ts'
import type { FontSpec, RasterGlyph } from '../../src/engine/ports/graphics.ts'
const directory = new URL('../../.generated/fonts/', import.meta.url),
  manifest = JSON.parse(
    await readFile(new URL('manifest.json', directory), 'utf8'),
  ) as FontManifest,
  factory = (await import(new URL(manifest.assets.mjs.file, directory).href))
    .default as FontFactory,
  binary = new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory))),
  open = async () => new FontKernel(await factory({ wasmBinary: binary })),
  bytes = async (name: string) =>
    new Uint8Array(
      await readFile(new URL('../fixtures/text-layout/' + name + '.ttf', import.meta.url)),
    ),
  font: FontSpec = {
    height: 20,
    face: '@fixture',
    angle: 2700,
    bold: false,
    italic: false,
    underline: false,
    strikeout: false,
  },
  horizontal = { ...font, face: 'fixture', angle: 0 },
  alpha = (glyph: RasterGlyph, x: number, y: number) => {
    x -= glyph.left
    y -= glyph.top
    return x < 0 || y < 0 || x >= glyph.width || y >= glyph.height
      ? 0
      : glyph.coverage[y * glyph.width + x]!
  }
test('file vertical faces retain upright ideographs, rotate Latin once and use actual vert/vrt2 glyphs', async () => {
  const kernel = await open()
  try {
    const source = await bytes('vert'),
      face = kernel.open(source),
      vrt2 = kernel.open(await bytes('vrt2')),
      fallback = kernel.open(await bytes('none'))
    source.fill(0)
    const han = face.glyph('漢', font, true),
      plain = face.glyph('漢', horizontal, true)
    assert.deepEqual(han.coverage, plain.coverage)
    assert.deepEqual([han.left, han.top, han.advance], [plain.left - 20, plain.top, 20])
    const latin = face.glyph('A', font, true),
      normal = face.glyph('A', horizontal, true)
    assert.deepEqual([latin.width, latin.height, latin.advance], [normal.height, normal.width, 12])
    for (let y = 0; y < latin.height; y++)
      for (let x = 0; x < latin.width; x++)
        assert.equal(
          latin.coverage[y * latin.width + x],
          normal.coverage[(normal.height - 1 - x) * normal.width + y],
        )
    const alternate = vrt2.glyph('A', font, true),
      encoded = vrt2.glyph('\ue004', horizontal, true)
    assert.deepEqual(alternate.coverage, encoded.coverage)
    assert.deepEqual([alternate.width, alternate.height, alternate.advance], [14, 8, 12])
    for (const [character, presentation] of [
      ['、', '\ue001'],
      ['（', '\ue002'],
      ['ぁ', '\ue003'],
    ]) {
      const selected = face.glyph(character!, font, true),
        expected = face.glyph(presentation!, horizontal, true)
      assert.deepEqual(selected.coverage, expected.coverage)
    }
    for (const ch of ['、', '（'])
      assert.deepEqual(fallback.glyph(ch, font, true), face.glyph(ch, font, true))
    assert.equal(face.advance('A', font), 12)
    assert.equal(face.advance('漢', font), 20)
    // The original file-name path retains its independently tested FreeType angle behavior.
    assert.deepEqual(
      face.glyph('A', { ...horizontal, angle: 2700 }, true).coverage,
      normal.coverage,
    )
  } finally {
    kernel.dispose()
  }
})
test('vertical underline and strikeout follow the writing axis and survive all four cardinal angles', async () => {
  const kernel = await open(),
    face = kernel.open(await bytes('vert'))
  try {
    const under = face.glyph('漢', { ...font, underline: true }, true)
    assert.equal(alpha(under, -19, 0), 255)
    assert.equal(alpha(under, -19, 19), 255)
    assert.equal(alpha(under, -19, 20), 0)
    const strike = face.glyph('漢', { ...font, strikeout: true }, true)
    assert.equal(alpha(strike, -12, 19), 255)
    for (const angle of [0, 900, 1800, 2700])
      for (const antialiased of [true, false]) {
        const glyph = face.glyph(
          '漢',
          { ...font, angle, underline: true, strikeout: true },
          antialiased,
        )
        assert(glyph.coverage.some((v) => v === 255))
        if (!antialiased) assert(glyph.coverage.every((v) => v === 0 || v === 255))
        assert.deepEqual(
          face.metrics('漢', { ...font, angle, underline: true }),
          face.metrics('漢', { ...font, angle: 0, underline: true }),
        )
      }
    assert.deepEqual(
      face.glyph(' ', { ...font, underline: true }, true).coverage,
      new Uint8Array(10).fill(255),
    )
  } finally {
    kernel.dispose()
  }
})
test('invalid vertical layouts stay isolated from horizontal drawing and invalid transforms recover', async () => {
  const kernel = await open(),
    source = await bytes('vert'),
    view = new DataView(source.buffer)
  const record = Array.from({ length: view.getUint16(4) }, (_, i) => 12 + i * 16).find(
      (at) => view.getUint32(at) === 0x47535542,
    )!,
    offset = view.getUint32(record + 8)
  view.setUint16(offset + 6, 65535)
  const face = kernel.open(source)
  try {
    assert(face.glyph('漢', horizontal, true).coverage.some((v) => v > 0))
    assert.throws(() => face.glyph('漢', font, true), /table bounds/)
    assert(face.glyph('漢', horizontal, true).coverage.some((v) => v > 0))
    const pointer = kernel.module._malloc!(60)
    try {
      kernel.module.HEAP32.fill(0, pointer / 4, pointer / 4 + 15)
      assert.equal(kernel.module._krfont_glyph_index!(1, 20, 0, 3, pointer), 0)
      assert.equal(kernel.module._krfont_error!(), -1)
    } finally {
      kernel.module._free!(pointer)
    }
    assert(face.glyph('漢', horizontal, true).coverage.some((v) => v > 0))
  } finally {
    kernel.dispose()
  }
})
test('explicit vertical family names use game fonts with synthesized metrics when vhea/vmtx are absent', async () => {
  const kernel = await open(),
    faces = new Map<string, NativeFileFont>()
  let loads = 0
  const { session } = await headless(
    {
      'startup.tjs':
        'var w=new Window(),a=new Layer(w,null);w.visible=true;w.setInnerSize(32,32);a.setSize(32,32);a.type=ltAlpha;a.font.getList(0);a.font.face="@Krkr Vertical novmetrics";a.font.height=20;a.font.angle=2700;a.drawText(24,0,"漢",0xffffff);',
      'novmetrics.ttf': await bytes('novmetrics'),
    },
    {
      graphics: {
        decode: async () => {
          throw new Error('unexpected image')
        },
        text: () => {
          throw new Error('unexpected browser fallback')
        },
        loadFont: async (bytes) => {
          const name = 'face-' + ++loads,
            face = kernel.open(bytes)
          faces.set(name, face)
          return {
            face: name,
            dispose: () => {
              face.dispose()
              faces.delete(name)
            },
          }
        },
        measure: (text, spec) => {
          const face = faces.get(spec.face)
          assert(face)
          let width = 0
          for (const char of text) width += face.advance(char, spec)
          return { width, height: spec.height, ascent: face.ascent(spec.height) }
        },
        glyph: (char, spec, aa) => {
          const face = faces.get(spec.face)
          assert(face)
          return face.glyph(char, spec, aa)
        },
        measureGlyph: (char, spec) => {
          const face = faces.get(spec.face)
          assert(face)
          return face.metrics(char, spec)
        },
        dispose: () => kernel.dispose(),
      },
    },
  )
  try {
    await session.start()
    assert.equal(loads, 1)
    assert.equal(await session.evaluate('a.font.getTextWidth("漢")'), '20')
    assert.equal(
      await session.evaluate('a.font.getList(fsfTrueTypeOnly).join(",")'),
      'Krkr Vertical novmetrics',
    )
    assert.equal(await session.evaluate('a.getMaskPixel(7,4)'), '255')
    assert.equal(await session.evaluate('a.getMaskPixel(7,2)'), '0')
  } finally {
    await session.stop()
    kernel.dispose()
  }
  assert.equal(faces.size, 0)
})
