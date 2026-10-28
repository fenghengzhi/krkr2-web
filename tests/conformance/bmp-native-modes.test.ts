import test from 'node:test'
import assert from 'node:assert/strict'
import { decodeBmp, decodeSelectedBmp } from '../../src/formats/image/bmp.ts'
import { ImageDecodeError, type ImageDecodeSelection } from '../../src/formats/image/selection.ts'
import { decodeSelectedImage } from '../../src/engine/graphics/image-decoder.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import { imageBytes, imageFixture, imageManifest } from '../helpers/image-fixtures.ts'

interface Fixture {
  core?: boolean
  depth: number
  width: number
  height?: number
  topDown?: boolean
  palette?: Uint8Array
  colors?: number
  rows?: readonly Uint8Array[]
}
/** Independent file bytes. Rows are authored in visible top-to-bottom order. */
function bitmap(options: Fixture): Buffer {
  const { core = false, depth, width, height = 1, topDown = false, colors = 0,
    palette = new Uint8Array(), rows = [] } = options,
    stride = Math.ceil(width * depth / 32) * 4,
    offset = (core ? 26 : 54) + palette.length,
    bytes = Buffer.alloc(offset + stride * height)
  bytes.write('BM')
  bytes.writeUInt32LE(bytes.length, 2)
  bytes.writeUInt32LE(offset, 10)
  bytes.writeUInt32LE(core ? 12 : 40, 14)
  if (core) {
    bytes.writeUInt16LE(width, 18)
    bytes.writeUInt16LE(height, 20)
    bytes.writeUInt16LE(1, 22)
    bytes.writeUInt16LE(depth, 24)
  } else {
    bytes.writeInt32LE(width, 18)
    bytes.writeInt32LE(topDown ? -height : height, 22)
    bytes.writeUInt16LE(1, 26)
    bytes.writeUInt16LE(depth, 28)
    bytes.writeUInt32LE(colors, 46)
  }
  bytes.set(palette, core ? 26 : 54)
  for (let y = 0; y < rows.length; y++) {
    assert.ok(rows[y]!.length <= stride, 'fixture row fits its separately declared stride')
    bytes.set(rows[y]!, offset + (topDown ? y : height - 1 - y) * stride)
  }
  return bytes
}
function words(values: readonly number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 2)
  values.forEach((value, index) => bytes.writeUInt16LE(value, index * 2))
  return bytes
}
function rgba(colors: readonly (readonly number[])[]): number[] {
  return colors.flatMap((color) => [...color, 255])
}
function gray(values: readonly number[]): number[] {
  return values.flatMap((value) => [value, value, value, 255])
}
function native(reason: string) {
  return (error: unknown): boolean => {
    assert.ok(error instanceof ImageDecodeError)
    assert.equal(error.format, 'bmp')
    assert.equal(error.reason, reason)
    return true
  }
}
function plain(error: unknown): boolean {
  assert.ok(error instanceof Error)
  assert.ok(!(error instanceof ImageDecodeError) && !(error instanceof TvpError))
  return true
}

test('CORE 24-bit uses portable bottom-up rows, DWORD padding and original grayscale', () => {
  const bytes = bitmap({ core: true, depth: 24, width: 3, height: 2, rows: [
      Uint8Array.of(50, 100, 200, 250, 20, 10, 3, 2, 1),
      Uint8Array.of(255, 255, 255, 0, 0, 0, 0, 0, 255),
    ] }),
    expected = rgba([[200, 100, 50], [10, 20, 250], [1, 2, 3], [255, 255, 255], [0, 0, 0], [255, 0, 0]])
  for (const image of [decodeBmp(bytes)!, decodeSelectedBmp(bytes, 'normal')!]) {
    assert.equal(image.width, 3)
    assert.equal(image.height, 2)
    assert.deepEqual([...image.data], expected)
  }
  assert.deepEqual([...decodeSelectedBmp(bytes, 'grayscale')!.data], gray([117, 34, 1, 255, 0, 53]))
  assert.throws(() => decodeSelectedBmp(bytes, 'palettized'), native('Unsupported color mode for palettized image.'))
})

