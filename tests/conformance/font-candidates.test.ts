import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fontCandidates } from '../../src/engine/graphics/font-candidates.ts'
import { FontService } from '../../src/engine/graphics/fonts.ts'
import { FontCatalog } from '../../src/engine/graphics/font-catalog.ts'
import type { FontSpec, GraphicsDecoder } from '../../src/engine/ports/graphics.ts'
import { cssFontFamily } from '../../src/backends/text/browser/families.ts'

const spec: FontSpec = { face: '', height: 20, angle: 0, bold: false, italic: false, underline: false, strikeout: false }
async function finish<T>(work: Generator<void, T>): Promise<T> {
  let result = work.next(); while (!result.done) result = work.next(); return result.value
}

test('native font candidates preserve Japanese names, ASCII delimiters, forced names and whole-list vertical orientation', () => {
  assert.deepEqual([...fontCandidates('@ Missing , 日本語 , , Forced , Last')], [
    { name: 'Missing', forced: false, vertical: true }, { name: '日本語', forced: false, vertical: true },
    { name: 'Forced', forced: true, vertical: true }, { name: 'Last', forced: false, vertical: true },
  ])
  assert.deepEqual([...fontCandidates('\t,,\r 名称，別名,　全角空白　,')], [
    { name: '名称，別名', forced: true, vertical: false },
    { name: '　全角空白　', forced: false, vertical: false },
  ])
  assert.deepEqual([...fontCandidates('')], [])
  assert.deepEqual([...fontCandidates('@,,')], [])
  assert.equal(cssFontFamily('　serif　'), '"　serif　"')
})

test('candidate priority combines known game faces, trusted system names, actual availability and old embeddings', async () => {
  const queries: string[] = [], measured: FontSpec[] = [], loaded: number[] = [], retired: number[] = [],
    graphics: GraphicsDecoder = {
      decode: async () => { throw new Error('No image decode') }, text: () => { throw new Error('No raster') },
      hasFont: (name) => { queries.push(name); return name === 'serif' },
      loadFont: async (bytes) => { const id = bytes[0]!; loaded.push(id); return { face: `file-${id}`, dispose: () => { retired.push(id) } } },
      measure: (_text, font) => { measured.push({ ...font }); return { width: font.face === 'file-1' ? 10 : font.face === 'file-2' ? 18 : 7, height: 20 } },
    }, fonts = new FontService(async (name) => ({ name, size: 1, read: async () => new Uint8Array([2]) }), graphics, finish),
    family = (name: string, id: number) => ({ resource: { name, size: 1, read: async () => new Uint8Array([id]) }, bold: false, italic: false })
  fonts.registerNamed(new Map([['narrow', [family('a.ttf', 1)]], ['日本語', [family('b.ttf', 2)]]]))
  fonts.registerSystem(['Trusted System'])
  try {
    for (const [face, width, selected] of [
      ['Narrow,serif', 10, 'file-1'], ['Missing, 日本語', 18, 'file-2'],
      ['Trusted System,Narrow', 7, 'Trusted System'], ['serif,Narrow', 7, 'serif'],
      [',Missing,Narrow', 7, 'Missing'], ['Missing,,日本語', 18, 'file-2'],
      ['Narrow，日本語', 7, 'Narrow，日本語'], ['@Missing,Narrow', 10, 'file-1'],
    ] as const) {
      const input = { ...spec, face }
      assert.equal((await fonts.measure('A', input)).width, width)
      assert.equal(measured.at(-1)!.face, selected)
      assert.equal(input.face, face, 'selection does not mutate script font state')
    }
    assert.equal(measured.at(-1)!.verticalFace, true)
    assert(!queries.includes('Trusted System'))
    fonts.registerSystem([])
    assert.equal((await fonts.measure('A', { ...spec, face: 'Trusted System,Narrow' })).width, 10)
    assert(queries.includes('Trusted System'))
    delete graphics.hasFont
    assert.equal((await fonts.measure('A', { ...spec, face: 'Unknown,Narrow' })).width, 7)
    assert.equal(measured.at(-1)!.face, 'Unknown,Narrow')
    assert.equal((await fonts.measure('A', { ...spec, face: 'literal,filename.ttf', faceIsFileName: true })).width, 18)
    assert.deepEqual(loaded, [1, 2, 2])
  } finally { fonts.dispose() }
  assert.deepEqual(retired.sort(), [1, 2, 2])
})

test('a pending system-font check is cancelled without loading or publishing a later candidate', async () => {
  let release!: (value: boolean) => void, entered!: () => void, loads = 0
  const ready = new Promise<void>((resolve) => { entered = resolve }), pending = new Promise<boolean>((resolve) => { release = resolve }),
    fonts = new FontService(async () => { throw new Error('Unexpected read') }, {
      decode: async () => { throw new Error('No image') }, text: () => { throw new Error('No text') },
      hasFont: () => { entered(); return pending },
      loadFont: async () => { loads++; return { face: 'loaded', dispose() {} } },
      measure: () => ({ width: 1, height: 20 }),
    }, finish)
  fonts.registerNamed(new Map([['narrow', [{ resource: { name: 'a.ttf', size: 1, read: async () => new Uint8Array([1]) }, bold: false, italic: false }]]]))
  const work = fonts.measure('A', { ...spec, face: 'Missing,Narrow' }), rejected = assert.rejects(work, /cancelled/)
  try { await ready; fonts.dispose(); await rejected; release(false); await pending; assert.equal(loads, 0) }
  finally { release(false); fonts.dispose(); await rejected }
})

