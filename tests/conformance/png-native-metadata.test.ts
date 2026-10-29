import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { decodeSelectedImage, type SelectedImageDecoderDependencies } from '../../src/engine/graphics/image-decoder.ts'
import { decodePng } from '../../src/formats/image/png.ts'
import { inflateImage } from '../../src/backends/files/blob-source.ts'
import { TvpError } from '../../src/engine/system/tvp-error.ts'
import type { ImageDecodeProgress, ImageDecodeSelection } from '../../src/formats/image/selection.ts'

const options = { timeout: 30_000 }
async function finish<T>(work: Generator<void, T>): Promise<T> {
  let next = work.next()
  while (!next.done) next = work.next()
  return next.value
}
const dependencies: SelectedImageDecoderDependencies = {
  finish, inflate: inflateImage,
  async host() { throw new Error('A selected PNG must not use the browser fallback') },
}
function chunk(type: string, data: Uint8Array, badCrc = false): Buffer {
  const bytes = Buffer.alloc(data.length + 12)
  bytes.writeUInt32BE(data.length); bytes.write(type, 4); bytes.set(data, 8)
  let crc = 0xffffffff
  for (const byte of bytes.subarray(4, 8 + data.length)) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  bytes.writeUInt32BE(((crc ^ 0xffffffff) ^ Number(badCrc)) >>> 0, 8 + data.length)
  return bytes
}
function position(x: number, y: number, unit = 0, extra: readonly number[] = []): Buffer {
  const bytes = Buffer.alloc(9 + extra.length)
  bytes.writeUInt32BE(x >>> 0); bytes.writeUInt32BE(y >>> 0, 4); bytes[8] = unit; bytes.set(extra, 9)
  return bytes
}
function png(before: readonly Uint8Array[] = [], after: readonly Uint8Array[] = [],
  color = 0, depth = 8, samples: readonly number[] = [17], width = 1): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width); header.writeUInt32BE(1, 4); header[8] = depth; header[9] = color
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header),
    ...before, chunk('IDAT', deflateSync(Buffer.from([0, ...samples]))), ...after, chunk('IEND', Buffer.alloc(0))])
}
function decode(bytes: Uint8Array, mode: ImageDecodeSelection['mode'] = 'normal', progress?: ImageDecodeProgress) {
  return decodeSelectedImage(bytes, { format: 'png', mode }, dependencies, progress)
}
async function direct(bytes: Uint8Array) {
  const work = decodePng(bytes)
  assert.ok(work)
  const plan = await finish(work)
  return finish(plan.decode(await inflateImage(plan.compressed, plan.expandedLength)))
}
function metadata(image: Awaited<ReturnType<typeof decode>>) { return Object.fromEntries(image.metadata ?? []) }

test('native RGB tRNS stays opaque in 8/16-bit rows while generic PNG still expands it', options, async () => {
  for (const depth of [8, 16]) {
    const samples = depth === 8 ? [18, 86, 154, 19, 87, 155]
      : [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0x12, 0x34, 0x56, 0x78, 0x9a, 0xbd],
      transparent = depth === 8 ? [0, 18, 0, 86, 0, 154] : [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc],
      bytes = png([chunk('tRNS', Uint8Array.from(transparent))], [], 2, depth, samples, 2),
      rows: number[][] = [], native = await decode(bytes, 'normal', {
        size(w, h) { assert.deepEqual([w, h], [2, 1]) }, row(y, rgba) { assert.equal(y, 0); rows.push([...rgba]) },
      }), expected = depth === 8 ? [18, 86, 154, 255, 19, 87, 155, 255]
        : [18, 86, 154, 255, 18, 86, 154, 255]
    assert.deepEqual([...native.data], expected)
    assert.deepEqual(rows, [expected])
    const generic = [...(await direct(bytes)).data]
    assert.deepEqual(generic, [18, 86, 154, 0, ...expected.slice(4)])
  }
})

test('native gray tRNS and explicit RGBA alpha keep their distinct expansion paths', options, async () => {
  const gray = await decode(png([chunk('tRNS', Uint8Array.from([0, 17]))], [], 0, 8, [17, 18], 2))
  assert.deepEqual([...gray.data], [17, 17, 17, 0, 18, 18, 18, 255])
  const rgba = await decode(png([], [], 6, 8, [18, 86, 154, 7, 19, 87, 155, 123], 2))
  assert.deepEqual([...rgba.data], [18, 86, 154, 7, 19, 87, 155, 123])
})

test('native oFFs/pHYs use the first valid pre-IDAT values in every safe mode', options, async () => {
  const bytes = png([chunk('oFFs', position(12, -7)), chunk('pHYs', position(300, 600, 1)),
    chunk('oFFs', position(99, 98, 1)), chunk('pHYs', position(97, 96))])
  for (const mode of ['normal', 'grayscale', 'palettized'] as const) {
    const image = await decode(bytes, mode)
    assert.deepEqual(metadata(image), { offs_x: '12', offs_y: '-7', offs_unit: 'pixel',
      reso_x: '300', reso_y: '600', reso_unit: 'meter' })
    assert.deepEqual([...image.data], [17, 17, 17, 255])
  }
})

