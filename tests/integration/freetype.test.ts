import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { FontKernel } from '../../src/backends/text/freetype/face.ts'
import {
  loadFontKernel,
  type FontFactory,
  type FontManifest,
} from '../../src/backends/text/freetype/module.ts'
import { ExecutionControl } from '../../src/engine/scheduler/control.ts'
import type { FontSpec } from '../../src/engine/ports/graphics.ts'
import { headless } from '../helpers/headless.ts'
const directory = new URL('../../.generated/fonts/', import.meta.url)
const manifest: FontManifest = JSON.parse(
  await readFile(new URL('manifest.json', directory), 'utf8'),
)
const factory: FontFactory = (await import(new URL(manifest.assets.mjs.file, directory).href))
  .default
const binary = new Uint8Array(await readFile(new URL(manifest.assets.wasm.file, directory)))
const openKernel = async () => new FontKernel(await factory({ wasmBinary: binary }))
const bytes = new Uint8Array(
  await readFile(new URL('../fixtures/font-geometry/outlines.ttf', import.meta.url)),
)
const spec: FontSpec = {
  height: 20,
  face: 'fixture',
  angle: 0,
  bold: false,
  italic: false,
  underline: false,
  strikeout: false,
}
type Case = {
  height: number
  flags: number
  code: number
  metrics: number[]
  advance: number
  glyph: number[]
  coverage: number[]
}
const reference: { version: number[]; cases: Case[] } = JSON.parse(
  await readFile(new URL('../fixtures/font-geometry/freetype.json', import.meta.url), 'utf8'),
)
test('session stop releases cached font faces before disposing the graphics backend', async () => {
  const releases: string[] = []
  const { session } = await headless(
    {
      'startup.tjs':
        'var w=new Window(),a=new Layer(w,null);a.font.face="font.ttf";a.font.faceIsFileName=true;a.font.getTextWidth("A");',
      'font.ttf': bytes,
    },
    {
      graphics: {
        decode: async () => {
          throw new Error('No image')
        },
        text: () => {
          throw new Error('No text')
        },
        measure: () => ({ width: 1, height: 20, ascent: 16 }),
        loadFont: async () => ({
          face: 'face',
          dispose: () => {
            releases.push('face')
          },
        }),
        dispose: () => {
          releases.push('backend')
        },
      },
    },
  )
  try {
    await session.start()
    await session.stop()
    await session.stop()
    assert.deepEqual(releases, ['face', 'backend'])
  } finally {
    await session.stop()
  }
})

