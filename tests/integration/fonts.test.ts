import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { headless } from '../helpers/headless.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import type { GraphicsDecoder, FontSpec, LoadedFont } from '../../src/engine/ports/graphics.ts'
const fixture = (name: string) =>
  new Uint8Array(readFileSync(new URL('../fixtures/font/' + name, import.meta.url)))
const graphics: GraphicsDecoder = {
  async decode() {
    throw new Error('Unexpected image')
  },
  measure(text) {
    return { width: text.length * 9, height: 8, ascent: 6 }
  },
  text() {
    return { width: 1, height: 1, left: 0, top: 1, data: new Uint8Array([255, 255, 255, 255]) }
  },
}
const setup =
  'var w=new Window();w.visible=true;var a=new Layer(w,null),b=new Layer(w,a);a.setSize(32,32);b.setSize(32,32);a.type=ltAlpha;b.type=ltAlpha;a.font.height=8;b.font.height=8;'
test('font mappings share complete settings across layers, restore on settings changes and survive failed replacement', async () => {
  const { session } = await headless(
    { 'startup.tjs': setup, 'font.tft': fixture('coverage-v1.tft'), 'bad.tft': new Uint8Array(40) },
    { graphics },
  )
  try {
    await session.start()
    await session.evaluate('a.font.mapPrerenderedFont("font.tft")')
    assert.equal(
      await session.evaluate('a.font.getTextWidth("AB")+","+b.font.getTextWidth("AB")'),
      '11,11',
    )
    await session.evaluate('b.font.bold=true')
    assert.equal(await session.evaluate('b.font.getTextWidth("AB")'), '18')
    await session.evaluate('b.font.bold=false')
    assert.equal(await session.evaluate('b.font.getTextWidth("AB")'), '11')
    assert.equal(
      await session.evaluate(
        '(function(){try{a.font.mapPrerenderedFont("bad.tft");}catch(e){return b.font.getTextWidth("AB");}})()',
      ),
      '11',
    )
    await session.evaluate('b.font.unmapPrerenderedFont()')
    assert.equal(await session.evaluate('a.font.getTextWidth("AB")'), '18')
    await session.evaluate('Scripts.exec("a.font.height=-8;a.font.angle=-900;")')
    assert.equal(await session.evaluate('a.font.height+","+a.font.angle'), '8,2700')
  } finally {
    await session.stop()
  }
})
for (const version of [0, 1])
  test(`pre-rendered v${version} drawing uses coverage, origins and per-glyph advances rather than measured string width`, async () => {
    const { session } = await headless(
      {
        'startup.tjs':
          setup + `a.font.mapPrerenderedFont("font.tft");a.drawText(0,0,"AB",0x123456);`,
        'font.tft': fixture(`coverage-v${version}.tft`),
      },
      { graphics },
    )
    try {
      await session.start()
      assert.equal(await session.evaluate('a.getMainPixel(1,5)'), String(0x123456))
      assert.equal(await session.evaluate('a.getMainPixel(6,4)'), String(0x123456))
      assert.equal(await session.evaluate('a.getMaskPixel(1,4)'), '64')
      assert.equal(await session.evaluate('a.getMaskPixel(4,4)'), '0')
      await session.evaluate('a.drawText(10,0,"A",0x123456,255,false)')
      assert.equal(await session.evaluate('a.getMaskPixel(11,4)'), '64')
      assert.equal(await session.evaluate('a.font.getTextWidth("AZ")'), '13')
    } finally {
      await session.stop()
    }
  })
