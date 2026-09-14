import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import type { FontSpec, GraphicsDecoder } from '../../src/engine/ports/graphics.ts'
import type { RasterGlyph } from '../../src/engine/ports/graphics.ts'
const font: FontSpec = {
  height: 20,
  face: 'synthetic',
  angle: 0,
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
}
test('bounds limits raster work per distinct glyph and rejects invalid backend counters', async () => {
  let samples = 16 * 1024 * 1024,
    calls = 0
  const service = new FontService(
    () => {
      throw new Error('No files')
    },
    {
      ...graphics,
      measureGlyph() {
        calls++
        return { left: 0, top: 0, right: 1, bottom: 1, advance: 1, rasterSamples: samples }
      },
    },
    finish,
  )
  try {
    assert.deepEqual(await service.bounds('A'.repeat(8192), font), {
      left: 0,
      top: 0,
      right: 8192,
      bottom: 1,
    })
    assert.equal(calls, 1)
    await assert.rejects(service.bounds('ABCDE', font), /raster budget/)
    for (const invalid of [-1, NaN, Infinity, 0.5]) {
      samples = invalid
      await assert.rejects(service.bounds('A', font), /Invalid glyph metrics/)
    }
  } finally {
    service.dispose()
  }
})
const finish = async <T>(work: Generator<void, T>) => {
  while (true) {
    const next = work.next()
    if (next.done) return next.value
  }
}
const graphics: GraphicsDecoder = {
  decode: async () => {
    throw new Error('Unexpected decode')
  },
  text: () => {
    throw new Error('Bounds must not rasterize a bitmap')
  },
  measure: () => ({ width: 10, height: 20, ascent: 16 }),
  measureGlyph(character, spec) {
    assert.equal(spec.angle, 0)
    return character === ' '
      ? { left: 0, top: 16, right: 0, bottom: 16, advance: 6 }
      : { left: 0, top: 2, right: 8, bottom: 16, advance: 10 }
  },
}
test('invalid native glyphs fail before pixel conversion and a valid next draw still succeeds', async () => {
  const valid: RasterGlyph = {
    width: 1,
    height: 1,
    left: 0,
    top: 0,
    advance: 1,
    coverage: new Uint8Array([255]),
  }
  let glyph = valid
  const service = new FontService(
    () => {
      throw new Error('No files')
    },
    { ...graphics, glyph: () => glyph },
    finish,
  )
  const options = {
    antialiased: true,
    shadowLevel: 0,
    shadowWidth: 0,
    shadowX: 0,
    shadowY: 0,
    shadowColor: 0,
  }
  try {
    for (const invalid of [
      { left: NaN },
      { height: -1 },
      { width: 4097 },
      { advance: 16777217 },
      { coverage: new Uint8Array(2) },
      { coverage: undefined },
    ]) {
      glyph = { ...valid, ...invalid } as RasterGlyph
      await assert.rejects(service.draw('A', font, 0xffffff, options), /Invalid font glyph/)
    }
    glyph = valid
    const draw = await service.draw('A', font, 0x123456, options)
    assert.equal(draw.length, 1)
    assert.deepEqual([...draw[0]!.pixels.data], [18, 52, 86, 255])
  } finally {
    service.dispose()
  }
})
test('glyph bounds return independent Rect objects and use font metrics despite pre-rendered maps', async () => {
  const { session } = await headless(
    {
      'startup.tjs': 'var w=new Window(),a=new Layer(w,null);a.font.height=20;',
      'font.tft': new Uint8Array(
        readFileSync(new URL('../fixtures/font/coverage-v1.tft', import.meta.url)),
      ),
    },
    { graphics },
  )
  try {
    await session.start()
    assert.equal(
      await session.evaluate(
        '(function(){var b=a.font.getGlyphDrawRect("A "),c=new Rect(b);b.addOffset(9,10);return [b instanceof "Rect",c.left,c.top,c.right,c.bottom,b.left,b.top].join(",");})()',
      ),
      '1,0,2,8,16,9,12',
    )
    await session.evaluate(
      '(function(){a.font.angle=2700;a.font.mapPrerenderedFont("font.tft");})()',
    )
    assert.equal(
      await session.evaluate(
        '(function(){var r=a.font.getGlyphDrawRect("A");return a.font.getTextWidth("A")+":"+[r.left,r.top,r.right,r.bottom].join(",");})()',
      ),
      '4:0,2,8,16',
    )
    await assert.rejects(session.evaluate('a.font.getGlyphDrawRect()'), /Missing text/)
  } finally {
    await session.stop()
  }
})
test('glyph bounds preserve the native first-character anchor and visit all UTF-16 units', async () => {
  const measured: string[] = []
  const service = new FontService(
    () => {
      throw new Error('No files')
    },
    {
      ...graphics,
      measureGlyph(char, spec) {
        measured.push(char)
        return graphics.measureGlyph!(char, spec)
      },
    },
    finish,
  )
  try {
    assert.deepEqual(await service.bounds('', font), { left: 0, top: 0, right: 0, bottom: 0 })
    assert.deepEqual(await service.bounds(' ', font), { left: 0, top: 16, right: 0, bottom: 16 })
    assert.deepEqual(await service.bounds(' A ', font), { left: 0, top: 2, right: 14, bottom: 16 })
    measured.length = 0
    assert.deepEqual(await service.bounds('A\0\ud800A', font), {
      left: 0,
      top: 2,
      right: 38,
      bottom: 16,
    })
    assert.deepEqual(measured, ['A', '\0', '\ud800'])
  } finally {
    service.dispose()
  }
})
test('glyph bounds load file fonts, reject invalid backend metrics and obey cancellation', async () => {
  let resolve!: (value: { face: string; dispose(): void }) => void,
    released = 0,
    measured = 0
  const service = new FontService(
    () => ({ name: 'font.ttf', size: 1, read: async () => new Uint8Array([1]) }),
    {
      ...graphics,
      loadFont: () =>
        new Promise((done) => {
          resolve = done
        }),
      measureGlyph(...args) {
        measured++
        return graphics.measureGlyph!(...args)
      },
    },
    finish,
  )
  const waiting = service.bounds('A', { ...font, faceIsFileName: true })
  await new Promise((done) => setTimeout(done, 0))
  service.dispose()
  resolve({
    face: 'late',
    dispose() {
      released++
    },
  })
  await assert.rejects(waiting, /Execution cancelled/)
  await new Promise((done) => setTimeout(done, 0))
  assert.equal(released, 1)
  assert.equal(measured, 0)
  const broken = new FontService(
    () => {
      throw new Error('No files')
    },
    { ...graphics, measureGlyph: () => ({ left: 0, top: 0, right: NaN, bottom: 1, advance: 1 }) },
    finish,
  )
  try {
    await assert.rejects(broken.bounds('A', font), /Invalid glyph metrics/)
    await assert.rejects(broken.bounds('A'.repeat(8193), font), /budget/)
  } finally {
    broken.dispose()
  }
})