test('CORE selected palette follows the fixed memset/quad behavior while direct decoding retains standard triples', () => {
  const bytes = bitmap({ core: true, depth: 1, width: 4,
    palette: Uint8Array.of(10, 20, 30, 40, 50, 60), rows: [Uint8Array.of(0x50, 0xee, 0xee, 0xee)] })
  // The fixed native loader reads 8 bytes from offset 26, then seeks backwards
  // to pixels at 32. Entry 1 is B=50,G=60,R=0x50, rather than B=40,G=50,R=60.
  assert.equal(bytes.readUInt32LE(10), 32)
  assert.deepEqual([...decodeBmp(bytes)!.data], rgba([[30, 20, 10], [60, 50, 40], [30, 20, 10], [60, 50, 40]]))
  assert.deepEqual([...decodeSelectedBmp(bytes, 'normal')!.data], rgba([[30, 20, 10], [80, 60, 50], [30, 20, 10], [80, 60, 50]]))
  assert.deepEqual([...decodeSelectedBmp(bytes, 'grayscale')!.data], gray([21, 63, 21, 63]))
  const indices = decodeSelectedBmp(bytes, 'palettized')!
  assert.deepEqual([...indices.indices!], [0, 1, 0, 1])
  assert.deepEqual([...indices.data], gray([0, 1, 0, 1]))
})

test('CORE indexed 1/4/8-bit selected modes preserve bit order, opaque palette values and padded row order', () => {
  for (const depth of [1, 4, 8]) {
    const palette = new Uint8Array((1 << depth) * 4), last = (1 << depth) - 1
    palette.set([10, 20, 30, 0], 0)
    palette.set([250, 20, 10, 0], last * 4)
    const rows = depth === 1 ? [Uint8Array.of(0xa0), Uint8Array.of(0x40)]
      : depth === 4 ? [Uint8Array.of(0xf0, 0xf0), Uint8Array.of(0x0f, 0x00)]
      : [Uint8Array.of(255, 0, 255), Uint8Array.of(0, 255, 0)],
      bytes = bitmap({ core: true, depth, width: 3, height: 2, palette, rows }),
      normal = decodeSelectedBmp(bytes, 'normal')!,
      palettized = decodeSelectedBmp(bytes, 'palettized')!,
      grayscale = decodeSelectedBmp(bytes, 'grayscale')!
    assert.deepEqual([...normal.indices!], [last, 0, last, 0, last, 0])
    assert.deepEqual([...normal.data], rgba([[10, 20, 250], [30, 20, 10], [10, 20, 250], [30, 20, 10], [10, 20, 250], [30, 20, 10]]))
    assert.deepEqual([...palettized.indices!], [...normal.indices!])
    assert.deepEqual([...palettized.data], gray([last, 0, last, 0, last, 0]))
    assert.equal(grayscale.indices, undefined)
    assert.equal(grayscale.grayscale, true)
    assert.deepEqual([...grayscale.data], gray([34, 21, 34, 21, 34, 21]))
  }
})

test('CORE complete standard palette can still be a selected-handler short read, never an out-of-bounds palette', () => {
  const palette = new Uint8Array(256 * 3)
  palette.set([7, 19, 201], 255 * 3)
  const bytes = bitmap({ core: true, depth: 8, width: 1, palette, rows: [Uint8Array.of(255)] })
  assert.deepEqual([...decodeBmp(bytes)!.data], [201, 19, 7, 255])
  for (const mode of ['normal', 'grayscale', 'palettized'] as const)
    assert.throws(() => decodeSelectedBmp(bytes, mode), plain)
  assert.throws(() => decodeSelectedBmp(bytes.subarray(0, 25), 'normal'), plain)
})

test('BI_RGB 15/16-bit is little-endian RGB555 with replicated low bits and ignored high bit', () => {
  const source = [0x0000, 0x7c00, 0x03e0, 0x001f, 0x7fff, 0xffff, 0x4210, 0x0401, 0x0822],
    expected = rgba([[0, 0, 0], [255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255],
      [255, 255, 255], [132, 132, 132], [8, 0, 8], [16, 8, 16]])
  for (const depth of [15, 16]) for (const core of [false, true]) {
    const bytes = bitmap({ core, depth, width: source.length, rows: [words(source)] })
    assert.deepEqual([...decodeSelectedBmp(bytes, 'normal')!.data], expected)
    assert.deepEqual([...decodeBmp(bytes)!.data], expected)
    assert.throws(() => decodeSelectedBmp(bytes, 'palettized'), native('Unsupported color mode for palettized image.'))
  }
})