test('tail oFFs/pHYs do not create or overwrite native metadata, without changing generic decoding', options, async () => {
  const tail = [chunk('oFFs', position(99, 98)), chunk('pHYs', position(97, 96, 1))]
  assert.deepEqual(metadata(await decode(png([], tail))), {})
  assert.deepEqual(metadata(await decode(png([chunk('oFFs', position(12, -7))], tail))),
    { offs_x: '12', offs_y: '-7', offs_unit: 'pixel' })
  assert.deepEqual(metadata(await direct(png([], tail))), { offs_x: '99', offs_y: '98', offs_unit: 'pixel',
    reso_x: '97', reso_y: '96', reso_unit: 'meter' })
})

test('invalid ancillary known metadata is ignored and does not reserve its first-value slot', options, async () => {
  for (const type of ['oFFs', 'pHYs']) {
    const bytes = png([chunk(type, Uint8Array.from([1, 2, 3])), chunk(type, position(9, 8), true),
      chunk(type, position(12, 13, 1)), chunk(type, position(90, 91, 0, [1]))]),
      image = await decode(bytes)
    assert.deepEqual(metadata(image), type === 'oFFs'
      ? { offs_x: '12', offs_y: '13', offs_unit: 'micrometer' }
      : { reso_x: '12', reso_y: '13', reso_unit: 'meter' })
    assert.deepEqual([...image.data], [17, 17, 17, 255])
  }
})

test('native metadata narrows pHYs/vpAg uint32 values through signed tjs_int', options, async () => {
  const bytes = png([chunk('oFFs', position(0x80000000, 0xffffffff, 9)),
    chunk('pHYs', position(0x80000000, 0xffffffff, 9)), chunk('vpAg', position(0xffffffff, 0x80000000, 9))])
  assert.deepEqual(metadata(await decode(bytes)), {
    offs_x: '-2147483648', offs_y: '-1', offs_unit: 'unknown',
    reso_x: '-2147483648', reso_y: '-1', reso_unit: 'unknown',
    vpag_w: '-1', vpag_h: '-2147483648', vpag_unit: 'unknown',
  })
  assert.deepEqual(metadata(await direct(bytes)), {
    offs_x: '-2147483648', offs_y: '-1', offs_unit: 'unknown',
    reso_x: '2147483648', reso_y: '4294967295', reso_unit: 'unknown',
    vpag_w: '4294967295', vpag_h: '2147483648', vpag_unit: 'unknown',
  })
})

test('native vpAg accepts all name cases and extra payload before or after IDAT', options, async () => {
  for (const type of ['vpAg', 'VPAG', 'VpAg', 'vPaG']) for (const after of [false, true]) {
    const entry = chunk(type, position(640, 480, 1, [0xab, 0xcd])),
      image = await decode(png(after ? [] : [entry], after ? [entry] : []))
    assert.deepEqual(metadata(image), { vpag_w: '640', vpag_h: '480', vpag_unit: 'micrometer' })
  }
  assert.deepEqual(metadata(await decode(png([chunk('vpAg', position(1, 2))],
    [chunk('VpaG', position(3, 4, 1))]))), { vpag_w: '3', vpag_h: '4', vpag_unit: 'micrometer' })
})

test('short ancillary vpAg is ignored but a short critical variant remains a native PNG error', options, async () => {
  for (const after of [false, true]) {
    const entry = chunk('vpAg', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]))
    assert.deepEqual(metadata(await decode(png(after ? [] : [entry], after ? [entry] : []))), {})
    const critical = chunk('VpAg', Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])), rows: number[][] = []
    await assert.rejects(decode(png(after ? [] : [critical], after ? [critical] : []), 'normal', {
      size() {}, row(_y, rgba) { rows.push([...rgba]) },
    }), (error: unknown) => {
      assert.ok(error instanceof TvpError)
      assert.deepEqual(error.tvpMessage, { id: 'TVPPNGLoadError', args: ['VpAg: unknown critical chunk'] })
      return true
    })
    assert.deepEqual(rows, after ? [[17, 17, 17, 255]] : [])
  }
})

test('ancillary vpAg publishes before its CRC warning, unlike known metadata', options, async () => {
  for (const after of [false, true]) {
    const entries = [chunk('vpAg', position(640, 480), true), chunk('oFFs', position(9, 8), true),
      chunk('pHYs', position(7, 6), true)],
      image = await decode(png(after ? [] : entries, after ? entries : []))
    assert.deepEqual(metadata(image), { vpag_w: '640', vpag_h: '480', vpag_unit: 'pixel' })
    assert.deepEqual([...image.data], [17, 17, 17, 255])
  }
})

test('critical vpAg CRC failure remains fatal and preserves completed tail rows', options, async () => {
  for (const after of [false, true]) {
    const entry = chunk('VpAg', position(640, 480), true), rows: number[][] = []
    await assert.rejects(decode(png(after ? [] : [entry], after ? [entry] : []), 'normal', {
      size() {}, row(_y, rgba) { rows.push([...rgba]) },
    }), { message: 'PNG chunk CRC mismatch' })
    assert.deepEqual(rows, after ? [[17, 17, 17, 255]] : [])
  }
})
