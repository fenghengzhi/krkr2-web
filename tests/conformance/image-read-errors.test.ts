import test from 'node:test'
import assert from 'node:assert/strict'
import { BinaryReader } from '../../src/formats/binary/reader.ts'
import { decodeBmp, decodeSelectedBmp } from '../../src/formats/image/bmp.ts'
import { decodeTlg, decodeSelectedTlg } from '../../src/formats/image/tlg/index.ts'
import { ImageReadError } from '../../src/formats/image/read-error.ts'
import { ImageDecodeError } from '../../src/formats/image/selection.ts'
import { TjsError } from '../../src/engine/system/tjs-error.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { imageReadFiles } from '../helpers/image-read-errors.ts'
import { imageFixture } from '../helpers/image-fixtures.ts'
import { partialBmp } from '../helpers/image-partial-fixtures.ts'
import { tlgSds, tlgU32 } from '../helpers/tlg-fixtures.ts'

function drain<T>(work: Generator<void, T>): T {
  try { for (;;) { const next = work.next(); if (next.done) return next.value } }
  finally { work.return(undefined as T) }
}
const dependencies: SelectedImageDecoderDependencies = {
  async finish<T>(work: Generator<void, T>) { return drain(work) },
  async inflate() { throw new Error('Unexpected inflation') },
  async host() { throw new Error('Unexpected host decoding') },
}
function short(format: ImageReadError['format'], offset: number, requested: number, actual: number) {
  return (error: unknown) => {
    assert.ok(error instanceof ImageReadError)
    assert.deepEqual([error.format, error.offset, error.requested, error.actual], [format, offset, requested, actual])
    return true
  }
}
function untyped(error: unknown) {
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof ImageReadError) && !(error instanceof TjsError))
  return true
}
function tlg5(tableSize = 18): Buffer {
  return Buffer.concat([Buffer.from('TLG5.0\0raw\x1a'), Buffer.from([3]),
    tlgU32(1), tlgU32(1), tlgU32(1), tlgU32(tableSize),
    ...[10, 20, 30].map((value) => Buffer.from([1, 1, 0, 0, 0, value]))])
}

test('BinaryReader source short reads consume available bytes without branding generic or invalid-size reads', () => {
  const bytes = new Uint8Array([1, 2]), generic = new BinaryReader(bytes),
    source = new BinaryReader(bytes, (offset, requested, actual) => new ImageReadError('tlg', offset, requested, actual, 'short'))
  assert.throws(() => generic.u32(), untyped)
  assert.equal(generic.position, 0)
  assert.throws(() => source.u32(), short('tlg', 0, 4, 2))
  assert.equal(source.position, 2)
  assert.throws(() => source.u8(), short('tlg', 2, 1, 0))
  for (const size of [-1, 0.5, Infinity]) assert.throws(() => source.slice(size), untyped)
  source.position = 9
  assert.deepEqual(source.slice(0), new Uint8Array())
  assert.throws(() => source.u32(), short('tlg', 9, 4, 0))
})

test('selected BMP reports actual header field reads while the direct decoder retains its generic diagnostic', () => {
  const bytes = partialBmp({ width: 1, height: 1 })
  for (const [offset, requested] of [[0, 2], [2, 4], [6, 2], [8, 2], [10, 4], [14, 4],
    [18, 4], [22, 4], [26, 2], [28, 2], [30, 4], [34, 4], [38, 4], [42, 4], [46, 4], [50, 4]] as const) {
    for (const actual of [0, requested - 1])
      assert.throws(() => decodeSelectedBmp(bytes.subarray(0, offset + actual), 'normal'), short('bmp', offset, requested, actual))
  }
  assert.throws(() => decodeBmp(bytes.subarray(0, 20)), untyped)
  assert.throws(() => decodeSelectedBmp(new Uint8Array([0, 0]), 'normal'), ImageDecodeError)
})