test('15/16-bit native grayscale uses the source five-bit coefficients, not rounded RGB expansion', () => {
  const source = [0x0000, 0x7c00, 0x03e0, 0x001f, 0x7fff, 0xffff, 0x4210, 0x0401, 0x0822],
    expected = gray([0, 54, 181, 20, 255, 255, 132, 2, 10])
  for (const depth of [15, 16]) {
    const bytes = bitmap({ depth, width: source.length, rows: [words(source)] }),
      image = decodeSelectedBmp(bytes, 'grayscale')!
    assert.deepEqual([...image.data], expected)
    assert.equal(image.grayscale, true)
    assert.equal(image.indices, undefined)
  }
  // White and the primaries distinguish this formula from all simple shifts
  // and from the 54/183/19 conversion applied after five-bit replication.
})

test('15/16-bit top-down and bottom-up files preserve row/pixel word spacing and padding', () => {
  for (const depth of [15, 16]) for (const topDown of [false, true]) {
    const bytes = bitmap({ depth, width: 3, height: 2, topDown,
      rows: [words([0x7c00, 0x03e0, 0x001f]), words([0x7fff, 0x0000, 0x4210])] })
    // width=3 has an eight-byte stride, six actual pixel bytes and two padding.
    bytes[54 + 6] = bytes[54 + 7] = bytes[54 + 14] = bytes[54 + 15] = 0xff
    assert.deepEqual([...decodeSelectedBmp(bytes, 'normal')!.data],
      rgba([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [132, 132, 132]]))
    assert.deepEqual([...decodeSelectedBmp(bytes, 'grayscale')!.data], gray([54, 181, 20, 255, 0, 132]))
  }
})

test('15-bit native pitch is not silently normalized to 16, and unsafe row overreads are rejected', () => {
  for (let width = 1; width <= 40; width++) {
    const bytes = bitmap({ depth: 15, width, height: 2 }),
      safe = width <= 15 || (width <= 30 && width % 2 === 0)
    if (safe) {
      const image = decodeSelectedBmp(bytes, 'normal')!
      assert.equal(image.data.length, width * 2 * 4)
      assert.ok(image.data.every((value, i) => value === (i % 4 === 3 ? 255 : 0)))
    } else {
      assert.throws(() => decodeSelectedBmp(bytes, 'normal'), plain)
      assert.throws(() => decodeBmp(bytes), plain)
    }
    // The corresponding proper 16-bit file is safe at every tested width.
    assert.equal(decodeSelectedBmp(bitmap({ depth: 16, width }), 'normal')!.width, width)
  }
})

test('palettized indexed output does not dereference absent palette entries, while color modes remain bounded', () => {
  const bytes = bitmap({ depth: 8, width: 3, colors: 1,
    palette: Uint8Array.of(5, 6, 7, 0), rows: [Uint8Array.of(0, 255, 127)] }),
    image = decodeSelectedBmp(bytes, 'palettized')!
  assert.deepEqual([...image.indices!], [0, 255, 127])
  assert.deepEqual([...image.data], gray([0, 255, 127]))
  assert.throws(() => decodeSelectedBmp(bytes, 'normal'), plain)
  assert.throws(() => decodeSelectedBmp(bytes, 'grayscale'), plain)
  assert.throws(() => decodeBmp(bytes), plain)
})