test('file font metrics and all style/AA coverage bytes match 512 extracted native cases', async () => {
  const kernel = await openKernel(),
    face = kernel.open(bytes)
  try {
    assert.deepEqual(reference.version, [2, 14, 3])
    assert.equal(reference.cases.length, 512)
    assert.equal(kernel.module._krfont_version!(), 21403)
    for (const row of reference.cases) {
      const font = {
          ...spec,
          height: row.height,
          bold: !!(row.flags & 1),
          italic: !!(row.flags & 2),
          underline: !!(row.flags & 4),
          strikeout: !!(row.flags & 8),
        },
        char = String.fromCharCode(row.code),
        tag = JSON.stringify([row.height, row.flags, row.code])
      const m = face.metrics(char, font),
        g = face.glyph(char, font, !(row.flags & 16))
      assert.deepEqual([m.left, m.top, m.right, m.bottom, m.advance], row.metrics, tag + ' metrics')
      assert.equal(face.advance(char, font), row.advance, tag + ' width')
      assert.deepEqual([g.width, g.height, g.left, g.top, g.advance], row.glyph, tag + ' glyph')
      assert.deepEqual([...g.coverage], row.coverage, tag + ' pixels')
    }
  } finally {
    kernel.dispose()
  }
})
test('native file handles recover after invalid data, enforce capacity and release once', async (t) => {
  const kernel = await openKernel(),
    close = t.mock.method(kernel.module, '_krfont_close'),
    done = t.mock.method(kernel.module, '_krfont_done')
  try {
    assert.throws(() => kernel.open(new Uint8Array()), /budget/)
    assert.throws(() => kernel.open(new Uint8Array(16 * 1024 * 1024 + 1)), /budget/)
    for (let i = 0; i < 80; i++)
      assert.throws(() => kernel.open(new Uint8Array([1, 2, 3])), /open failed/)
    assert.throws(() => kernel.open(bytes, 1), /open failed/)
    const faces = Array.from({ length: 64 }, () => kernel.open(bytes))
    assert.throws(() => kernel.open(bytes), /open failed \(-4\)/)
    faces[0]!.dispose()
    faces[0]!.dispose()
    assert.equal(close.mock.callCount(), 1)
    assert.throws(() => faces[0]!.metrics('Q', spec), /disposed/)
    const replacement = kernel.open(bytes)
    assert.equal(replacement.has('Q'), true)
    kernel.dispose()
    kernel.dispose()
    replacement.dispose()
    assert.equal(close.mock.callCount(), 65)
    assert.equal(done.mock.callCount(), 1)
    assert.throws(() => kernel.open(bytes), /disposed/)
    assert.throws(() => replacement.glyph('Q', spec, true), /disposed/)
  } finally {
    kernel.dispose()
  }
})
test('font masks own their bytes across later calls, styles, missing characters and heap growth', async () => {
  const kernel = await openKernel(),
    source = bytes.slice(),
    face = kernel.open(source)
  try {
    source.fill(0)
    const first = face.glyph('Q', spec, true),
      snapshot = first.coverage.slice()
    assert(first.coverage.some((v) => v > 0 && v < 255))
    for (const c of ['Z', '\ud800', '\uffff']) {
      assert.equal(face.has(c), false)
      assert.equal(face.advance(c, spec), 20)
      assert.deepEqual(face.metrics(c, spec), face.metrics(' ', spec))
      assert.deepEqual(face.glyph(c, spec, true), face.glyph(' ', spec, true))
    }
    assert(face.glyph('Q', spec, false).coverage.every((v) => v === 0 || v === 255))
    const heap = kernel.module.HEAPU8.buffer,
      pointer = kernel.module._malloc!(8 * 1024 * 1024)
    assert(pointer)
    assert.notEqual(kernel.module.HEAPU8.buffer, heap)
    kernel.module._free!(pointer)
    face.glyph('R', { ...spec, bold: true, italic: true }, true)
    assert.deepEqual(first.coverage, snapshot)
    assert.deepEqual(face.glyph('Q', spec, true), first)
    const rotated = face.glyph('Q', { ...spec, angle: 2700 }, true)
    assert.deepEqual(rotated.coverage, first.coverage)
    assert.equal(rotated.left, first.left - face.ascent(20))
    assert.equal(rotated.top, first.top)
    for (const height of [0, 257])
      assert.throws(() => face.glyph('Q', { ...spec, height }, true), /failed/)
    assert.deepEqual(face.glyph('Q', spec, true), first)
  } finally {
    kernel.dispose()
  }
})
test('font loader validates bytes and ABI, aborts fetch and detaches its cancellation listener', async (t) => {
  const url = new URL('manifest.json', directory).href
  let mode = 'ok',
    aborts = 0,
    started!: () => void
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input)
    if (mode === 'wait')
      return await new Promise<Response>((_resolve, reject) => {
        started()
        init?.signal?.addEventListener(
          'abort',
          () => {
            aborts++
            reject(new DOMException('aborted', 'AbortError'))
          },
          { once: true },
        )
      })
    if (path === url)
      return mode === '404'
        ? new Response(null, { status: 404 })
        : Response.json(mode === 'abi' ? { ...manifest, abi: 9 } : manifest)
    const data = binary.slice()
    if (mode === 'hash') data[100] ^= 1
    return new Response(mode === 'size' ? data.subarray(1) : data)
  })
  for (const [failure, pattern] of [
    ['404', /missing/],
    ['abi', /ABI/],
    ['size', /size/],
    ['hash', /hash/],
  ] as const) {
    mode = failure
    await assert.rejects(loadFontKernel(url, new ExecutionControl()), pattern)
  }
  mode = 'wait'
  const ready = new Promise<void>((r) => (started = r)),
    control = new ExecutionControl(),
    pending = loadFontKernel(url, control),
    rejected = assert.rejects(pending, /aborted/)
  await ready
  control.cancel()
  await rejected
  assert.equal(aborts, 1)
  mode = 'ok'
  const live = new ExecutionControl(),
    kernel = await loadFontKernel(url, live),
    face = kernel.open(bytes)
  live.cancel()
  assert.equal(aborts, 1)
  assert.equal(face.has('Q'), true)
  kernel.dispose()
  const cancelled = new ExecutionControl()
  cancelled.cancel()
  await assert.rejects(loadFontKernel(url, cancelled), /cancelled/)
})