test('selected BMP palette reads precede size and incomplete eight-row batches report whole source spans', () => {
  const files = imageReadFiles(), sizes: number[][] = [], rows: number[] = [],
    progress = { size(w: number, h: number) { sizes.push([w, h]) }, row(y: number) { rows.push(y) } }
  assert.throws(() => decodeSelectedBmp(files['read-bmp-palette.bmp']!, 'normal', progress), short('bmp', 54, 8, 4))
  assert.deepEqual(sizes, [])
  assert.throws(() => decodeSelectedBmp(files['read-bmp-late.bmp']!, 'normal', progress), short('bmp', 182, 128, 16))
  assert.deepEqual(sizes, [[5, 17]])
  assert.deepEqual(rows, [0, 1, 2, 3, 4, 5, 6, 7])
  assert.throws(() => decodeSelectedBmp(files['read-bmp-late.bmp']!, 'normal'), short('bmp', 182, 128, 16))
})

test('selected TLG reads the complete TLG6 mark and seeks the TLG5 size table before the next actual source read', () => {
  const tlg6 = Buffer.concat([Buffer.from('TLG6.0\0raw\x1a'), Buffer.from([3, 0, 0, 0])])
  for (const actual of [0, 1, 2, 3])
    assert.throws(() => drain(decodeSelectedTlg(tlg6.subarray(0, 11 + actual), 'normal')), short('tlg', 11, 4, actual))
  const bytes = tlg5(0), sizes: number[][] = [], progress = { size(w: number, h: number) { sizes.push([w, h]) }, row() {} }
  assert.deepEqual([...drain(decodeSelectedTlg(bytes, 'normal')).data], [50, 20, 30, 255])
  assert.throws(() => drain(decodeTlg(bytes)!), untyped)
  assert.throws(() => drain(decodeSelectedTlg(bytes.subarray(0, 24), 'normal', progress)), short('tlg', 28, 1, 0))
  assert.deepEqual(sizes, [[1, 1]])
})

test('selected TLG SDS length is a later seek target and optional names or skipped unknown chunks are not ReadBuffer failures', () => {
  const raw = tlg5(), expected = [50, 20, 30, 255]
  for (const rawLength of [raw.length - 1, raw.length + 100]) {
    const bytes = tlgSds(raw, [])
    bytes.writeUInt32LE(rawLength, 11)
    assert.deepEqual([...drain(decodeSelectedTlg(bytes, 'normal')).data], expected)
  }
  for (const tail of [Buffer.from('t'), Buffer.from('ta'), Buffer.from('tag'),
    Buffer.concat([Buffer.from('skip'), tlgU32(100)])])
    assert.deepEqual([...drain(decodeSelectedTlg(Buffer.concat([tlgSds(raw, []), tail]), 'normal')).data], expected)
  assert.throws(() => drain(decodeTlg(Buffer.concat([tlgSds(raw, []), Buffer.from('tag')]))!), untyped)
})

test('selected TLG tags brand actual chunk size and payload reads but never in-memory tag parsing', () => {
  const base = tlgSds(tlg5(), []), name = Buffer.concat([base, Buffer.from('tags')])
  assert.throws(() => drain(decodeSelectedTlg(name, 'normal')), short('tlg', name.length, 4, 0))
  const payload = Buffer.concat([name, tlgU32(5), Buffer.from('1:')])
  assert.throws(() => drain(decodeSelectedTlg(payload, 'normal')), short('tlg', name.length + 4, 5, 2))
  assert.throws(() => drain(decodeSelectedTlg(tlgSds(tlg5(), [['tags', Buffer.from('1:x=9:a')]]), 'normal')), untyped)
})

test('selected decoder preserves a structured source cause beneath the private TJSReadError descriptor', async () => {
  for (const [format, bytes] of [['bmp', new Uint8Array([66])], ['tlg', new Uint8Array([84])],
    ['png', new Uint8Array([137])]] as const) {
    for (const streaming of [false, true])
    await assert.rejects(decodeSelectedImage(bytes, { format, mode: 'normal' }, { ...dependencies,
      ...(streaming ? { async openInflater() { throw new Error('A short signature must not open an inflater') } } : {}),
    }), (error: unknown) => {
      assert.ok(error instanceof TjsError)
      assert.deepEqual(error.tjsMessage, { id: 'TJSReadError' })
      assert.ok(error.cause instanceof ImageReadError)
      assert.equal(error.cause.format, format)
      assert.equal(error.message, error.cause.message)
      assert.ok(!(error instanceof TvpError))
      return true
    })
  }
})