test('native BMP message branches retain precedence and Web limits/short reads retain plain identity', () => {
  const bytes = bitmap({ depth: 16, width: 1, rows: [words([0x4210])] })
  for (const [compression, reason] of [[3, 'BITFIELDS not supported.'], [1, 'Compressed BMP not supported.']] as const) {
    const changed = Buffer.from(bytes)
    changed.writeUInt32LE(compression, 30)
    assert.throws(() => decodeSelectedBmp(changed, 'palettized'), native(reason))
    assert.equal(decodeBmp(changed), undefined)
  }
  for (const [offset, value] of [[18, 4097], [18, 0], [22, 0x80000000], [10, 0xffffffff]] as const) {
    const changed = Buffer.from(bytes)
    changed.writeUInt32LE(value, offset)
    assert.throws(() => decodeSelectedBmp(changed, 'normal'), plain)
  }
  const core = bitmap({ core: true, depth: 24, width: 1, rows: [Uint8Array.of(1, 2, 3)] })
  core.writeUInt16LE(0xffff, 18)
  assert.throws(() => decodeSelectedBmp(core, 'normal'), plain)
  assert.throws(() => decodeSelectedBmp(bytes.subarray(0, bytes.length - 1), 'normal'), plain)
  const invalidPalette = bitmap({ depth: 8, width: 1, colors: 257, palette: new Uint8Array(257 * 4) })
  assert.throws(() => decodeSelectedBmp(invalidPalette, 'palettized'), plain)
})

test('existing direct BMP corpus and extended DIB alpha remain unchanged and all reads honor byteOffset', () => {
  for (const entry of imageManifest.entries.filter((item) => item.name.endsWith('.bmp'))) {
    const image = decodeBmp(imageFixture(entry.name))!, count = entry.width * entry.height
    assert.deepEqual(Buffer.from(image.data), imageBytes.subarray(entry.rgbaOffset, entry.rgbaOffset + count * 4), entry.name)
    assert.deepEqual(Buffer.from(image.indices!), imageBytes.subarray(entry.indicesOffset!, entry.indicesOffset! + count), entry.name)
  }
  const original = bitmap({ depth: 32, width: 1, rows: [Uint8Array.of(3, 2, 1, 17)] }),
    extended = Buffer.concat([original.subarray(0, 54), Buffer.alloc(68), original.subarray(54)])
  extended.writeUInt32LE(108, 14)
  extended.writeUInt32LE(122, 10)
  assert.deepEqual([...decodeBmp(extended)!.data], [1, 2, 3, 17])
  assert.throws(() => decodeSelectedBmp(extended, 'normal'), native('Non-supported header version.'))
  const enclosing = Buffer.concat([Buffer.alloc(13, 0xee), original, Buffer.alloc(9, 0xdd)]),
    view = enclosing.subarray(13, 13 + original.length), image = decodeSelectedBmp(view, 'normal')!
  assert.deepEqual([...image.data], [1, 2, 3, 17])
  view.fill(0)
  assert.deepEqual([...image.data], [1, 2, 3, 17])
})

test('selected engine path handles native CORE and 555 pixels without host fallback in every allowed mode', { timeout: 30_000 }, async () => {
  const palette = Uint8Array.of(0, 0, 255, 0, 255, 0, 0, 0),
    core = bitmap({ core: true, depth: 1, width: 2, palette, rows: [Uint8Array.of(0x40)] }),
    image16 = bitmap({ depth: 16, width: 2, rows: [words([0x7c00, 0x001f])] }),
    expected = new Map<ImageDecodeSelection['mode'], number[]>([
      ['normal', rgba([[255, 0, 0], [0, 0, 255]])],
      ['grayscale', gray([53, 18])],
      ['palettized', gray([0, 1])],
    ])
  const dependencies = {
    async finish<T>(work: Generator<void, T>): Promise<T> {
      let step = work.next()
      while (!step.done) step = work.next()
      return step.value
    },
    async inflate(): Promise<Uint8Array> { throw new Error('BMP must not inflate') },
    async host(): Promise<never> { throw new Error('BMP must not call a platform decoder') },
  }
  for (const mode of ['normal', 'grayscale', 'palettized'] as const) {
    const image = await decodeSelectedImage(core, { format: 'bmp', mode }, dependencies)
    assert.deepEqual([...image.data], expected.get(mode))
  }
  assert.deepEqual([...(await decodeSelectedImage(image16, { format: 'bmp', mode: 'grayscale' }, dependencies)).data], gray([54, 20]))
  await assert.rejects(decodeSelectedImage(image16, { format: 'bmp', mode: 'palettized' }, dependencies), (error: unknown) => {
    assert.ok(error instanceof TvpError)
    assert.deepEqual(error.tvpMessage, { id: 'TVPImageLoadError', args: ['Unsupported color mode for palettized image.'] })
    return true
  })
})