test('mapped vertical glyphs retain their pre-rendered bitmap and normalize advance direction', async () => {
  const { session } = await headless(
    {
      'startup.tjs':
        setup +
        'a.font.angle=2700;a.font.mapPrerenderedFont("font.tft");a.drawText(10,5,"中中",0xabcdef);',
      'font.tft': fixture('coverage-v1.tft'),
    },
    { graphics },
  )
  try {
    await session.start()
    assert.equal(await session.evaluate('a.getMaskPixel(3,2)'), '64')
    assert.equal(await session.evaluate('a.getMaskPixel(3,8)'), '64')
    assert.equal(await session.evaluate('int(a.font.getEscWidthY("中中"))'), '16')
  } finally {
    await session.stop()
  }
})
const spec: FontSpec = {
  height: 20,
  face: 'font.ttf',
  faceIsFileName: true,
  angle: 0,
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
}
const finish = async <T>(work: Generator<void, T>): Promise<T> => {
  while (true) {
    const next = work.next()
    if (next.done) return next.value
  }
}
test('font file resources deduplicate by immutable identity, observe replacements and release faces on disposal', async () => {
  let resource = { name: 'font.ttf', size: 1, read: async () => new Uint8Array([1]) },
    loads = 0,
    releases = 0
  const service = new FontService(
    () => resource,
    {
      ...graphics,
      async loadFont(bytes) {
        loads++
        return {
          face: 'loaded-' + bytes[0],
          dispose() {
            releases++
          },
        }
      },
      measure(_text, font) {
        return { width: font.face === 'loaded-1' ? 10 : 20, height: 20, ascent: 16 }
      },
    },
    finish,
  )
  assert.equal((await service.measure('AA', spec)).width, 20)
  await service.measure('A', spec)
  assert.equal(loads, 1)
  resource = { name: 'font.ttf', size: 1, read: async () => new Uint8Array([2]) }
  assert.equal((await service.measure('A', spec)).width, 20)
  assert.equal(loads, 2)
  service.dispose()
  service.dispose()
  assert.equal(releases, 2)
})
test('stop cancels a pending font load and releases its late FontFace without resuming TJS', async () => {
  let entered!: () => void,
    resolve!: (value: LoadedFont) => void,
    releases = 0
  const ready = new Promise<void>((r) => (entered = r)),
    pending = new Promise<LoadedFont>((r) => (resolve = r))
  const { session } = await headless(
    {
      'startup.tjs':
        setup +
        'a.font.face="late.ttf";a.font.faceIsFileName=true;a.font.getTextWidth("A");Debug.message("should not resume");',
      'late.ttf': new Uint8Array([1]),
    },
    {
      graphics: {
        ...graphics,
        loadFont() {
          entered()
          return pending
        },
      },
    },
  )
  const started = session.start(),
    rejected = assert.rejects(started, /cancelled/)
  await ready
  await session.stop()
  await rejected
  assert.equal(session.snapshot().handles, 0)
  resolve({
    face: 'late',
    dispose() {
      releases++
    },
  })
  await pending
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(releases, 1)
})

test('font file cache evicts least recently used faces and has bounded resource residency', async () => {
  let loads = 0,
    released: string[] = []
  const resources = new Map(
    Array.from({ length: 40 }, (_, i) => [
      'font' + i,
      { name: 'font' + i, size: 1, read: async () => new Uint8Array([i]) },
    ]),
  )
  const service = new FontService(
    (name) => resources.get(name)!,
    {
      ...graphics,
      async loadFont(bytes) {
        loads++
        const face = 'file' + bytes[0]
        return {
          face,
          dispose() {
            released.push(face)
          },
        }
      },
    },
    finish,
  )
  for (let i = 0; i < 40; i++) await service.measure('A', { ...spec, face: 'font' + i })
  assert.equal(loads, 40)
  assert.deepEqual(
    released,
    Array.from({ length: 8 }, (_, i) => 'file' + i),
  )
  await service.measure('A', { ...spec, face: 'font39' })
  assert.equal(loads, 40)
  service.dispose()
  assert.equal(released.length, 40)
})

test('underreported font bytes fail before a browser face is created', async () => {
  let loads = 0
  const service = new FontService(
    () => ({ name: 'font.ttf', size: 1, read: async () => new Uint8Array(16 * 1024 * 1024 + 1) }),
    {
      ...graphics,
      async loadFont() {
        loads++
        throw new Error('must not load')
      },
    },
    finish,
  )
  await assert.rejects(service.measure('A', spec), /16 MiB/)
  assert.equal(loads, 0)
  service.dispose()
})

test('a font load settling beside cancellation releases exactly one face', async () => {
  let service: FontService,
    released = 0,
    complete!: (font: LoadedFont) => void
  const loading = new Promise<LoadedFont>((resolve) => {
    complete = resolve
  })
  service = new FontService(
    () => ({ name: 'font.ttf', size: 1, read: async () => new Uint8Array([1]) }),
    {
      ...graphics,
      loadFont() {
        queueMicrotask(() => {
          complete({
            face: 'race',
            dispose() {
              released++
            },
          })
          queueMicrotask(() => service.dispose())
        })
        return loading
      },
    },
    finish,
  )
  await assert.rejects(service.measure('A', spec), /cancelled/)
  assert.equal(released, 1)
})