test('optional discovery is shared, warns once for excessive files, and explicit refresh remains strict and can recover', async () => {
  const warnings: string[] = [], bindings: string[][] = []
  let entries = 129, enumerations = 0, cancelled = false
  const catalog = new FontCatalog({
    files: () => { enumerations++; return Array.from({ length: entries }, (_, i) => ({ name: `${i}.ttf`, size: 1, read: async () => new Uint8Array([0]) })) },
    resolve: async () => { throw new Error('Unexpected file lookup') },
    bind: (fonts) => bindings.push([...fonts.keys()]), check: () => { if (cancelled) throw new Error('cancelled') },
    yield: async () => {}, warn: (message) => warnings.push(message), wait: (work) => work,
  })
  await Promise.all([catalog.ensure(), catalog.ensure()])
  // Both waiters share one attempt and one warning.
  assert.equal(enumerations, 1)
  assert.deepEqual(warnings, ['Optional game font discovery failed: Game font catalog exceeds 128 files'])
  await catalog.ensure(); assert.equal(enumerations, 1)
  await assert.rejects(catalog.prepare(), /Game font catalog exceeds 128 files/)
  entries = 1; await catalog.prepare()
  assert.deepEqual(bindings, [[]])
  assert(warnings.some((message) => message.startsWith('Font catalog ignored 0.ttf:')))
  catalog.clear(); cancelled = true
  await assert.rejects(catalog.ensure(), /cancelled/)
})

test('ordinary lazy discovery borrows metadata ranges, ignores corrupt optional files and refreshes newly added families explicitly', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../fixtures/font/narrow.ttf', import.meta.url))),
    wide = new Uint8Array(await readFile(new URL('../fixtures/font/wide.ttf', import.meta.url))),
    reads: [number, number][] = [], warnings: string[] = [], bindings: string[][] = []
  let wholeReads = 0, enumerations = 0, added = false
  const good = { name: 'narrow.ttf', size: bytes.length,
    source: { size: bytes.length, read: async (offset: number, length: number) => { reads.push([offset, length]); return bytes.slice(offset, offset + length) } },
    read: async () => { wholeReads++; throw new Error('Discovery must not load glyph bytes') } },
    bad = { name: 'bad.ttf', size: 1, read: async () => new Uint8Array([0]) },
    later = { name: 'wide.ttf', size: wide.length, read: async () => wide },
    catalog = new FontCatalog({ files: () => { enumerations++; return added ? [good, bad, later] : [good, bad] },
      resolve: async () => good, bind: (fonts) => bindings.push([...fonts.keys()]),
      check() {}, yield: async () => {}, warn: (message) => warnings.push(message), wait: (work) => work })
  await catalog.ensure(); await catalog.ensure()
  assert.equal(enumerations, 1); assert.equal(wholeReads, 0)
  assert.deepEqual(bindings, [['krkr synthetic narrow']])
  assert.equal(warnings.length, 1); assert(warnings[0]!.startsWith('Font catalog ignored bad.ttf:'))
  const view = new DataView(bytes.buffer), count = view.getUint16(4),
    record = Array.from({ length: count }, (_, i) => 12 + i * 16).find((at) => view.getUint32(at) === 0x676c7966)!
  const glyf = view.getUint32(record + 8), glyfEnd = glyf + view.getUint32(record + 12)
  assert(reads.length > 0)
  assert(reads.every(([offset, length]) => offset + length <= glyf || offset >= glyfEnd), 'metadata reads never enter the glyph outlines')
  const before = reads.length
  added = true; await catalog.ensure(); assert.equal(enumerations, 1)
  await catalog.prepare()
  assert.deepEqual(bindings.at(-1), ['krkr synthetic narrow', 'krkr synthetic wide'])
  assert.equal(reads.length, before); assert.equal(warnings.length, 1)
})

test('an explicit file request behind lazy discovery gets one supplemental scan, while cancellation prevents late publication', async () => {
  const bytes = new Uint8Array(await readFile(new URL('../fixtures/font/wide.ttf', import.meta.url)))
  for (const cancel of [false, true]) {
    let release!: () => void, enumerations = 0, resolutions = 0, cancelled = false
    const gate = new Promise<void>((resolve) => { release = resolve }), bindings: string[][] = [],
      catalog = new FontCatalog({
        files: async () => { if (++enumerations === 1) await gate; return [] },
        resolve: async (name) => { resolutions++; return { name, size: bytes.length, read: async () => bytes } },
        bind: (fonts) => bindings.push([...fonts.keys()]),
        check: () => { if (cancelled) throw new Error('cancelled') },
        yield: async () => {}, warn: () => { throw new Error('Unexpected font warning') }, wait: (work) => work,
      }), request = { ...spec, face: 'unopened.xp3>wide.ttf', faceIsFileName: true },
      normal = catalog.ensure(), first = catalog.prepare(request), second = catalog.prepare(request),
      observed = Promise.allSettled([normal, first, second])
    cancelled = cancel
    release()
    const results = await observed
    if (cancel) {
      assert(results.every((result) => result.status === 'rejected' && result.reason instanceof Error && result.reason.message === 'cancelled'))
      assert.equal(resolutions, 0); assert.deepEqual(bindings, [])
    } else {
      assert(results.every((result) => result.status === 'fulfilled'))
      assert.equal(enumerations, 2); assert.equal(resolutions, 1)
      assert.deepEqual(bindings, [[], ['krkr synthetic wide']])
      const charset = catalog.entries().find((font) => font.name === 'Krkr Synthetic wide')!.charsets?.[0]
      assert.notEqual(charset, undefined)
      assert.equal(catalog.charset(request), charset)
    }
  }
})