test('selected decoder never translates codec-looking host, scheduler, inflater setup or observer exceptions', async () => {
  const png = imageFixture('transparent-rgb.png'), bmp = partialBmp({ width: 1, height: 1 })
  for (const cause of [new ImageReadError('png', 0, 8, 1, 'external read'), new ImageDecodeError('png', 'external codec')]) {
    await assert.rejects(decodeSelectedImage(new Uint8Array([255, 216, 255]), { format: 'jpeg', mode: 'normal' },
      { ...dependencies, async host() { throw cause } }), (error) => error === cause)
    await assert.rejects(decodeSelectedImage(tlg5(), { format: 'tlg', mode: 'normal' },
      { ...dependencies, async finish() { throw cause } }), (error) => error === cause)
    await assert.rejects(decodeSelectedImage(tlg5(), { format: 'tlg', mode: 'normal' },
      { ...dependencies, async finish<T>(work: Generator<void, T>) {
        try {
          assert.equal(work.next().done, false)
          work.throw(cause)
          throw new Error('The injected scheduler failure must escape')
        } finally { work.return(undefined as T) }
      } }), (error) => error === cause)
    await assert.rejects(decodeSelectedImage(png, { format: 'png', mode: 'normal' },
      { ...dependencies, async inflate() { throw cause } }), (error) => error === cause)
    await assert.rejects(decodeSelectedImage(png, { format: 'png', mode: 'normal' },
      { ...dependencies, async openInflater() { throw cause } }), (error) => error === cause)
    for (const phase of ['size', 'row'])
      await assert.rejects(decodeSelectedImage(bmp, { format: 'bmp', mode: 'normal' }, dependencies, {
        size() { if (phase === 'size') throw cause }, row() { throw cause },
      }), (error) => error === cause)
  }
})

test('PNG true source failure and cleanup failure preserve the mapped TJS primary plus the independent cleanup cause', async () => {
  const bytes = imageReadFiles()['read-png-idat.png']!, cleanup = new Error('close failed')
  let closes = 0
  await assert.rejects(decodeSelectedImage(bytes, { format: 'png', mode: 'normal' }, {
    ...dependencies, async openInflater() {
      return { step() { throw new Error('Incomplete IDAT input must fail before inflation') },
        close() { closes++; throw cleanup } }
    },
  }), (error: unknown) => {
    assert.ok(error instanceof AggregateError)
    assert.ok(error.cause instanceof TjsError)
    assert.ok(error.cause.cause instanceof ImageReadError)
    assert.deepEqual(error.cause.tjsMessage, { id: 'TJSReadError' })
    assert.deepEqual(error.errors, [error.cause, cleanup])
    return true
  })
  assert.equal(closes, 1)
})

test('PNG inflater step and cleanup exceptions retain exact identity and both causes without being source reads', async () => {
  const bytes = imageFixture('transparent-rgb.png')
  for (const cause of [new ImageReadError('png', 9, 4, 0, 'external step'), new ImageDecodeError('png', 'external step')]) {
    for (const cleanup of [undefined, new ImageReadError('png', 10, 4, 0, 'external cleanup')]) {
      let closes = 0
      await assert.rejects(decodeSelectedImage(bytes, { format: 'png', mode: 'normal' }, {
        ...dependencies, async openInflater() {
          return { step() { throw cause }, close() { closes++; if (cleanup) throw cleanup } }
        },
      }), (error: unknown) => {
        if (!cleanup) assert.equal(error, cause)
        else {
          assert.ok(error instanceof AggregateError)
          assert.equal(error.cause, cause)
          assert.deepEqual(error.errors, [cause, cleanup])
        }
        return true
      })
      assert.equal(closes, 1)
    }
  }
})
